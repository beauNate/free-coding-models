import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AccountManager } from '../lib/account-manager.js'
import { getQuotaTelemetry, isKnownQuotaTelemetry } from '../lib/quota-capabilities.js'

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `acct-${i}`,
    providerKey: `provider-${i}`,
    apiKey: `key-${i}`,
    modelId: `model-${i}`,
    url: `https://api.provider-${i}.com/v1`,
  }))
}

describe('AccountManager', () => {
  it('selectAccount returns an account via P2C', () => {
    const am = new AccountManager(makeAccounts(3))
    const acct = am.selectAccount({})
    assert.ok(acct)
    assert.ok(acct.id.startsWith('acct-'))
  })

  it('skips accounts with open circuit breaker', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts, { circuitBreakerThreshold: 2 })
    // Trip circuit breaker on acct-0
    am.recordFailure('acct-0', { type: 'SERVER_ERROR', shouldRetry: true, skipAccount: false, retryAfterSec: null })
    am.recordFailure('acct-0', { type: 'SERVER_ERROR', shouldRetry: true, skipAccount: false, retryAfterSec: null })
    // Should always select acct-1
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(am.selectAccount({}).id, 'acct-1')
    }
  })

  it('updates quota from rate-limit headers', () => {
    const am = new AccountManager(makeAccounts(1))
    const changed = am.updateQuota('acct-0', { 'x-ratelimit-remaining': '20', 'x-ratelimit-limit': '100' })
    assert.strictEqual(changed, true)
    const h = am.getHealth('acct-0')
    assert.strictEqual(h.quotaPercent, 20) // 20% remaining
  })

  it('updates quota from -requests header variants', () => {
    const am = new AccountManager(makeAccounts(1))
    const changed = am.updateQuota('acct-0', {
      'x-ratelimit-remaining-requests': '35',
      'x-ratelimit-limit-requests': '100',
    })
    assert.strictEqual(changed, true)
    const h = am.getHealth('acct-0')
    assert.strictEqual(h.quotaPercent, 35)
  })

  it('returns false when quota headers are missing', () => {
    const am = new AccountManager(makeAccounts(1))
    const changed = am.updateQuota('acct-0', {})
    assert.strictEqual(changed, false)
    const h = am.getHealth('acct-0')
    // quota unknown — null, not 100 (no best-case assumption)
    assert.strictEqual(h.quotaPercent, null)
  })

  it('deprioritizes accounts at 80% quota used', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts)
    // acct-0: 15% remaining (85% used) — should be deprioritized
    am.updateQuota('acct-0', { 'x-ratelimit-remaining': '15', 'x-ratelimit-limit': '100' })
    // acct-1: 80% remaining (20% used) — healthy
    am.updateQuota('acct-1', { 'x-ratelimit-remaining': '80', 'x-ratelimit-limit': '100' })
    // Check health scores
    const h0 = am.getHealth('acct-0')
    const h1 = am.getHealth('acct-1')
    assert.ok(h1.score > h0.score, `Healthy account (${h1.score}) should score higher than quota-depleted (${h0.score})`)
  })

  it('skips account when quota >= 95% used', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts)
    am.updateQuota('acct-0', { 'x-ratelimit-remaining': '3', 'x-ratelimit-limit': '100' })
    // acct-0 at 97% used, should be effectively skipped
    for (let i = 0; i < 20; i++) {
      const selected = am.selectAccount({})
      assert.strictEqual(selected.id, 'acct-1', 'Should not select nearly-exhausted account')
    }
  })

  it('returns null when all accounts exhausted', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts, { circuitBreakerThreshold: 1 })
    am.recordFailure('acct-0', { type: 'AUTH_ERROR', shouldRetry: false, skipAccount: true, retryAfterSec: null })
    am.recordFailure('acct-1', { type: 'AUTH_ERROR', shouldRetry: false, skipAccount: true, retryAfterSec: null })
    assert.strictEqual(am.selectAccount({}), null)
  })

  it('sticky session returns same account for same fingerprint', () => {
    const am = new AccountManager(makeAccounts(5))
    const first = am.selectAccount({ sessionFingerprint: 'fp-abc' })
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(
        am.selectAccount({ sessionFingerprint: 'fp-abc' }).id,
        first.id,
        'Same fingerprint should return same account'
      )
    }
  })

  it('sticky session falls back when sticky account unhealthy', () => {
    const accounts = makeAccounts(3)
    const am = new AccountManager(accounts, { circuitBreakerThreshold: 2 })
    const first = am.selectAccount({ sessionFingerprint: 'fp-xyz' })
    // Kill the sticky account
    am.recordFailure(first.id, { type: 'SERVER_ERROR', shouldRetry: true, skipAccount: false, retryAfterSec: null })
    am.recordFailure(first.id, { type: 'SERVER_ERROR', shouldRetry: true, skipAccount: false, retryAfterSec: null })
    // Should get a different account
    const fallback = am.selectAccount({ sessionFingerprint: 'fp-xyz' })
    assert.ok(fallback)
    assert.notStrictEqual(fallback.id, first.id)
  })

  it('sticky session falls back when sticky account has low health score due to high latency', () => {
    // Use 3 accounts; make the sticky one very slow (high latency → low score)
    // but NOT circuit-broken (circuit breaker stays closed).
    const accounts = makeAccounts(3)
    const am = new AccountManager(accounts, { circuitBreakerThreshold: 10 }) // high threshold — CB won't open
    const first = am.selectAccount({ sessionFingerprint: 'fp-slow' })
    // Record many successes with very high latency (4800ms avg ≈ latencyScore ≈ 0.04)
    // Score ≈ 0.4*1.0 + 0.3*0.04 + 0.3*0.5 = 0.4 + 0.012 + 0.15 = 0.562 → below 0.65 threshold
    for (let i = 0; i < 10; i++) {
      am.recordSuccess(first.id, 4800)
    }
    // Verify the sticky account's score is actually below 0.65
    const score = am.getHealth(first.id).score
    assert.ok(score < 0.65, `Expected score < 0.65 but got ${score}`)
    // Now sticky should be broken due to low score — should get a different account
    const fallback = am.selectAccount({ sessionFingerprint: 'fp-slow' })
    assert.ok(fallback, 'Should return a fallback account')
    assert.notStrictEqual(fallback.id, first.id, 'Fallback should not be the slow sticky account')
  })

  it('LRU evicts oldest sticky entries', () => {
    const am = new AccountManager(makeAccounts(10), { maxStickySessions: 5 })
    // Fill LRU with 5 entries
    for (let i = 0; i < 5; i++) {
      am.selectAccount({ sessionFingerprint: `fp-${i}` })
    }
    // Add one more, should evict fp-0
    am.selectAccount({ sessionFingerprint: 'fp-new' })
    // fp-0 should no longer be sticky (might get different account)
    const before = am.selectAccount({ sessionFingerprint: 'fp-0' })
    // Just verify no crash and it returns something
    assert.ok(before)
  })

  it('respects retryAfterSec cooldown', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts)
    am.recordFailure('acct-0', { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: 3600 })
    // acct-0 should be skipped due to retry-after
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(am.selectAccount({}).id, 'acct-1')
    }
  })

  it('recordSuccess improves health', () => {
    const am = new AccountManager(makeAccounts(1))
    am.recordFailure('acct-0', { type: 'SERVER_ERROR', shouldRetry: true, skipAccount: false, retryAfterSec: null })
    const before = am.getHealth('acct-0').score
    am.recordSuccess('acct-0')
    const after = am.getHealth('acct-0').score
    assert.ok(after > before, 'Health should improve after success')
  })

  it('getAllHealth returns snapshot keyed by account id with score and quotaPercent', () => {
    const accounts = makeAccounts(3)
    const am = new AccountManager(accounts)
    am.updateQuota('acct-0', { 'x-ratelimit-remaining': '50', 'x-ratelimit-limit': '100' })
    am.recordSuccess('acct-1', 200)

    const health = am.getAllHealth()

    assert.ok(typeof health === 'object' && health !== null)
    assert.ok('acct-0' in health, 'snapshot should include acct-0')
    assert.ok('acct-1' in health, 'snapshot should include acct-1')
    assert.ok('acct-2' in health, 'snapshot should include acct-2')

    assert.strictEqual(typeof health['acct-0'].score, 'number')
    assert.strictEqual(health['acct-0'].quotaPercent, 50)

    assert.strictEqual(typeof health['acct-1'].score, 'number')
    // acct-1 has no quota headers — unknown quota signal, quotaPercent is null
    assert.strictEqual(health['acct-1'].quotaPercent, null)
  })

  it('getAllHealth includes providerKey and modelId identity fields', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts)

    const health = am.getAllHealth()

    assert.strictEqual(health['acct-0'].providerKey, 'provider-0')
    assert.strictEqual(health['acct-0'].modelId, 'model-0')
    assert.strictEqual(health['acct-1'].providerKey, 'provider-1')
    assert.strictEqual(health['acct-1'].modelId, 'model-1')
  })

  it('getAllHealth returns empty object when no accounts', () => {
    const am = new AccountManager([])
    const health = am.getAllHealth()
    assert.deepStrictEqual(health, {})
  })

  // ─── quotaSignal: known / inferred / unknown ──────────────────────────────

  it('new account has quotaSignal=unknown and nullable quotaPercent', () => {
    const am = new AccountManager(makeAccounts(1))
    const h = am.getHealth('acct-0')
    assert.strictEqual(h.quotaSignal, 'unknown')
    assert.strictEqual(h.quotaPercent, null)
  })

  it('updateQuota sets quotaSignal=known', () => {
    const am = new AccountManager(makeAccounts(1))
    am.updateQuota('acct-0', { 'x-ratelimit-remaining': '50', 'x-ratelimit-limit': '100' })
    const h = am.getHealth('acct-0')
    assert.strictEqual(h.quotaSignal, 'known')
    assert.strictEqual(h.quotaPercent, 50)
  })

  it('unknown quota does not score as best (neutral score, no quota bonus)', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts)
    // acct-0: unknown quota (fresh)
    // acct-1: explicitly known 100% quota
    am.updateQuota('acct-1', { 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '100' })
    const h0 = am.getHealth('acct-0')
    const h1 = am.getHealth('acct-1')
    // unknown should NOT score higher than a known 100% account
    // (in old code, unknown defaulted to 100 which was "best case")
    // we just verify unknown != artificially inflated: h0.score <= h1.score
    assert.ok(h0.score <= h1.score, `unknown quota score (${h0.score}) should not exceed known-full quota score (${h1.score})`)
  })

  it('unknown quota account is still available for selection (not skipped)', () => {
    const accounts = makeAccounts(1)
    const am = new AccountManager(accounts)
    // Fresh account with unknown quota should still be selectable
    const selected = am.selectAccount({})
    assert.ok(selected, 'Account with unknown quota should still be selectable')
    assert.strictEqual(selected.id, 'acct-0')
  })

  it('returns false when quota headers are missing — quotaSignal stays unknown', () => {
    const am = new AccountManager(makeAccounts(1))
    const changed = am.updateQuota('acct-0', {})
    assert.strictEqual(changed, false)
    const h = am.getHealth('acct-0')
    assert.strictEqual(h.quotaSignal, 'unknown')
    assert.strictEqual(h.quotaPercent, null)
  })

  it('getAllHealth includes quotaSignal field', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts)
    am.updateQuota('acct-0', { 'x-ratelimit-remaining': '80', 'x-ratelimit-limit': '100' })

    const health = am.getAllHealth()
    assert.strictEqual(health['acct-0'].quotaSignal, 'known')
    assert.strictEqual(health['acct-1'].quotaSignal, 'unknown')
  })

  it('requestedModel filters selection to matching proxyModelId', () => {
    const accounts = [
      { id: 'a1', providerKey: 'p1', apiKey: 'k1', modelId: 'upstream-m1', proxyModelId: 'model-a', url: 'https://a' },
      { id: 'a2', providerKey: 'p2', apiKey: 'k2', modelId: 'upstream-m2', proxyModelId: 'model-b', url: 'https://b' },
    ]
    const am = new AccountManager(accounts)

    for (let i = 0; i < 8; i++) {
      const selected = am.selectAccount({ requestedModel: 'model-a' })
      assert.ok(selected)
      assert.strictEqual(selected.proxyModelId, 'model-a')
    }
  })

  it('requestedModel returns null when no mapping exists (strict isolation)', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts)
    // No account has proxyModelId or modelId matching 'non-existent-model',
    // so selectAccount returns null (does NOT fall back to the full pool).
    // This prevents silently serving the wrong model.
    const selected = am.selectAccount({ requestedModel: 'non-existent-model' })
    assert.strictEqual(selected, null)
  })
})

// ─── Task 2: Temporary exhaustion + deterministic recovery ──────────────────

describe('AccountManager — temporary exhaustion (unknown telemetry)', () => {
  // Helper: make accounts with explicit providerKey for telemetry classification
  function makeUnknownAccounts(n) {
    return Array.from({ length: n }, (_, i) => ({
      id: `u-acct-${i}`,
      providerKey: 'huggingface', // unknown telemetry
      apiKey: `key-${i}`,
      modelId: `model-${i}`,
      url: `https://api.unknown-${i}.com/v1`,
    }))
  }

  function makeKnownAccounts(n) {
    return Array.from({ length: n }, (_, i) => ({
      id: `k-acct-${i}`,
      providerKey: 'groq', // header telemetry (known)
      apiKey: `key-${i}`,
      modelId: `model-${i}`,
      url: `https://api.groq-${i}.com/v1`,
    }))
  }

  it('single 429 does NOT permanently disable unknown telemetry account', () => {
    const am = new AccountManager(makeUnknownAccounts(1))
    am.recordFailure('u-acct-0', {
      type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: null,
      rateLimitConfidence: 'generic_rate_limit',
    }, { providerKey: 'huggingface' })
    const h = am.getHealth('u-acct-0')
    assert.strictEqual(h.disabled, false, 'Single 429 must not permanently disable')
  })

  it('quota_exhaustion_likely 429 does NOT permanently disable unknown telemetry account', () => {
    const am = new AccountManager(makeUnknownAccounts(1))
    am.recordFailure('u-acct-0', {
      type: 'QUOTA_EXHAUSTED', shouldRetry: true, skipAccount: true, retryAfterSec: null,
      rateLimitConfidence: 'quota_exhaustion_likely',
    }, { providerKey: 'huggingface' })
    const h = am.getHealth('u-acct-0')
    assert.strictEqual(h.disabled, false, 'quota-like 429 must not permanently disable unknown telemetry account')
  })

  it('3 consecutive 429s in rolling window triggers 15m cooldown', () => {
    const am = new AccountManager(makeUnknownAccounts(2))
    const err429 = { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: null, rateLimitConfidence: 'generic_rate_limit' }
    const ctx = { providerKey: 'huggingface' }
    am.recordFailure('u-acct-0', err429, ctx)
    am.recordFailure('u-acct-0', err429, ctx)
    am.recordFailure('u-acct-0', err429, ctx)
    // acct-0 should now be in cooldown, not available
    for (let i = 0; i < 10; i++) {
      const selected = am.selectAccount({})
      assert.ok(selected, 'should have u-acct-1 available')
      assert.strictEqual(selected.id, 'u-acct-1', 'exhausted account should be skipped')
    }
    // Check cooldown is set (roughly 15 minutes)
    const ra = am.getRetryAfter('u-acct-0')
    assert.ok(ra > 0, 'cooldown should be set')
    assert.ok(ra <= 900 + 5 && ra >= 900 - 5, `cooldown should be ~15m (900s), got ${ra}`)
  })

  it('rolling window resets 429 count after 10 minutes', () => {
    const am = new AccountManager(makeUnknownAccounts(1))
    const err429 = { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: null, rateLimitConfidence: 'generic_rate_limit' }
    const ctx = { providerKey: 'huggingface' }
    // 2 failures, then simulate window expiry by manipulating state
    am.recordFailure('u-acct-0', err429, ctx)
    am.recordFailure('u-acct-0', err429, ctx)
    // Manually expire window
    const health = am._healthMap.get('u-acct-0')
    health.rateLimitState.windowStartMs = Date.now() - 11 * 60 * 1000
    // Third 429 after window — should reset counter to 1, not trigger cooldown
    am.recordFailure('u-acct-0', err429, ctx)
    // Should NOT be in cooldown (only 1 in new window)
    const selected = am.selectAccount({})
    assert.ok(selected, 'Account should be available after window reset')
    assert.strictEqual(selected.id, 'u-acct-0')
  })

  it('cooldown escalates on repeated exhaustion: 15m → 30m → 60m', () => {
    const am = new AccountManager(makeUnknownAccounts(1))
    const err429 = { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: null, rateLimitConfidence: 'generic_rate_limit' }
    const ctx = { providerKey: 'huggingface' }

    // First exhaustion (3 failures)
    for (let i = 0; i < 3; i++) am.recordFailure('u-acct-0', err429, ctx)
    const cd1 = am.getRetryAfter('u-acct-0')
    assert.ok(cd1 > 890 && cd1 <= 905, `First cooldown should be ~15m, got ${cd1}`)

    // Simulate cooldown expiry — fast-forward cooldown state
    const h = am._healthMap.get('u-acct-0')
    h.rateLimitState.cooldownUntilMs = Date.now() - 1

    // Probe (selectAccount should allow one probe), force probe failure (simulate probe 429)
    const selected = am.selectAccount({})
    assert.ok(selected, 'should allow one probe after cooldown expires')
    assert.ok(h.rateLimitState.probeInFlight, 'probe should be marked in-flight')

    // Probe fails with 429 — escalate cooldown
    am.recordFailure('u-acct-0', err429, ctx)
    const cd2 = am.getRetryAfter('u-acct-0')
    assert.ok(!h.rateLimitState.probeInFlight, 'probe lock should be cleared after failure')
    assert.ok(cd2 > 1790 && cd2 <= 1810, `Second cooldown should be ~30m, got ${cd2}`)

    // Second probe expiry + failure → 60m
    h.rateLimitState.cooldownUntilMs = Date.now() - 1
    am.selectAccount({}) // arms probe
    am.recordFailure('u-acct-0', err429, ctx)
    const cd3 = am.getRetryAfter('u-acct-0')
    assert.ok(cd3 > 3590 && cd3 <= 3610, `Third cooldown should be ~60m, got ${cd3}`)
  })

  it('cooldown caps at 6h (21600s)', () => {
    const am = new AccountManager(makeUnknownAccounts(1))
    const err429 = { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: null, rateLimitConfidence: 'generic_rate_limit' }
    const ctx = { providerKey: 'huggingface' }
    // Trigger first cooldown
    for (let i = 0; i < 3; i++) am.recordFailure('u-acct-0', err429, ctx)
    const h = am._healthMap.get('u-acct-0')
    // Directly set cooldownLevel high
    h.rateLimitState.cooldownLevel = 8 // would be 15 * 2^8 = 3840m > 6h
    h.rateLimitState.cooldownUntilMs = Date.now() - 1
    am.selectAccount({}) // arm probe
    am.recordFailure('u-acct-0', err429, ctx)
    const cd = am.getRetryAfter('u-acct-0')
    assert.ok(cd <= 21600 + 5, `Cooldown should be capped at 6h (21600s), got ${cd}`)
    assert.ok(cd >= 21590, `Cooldown should be at max 6h, got ${cd}`)
  })

  it('successful probe clears cooldown and resets 429 counters', () => {
    const am = new AccountManager(makeUnknownAccounts(1))
    const err429 = { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: null, rateLimitConfidence: 'generic_rate_limit' }
    const ctx = { providerKey: 'huggingface' }
    // Exhaust
    for (let i = 0; i < 3; i++) am.recordFailure('u-acct-0', err429, ctx)
    const h = am._healthMap.get('u-acct-0')
    h.rateLimitState.cooldownUntilMs = Date.now() - 1
    // Arm probe
    am.selectAccount({})
    assert.ok(h.rateLimitState.probeInFlight, 'probe should be in-flight')
    // Successful probe
    am.recordSuccess('u-acct-0', 100)
    assert.strictEqual(h.rateLimitState.cooldownUntilMs, 0, 'cooldown should be cleared on success')
    assert.strictEqual(h.rateLimitState.consecutive429, 0, '429 counter should reset on success')
    assert.strictEqual(h.rateLimitState.probeInFlight, false, 'probe lock should clear on success')
    // Account should be selectable again
    const selected = am.selectAccount({})
    assert.ok(selected, 'Account should be available after successful probe')
    assert.strictEqual(selected.id, 'u-acct-0')
  })

  it('concurrent probes blocked — only one probe allowed when cooldown expires', () => {
    const am = new AccountManager(makeUnknownAccounts(2))
    const err429 = { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: null, rateLimitConfidence: 'generic_rate_limit' }
    const ctx = { providerKey: 'huggingface' }
    // Exhaust u-acct-0
    for (let i = 0; i < 3; i++) am.recordFailure('u-acct-0', err429, ctx)
    const h = am._healthMap.get('u-acct-0')
    h.rateLimitState.cooldownUntilMs = Date.now() - 1
    // First selectAccount should set probeInFlight and return u-acct-0 or u-acct-1
    // We need to check that once probe is in-flight, u-acct-0 is blocked for further selects
    const first = am.selectAccount({})
    // Now probeInFlight is set on u-acct-0 if it was selected
    // Force a direct check: set probeInFlight and verify it's blocked
    h.rateLimitState.probeInFlight = true
    h.rateLimitState.cooldownUntilMs = Date.now() - 1 // still expired but probe ongoing
    // Further selects should NOT pick u-acct-0 since probe is in-flight
    for (let i = 0; i < 5; i++) {
      const s = am.selectAccount({})
      assert.ok(s, 'should return u-acct-1')
      assert.strictEqual(s.id, 'u-acct-1', 'should not probe again while probe in-flight')
    }
  })

  it('known telemetry 429 uses retry-after header', () => {
    const am = new AccountManager(makeKnownAccounts(2))
    const err429 = { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: 300, rateLimitConfidence: 'generic_rate_limit' }
    const ctx = { providerKey: 'groq' }
    am.recordFailure('k-acct-0', err429, ctx)
    const ra = am.getRetryAfter('k-acct-0')
    // Should use the retry-after value (300s = 5m)
    assert.ok(ra > 295 && ra <= 305, `Known telemetry should use retry-after=300, got ${ra}`)
  })

  it('known telemetry 429 without retry-after uses 5m fallback cooldown', () => {
    const am = new AccountManager(makeKnownAccounts(2))
    const err429 = { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: null, rateLimitConfidence: 'generic_rate_limit' }
    const ctx = { providerKey: 'groq' }
    am.recordFailure('k-acct-0', err429, ctx)
    const ra = am.getRetryAfter('k-acct-0')
    // Should use 5m fallback (300s)
    assert.ok(ra > 295 && ra <= 305, `Known telemetry without retry-after should use 5m fallback, got ${ra}`)
  })

  it('known telemetry 429 does NOT count toward unknown exhaustion threshold', () => {
    const am = new AccountManager(makeKnownAccounts(1))
    const err429 = { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: 60, rateLimitConfidence: 'generic_rate_limit' }
    const ctx = { providerKey: 'groq' }
    // 5 consecutive 429s — should use retry-after, not unknown threshold
    for (let i = 0; i < 5; i++) am.recordFailure('k-acct-0', err429, ctx)
    const h = am._healthMap.get('k-acct-0')
    assert.strictEqual(h.rateLimitState.consecutive429, 0, 'Known telemetry should not count toward unknown threshold')
  })

  it('auth 401 permanently disables regardless of telemetry type', () => {
    const am = new AccountManager(makeUnknownAccounts(1))
    am.recordFailure('u-acct-0', {
      type: 'AUTH_ERROR', shouldRetry: false, skipAccount: true, retryAfterSec: null,
    }, { providerKey: 'huggingface' })
    const h = am.getHealth('u-acct-0')
    assert.strictEqual(h.disabled, true, '401 should permanently disable account')
    assert.strictEqual(am.selectAccount({}), null)
  })

  it('auth 403 permanently disables regardless of telemetry type', () => {
    const am = new AccountManager(makeKnownAccounts(1))
    am.recordFailure('k-acct-0', {
      type: 'AUTH_ERROR', shouldRetry: false, skipAccount: true, retryAfterSec: null,
    }, { providerKey: 'groq' })
    const h = am.getHealth('k-acct-0')
    assert.strictEqual(h.disabled, true, '403 should permanently disable account')
  })

  it('MODEL_NOT_FOUND (skipAccount=true, non-429) does NOT permanently disable account', () => {
    // Only AUTH_ERROR should permanently disable. MODEL_NOT_FOUND has skipAccount=true
    // but is NOT an auth failure — the account may work for other models.
    const am = new AccountManager(makeUnknownAccounts(2))
    am.recordFailure('u-acct-0', {
      type: 'MODEL_NOT_FOUND', shouldRetry: true, skipAccount: true, retryAfterSec: null,
    }, { providerKey: 'huggingface' })
    const h = am.getHealth('u-acct-0')
    assert.strictEqual(h.disabled, false, 'MODEL_NOT_FOUND must NOT permanently disable account')
  })

  it('SERVER_ERROR (skipAccount=false) does NOT permanently disable account', () => {
    const am = new AccountManager(makeUnknownAccounts(1))
    am.recordFailure('u-acct-0', {
      type: 'SERVER_ERROR', shouldRetry: true, skipAccount: false, retryAfterSec: null,
    }, { providerKey: 'huggingface' })
    const h = am.getHealth('u-acct-0')
    assert.strictEqual(h.disabled, false, 'SERVER_ERROR must not permanently disable account')
  })

  it('probeInFlight is cleared when probe fails with non-429 error (500/network)', () => {
    // Scenario: account entered cooldown, cooldown expired, probe was sent,
    // but the probe got a 500 (not 429). probeInFlight must be cleared so
    // the account is not permanently blocked.
    const am = new AccountManager(makeUnknownAccounts(2))
    const err429 = { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: null, rateLimitConfidence: 'generic_rate_limit' }
    const ctx = { providerKey: 'huggingface' }
    // Exhaust the account into cooldown
    for (let i = 0; i < 3; i++) am.recordFailure('u-acct-0', err429, ctx)
    // Fast-forward cooldown
    const h = am._healthMap.get('u-acct-0')
    h.rateLimitState.cooldownUntilMs = Date.now() - 1
    // Arm probe
    am.selectAccount({})
    assert.strictEqual(h.rateLimitState.probeInFlight, true, 'probe should be armed')
    // Probe fails with a 500 (non-429)
    am.recordFailure('u-acct-0', {
      type: 'SERVER_ERROR', shouldRetry: true, skipAccount: false, retryAfterSec: null,
    }, { providerKey: 'huggingface' })
    // probeInFlight must be cleared so account can be re-probed after next cooldown
    assert.strictEqual(h.rateLimitState.probeInFlight, false, 'probeInFlight must be cleared after non-429 probe failure')
  })
})

describe('quota-capabilities', () => {
  it('getQuotaTelemetry returns object with telemetryType for known providers', () => {
    const groq = getQuotaTelemetry('groq')
    assert.ok(groq, 'should return capability info for groq')
    assert.ok(['header', 'endpoint', 'unknown'].includes(groq.telemetryType), 'telemetryType must be header|endpoint|unknown')
  })

  it('getQuotaTelemetry returns unknown type for unrecognized provider', () => {
    const cap = getQuotaTelemetry('nonexistent-provider-xyz')
    assert.strictEqual(cap.telemetryType, 'unknown')
  })

  it('isKnownQuotaTelemetry returns true for header-based providers', () => {
    // groq sends x-ratelimit-remaining headers
    const result = isKnownQuotaTelemetry('groq')
    assert.strictEqual(result, true)
  })

  it('isKnownQuotaTelemetry returns false for unknown providers', () => {
    const result = isKnownQuotaTelemetry('nonexistent-provider-xyz')
    assert.strictEqual(result, false)
  })

  it('openrouter has endpoint support flag', () => {
    const cap = getQuotaTelemetry('openrouter')
    assert.ok(cap, 'openrouter should have capability info')
    assert.strictEqual(typeof cap.supportsEndpoint, 'boolean')
  })
})
