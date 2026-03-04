/**
 * @file lib/account-manager.js
 * @description Multi-account health tracking and selection for proxy rotation.
 *
 * Tracks per-account health (success rate, latency, quota) and uses
 * Power-of-2-Choices (P2C) to select the best available account.
 * Supports sticky sessions via an LRU map, circuit breakers per account,
 * and retry-after cooldown periods.
 *
 * ## Rate-limit state machine (per account)
 *
 * Unknown-telemetry providers (huggingface, cloudflare, etc.):
 *   - Count consecutive 429s within a rolling 10-minute window.
 *   - On reaching threshold (3), enter temporary cooldown starting at 15m.
 *   - Cooldown escalates: 15m → 30m → 60m → ... capped at 6h.
 *   - After cooldown expires, allow ONE probe request (half-open).
 *   - Probe success → reset all state (active again).
 *   - Probe failure (429) → escalate cooldown, clear probe lock.
 *
 * Known-telemetry providers (groq, nvidia, etc.):
 *   - Honor `retry-after` header if present.
 *   - If absent, use 5m fallback cooldown.
 *   - 429s do NOT count toward unknown-telemetry threshold.
 *
 * Permanent disable:
 *   - Only for AUTH_ERROR (401/403) with skipAccount=true AND no rateLimitConfidence.
 *
 * @exports AccountManager
 */

import { CircuitBreaker } from './error-classifier.js'
import { isKnownQuotaTelemetry } from './quota-capabilities.js'

// ─── Rate-limit state machine constants ──────────────────────────────────────

const UNKNOWN_429_THRESHOLD = 3            // consecutive 429s in window before cooldown
const UNKNOWN_429_WINDOW_MS = 10 * 60 * 1000 // 10-minute rolling window
const UNKNOWN_COOLDOWN_BASE_MS = 15 * 60 * 1000 // 15m initial cooldown
const UNKNOWN_COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000 // 6h max cooldown
const KNOWN_FALLBACK_COOLDOWN_MS = 5 * 60 * 1000 // 5m fallback for known providers

// ─── Internal: per-account health state ──────────────────────────────────────

class AccountHealth {
  /**
   * @param {number} cbThreshold - Circuit breaker failure threshold
   * @param {number} cbCooldownMs - Circuit breaker cooldown in ms
   */
  constructor(cbThreshold, cbCooldownMs) {
    this.successCount = 0
    this.failureCount = 0
    this.totalLatencyMs = 0
    /**
     * Remaining quota as a percentage 0–100, or null when unknown.
     * null means we have not yet received quota telemetry for this account.
     */
    this.quotaPercent = null
    /**
     * Quota signal reliability:
     * - 'known'    — quota was updated from verifiable headers/endpoint
     * - 'inferred' — quota was estimated from error patterns (future use)
     * - 'unknown'  — no quota data received yet
     */
    this.quotaSignal = 'unknown'
    /** When true, this account is permanently disabled (e.g. auth failure). */
    this.disabled = false
    this.circuitBreaker = new CircuitBreaker({
      threshold: cbThreshold,
      cooldownMs: cbCooldownMs,
    })

    /**
     * Per-account rate-limit state machine for 429 handling.
     *
     * - consecutive429: count of consecutive 429s in the current rolling window
     * - windowStartMs:  start time of the current rolling window (ms epoch)
     * - cooldownLevel:  escalation level (0 = first occurrence → 15m, 1 → 30m, ...)
     * - cooldownUntilMs: epoch ms when cooldown expires (0 = not in cooldown)
     * - probeInFlight:  true while one half-open probe is in flight
     */
    this.rateLimitState = {
      consecutive429: 0,
      windowStartMs: 0,
      cooldownLevel: 0,
      cooldownUntilMs: 0,
      probeInFlight: false,
    }
  }

  /**
   * Health score in roughly [0, 1].
   *
   * Formula:
   *   0.4 * successRate + 0.3 * latencyScore + 0.3 * quotaScore − penalty
   *
   * Where:
   *   successRate  = successes / (successes + failures), default 1.0 if no requests
   *   latencyScore = 1 − min(avgLatencyMs / 5000, 1)   (lower = better)
   *   quotaScore:
   *     - When quotaSignal is 'known':   quotaPercent / 100
   *     - When quotaSignal is 'unknown': 0.5 (neutral — not best, not worst)
   *   penalty:
   *     - 0.5 if known quotaPercent < 20%
   *     - 0.3 if known quotaPercent < 35%
   *     - 0   otherwise / unknown
   *
   * @returns {number}
   */
  computeScore() {
    const total = this.successCount + this.failureCount
    const successRate = total === 0 ? 1.0 : this.successCount / total
    const avgLatencyMs = total === 0 ? 0 : this.totalLatencyMs / total
    const latencyScore = 1 - Math.min(avgLatencyMs / 5000, 1)

    let quotaScore
    let penalty = 0

    if (this.quotaSignal === 'known' && this.quotaPercent !== null) {
      quotaScore = this.quotaPercent / 100
      if (this.quotaPercent < 20) penalty = 0.5
      else if (this.quotaPercent < 35) penalty = 0.3
    } else {
      // Unknown quota: treat as neutral (0.5) — do not assume best-case
      quotaScore = 0.5
    }

    return 0.4 * successRate + 0.3 * latencyScore + 0.3 * quotaScore - penalty
  }
}

// ─── LRU Map helper ───────────────────────────────────────────────────────────
// Uses plain Map (insertion-ordered). To access: delete then re-set (moves to end).
// To insert new: evict first key if at capacity.

/**
 * Read from LRU map, moving the entry to "most recently used" position.
 * Returns undefined if key is absent.
 *
 * @param {Map<string, string>} map
 * @param {string} key
 * @returns {string|undefined}
 */
function lruGet(map, key) {
  if (!map.has(key)) return undefined
  const val = map.get(key)
  map.delete(key)
  map.set(key, val)
  return val
}

/**
 * Write to LRU map. If the key already exists, move it to the end.
 * If the map is at capacity (and key is new), evict the oldest entry first.
 *
 * @param {Map<string, string>} map
 * @param {string} key
 * @param {string} value
 * @param {number} maxSize
 */
function lruSet(map, key, value, maxSize) {
  if (map.has(key)) {
    // Update value and move to end
    map.delete(key)
  } else if (map.size >= maxSize) {
    // Evict oldest (first) entry
    const oldest = map.keys().next().value
    map.delete(oldest)
  }
  map.set(key, value)
}

// ─── AccountManager ───────────────────────────────────────────────────────────

export class AccountManager {
  /**
   * @param {Array<{ id: string, providerKey: string, apiKey: string, modelId: string, url: string }>} accounts
   * @param {{ circuitBreakerThreshold?: number, circuitBreakerCooldownMs?: number, maxStickySessions?: number }} [opts]
   */
  constructor(accounts, opts = {}) {
    const {
      circuitBreakerThreshold = 5,
      circuitBreakerCooldownMs = 60000,
      maxStickySessions = 1000,
    } = opts

    this._accounts = accounts
    this._maxStickySessions = maxStickySessions

    /** @type {Map<string, AccountHealth>} */
    this._healthMap = new Map()
    for (const acct of accounts) {
      this._healthMap.set(
        acct.id,
        new AccountHealth(circuitBreakerThreshold, circuitBreakerCooldownMs)
      )
    }

    /** LRU Map: fingerprint → accountId */
    this._stickyMap = new Map()

    /** Map: accountId → retryAfter epoch ms */
    this._retryAfterMap = new Map()
  }

  /**
   * Returns true when an account can serve the requested proxy model.
   *
   * Supports both:
   * - `account.proxyModelId` (logical fcm-proxy slug)
   * - `account.modelId` (upstream model id, backward compatibility)
   *
   * @private
   * @param {{ proxyModelId?: string, modelId?: string }} acct
   * @param {string|undefined} requestedModel
   * @returns {boolean}
   */
  _accountSupportsModel(acct, requestedModel) {
    if (!requestedModel) return true
    if (acct.proxyModelId === requestedModel) return true
    if (acct.modelId === requestedModel) return true
    return false
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Returns true if the account can currently accept requests.
   * Checks: not disabled, circuit breaker not open, not in retry-after cooldown,
   * and quota > 5% remaining.
   *
   * Also manages the half-open probe window:
   * - When cooldown has expired but probeInFlight is false, allow ONE probe
   *   and mark probeInFlight = true.
   * - While probeInFlight is true, block further selection of this account.
   *
   * @param {{ id: string }} acct
   * @returns {boolean}
   */
  _isAccountAvailable(acct) {
    const health = this._healthMap.get(acct.id)
    if (!health) return false
    if (health.disabled) return false
    if (health.circuitBreaker.isOpen()) return false

    // Half-open probe logic for temporary exhaustion cooldown (unknown telemetry)
    // This takes priority over _retryAfterMap for unknown-telemetry cooldowns.
    const rl = health.rateLimitState
    if (rl.cooldownUntilMs > 0) {
      const now = Date.now()
      if (now < rl.cooldownUntilMs) {
        // Still in cooldown
        return false
      }
      // Cooldown expired — allow one probe if none in flight
      if (rl.probeInFlight) {
        // Another probe is already in flight for this account — block
        return false
      }
      // Arm the probe: mark it in-flight so subsequent selects are blocked
      rl.probeInFlight = true
      // fall through — this request IS the probe
    }

    // Known-telemetry retry-after cooldown (set via _retryAfterMap)
    const retryAfterTs = this._retryAfterMap.get(acct.id)
    if (retryAfterTs && Date.now() < retryAfterTs) return false

    // Only exclude when quota is known to be nearly exhausted.
    // When quotaSignal is 'unknown' (null quotaPercent), we remain available.
    if (health.quotaSignal === 'known' && health.quotaPercent !== null && health.quotaPercent <= 5) return false

    return true
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Select the best available account.
   *
   * Algorithm:
   * 1. If `sessionFingerprint` is set and a sticky entry exists for it,
   *    return the sticky account if it is healthy. Otherwise fall through.
   * 2. Filter all accounts to those that are currently available.
   * 3. If none available, return null.
   * 4. Power-of-2-Choices (P2C): sample 2 random candidates, return the
   *    one with the higher health score. (If only 1 available, return it.)
   * 5. If `sessionFingerprint` is set, store the selection in the LRU map.
   *
   * @param {{ sessionFingerprint?: string, requestedModel?: string }} [opts]
   * @returns {{ id: string, providerKey: string, apiKey: string, modelId: string, url: string, proxyModelId?: string } | null}
   */
  selectAccount({ sessionFingerprint, requestedModel } = {}) {
    const stickyKey = sessionFingerprint
      ? (requestedModel ? `${requestedModel}::${sessionFingerprint}` : sessionFingerprint)
      : null

    // 1. Sticky session fast-path
    if (stickyKey) {
      const stickyId = lruGet(this._stickyMap, stickyKey)
      if (stickyId !== undefined) {
        const stickyAcct = this._accounts.find(a => a.id === stickyId)
        if (stickyAcct && this._accountSupportsModel(stickyAcct, requestedModel) && this._isAccountAvailable(stickyAcct)) {
          // Break sticky if the account's health score is below the slow-provider threshold
          const stickyScore = this._healthMap.get(stickyAcct.id)?.computeScore() ?? 1.0
          if (stickyScore >= 0.65) {
            return stickyAcct
          }
          // Score too low (slow/degraded provider) — fall through to P2C re-selection
        }
        // Sticky account is unhealthy — fall through to P2C
      }
    }

    // 2. Filter to available accounts.
    // If a model is explicitly requested but has no accounts, return null immediately
    // rather than silently falling back to the full pool (which would serve the wrong model).
    const candidatePool = requestedModel
      ? this._accounts.filter(a => this._accountSupportsModel(a, requestedModel))
      : this._accounts
    if (requestedModel && candidatePool.length === 0) return null
    const available = candidatePool.filter(a => this._isAccountAvailable(a))
    if (available.length === 0) return null

    // 3. P2C selection
    let selected
    if (available.length === 1) {
      selected = available[0]
    } else {
      // Pick two distinct random indices
      const idx1 = Math.floor(Math.random() * available.length)
      let idx2 = Math.floor(Math.random() * (available.length - 1))
      if (idx2 >= idx1) idx2++

      const a = available[idx1]
      const b = available[idx2]
      const scoreA = this._healthMap.get(a.id).computeScore()
      const scoreB = this._healthMap.get(b.id).computeScore()
      selected = scoreA >= scoreB ? a : b
    }

    // 4. Store/update sticky entry
    if (stickyKey) {
      lruSet(this._stickyMap, stickyKey, selected.id, this._maxStickySessions)
    }

    return selected
  }

  /**
   * Return true if at least one account is registered for the given model.
   * Uses the same matching logic as selectAccount: proxyModelId or modelId.
   *
   * @param {string} requestedModel
   * @returns {boolean}
   */
  hasAccountsForModel(requestedModel) {
    if (!requestedModel) return this._accounts.length > 0
    return this._accounts.some(a => this._accountSupportsModel(a, requestedModel))
  }

  /**
   * Update an account's remaining quota from rate-limit response headers.
   * Reads common header variants:
   * - x-ratelimit-remaining / x-ratelimit-limit
   * - x-ratelimit-remaining-requests / x-ratelimit-limit-requests
   *
   * @param {string} accountId
   * @param {Record<string, string>} headers - Lowercased response headers
   * @returns {boolean} true when quota was updated from headers
   */
  updateQuota(accountId, headers) {
    const remainingRaw =
      headers?.['x-ratelimit-remaining'] ??
      headers?.['x-ratelimit-remaining-requests']
    const limitRaw =
      headers?.['x-ratelimit-limit'] ??
      headers?.['x-ratelimit-limit-requests']

    const remaining = parseFloat(remainingRaw)
    const limit = parseFloat(limitRaw)
    if (!isNaN(remaining) && !isNaN(limit) && limit > 0) {
      const health = this._healthMap.get(accountId)
      if (health) {
        health.quotaPercent = Math.round((remaining / limit) * 100)
        health.quotaSignal = 'known'
        return true
      }
    }
    return false
  }

  /**
   * Record a failed request against an account.
   *
   * Implements provider-aware 429 policy:
   *
   * Auth errors (401/403):
   *   - Permanently disable the account (health.disabled = true).
   *
   * Known-telemetry 429s (groq, nvidia, cerebras, etc.):
   *   - Honor `retry-after` if present; else use 5m fallback cooldown.
   *   - Do NOT count toward the unknown-telemetry threshold.
   *
   * Unknown-telemetry 429s (huggingface, cloudflare, etc.):
   *   - Count consecutive 429s in a rolling 10-minute window.
   *   - On reaching threshold (3): enter temporary cooldown (15m initial, x2 each time, cap 6h).
   *   - If a probe was in-flight when the 429 occurred: escalate cooldown, clear probe lock.
   *
   * @param {string} accountId
   * @param {{ type: string, shouldRetry: boolean, skipAccount: boolean, retryAfterSec: number|null, rateLimitConfidence?: string }} classifiedError
   * @param {{ providerKey?: string }} [accountCtx] - Provider context for telemetry routing
   */
  recordFailure(accountId, classifiedError, accountCtx = {}) {
    const health = this._healthMap.get(accountId)
    if (!health) return

    health.failureCount++
    health.circuitBreaker.recordFailure()

    const is429 = classifiedError?.type === 'RATE_LIMITED' || classifiedError?.type === 'QUOTA_EXHAUSTED'
    const isAuthFatal = classifiedError?.type === 'AUTH_ERROR'

    // Permanent disable only for AUTH_ERROR (401/403). Other skipAccount errors
    // (e.g. MODEL_NOT_FOUND) do NOT permanently disable — the account may be
    // healthy for other models/requests.
    if (isAuthFatal) {
      health.disabled = true
      return
    }

    if (is429) {
      const providerKey = accountCtx?.providerKey ?? ''
      const hasKnownTelemetry = isKnownQuotaTelemetry(providerKey)

      if (hasKnownTelemetry) {
        // Known-telemetry: use retry-after or 5m fallback
        const cooldownMs = classifiedError?.retryAfterSec
          ? classifiedError.retryAfterSec * 1000
          : KNOWN_FALLBACK_COOLDOWN_MS
        this._retryAfterMap.set(accountId, Date.now() + cooldownMs)
      } else {
        // Unknown-telemetry: rolling window + threshold + escalating cooldown
        this._recordUnknown429(accountId, health)
      }
      return
    }

    // Non-429 retryable errors: apply retryAfterSec if present.
    // Also clear probeInFlight if one was in flight — a non-429 probe failure
    // should not permanently block the account from re-probing after cooldown.
    const rl = health.rateLimitState
    if (rl.probeInFlight) {
      rl.probeInFlight = false
    }
    if (classifiedError?.retryAfterSec) {
      this._retryAfterMap.set(accountId, Date.now() + classifiedError.retryAfterSec * 1000)
    }
  }

  /**
   * Handle a 429 for an unknown-telemetry account.
   * Manages the rolling window, threshold, cooldown escalation, and probe state.
   * Uses `rateLimitState.cooldownUntilMs` (NOT _retryAfterMap) as source of truth.
   *
   * @private
   * @param {string} accountId
   * @param {AccountHealth} health
   */
  _recordUnknown429(accountId, health) {
    const rl = health.rateLimitState
    const now = Date.now()

    // If a probe was in flight when this 429 happened, it means the probe failed.
    // Escalate cooldown and clear probe lock.
    if (rl.probeInFlight) {
      rl.probeInFlight = false
      // Increment cooldown level (probe failure = another escalation step)
      rl.cooldownLevel++
      const cooldownMs = Math.min(UNKNOWN_COOLDOWN_BASE_MS * Math.pow(2, rl.cooldownLevel - 1), UNKNOWN_COOLDOWN_MAX_MS)
      rl.cooldownUntilMs = now + cooldownMs
      // Reset consecutive counter for next window
      rl.consecutive429 = 0
      rl.windowStartMs = now
      return
    }

    // Rolling window: reset if window has expired
    if (rl.windowStartMs === 0 || now - rl.windowStartMs > UNKNOWN_429_WINDOW_MS) {
      rl.consecutive429 = 0
      rl.windowStartMs = now
    }

    rl.consecutive429++

    if (rl.consecutive429 >= UNKNOWN_429_THRESHOLD) {
      // Threshold reached: enter cooldown
      const cooldownMs = Math.min(UNKNOWN_COOLDOWN_BASE_MS * Math.pow(2, rl.cooldownLevel), UNKNOWN_COOLDOWN_MAX_MS)
      rl.cooldownUntilMs = now + cooldownMs
      // Increment level for next occurrence
      rl.cooldownLevel++
      // Reset window for next cycle
      rl.consecutive429 = 0
      rl.windowStartMs = now
    }
  }

  /**
   * Record a successful request against an account.
   * Clears temporary exhaustion state (cooldown, probe lock, 429 counters).
   *
   * @param {string} accountId
   * @param {number} [latencyMs] - Round-trip time in milliseconds (optional)
   */
  recordSuccess(accountId, latencyMs = 0) {
    const health = this._healthMap.get(accountId)
    if (!health) return

    health.successCount++
    health.totalLatencyMs += latencyMs
    health.circuitBreaker.recordSuccess()

    // Clear temporary exhaustion state on any successful request
    const rl = health.rateLimitState
    rl.cooldownUntilMs = 0
    rl.consecutive429 = 0
    rl.windowStartMs = 0
    rl.probeInFlight = false
    // Note: cooldownLevel intentionally preserved for future escalation tracking;
    // reset it only when we have high confidence the quota has genuinely recovered.
    // (For now, a successful probe is considered a full reset.)
    rl.cooldownLevel = 0

    // Clear retry-after from the retryAfterMap (no longer cooling down)
    this._retryAfterMap.delete(accountId)
  }

  /**
   * Get the current health snapshot for an account.
   *
   * @param {string} accountId
   * @returns {{ score: number, quotaPercent: number|null, quotaSignal: string, disabled: boolean } | null}
   */
  getHealth(accountId) {
    const health = this._healthMap.get(accountId)
    if (!health) return null
    return {
      score: health.computeScore(),
      quotaPercent: health.quotaPercent,
      quotaSignal: health.quotaSignal,
      disabled: health.disabled,
    }
  }

  /**
   * Get a snapshot of health for all accounts, keyed by account id.
   *
   * Each entry includes at minimum `{ score, quotaPercent, quotaSignal, disabled }`.
   * If the account has `providerKey` and `modelId`, those are included too.
   *
   * @returns {Record<string, { score: number, quotaPercent: number|null, quotaSignal: string, disabled: boolean, providerKey?: string, modelId?: string }>}
   */
  getAllHealth() {
    const snapshot = {}
    for (const acct of this._accounts) {
      const health = this._healthMap.get(acct.id)
      if (!health) continue
      const entry = {
        score: health.computeScore(),
        quotaPercent: health.quotaPercent,
        quotaSignal: health.quotaSignal,
        disabled: health.disabled,
      }
      if (acct.providerKey !== undefined) entry.providerKey = acct.providerKey
      if (acct.modelId !== undefined) entry.modelId = acct.modelId
      snapshot[acct.id] = entry
    }
    return snapshot
  }

  /**
   * Get the remaining retry-after cooldown for an account in seconds.
   * Returns 0 if no cooldown is active.
   *
   * Checks both known-telemetry retryAfterMap and unknown-telemetry cooldownUntilMs.
   *
   * @param {string} accountId
   * @returns {number}
   */
  getRetryAfter(accountId) {
    const retryAfterTs = this._retryAfterMap.get(accountId)
    const health = this._healthMap.get(accountId)
    const cooldownUntilMs = health?.rateLimitState?.cooldownUntilMs ?? 0

    // Return the longer of the two active cooldowns
    const fromRetryAfter = retryAfterTs ? Math.max(0, (retryAfterTs - Date.now()) / 1000) : 0
    const fromCooldown = cooldownUntilMs > 0 ? Math.max(0, (cooldownUntilMs - Date.now()) / 1000) : 0

    return Math.max(fromRetryAfter, fromCooldown)
  }
}
