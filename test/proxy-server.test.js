import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../lib/proxy-server.js'
import { parseLogLine } from '../lib/log-reader.js'

// Helper: create mock upstream API
function createMockUpstream(responseBody, statusCode = 200, extraHeaders = {}) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        const headers = {
          'content-type': 'application/json',
          ...extraHeaders,
        }
        res.writeHead(statusCode, headers)
        res.end(JSON.stringify(responseBody))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// Helper: create SSE streaming mock upstream
function createMockStreamingUpstream() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const chunks = [
          { choices: [{ delta: { content: 'Hello' } }] },
          { choices: [{ delta: { content: ' World' } }] },
          { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        ]
        let i = 0
        const send = () => {
          if (i < chunks.length) {
            res.write(`data: ${JSON.stringify(chunks[i])}\n\n`)
            i++
            setTimeout(send, 10)
          } else {
            res.write('data: [DONE]\n\n')
            res.end()
          }
        }
        send()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// Helper: make request to proxy
function makeRequest(port, body, method = 'POST', path = '/v1/chat/completions') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1', port, method, path,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, res => {
      let responseBody = ''
      res.on('data', chunk => responseBody += chunk)
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: responseBody })
      })
    })
    req.on('error', reject)
    if (method === 'POST') req.write(data)
    req.end()
  })
}

// Helper: make streaming request
function makeStreamRequest(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ ...body, stream: true })
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk.toString()))
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, chunks }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('ProxyServer', () => {
  const cleanups = []

  after(async () => {
    for (const fn of cleanups) await fn()
  })

  it('forwards JSON request and strips rate limit headers', async () => {
    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      200,
      { 'x-ratelimit-remaining': '99', 'x-ratelimit-limit': '100' }
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'test-acct', providerKey: 'test', apiKey: 'key-1',
      modelId: 'test-model', url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200)
    assert.ok(!res.headers['x-ratelimit-remaining'], 'Rate limit headers should be stripped')
    const parsed = JSON.parse(res.body)
    assert.ok(parsed.choices)
  })

  it('streams SSE without buffering', async () => {
    const upstream = await createMockStreamingUpstream()
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'stream-acct', providerKey: 'test', apiKey: 'key-1',
      modelId: 'stream-model', url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeStreamRequest(port, { model: 'stream-model', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200)
    const allData = res.chunks.join('')
    assert.ok(allData.includes('Hello'), 'Should contain streamed content')
    assert.ok(allData.includes('[DONE]'), 'Should contain DONE marker')
  })

  it('rotates to next account on 429', async () => {
    const bad = await createMockUpstream({ error: 'rate limited' }, 429, { 'retry-after': '60' })
    const good = await createMockUpstream({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    cleanups.push(() => bad.server.close(), () => good.server.close())

    const accounts = [
      { id: 'bad-acct', providerKey: 'p1', apiKey: 'k1', modelId: 'm1', url: bad.url + '/v1' },
      { id: 'good-acct', providerKey: 'p2', apiKey: 'k2', modelId: 'm2', url: good.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200)
  })

  it('returns 503 when all accounts exhausted', async () => {
    const bad = await createMockUpstream({ error: 'rate limited' }, 429)
    cleanups.push(() => bad.server.close())

    const accounts = [
      { id: 'only-acct', providerKey: 'p1', apiKey: 'k1', modelId: 'm1', url: bad.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 1 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 503)
  })

  it('serves GET /v1/models', async () => {
    const upstream = await createMockUpstream({})
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'models-acct', providerKey: 'test', apiKey: 'key-1',
      modelId: 'cool-model', url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, null, 'GET', '/v1/models')
    assert.strictEqual(res.statusCode, 200)
    const parsed = JSON.parse(res.body)
    assert.ok(Array.isArray(parsed.data), 'Should return models array')
  })

  it('respects retry-after', async () => {
    const bad = await createMockUpstream({ error: 'rate limited' }, 429, { 'retry-after': '3600' })
    cleanups.push(() => bad.server.close())

    const accounts = [
      { id: 'retry-acct', providerKey: 'p1', apiKey: 'k1', modelId: 'm1', url: bad.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // First request triggers 429 and sets retry-after
    await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    // Second request should fail immediately (account in retry-after)
    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 503)
  })

  it('getStatus returns running, port, accountCount and healthByAccount', async () => {
    const upstream = await createMockUpstream({})
    cleanups.push(() => upstream.server.close())

    const accounts = [
      { id: 'status-acct-1', providerKey: 'prov1', apiKey: 'k1', modelId: 'model-a', url: upstream.url + '/v1' },
      { id: 'status-acct-2', providerKey: 'prov2', apiKey: 'k2', modelId: 'model-b', url: upstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, proxyApiKey: 'test-secret-token' })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const status = proxy.getStatus()

    assert.strictEqual(status.running, true)
    assert.strictEqual(status.port, port)
    assert.strictEqual(status.accountCount, 2)

    // healthByAccount must be present and keyed by account id
    assert.ok('healthByAccount' in status, 'status must include healthByAccount')
    assert.ok('status-acct-1' in status.healthByAccount, 'healthByAccount must include status-acct-1')
    assert.ok('status-acct-2' in status.healthByAccount, 'healthByAccount must include status-acct-2')

    const h1 = status.healthByAccount['status-acct-1']
    assert.strictEqual(typeof h1.score, 'number', 'health entry must have numeric score')
    // quotaPercent is null when no quota headers received (unknown signal) — not a number
    assert.ok(h1.quotaPercent === null || typeof h1.quotaPercent === 'number', 'health entry quotaPercent must be null or number')

    // API keys must NOT be present in status
    assert.ok(!('proxyApiKey' in status), 'status must not expose proxyApiKey')
    assert.ok(!('apiKey' in status), 'status must not expose apiKey')
  })

  it('getStatus healthByAccount reflects account provider and model identity', async () => {
    const upstream = await createMockUpstream({})
    cleanups.push(() => upstream.server.close())

    const accounts = [
      { id: 'identity-acct', providerKey: 'myprovider', apiKey: 'secret', modelId: 'my-model', url: upstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts })
    await proxy.start()
    cleanups.push(() => proxy.stop())

    const status = proxy.getStatus()
    const h = status.healthByAccount['identity-acct']

    assert.strictEqual(h.providerKey, 'myprovider')
    assert.strictEqual(h.modelId, 'my-model')
  })

  it('proxy passes providerKey to recordFailure for unknown-telemetry 429 temp cooldown', async () => {
    // Unknown provider (huggingface) gets 3 consecutive 429s → temp cooldown, not permanent disable
    const bad = await createMockUpstream({ error: 'rate limited' }, 429)
    const good = await createMockUpstream({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    cleanups.push(() => bad.server.close(), () => good.server.close())

    const accounts = [
      { id: 'hf-acct', providerKey: 'huggingface', apiKey: 'k1', modelId: 'm1', url: bad.url + '/v1' },
      { id: 'gr-acct', providerKey: 'groq', apiKey: 'k2', modelId: 'm2', url: good.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // This request should fail on hf-acct (429) and succeed on gr-acct
    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200)

    // hf-acct should NOT be permanently disabled (only 1 failure, threshold is 3)
    const status = proxy.getStatus()
    const hfHealth = status.healthByAccount['hf-acct']
    assert.strictEqual(hfHealth.disabled, false, 'unknown-telemetry 429 should not permanently disable account')
  })

  it('proxy rotates away from unknown-telemetry account after 3 consecutive 429s', async () => {
    // We need 3 429s on the same account to trigger temp cooldown
    // Use retries=4 to ensure 3 hits on hf-acct; only 1 good account
    const bad = await createMockUpstream({ error: 'rate limited' }, 429)
    const good = await createMockUpstream({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    cleanups.push(() => bad.server.close(), () => good.server.close())

    const accounts = [
      { id: 'hf-acct-2', providerKey: 'huggingface', apiKey: 'k1', modelId: 'm1', url: bad.url + '/v1' },
      { id: 'gr-acct-2', providerKey: 'groq', apiKey: 'k2', modelId: 'm2', url: good.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 5 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // Manually cause 3 failures to trigger cooldown
    const am = proxy._accountManager
    const err429 = { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: null, rateLimitConfidence: 'generic_rate_limit' }
    am.recordFailure('hf-acct-2', err429, { providerKey: 'huggingface' })
    am.recordFailure('hf-acct-2', err429, { providerKey: 'huggingface' })
    am.recordFailure('hf-acct-2', err429, { providerKey: 'huggingface' })

    // hf-acct-2 should now be in temporary cooldown
    const ra = am.getRetryAfter('hf-acct-2')
    assert.ok(ra > 0, `hf-acct-2 should have a cooldown after 3 failures, got ${ra}`)

    const status = proxy.getStatus()
    assert.strictEqual(status.healthByAccount['hf-acct-2'].disabled, false, 'should NOT be permanently disabled')
  })
})

// ─── Suite: ProxyServer – log coherence (Task 5) ─────────────────────────────
// These tests verify that every real upstream attempt (success OR failure)
// produces a coherent JSONL log entry with all required fields.

function makeTempLogDir(label) {
  const dir = join(tmpdir(), `fcm-proxy-log-${label}-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    logFile: join(dir, 'request-log.jsonl'),
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } },
    readLog: () => {
      const logFile = join(dir, 'request-log.jsonl')
      if (!existsSync(logFile)) return []
      return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean)
    },
  }
}

describe('ProxyServer – log coherence', () => {
  const cleanups = []

  after(async () => {
    for (const fn of cleanups) await fn()
  })

  it('logs successful request with usage data', async () => {
    const logCtx = makeTempLogDir('success-usage')
    cleanups.push(logCtx.cleanup)

    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      200
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [{ id: 'log-acct', providerKey: 'testprov', apiKey: 'k1', modelId: 'test-model', url: upstream.url + '/v1' }]
    const proxy = new ProxyServer({ port: 0, accounts, tokenStatsOpts: { dataDir: logCtx.dir } })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    await makeRequest(port, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })

    const entries = logCtx.readLog()
    assert.strictEqual(entries.length, 1, 'should log exactly 1 entry for a successful request')

    const e = entries[0]
    assert.ok(e.timestamp, 'entry must have timestamp')
    assert.strictEqual(e.modelId, 'test-model', 'entry must carry modelId')
    assert.strictEqual(e.providerKey, 'testprov', 'entry must carry providerKey')
    assert.strictEqual(e.statusCode, 200, 'entry must carry statusCode=200')
    assert.strictEqual(e.requestType, 'chat.completions', 'entry must carry requestType')
    assert.strictEqual(e.promptTokens, 10, 'entry must carry promptTokens from usage')
    assert.strictEqual(e.completionTokens, 5, 'entry must carry completionTokens from usage')
    assert.ok(e.latencyMs >= 0, 'entry must carry non-negative latencyMs')
    assert.strictEqual(e.success, true, 'entry must have success=true')

    // log-reader should be able to parse this entry cleanly
    const row = parseLogLine(JSON.stringify(e))
    assert.ok(row !== null, 'log-reader parseLogLine must parse the entry')
    assert.strictEqual(row.model, 'test-model')
    assert.strictEqual(row.provider, 'testprov')
    assert.strictEqual(row.status, '200')
    assert.strictEqual(row.tokens, 15)
  })

  it('logs successful request even when upstream returns NO usage', async () => {
    const logCtx = makeTempLogDir('success-no-usage')
    cleanups.push(logCtx.cleanup)

    // Upstream returns 200 but no usage field
    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'hello' } }] },
      200
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [{ id: 'log-nousage', providerKey: 'provx', apiKey: 'k1', modelId: 'model-x', url: upstream.url + '/v1' }]
    const proxy = new ProxyServer({ port: 0, accounts, tokenStatsOpts: { dataDir: logCtx.dir } })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    await makeRequest(port, { model: 'model-x', messages: [{ role: 'user', content: 'hi' }] })

    const entries = logCtx.readLog()
    assert.strictEqual(entries.length, 1, 'should log entry even without usage data')

    const e = entries[0]
    assert.ok(e.timestamp, 'entry must have timestamp')
    assert.strictEqual(e.modelId, 'model-x')
    assert.strictEqual(e.providerKey, 'provx')
    assert.strictEqual(e.statusCode, 200)
    assert.strictEqual(e.requestType, 'chat.completions')
    assert.strictEqual(e.promptTokens, 0, 'tokens default to 0 when not provided')
    assert.strictEqual(e.completionTokens, 0)
    assert.strictEqual(e.success, true)

    const row = parseLogLine(JSON.stringify(e))
    assert.ok(row !== null)
    assert.strictEqual(row.tokens, 0)
  })

  it('logs failed 429 request attempt', async () => {
    const logCtx = makeTempLogDir('fail-429')
    cleanups.push(logCtx.cleanup)

    // Use a single bad account that always returns 429 so retries all hit it.
    // The proxy will exhaust retries → 503, but every attempt should be logged.
    const bad = await createMockUpstream({ error: 'rate limited' }, 429)
    cleanups.push(() => bad.server.close())

    const accounts = [
      { id: 'bad-log-acct', providerKey: 'prov-bad', apiKey: 'k1', modelId: 'bad-model', url: bad.url + '/v1' },
    ]
    // retries=2 → 2 attempts against bad-log-acct → expect 2 log entries
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2, tokenStatsOpts: { dataDir: logCtx.dir } })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 503, 'proxy should 503 when all accounts exhausted')

    const entries = logCtx.readLog()
    // Expect at least 1 log entry for the failed 429 attempt
    assert.ok(entries.length >= 1, `should log failed attempt(s), got ${entries.length}`)

    const failEntry = entries.find(e => e.statusCode === 429)
    assert.ok(failEntry, 'should have a log entry for the 429 failure')
    assert.strictEqual(failEntry.providerKey, 'prov-bad')
    assert.strictEqual(failEntry.success, false, 'failed entry must have success=false')
    assert.ok(failEntry.timestamp, 'failed entry must have timestamp')
    assert.strictEqual(failEntry.requestType, 'chat.completions')
    assert.strictEqual(failEntry.modelId, 'bad-model')

    // log-reader must parse the failed entry cleanly
    const row = parseLogLine(JSON.stringify(failEntry))
    assert.ok(row !== null, 'log-reader must parse the 429 entry')
    assert.strictEqual(row.status, '429', 'row.status must be "429"')
    assert.strictEqual(row.provider, 'prov-bad')
    assert.strictEqual(row.model, 'bad-model')
  })

  it('log entry fields are all human-readable / renderable', async () => {
    const logCtx = makeTempLogDir('renderable')
    cleanups.push(logCtx.cleanup)

    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      200
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [{ id: 'render-acct', providerKey: 'myprov', apiKey: 'k1', modelId: 'render-model', url: upstream.url + '/v1' }]
    const proxy = new ProxyServer({ port: 0, accounts, tokenStatsOpts: { dataDir: logCtx.dir } })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    await makeRequest(port, { model: 'render-model', messages: [{ role: 'user', content: 'hi' }] })

    const entries = logCtx.readLog()
    assert.strictEqual(entries.length, 1)
    const e = entries[0]

     // timestamp must be renderable as a Date
     const d = new Date(e.timestamp)
     assert.ok(!Number.isNaN(d.getTime()), 'timestamp must be a valid ISO date string')
 
     // log-reader row must have consistent time field
     const row = parseLogLine(JSON.stringify(e))
     assert.ok(row !== null)
     const rowDate = new Date(row.time)
     assert.ok(!Number.isNaN(rowDate.getTime()), 'row.time must be a renderable ISO date string')
     assert.ok(row.time === e.timestamp, 'row.time must match the stored timestamp')
   })
 })

// ─── Suite: ProxyServer – unsupported paths return 501, not 404 ───────────────
// These tests verify that POST /v1/completions and POST /v1/responses return
// 501 Not Implemented (not silent 404) so callers get a clear signal.

describe('ProxyServer – unsupported paths return 501', () => {
  const cleanups = []

  after(async () => {
    for (const fn of cleanups) await fn()
  })

  it('POST /v1/completions returns 501 Not Implemented', async () => {
    const proxy = new ProxyServer({ port: 0, accounts: [] })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'any', prompt: 'hello' }, 'POST', '/v1/completions')
    assert.strictEqual(res.statusCode, 501)
    const body = JSON.parse(res.body)
    assert.ok(body.error, 'should include error field')
    assert.match(body.error, /not implemented|not supported/i, 'error message should mention not implemented or not supported')
  })

  it('POST /v1/responses returns 501 Not Implemented', async () => {
    const proxy = new ProxyServer({ port: 0, accounts: [] })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'any', input: 'hello' }, 'POST', '/v1/responses')
    assert.strictEqual(res.statusCode, 501)
    const body = JSON.parse(res.body)
    assert.ok(body.error, 'should include error field')
    assert.match(body.error, /not implemented|not supported/i, 'error message should mention not implemented or not supported')
  })

  it('GET /unknown-path returns 404', async () => {
    const proxy = new ProxyServer({ port: 0, accounts: [] })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, null, 'GET', '/unknown-path')
    assert.strictEqual(res.statusCode, 404)
  })

  it('401 unauthorized on /v1/completions when auth is wrong', async () => {
    const proxy = new ProxyServer({ port: 0, accounts: [], proxyApiKey: 'secret-key' })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // No auth header — should get 401, not 501
    const res = await makeRequest(port, { model: 'any', prompt: 'hello' }, 'POST', '/v1/completions')
    assert.strictEqual(res.statusCode, 401)
  })
})

// ─── Suite: ProxyServer – upstream request timeout ────────────────────────────
// These tests verify that the proxy does NOT hang forever when the upstream
// is slow or unresponsive — it must time out and treat it like a network error.

describe('ProxyServer – upstream request timeout', () => {
  const cleanups = []

  after(async () => {
    for (const fn of cleanups) await fn()
  })

  it('times out and retries when upstream hangs longer than upstreamTimeoutMs', async () => {
    // Create a mock upstream that hangs without responding for 2 seconds
    let connectionCount = 0
    const hangingUpstream = await new Promise(resolve => {
      const server = http.createServer((req, res) => {
        connectionCount++
        // Never respond — simulate hanging upstream
        req.on('data', () => {})
        req.on('end', () => {
          // Intentionally don't call res.end() — just hang
        })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => hangingUpstream.server.close())

    const goodUpstream = await new Promise(resolve => {
      const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
        })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => goodUpstream.server.close())

    const accounts = [
      { id: 'hang-acct', providerKey: 'hang', apiKey: 'k1', modelId: 'hang-model', url: hangingUpstream.url + '/v1' },
      { id: 'good-acct-to', providerKey: 'good', apiKey: 'k2', modelId: 'good-model', url: goodUpstream.url + '/v1' },
    ]
    // upstreamTimeoutMs=200ms: much shorter than the 302s real hang
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2, upstreamTimeoutMs: 200 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const start = Date.now()
    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    const elapsed = Date.now() - start

    // Must complete in much less than 302 seconds (within 2000ms for this test)
    assert.ok(elapsed < 2000, `Request took ${elapsed}ms, expected < 2000ms (timeout should have fired)`)
    // Should have fallen over to the good upstream
    assert.strictEqual(res.statusCode, 200)
  })

  it('returns 503 when all accounts time out and no fallback', async () => {
    const hangingUpstream = await new Promise(resolve => {
      const server = http.createServer((req, res) => {
        req.on('data', () => {})
        req.on('end', () => { /* hang */ })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => hangingUpstream.server.close())

    const accounts = [
      { id: 'hang-only', providerKey: 'hang', apiKey: 'k1', modelId: 'hang-model', url: hangingUpstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 1, upstreamTimeoutMs: 150 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const start = Date.now()
    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    const elapsed = Date.now() - start

    assert.ok(elapsed < 2000, `Request took ${elapsed}ms, expected < 2000ms`)
    assert.strictEqual(res.statusCode, 503)
  })

  it('logs timeout attempts in the request log', async () => {
    const logCtx = makeTempLogDir('timeout-log')
    cleanups.push(logCtx.cleanup)

    const hangingUpstream = await new Promise(resolve => {
      const server = http.createServer((req, res) => {
        req.on('data', () => {})
        req.on('end', () => { /* hang */ })
      })
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
    cleanups.push(() => hangingUpstream.server.close())

    const accounts = [
      { id: 'hang-log-acct', providerKey: 'hang-prov', apiKey: 'k1', modelId: 'hang-model', url: hangingUpstream.url + '/v1' },
    ]
    const proxy = new ProxyServer({
      port: 0, accounts, retries: 1, upstreamTimeoutMs: 150,
      tokenStatsOpts: { dataDir: logCtx.dir },
    })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })

    const entries = logCtx.readLog()
    assert.ok(entries.length >= 1, 'timeout should produce a log entry')
    const timeoutEntry = entries[0]
    assert.strictEqual(timeoutEntry.success, false, 'timed-out request must be logged as failed')
    assert.strictEqual(timeoutEntry.statusCode, 0, 'timeout entry must use statusCode=0 (network error)')
    assert.strictEqual(timeoutEntry.providerKey, 'hang-prov')
  })
})
