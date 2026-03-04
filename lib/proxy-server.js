/**
 * @file lib/proxy-server.js
 * @description Multi-account rotation proxy server with SSE streaming,
 * token stats tracking, and persistent request logging.
 *
 * Design:
 *   - Binds to 127.0.0.1 only (never 0.0.0.0)
 *   - SSE is piped through without buffering (upstreamRes.pipe(clientRes))
 *   - HTTP/HTTPS module is chosen BEFORE the request is created (single code-path)
 *   - x-ratelimit-* headers are stripped from all responses forwarded to clients
 *   - Retry loop: first attempt uses sticky session fingerprint; subsequent
 *     retries use fresh P2C to avoid hitting the same failed account
 *
 * @exports ProxyServer
 */

import http from 'node:http'
import https from 'node:https'
import { AccountManager } from './account-manager.js'
import { classifyError } from './error-classifier.js'
import { applyThinkingBudget, compressContext } from './request-transformer.js'
import { TokenStats } from './token-stats.js'
import { createHash } from 'node:crypto'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Choose the http or https module based on the URL scheme.
 * MUST be called before creating the request (single code-path).
 *
 * @param {string} url
 * @returns {typeof import('http') | typeof import('https')}
 */
function selectClient(url) {
  return url.startsWith('https') ? https : http
}

/**
 * Return a copy of the headers object with all x-ratelimit-* entries removed.
 *
 * @param {Record<string, string | string[]>} headers
 * @returns {Record<string, string | string[]>}
 */
function stripRateLimitHeaders(headers) {
  const result = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!key.toLowerCase().startsWith('x-ratelimit')) {
      result[key] = value
    }
  }
  return result
}

/**
 * Buffer all chunks from an http.IncomingMessage and return the body as a string.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

/**
 * Write a JSON (or pre-serialised) response to the client.
 *
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {object | string} body
 */
function sendJson(res, statusCode, body) {
  if (res.headersSent) return
  const json = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(json)
}

// ─── ProxyServer ─────────────────────────────────────────────────────────────

export class ProxyServer {
  /**
 * @param {{
 *   port?: number,
 *   accounts?: Array<{ id: string, providerKey: string, apiKey: string, modelId: string, url: string }>,
 *   retries?: number,
 *   proxyApiKey?: string,
 *   accountManagerOpts?: object,
 *   tokenStatsOpts?: object,
 *   thinkingConfig?: { mode: string, budget_tokens?: number },
 *   compressionOpts?: { level?: number, toolResultMaxChars?: number, thinkingMaxChars?: number, maxTotalChars?: number },
 *   upstreamTimeoutMs?: number
 * }} opts
 */
  constructor({
    port = 0,
    accounts = [],
    retries = 3,
    proxyApiKey = null,
    accountManagerOpts = {},
    tokenStatsOpts = {},
    thinkingConfig,
    compressionOpts,
    upstreamTimeoutMs = 120_000,
  } = {}) {
    this._port = port
    this._retries = retries
    this._thinkingConfig = thinkingConfig
    this._compressionOpts = compressionOpts
    this._proxyApiKey = proxyApiKey
    this._accounts = accounts
    this._upstreamTimeoutMs = upstreamTimeoutMs
    this._accountManager = new AccountManager(accounts, accountManagerOpts)
    this._tokenStats = new TokenStats(tokenStatsOpts)
    this._running = false
    this._listeningPort = null
    this._server = http.createServer((req, res) => this._handleRequest(req, res))
  }

  /**
   * Start listening on 127.0.0.1.
   *
   * @returns {Promise<{ port: number }>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server.once('error', reject)
      this._server.listen(this._port, '127.0.0.1', () => {
        this._server.removeListener('error', reject)
        this._running = true
        this._listeningPort = this._server.address().port
        resolve({ port: this._listeningPort })
      })
    })
  }

  /**
   * Save stats and close the server.
   *
   * @returns {Promise<void>}
   */
  stop() {
    this._tokenStats.save()
    return new Promise(resolve => {
      this._server.close(() => {
        this._running = false
        this._listeningPort = null
        resolve()
      })
    })
  }

  getStatus() {
    return {
      running: this._running,
      port: this._listeningPort,
      accountCount: this._accounts.length,
      healthByAccount: this._accountManager.getAllHealth(),
    }
  }

  _isAuthorized(req) {
    if (!this._proxyApiKey) return true
    const authorization = req.headers.authorization
    if (typeof authorization !== 'string') return false
    return authorization === `Bearer ${this._proxyApiKey}`
  }

  // ── Request routing ────────────────────────────────────────────────────────

  _handleRequest(req, res) {
    if (!this._isAuthorized(req)) {
      return sendJson(res, 401, { error: 'Unauthorized' })
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      this._handleModels(res)
    } else if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      this._handleChatCompletions(req, res).catch(err => {
        sendJson(res, 500, { error: 'Internal server error', message: err.message })
      })
    } else if (req.method === 'POST' && (req.url === '/v1/completions' || req.url === '/v1/responses')) {
      // These legacy/alternative OpenAI endpoints are not supported by the proxy.
      // Return 501 (not 404) so callers get a clear signal instead of silently failing.
      sendJson(res, 501, {
        error: 'Not Implemented',
        message: `${req.url} is not supported by this proxy. Use POST /v1/chat/completions instead.`,
      })
    } else {
      sendJson(res, 404, { error: 'Not found' })
    }
  }

  // ── GET /v1/models ─────────────────────────────────────────────────────────

  _handleModels(res) {
    const seen = new Set()
    const data = []
    for (const acct of this._accounts) {
      const publicModelId = acct.proxyModelId || acct.modelId
      if (!seen.has(publicModelId)) {
        seen.add(publicModelId)
        data.push({
          id: publicModelId,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'proxy',
        })
      }
    }
    sendJson(res, 200, { object: 'list', data })
  }

  // ── POST /v1/chat/completions ──────────────────────────────────────────────

  async _handleChatCompletions(clientReq, clientRes) {
    // 1. Read and parse request body
    const rawBody = await readBody(clientReq)
    let body
    try {
      body = JSON.parse(rawBody)
    } catch {
      return sendJson(clientRes, 400, { error: 'Invalid JSON body' })
    }

    // 2. Optional transformations (both functions return new objects, no mutation)
    if (this._compressionOpts && Array.isArray(body.messages)) {
      body = { ...body, messages: compressContext(body.messages, this._compressionOpts) }
    }
    if (this._thinkingConfig) {
      body = applyThinkingBudget(body, this._thinkingConfig)
    }

    // 3. Session fingerprint for first-attempt sticky routing
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(body.messages?.slice(-1) ?? []))
      .digest('hex')
      .slice(0, 16)

    const requestedModel = typeof body.model === 'string'
      ? body.model.replace(/^fcm-proxy\//, '')
      : undefined

    // 4. Retry loop
    for (let attempt = 0; attempt < this._retries; attempt++) {
      // First attempt: respect sticky session.
      // Subsequent retries: fresh P2C (don't hammer the same failed account).
      const selectOpts = attempt === 0
        ? { sessionFingerprint: fingerprint, requestedModel }
        : { requestedModel }
      const account = this._accountManager.selectAccount(selectOpts)
      if (!account) break // No available accounts → fall through to 503

      const result = await this._forwardRequest(account, body, clientRes)

      // Response fully sent (success JSON or SSE pipe established)
      if (result.done) return

      // Error path: classify → record → retry or forward error
      const { statusCode, responseBody, responseHeaders, networkError } = result
      const classified = classifyError(
        networkError ? 0 : statusCode,
        responseBody || '',
        responseHeaders || {}
      )

      this._accountManager.recordFailure(account.id, classified, { providerKey: account.providerKey })
      if (responseHeaders) {
        const quotaUpdated = this._accountManager.updateQuota(account.id, responseHeaders)
        this._persistQuotaSnapshot(account, quotaUpdated)
      }

      if (!classified.shouldRetry) {
        // Non-retryable (auth error, unknown) → return upstream response directly
        return sendJson(
          clientRes,
          statusCode || 500,
          responseBody || JSON.stringify({ error: 'Upstream error' })
        )
      }
      // shouldRetry === true → next attempt
    }

    // All retries consumed, or no accounts available from the start
    sendJson(clientRes, 503, { error: 'All accounts exhausted or unavailable' })
  }

  // ── Upstream forwarding ────────────────────────────────────────────────────

  /**
   * Forward one attempt to the upstream API.
   *
   * Resolves with:
   *   { done: true }
   *     — The response has been committed to clientRes (success JSON sent, or
   *       SSE pipe established).  The retry loop must return immediately.
   *
   *   { done: false, statusCode, responseBody, responseHeaders, networkError }
   *     — An error occurred; the retry loop decides whether to retry or give up.
   *
   * @param {{ id: string, apiKey: string, modelId: string, url: string }} account
   * @param {object} body
   * @param {http.ServerResponse} clientRes
   * @returns {Promise<{ done: boolean }>}
   */
  _forwardRequest(account, body, clientRes) {
    return new Promise(resolve => {
      // Replace client-supplied model name with the account's model ID
      const newBody = { ...body, model: account.modelId }
      const bodyStr = JSON.stringify(newBody)

      // Build the full upstream URL from the account's base URL
      const baseUrl = account.url.replace(/\/$/, '')
      const upstreamUrl = new URL(baseUrl + '/chat/completions')

      // Choose http or https module BEFORE creating the request
      const client = selectClient(account.url)
      const startTime = Date.now()

      const requestOptions = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
        path: upstreamUrl.pathname + (upstreamUrl.search || ''),
        method: 'POST',
        headers: {
          'authorization': `Bearer ${account.apiKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr),
        },
      }

      const upstreamReq = client.request(requestOptions, upstreamRes => {
        const { statusCode } = upstreamRes
        const headers = upstreamRes.headers
        const contentType = headers['content-type'] || ''
        const isSSE = contentType.includes('text/event-stream')

        if (statusCode >= 200 && statusCode < 300) {
          if (isSSE) {
            // ── SSE passthrough: MUST NOT buffer ──────────────────────────
            const strippedHeaders = stripRateLimitHeaders(headers)
            clientRes.writeHead(statusCode, {
              ...strippedHeaders,
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
            })

            // Tap the data stream to capture usage from the last data line.
            // Register BEFORE pipe() so both listeners share the same event queue.
            let lastChunkData = ''
            upstreamRes.on('data', chunk => {
              const text = chunk.toString()
              const lines = text.split('\n')
              for (const line of lines) {
                if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                  lastChunkData = line.slice(6).trim()
                }
              }
            })

            upstreamRes.on('end', () => {
              let promptTokens = 0
              let completionTokens = 0
              try {
                const parsed = JSON.parse(lastChunkData)
                if (parsed.usage) {
                  promptTokens = parsed.usage.prompt_tokens || 0
                  completionTokens = parsed.usage.completion_tokens || 0
                }
              } catch { /* no usage in stream — ignore */ }
              // Always record every upstream attempt so the log page shows real requests
              this._tokenStats.record({
                accountId: account.id,
                modelId: account.modelId,
                providerKey: account.providerKey,
                statusCode,
                requestType: 'chat.completions',
                promptTokens,
                completionTokens,
                latencyMs: Date.now() - startTime,
                success: true,
              })
              this._accountManager.recordSuccess(account.id, Date.now() - startTime)
              const quotaUpdated = this._accountManager.updateQuota(account.id, headers)
              this._persistQuotaSnapshot(account, quotaUpdated)
            })

            // Pipe after listeners are registered; upstream → client, no buffering
            upstreamRes.pipe(clientRes)

            // The pipe handles the rest asynchronously; signal done to retry loop
            resolve({ done: true })
          } else {
            // ── JSON response ─────────────────────────────────────────────
            const chunks = []
            upstreamRes.on('data', chunk => chunks.push(chunk))
            upstreamRes.on('end', () => {
              const responseBody = Buffer.concat(chunks).toString()
              const latencyMs = Date.now() - startTime

              const quotaUpdated = this._accountManager.updateQuota(account.id, headers)
              this._accountManager.recordSuccess(account.id, latencyMs)
              this._persistQuotaSnapshot(account, quotaUpdated)

              // Always record every upstream attempt so the log page shows real requests.
              // Extract tokens if upstream provides them; default to 0 when not present.
              let promptTokens = 0
              let completionTokens = 0
              try {
                const parsed = JSON.parse(responseBody)
                if (parsed.usage) {
                  promptTokens = parsed.usage.prompt_tokens || 0
                  completionTokens = parsed.usage.completion_tokens || 0
                }
              } catch { /* non-JSON body — tokens stay 0 */ }
              this._tokenStats.record({
                accountId: account.id,
                modelId: account.modelId,
                providerKey: account.providerKey,
                statusCode,
                requestType: 'chat.completions',
                promptTokens,
                completionTokens,
                latencyMs,
                success: true,
              })

              // Forward stripped response to client
              const strippedHeaders = stripRateLimitHeaders(headers)
              clientRes.writeHead(statusCode, {
                ...strippedHeaders,
                'content-type': 'application/json',
              })
              clientRes.end(responseBody)
              resolve({ done: true })
            })
          }
        } else {
          // ── Error response: buffer for classification in retry loop ─────
          const chunks = []
          upstreamRes.on('data', chunk => chunks.push(chunk))
          upstreamRes.on('end', () => {
            const latencyMs = Date.now() - startTime
            // Log every failed upstream attempt so the log page shows real requests
            this._tokenStats.record({
              accountId: account.id,
              modelId: account.modelId,
              providerKey: account.providerKey,
              statusCode,
              requestType: 'chat.completions',
              promptTokens: 0,
              completionTokens: 0,
              latencyMs,
              success: false,
            })
            resolve({
              done: false,
              statusCode,
              responseBody: Buffer.concat(chunks).toString(),
              responseHeaders: headers,
              networkError: false,
            })
          })
        }
      })

      upstreamReq.on('error', err => {
        // TCP / DNS / timeout errors — log as network failure
        const latencyMs = Date.now() - startTime
        this._tokenStats.record({
          accountId: account.id,
          modelId: account.modelId,
          providerKey: account.providerKey,
          statusCode: 0,
          requestType: 'chat.completions',
          promptTokens: 0,
          completionTokens: 0,
          latencyMs,
          success: false,
        })
        // TCP / DNS / timeout errors
        resolve({
          done: false,
          statusCode: 0,
          responseBody: err.message,
          responseHeaders: {},
          networkError: true,
        })
      })

      // Abort the upstream request if it exceeds the configured timeout.
      // This prevents indefinite hangs (e.g. nvidia returning 504 after 302 s).
      // The 'timeout' event fires but does NOT automatically abort; we must call destroy().
      upstreamReq.setTimeout(this._upstreamTimeoutMs, () => {
        upstreamReq.destroy(new Error(`Upstream request timed out after ${this._upstreamTimeoutMs}ms`))
      })

      upstreamReq.write(bodyStr)
      upstreamReq.end()
    })
  }

  /**
   * Persist a quota snapshot for the given account into TokenStats.
   * Called after every `AccountManager.updateQuota()` so TUI can read fresh data.
   * Never exposes apiKey.
   *
   * @param {{ id: string, providerKey?: string, modelId?: string }} account
   * @param {boolean} quotaUpdated
   */
  _persistQuotaSnapshot(account, quotaUpdated = true) {
    if (!quotaUpdated) return
    const health = this._accountManager.getHealth(account.id)
    if (!health) return
    this._tokenStats.updateQuotaSnapshot(account.id, {
      quotaPercent: health.quotaPercent,
      ...(account.providerKey !== undefined && { providerKey: account.providerKey }),
      ...(account.modelId !== undefined && { modelId: account.modelId }),
    })
  }
}
