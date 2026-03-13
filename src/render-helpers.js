/**
 * @file render-helpers.js
 * @description Rendering utility functions for TUI display and layout.
 *
 * @details
 *   This module provides helper functions for rendering the various UI elements:
 *   - String display width calculation for proper alignment (handles emojis)
 *   - ANSI code stripping for text width estimation
 *   - API key masking for security
 *   - Overlay viewport management (scrolling, clamping, visibility)
 *   - Table viewport calculation
 *   - Sorting with pinned favorites and recommendations
 *   - Proxy status rendering
 *
 *   🎯 Key features:
 *   - Emoji-aware display width calculation without external dependencies
 *   - ANSI color/control sequence stripping
 *   - API key masking (keeps first 4 and last 3 chars visible)
 *   - Overlay viewport helpers (clamp, slice, scroll target visibility)
 *   - Table viewport calculation with scroll indicators
 *   - Sorting with pinned favorites/recommendations at top
 *   - Proxy status formatting
 *
 *   → Functions:
 *   - `stripAnsi`: Remove ANSI color codes to estimate visible text width
 *   - `maskApiKey`: Mask API keys (first 4 + *** + last 3 chars)
 *   - `displayWidth`: Calculate display width of string with emoji support
 *   - `padEndDisplay`: Left-pad using display width for proper alignment
 *   - `tintOverlayLines`: Apply background color to overlay lines
 *   - `clampOverlayOffset`: Clamp scroll offset to valid bounds
 *   - `keepOverlayTargetVisible`: Ensure target line is visible in viewport
 *   - `sliceOverlayLines`: Slice lines to viewport and pad with blanks
 *   - `calculateViewport`: Compute visible slice of model rows
 *   - `sortResultsWithPinnedFavorites`: Sort with pinned items at top
 *   - `renderProxyStatusLine`: Format proxy status for footer display
 *   - `adjustScrollOffset`: Clamp scrollOffset so cursor stays visible
 *
 *   📦 Dependencies:
 *   - chalk: Terminal colors and formatting
 *   - ../src/constants.js: OVERLAY_PANEL_WIDTH, TABLE_FIXED_LINES
 *   - ../src/utils.js: sortResults, getProxyStatusInfo
 *
 *   ⚙️ Configuration:
 *   - OVERLAY_PANEL_WIDTH: Fixed width for overlay panels (from constants.js)
 *   - TABLE_FIXED_LINES: Fixed lines in table (header + footer, from constants.js)
 *
 *   @see {@link ../src/constants.js} Constants for overlay and table layout
 *   @see {@link ../src/utils.js} Core sorting functions
 */

import chalk from 'chalk'
import { OVERLAY_PANEL_WIDTH, TABLE_FIXED_LINES } from './constants.js'
import { sortResults, getProxyStatusInfo } from './utils.js'

// 📖 stripAnsi: Remove ANSI color/control sequences to estimate visible text width before padding.
// 📖 Strips CSI sequences (SGR colors) and OSC sequences (hyperlinks).
export function stripAnsi(input) {
  return String(input).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\][^\x1b]*\x1b\\/g, '')
}

// 📖 maskApiKey: Mask all but first 4 and last 3 characters of an API key.
// 📖 Prevents accidental disclosure of secrets in TUI display.
export function maskApiKey(key) {
  if (!key || key.length < 10) return '***'
  return key.slice(0, 4) + '***' + key.slice(-3)
}

// 📖 displayWidth: Calculate display width of a string in terminal columns.
// 📖 Emojis and other wide characters occupy 2 columns, variation selectors (U+FE0F) are zero-width.
// 📖 This avoids pulling in a full `string-width` dependency for a lightweight CLI tool.
export function displayWidth(str) {
  const plain = stripAnsi(String(str))
  let w = 0
  for (const ch of plain) {
    const cp = ch.codePointAt(0)
    // Zero-width: variation selectors (FE00-FE0F), zero-width joiner/non-joiner, combining marks
    if ((cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0x200D || cp === 0x200C || cp === 0x20E3) continue
    // Wide: CJK, emoji (most above U+1F000), fullwidth forms
    if (
      cp > 0x1F000 ||                              // emoji & symbols
      (cp >= 0x2600 && cp <= 0x27BF) ||             // misc symbols, dingbats
      (cp >= 0x2300 && cp <= 0x23FF) ||             // misc technical (⏳, ⏰, etc.)
      (cp >= 0x2700 && cp <= 0x27BF) ||             // dingbats
      (cp >= 0xFE10 && cp <= 0xFE19) ||             // vertical forms
      (cp >= 0xFF01 && cp <= 0xFF60) ||             // fullwidth ASCII
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||             // fullwidth signs
      (cp >= 0x4E00 && cp <= 0x9FFF) ||             // CJK unified
      (cp >= 0x3000 && cp <= 0x303F) ||             // CJK symbols
      (cp >= 0x2B50 && cp <= 0x2B55) ||             // stars, circles
      cp === 0x2705 || cp === 0x2714 || cp === 0x2716 || // check/cross marks
      cp === 0x26A0                                  // ⚠ warning sign
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

// 📖 padEndDisplay: Left-pad (padEnd equivalent) using display width instead of string length.
// 📖 Ensures columns with emoji text align correctly in the terminal.
export function padEndDisplay(str, width) {
  const dw = displayWidth(str)
  const need = Math.max(0, width - dw)
  return str + ' '.repeat(need)
}

// 📖 tintOverlayLines: Tint overlay lines with a terminal width so the background is clearly visible.
// 📖 Applies bgColor to each line and pads to terminalCols for full-width panel look.
// 📖 If terminalCols is not provided, falls back to OVERLAY_PANEL_WIDTH for compatibility.
export function tintOverlayLines(lines, bgColor, terminalCols = null) {
  const panelWidth = terminalCols || OVERLAY_PANEL_WIDTH
  return lines.map((line) => {
    const text = String(line)
    const visibleWidth = stripAnsi(text).length
    const padding = ' '.repeat(Math.max(0, panelWidth - visibleWidth))
    return bgColor(text + padding)
  })
}

// 📖 clampOverlayOffset: Clamp overlay scroll to valid bounds for the current terminal height.
export function clampOverlayOffset(offset, totalLines, terminalRows) {
  const viewportRows = Math.max(1, terminalRows || 1)
  const maxOffset = Math.max(0, totalLines - viewportRows)
  return Math.max(0, Math.min(maxOffset, offset))
}

// 📖 keepOverlayTargetVisible: Ensure a target line is visible inside overlay viewport (used by Settings cursor).
// 📖 Adjusts offset so the target line is always visible, scrolling if needed.
export function keepOverlayTargetVisible(offset, targetLine, totalLines, terminalRows) {
  const viewportRows = Math.max(1, terminalRows || 1)
  let next = clampOverlayOffset(offset, totalLines, terminalRows)
  if (targetLine < next) next = targetLine
  else if (targetLine >= next + viewportRows) next = targetLine - viewportRows + 1
  return clampOverlayOffset(next, totalLines, terminalRows)
}

// 📖 sliceOverlayLines: Slice overlay lines to terminal viewport and pad with blanks to avoid stale frames.
// 📖 Returns { visible, offset } where visible is the sliced/padded lines array.
export function sliceOverlayLines(lines, offset, terminalRows) {
  const viewportRows = Math.max(1, terminalRows || 1)
  const nextOffset = clampOverlayOffset(offset, lines.length, terminalRows)
  const visible = lines.slice(nextOffset, nextOffset + viewportRows)
  while (visible.length < viewportRows) visible.push('')
  return { visible, offset: nextOffset }
}

// ─── Table viewport calculation ────────────────────────────────────────────────

// 📖 calculateViewport: Computes the visible slice of model rows that fits in the terminal.
// 📖 When scroll indicators are needed, they each consume 1 line from the model budget.
// 📖 Returns { startIdx, endIdx, hasAbove, hasBelow } for rendering.
export function calculateViewport(terminalRows, scrollOffset, totalModels) {
  if (terminalRows <= 0) return { startIdx: 0, endIdx: totalModels, hasAbove: false, hasBelow: false }
  let maxSlots = terminalRows - TABLE_FIXED_LINES
  if (maxSlots < 1) maxSlots = 1
  if (totalModels <= maxSlots) return { startIdx: 0, endIdx: totalModels, hasAbove: false, hasBelow: false }

  const hasAbove = scrollOffset > 0
  const hasBelow = scrollOffset + maxSlots - (hasAbove ? 1 : 0) < totalModels
  // Recalculate with indicator lines accounted for
  const modelSlots = maxSlots - (hasAbove ? 1 : 0) - (hasBelow ? 1 : 0)
  const endIdx = Math.min(scrollOffset + modelSlots, totalModels)
  return { startIdx: scrollOffset, endIdx, hasAbove, hasBelow }
}

// ─── Sorting helpers ───────────────────────────────────────────────────────────

// 📖 sortResultsWithPinnedFavorites: Recommended models are pinned above favorites, favorites above non-favorites.
// 📖 Recommended: sorted by recommendation score (highest first).
// 📖 Favorites: keep insertion order (favoriteRank).
// 📖 Non-favorites: active sort column/direction.
// 📖 Models that are both recommended AND favorite — show in recommended section.
export function sortResultsWithPinnedFavorites(results, sortColumn, sortDirection) {
  const recommendedRows = results
    .filter((r) => r.isRecommended && !r.isFavorite)
    .sort((a, b) => (b.recommendScore || 0) - (a.recommendScore || 0))
  const favoriteRows = results
    .filter((r) => r.isFavorite && !r.isRecommended)
    .sort((a, b) => a.favoriteRank - b.favoriteRank)
  // 📖 Models that are both recommended AND favorite — show in recommended section
  const bothRows = results
    .filter((r) => r.isRecommended && r.isFavorite)
    .sort((a, b) => (b.recommendScore || 0) - (a.recommendScore || 0))
  const nonSpecialRows = sortResults(results.filter((r) => !r.isFavorite && !r.isRecommended), sortColumn, sortDirection)
  return [...bothRows, ...recommendedRows, ...favoriteRows, ...nonSpecialRows]
}

// ─── Proxy status rendering ───────────────────────────────────────────────────

// 📖 renderProxyStatusLine: Maps proxyStartupStatus + active proxy into a chalk-coloured footer line.
// 📖 Always returns a non-empty string (no hidden states) so the footer row is always present.
// 📖 Delegates state classification to the pure getProxyStatusInfo helper (testable in utils.js).
export function renderProxyStatusLine(proxyStartupStatus, proxyInstance, proxyEnabled = false) {
  const activeStatus = typeof proxyInstance?.getStatus === 'function' ? proxyInstance.getStatus() : null
  const hasLiveProxy = Boolean(proxyInstance) && activeStatus?.running !== false
  const info = getProxyStatusInfo(proxyStartupStatus, hasLiveProxy, proxyEnabled)
  const neonGreen = chalk.rgb(57, 255, 20)
  switch (info.state) {
    case 'starting':
      return chalk.dim('  ') + chalk.yellow('⟳ Proxy') + chalk.dim(' starting…')
    case 'running': {
      const resolvedPort = info.port ?? activeStatus?.port ?? activeStatus?.listeningPort ?? null
      const resolvedAccountCount = info.accountCount ?? activeStatus?.accountCount ?? proxyInstance?._accounts?.length ?? null
      const portPart  = resolvedPort ? chalk.dim(` :${resolvedPort}`) : ''
      const acctPart  = resolvedAccountCount != null ? chalk.dim(` · ${resolvedAccountCount} account${resolvedAccountCount === 1 ? '' : 's'}`) : ''
      return chalk.dim('  ') + neonGreen('🔀 Proxy running') + portPart + acctPart
    }
    case 'failed':
      return chalk.dim('  ') + chalk.red('🔀 Proxy Stopped') + chalk.dim(` — ${info.reason}`)
    case 'configured':
      return chalk.dim('  ') + chalk.cyan('🔀 Proxy configured') + chalk.dim(' — OpenCode rotation')
    default:
      return chalk.dim('  ') + chalk.red('🔀 Proxy Stopped')
  }
}

// ─── Scroll offset adjustment ──────────────────────────────────────────────────

// 📖 adjustScrollOffset: Clamp scrollOffset so cursor is always within the visible viewport window.
// 📖 Called after every cursor move, sort change, and terminal resize.
// 📖 Modifies st.scrollOffset in-place, returns undefined.
export function adjustScrollOffset(st) {
  const total = st.visibleSorted ? st.visibleSorted.length : st.results.filter(r => !r.hidden).length
  let maxSlots = st.terminalRows - TABLE_FIXED_LINES
  if (maxSlots < 1) maxSlots = 1
  if (total <= maxSlots) { st.scrollOffset = 0; return }
  // Ensure cursor is not above the visible window
  if (st.cursor < st.scrollOffset) {
    st.scrollOffset = st.cursor
  }
  // Ensure cursor is not below the visible window
  // Account for indicator lines eating into model slots
  const hasAbove = st.scrollOffset > 0
  const tentativeBelow = st.scrollOffset + maxSlots - (hasAbove ? 1 : 0) < total
  const modelSlots = maxSlots - (hasAbove ? 1 : 0) - (tentativeBelow ? 1 : 0)
  if (st.cursor >= st.scrollOffset + modelSlots) {
    st.scrollOffset = st.cursor - modelSlots + 1
  }
  // Final clamp
  // 📖 Keep one extra scroll step when top indicator is visible,
  // 📖 otherwise the last rows become unreachable at the bottom.
  const maxOffset = Math.max(0, total - maxSlots + 1)
  if (st.scrollOffset > maxOffset) st.scrollOffset = maxOffset
  if (st.scrollOffset < 0) st.scrollOffset = 0
}
