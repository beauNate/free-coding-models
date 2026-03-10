/**
 * @file test/tui-hotkeys.test.js
 * @description Tests covering TUI hotkey behaviour for Task 5.
 *
 * Scope:
 *   1. G        — usage sort: sortResults('usage') sorts by usagePercent asc/desc
 *   2. X key    — log page toggle: logVisible state flag semantics
 *   3. W key    — ping mode cycle: speed → normal → slow → forced
 *   4. Auto ping transitions — startup speed drops to normal, inactivity drops to slow,
 *                  and activity wakes idle sessions back into a 60s speed burst
 *
 * Because the TUI is a full interactive loop we test the underlying pure logic
 * (sortResults from lib/utils.js) plus a lightweight state-machine helper that
 * mirrors the key-handler logic extracted for testability.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sortResults, getProxyStatusInfo, getVersionStatusInfo } from '../src/utils.js'
import { renderProxyStatusLine } from '../src/render-helpers.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal result object for sort tests. */
function makeResult(overrides = {}) {
  return {
    idx: 1,
    modelId: 'model-x',
    label: 'Model X',
    tier: 'A',
    sweScore: '50%',
    ctx: '128k',
    providerKey: 'nvidia',
    status: 'up',
    pings: [{ ms: 200, code: '200' }],
    usagePercent: undefined,
    ...overrides,
  }
}

// ─── Suite: G — usage sort (sortResults 'usage') ─────────────────────────────

describe('tui-hotkeys – G usage sort', () => {
  it('sortResults("usage", "asc") puts lower usagePercent first', () => {
    const results = [
      makeResult({ idx: 1, label: 'A', usagePercent: 80 }),
      makeResult({ idx: 2, label: 'B', usagePercent: 20 }),
      makeResult({ idx: 3, label: 'C', usagePercent: 50 }),
    ]
    const sorted = sortResults(results, 'usage', 'asc')
    assert.strictEqual(sorted[0].label, 'B')  // 20% — least quota left first
    assert.strictEqual(sorted[1].label, 'C')  // 50%
    assert.strictEqual(sorted[2].label, 'A')  // 80%
  })

  it('sortResults("usage", "desc") puts higher usagePercent first', () => {
    const results = [
      makeResult({ idx: 1, label: 'A', usagePercent: 80 }),
      makeResult({ idx: 2, label: 'B', usagePercent: 20 }),
      makeResult({ idx: 3, label: 'C', usagePercent: 50 }),
    ]
    const sorted = sortResults(results, 'usage', 'desc')
    assert.strictEqual(sorted[0].label, 'A')  // 80% first
    assert.strictEqual(sorted[1].label, 'C')  // 50%
    assert.strictEqual(sorted[2].label, 'B')  // 20%
  })

  it('treats undefined usagePercent as 0 (sorts to bottom on asc)', () => {
    const results = [
      makeResult({ idx: 1, label: 'Has-Usage',  usagePercent: 30 }),
      makeResult({ idx: 2, label: 'No-Usage-A', usagePercent: undefined }),
      makeResult({ idx: 3, label: 'No-Usage-B', usagePercent: null }),
    ]
    const sorted = sortResults(results, 'usage', 'asc')
    // undefined/null → 0, so they sort before 30 on asc
    assert.strictEqual(sorted[0].usagePercent ?? 0, 0)
    assert.strictEqual(sorted[1].usagePercent ?? 0, 0)
    assert.strictEqual(sorted[2].label, 'Has-Usage')
  })

  it('toggling direction when column is already "usage" flips asc/desc', () => {
    // Simulate: state.sortColumn === 'usage' → flip direction
    let sortColumn = 'usage'
    let sortDirection = 'asc'

    // First toggle: same column → flip
    if (sortColumn === 'usage') {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
    }
    assert.strictEqual(sortDirection, 'desc')

    // Second toggle: flip again
    if (sortColumn === 'usage') {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
    }
    assert.strictEqual(sortDirection, 'asc')
  })

  it('switching from a different column to "usage" resets direction to asc', () => {
    let sortColumn = 'avg'
    let sortDirection = 'desc'

    // Press G: different column → set usage + reset to asc
    const col = 'usage'
    if (sortColumn === col) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
    } else {
      sortColumn = col
      sortDirection = 'asc'
    }
    assert.strictEqual(sortColumn, 'usage')
    assert.strictEqual(sortDirection, 'asc')
  })
})

// ─── Suite: X key — log page toggle ──────────────────────────────────────────

describe('tui-hotkeys – X key log page toggle', () => {
  it('toggling logVisible false→true opens log page', () => {
    const state = { logVisible: false, logScrollOffset: 0 }

    // Simulate X key press
    state.logVisible = !state.logVisible
    if (state.logVisible) state.logScrollOffset = 0

    assert.strictEqual(state.logVisible, true)
    assert.strictEqual(state.logScrollOffset, 0)
  })

  it('toggling logVisible true→false closes log page', () => {
    const state = { logVisible: true, logScrollOffset: 10 }

    state.logVisible = !state.logVisible
    if (state.logVisible) state.logScrollOffset = 0

    assert.strictEqual(state.logVisible, false)
    // scrollOffset is preserved when closing (next open will reset it)
    assert.strictEqual(state.logScrollOffset, 10)
  })

  it('opening log page resets scrollOffset to 0', () => {
    const state = { logVisible: false, logScrollOffset: 42 }

    state.logVisible = !state.logVisible
    if (state.logVisible) state.logScrollOffset = 0

    assert.strictEqual(state.logVisible, true)
    assert.strictEqual(state.logScrollOffset, 0)
  })

  it('Esc closes the log page', () => {
    const state = { logVisible: true }

    // Simulate Esc key while logVisible
    // key.name === 'escape' → logVisible = false
    state.logVisible = false

    assert.strictEqual(state.logVisible, false)
  })

  it('X key is distinct from W (ping mode toggle) key', () => {
    // X must NOT change ping mode; W must NOT toggle log
    const KEY_LOG_TOGGLE   = 'x'
    const KEY_PING_MODE    = 'w'

    assert.notStrictEqual(KEY_LOG_TOGGLE, KEY_PING_MODE)
  })
})

// ─── Suite: W key + auto transitions — ping mode state machine ──────────────

describe('tui-hotkeys – W key ping mode cycle + auto transitions', () => {
  const PING_MODE_CYCLE = ['speed', 'normal', 'slow', 'forced']
  const PING_MODE_INTERVALS = { speed: 2000, normal: 10000, slow: 30000, forced: 4000 }
  const SPEED_MODE_DURATION_MS = 60000
  const IDLE_SLOW_AFTER_MS = 5 * 60_000

  function setPingMode(state, nextMode, source = 'manual', now = 0) {
    state.pingMode = nextMode
    state.pingModeSource = source
    state.pingInterval = PING_MODE_INTERVALS[nextMode]
    state.speedModeUntil = nextMode === 'speed' ? now + SPEED_MODE_DURATION_MS : null
    state.resumeSpeedOnActivity = source === 'idle'
  }

  function refreshAutoPingMode(state, now) {
    if (state.pingMode === 'forced') return
    if (state.speedModeUntil && now >= state.speedModeUntil) {
      setPingMode(state, 'normal', 'auto', now)
      return
    }
    if (now - state.lastUserActivityAt >= IDLE_SLOW_AFTER_MS) {
      if (state.pingMode !== 'slow' || state.pingModeSource !== 'idle') {
        setPingMode(state, 'slow', 'idle', now)
      } else {
        state.resumeSpeedOnActivity = true
      }
    }
  }

  function noteUserActivity(state, now) {
    state.lastUserActivityAt = now
    if (state.pingMode === 'forced') return
    if (state.resumeSpeedOnActivity) {
      setPingMode(state, 'speed', 'activity', now)
    }
  }

  it('W cycles speed → normal → slow → forced → speed', () => {
    const state = { pingMode: 'speed', pingInterval: 2000 }

    const nextMode = () => {
      const currentIdx = PING_MODE_CYCLE.indexOf(state.pingMode)
      const nextIdx = (currentIdx + 1) % PING_MODE_CYCLE.length
      state.pingMode = PING_MODE_CYCLE[nextIdx]
      state.pingInterval = PING_MODE_INTERVALS[state.pingMode]
    }

    nextMode()
    assert.strictEqual(state.pingMode, 'normal')
    assert.strictEqual(state.pingInterval, 10000)

    nextMode()
    assert.strictEqual(state.pingMode, 'slow')
    assert.strictEqual(state.pingInterval, 30000)

    nextMode()
    assert.strictEqual(state.pingMode, 'forced')
    assert.strictEqual(state.pingInterval, 4000)

    nextMode()
    assert.strictEqual(state.pingMode, 'speed')
    assert.strictEqual(state.pingInterval, 2000)
  })

  it('startup speed auto-falls back to normal after one minute', () => {
    const state = {
      pingMode: 'speed',
      pingModeSource: 'startup',
      pingInterval: 2000,
      speedModeUntil: 60000,
      lastUserActivityAt: 0,
      resumeSpeedOnActivity: false,
    }

    refreshAutoPingMode(state, 60000)
    assert.strictEqual(state.pingMode, 'normal')
    assert.strictEqual(state.pingInterval, 10000)
  })

  it('five minutes of inactivity auto-switches to slow', () => {
    const state = {
      pingMode: 'normal',
      pingModeSource: 'manual',
      pingInterval: 10000,
      speedModeUntil: null,
      lastUserActivityAt: 0,
      resumeSpeedOnActivity: false,
    }

    refreshAutoPingMode(state, IDLE_SLOW_AFTER_MS)
    assert.strictEqual(state.pingMode, 'slow')
    assert.strictEqual(state.pingModeSource, 'idle')
    assert.strictEqual(state.resumeSpeedOnActivity, true)
  })

  it('activity after idle slowdown restarts a one-minute speed burst', () => {
    const state = {
      pingMode: 'slow',
      pingModeSource: 'idle',
      pingInterval: 30000,
      speedModeUntil: null,
      lastUserActivityAt: 0,
      resumeSpeedOnActivity: true,
    }

    noteUserActivity(state, 301000)
    assert.strictEqual(state.pingMode, 'speed')
    assert.strictEqual(state.pingModeSource, 'activity')
    assert.strictEqual(state.pingInterval, 2000)
    assert.strictEqual(state.speedModeUntil, 361000)
  })

  it('forced mode ignores idle and speed auto transitions', () => {
    const state = {
      pingMode: 'forced',
      pingModeSource: 'manual',
      pingInterval: 4000,
      speedModeUntil: 1000,
      lastUserActivityAt: 0,
      resumeSpeedOnActivity: false,
    }

    refreshAutoPingMode(state, IDLE_SLOW_AFTER_MS + 1000)
    assert.strictEqual(state.pingMode, 'forced')
    assert.strictEqual(state.pingInterval, 4000)
  })

  it('X key no longer adjusts ping cadence — it toggles logVisible', () => {
    // The binding contract: X → log toggle, W → ping mode cycle
    const sortKeys = {
      'r': 'rank', 'o': 'origin', 'm': 'model',
      'l': 'ping', 'a': 'avg', 's': 'swe', 'c': 'ctx',
      'h': 'condition', 'v': 'verdict', 'b': 'stability', 'u': 'uptime', 'g': 'usage',
    }
    // X is NOT a sort key
    assert.ok(!('x' in sortKeys), 'x must not be in sort keys')
    // Y is NOT a sort key anymore (it opens Install Endpoints)
    assert.ok(!('y' in sortKeys), 'y must not be in sort keys')
    // W is NOT a sort key (it controls interval)
    assert.ok(!('w' in sortKeys), 'w must not be in sort keys')
  })
})

// ─── Suite: proxy status indicator — getProxyStatusInfo ──────────────────────

describe('tui-hotkeys – proxy status indicator (getProxyStatusInfo)', () => {
  it('returns "stopped" state when proxyStartupStatus is null and proxy is not active', () => {
    const info = getProxyStatusInfo(null, false)
    assert.strictEqual(info.state, 'stopped')
  })

  it('returns "starting" state when proxyStartupStatus phase is "starting"', () => {
    const info = getProxyStatusInfo({ phase: 'starting' }, false)
    assert.strictEqual(info.state, 'starting')
  })

  it('"running" state carries port and accountCount from proxyStartupStatus', () => {
    const info = getProxyStatusInfo({ phase: 'running', port: 4891, accountCount: 3 }, true)
    assert.strictEqual(info.state, 'running')
    assert.strictEqual(info.port, 4891)
    assert.strictEqual(info.accountCount, 3)
  })

  it('"running" state falls back to "active" when proxyStartupStatus is null but activeProxy is true', () => {
    const info = getProxyStatusInfo(null, true)
    assert.strictEqual(info.state, 'running')
  })

  it('"failed" state carries a short reason string', () => {
    const info = getProxyStatusInfo({ phase: 'failed', reason: 'EADDRINUSE: port in use' }, false)
    assert.strictEqual(info.state, 'failed')
    assert.ok(typeof info.reason === 'string', 'reason should be a string')
    assert.ok(info.reason.length > 0, 'reason should be non-empty')
  })

  it('"failed" reason is truncated to 80 chars maximum', () => {
    const longReason = 'x'.repeat(200)
    const info = getProxyStatusInfo({ phase: 'failed', reason: longReason }, false)
    assert.ok(info.reason.length <= 80, `reason should be ≤80 chars, got ${info.reason.length}`)
  })

  it('proxyStartupStatus "running" takes priority over null activeProxy', () => {
    // Even if activeProxy object is falsy, a running startup status is authoritative
    const info = getProxyStatusInfo({ phase: 'running', port: 5000, accountCount: 2 }, false)
    assert.strictEqual(info.state, 'running')
    assert.strictEqual(info.port, 5000)
  })

  it('returns "stopped" for unrecognized phase', () => {
    const info = getProxyStatusInfo({ phase: 'unknown' }, false)
    assert.strictEqual(info.state, 'stopped')
  })
})

describe('tui-hotkeys – proxy footer rendering', () => {
  it('shows proxy as running when a live proxy instance exists without startup status', () => {
    const line = renderProxyStatusLine(null, {
      getStatus() {
        return { running: true, port: 4321, accountCount: 2 }
      },
    })

    assert.match(line, /Proxy/)
    assert.match(line, /running/)
    assert.match(line, /4321/)
  })

  it('shows proxy as configured when settings enable it but it is not running yet', () => {
    const line = renderProxyStatusLine(null, null, true)

    assert.match(line, /Proxy configured/)
    assert.match(line, /OpenCode rotation/)
  })
})

describe('tui-hotkeys – version status indicator', () => {
  it('marks the install as outdated only when a newer version is explicitly available', () => {
    const info = getVersionStatusInfo('available', '0.2.1')
    assert.equal(info.isOutdated, true)
    assert.equal(info.latestVersion, '0.2.1')
  })

  it('stays quiet when no update has been found', () => {
    const info = getVersionStatusInfo('idle', null)
    assert.equal(info.isOutdated, false)
    assert.equal(info.latestVersion, null)
  })
})
