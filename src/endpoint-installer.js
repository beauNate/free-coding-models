/**
 * @file src/endpoint-installer.js
 * @description Install and refresh FCM-managed provider catalogs inside external tool configs.
 *
 * @details
 *   📖 This module powers the `Y` hotkey flow in the TUI.
 *   It lets users pick one configured provider, choose a target tool, then install either:
 *   - the full provider catalog (`all` models), or
 *   - a curated subset of specific models (`selected`)
 *
 *   📖 The implementation is intentionally conservative:
 *   - it writes managed provider entries under an `fcm-*` namespace to avoid clobbering user-defined providers
 *   - it merges into existing config files instead of replacing them
 *   - it records successful installs in `~/.free-coding-models.json` so catalogs can be refreshed automatically later
 *
 *   📖 Tool-specific notes:
 *   - OpenCode CLI and OpenCode Desktop share the same `opencode.json`
 *   - Crush gets a managed provider block in `crush.json`
 *   - Goose gets a declarative custom provider JSON + a matching secret in `secrets.yaml`
 *   - OpenClaw gets a managed `models.providers` entry plus matching allowlist rows
 *
 * @functions
 *   → `getConfiguredInstallableProviders` — list configured providers that support direct endpoint installs
 *   → `getProviderCatalogModels` — return the current FCM catalog for one provider
 *   → `getInstallTargetModes` — stable install target list exposed in the TUI
 *   → `installProviderEndpoints` — install one provider catalog into one external tool
 *   → `refreshInstalledEndpoints` — replay tracked installs to keep catalogs in sync on future launches
 *
 * @exports
 *   getConfiguredInstallableProviders, getProviderCatalogModels, getInstallTargetModes,
 *   installProviderEndpoints, refreshInstalledEndpoints
 *
 * @see ../sources.js
 * @see src/config.js
 * @see src/tool-metadata.js
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MODELS, sources } from '../sources.js'
import { getApiKey, saveConfig } from './config.js'
import { ENV_VAR_NAMES, PROVIDER_METADATA } from './provider-metadata.js'
import { getToolMeta } from './tool-metadata.js'

const DIRECT_INSTALL_UNSUPPORTED_PROVIDERS = new Set(['replicate', 'zai'])
const INSTALL_TARGET_MODES = ['opencode', 'opencode-desktop', 'openclaw', 'crush', 'goose']

function getDefaultPaths() {
  const home = homedir()
  return {
    opencodeConfigPath: join(home, '.config', 'opencode', 'opencode.json'),
    openclawConfigPath: join(home, '.openclaw', 'openclaw.json'),
    crushConfigPath: join(home, '.config', 'crush', 'crush.json'),
    gooseProvidersDir: join(home, '.config', 'goose', 'custom_providers'),
    gooseSecretsPath: join(home, '.config', 'goose', 'secrets.yaml'),
  }
}

function ensureDirFor(filePath) {
  mkdirSync(dirname(filePath), { recursive: true })
}

function backupIfExists(filePath) {
  if (!existsSync(filePath)) return null
  const backupPath = `${filePath}.backup-${Date.now()}`
  copyFileSync(filePath, backupPath)
  return backupPath
}

function readJson(filePath, fallback = {}) {
  if (!existsSync(filePath)) return fallback
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(filePath, value, { backup = true } = {}) {
  ensureDirFor(filePath)
  const backupPath = backup ? backupIfExists(filePath) : null
  writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
  return backupPath
}

function readSimpleYamlMap(filePath) {
  if (!existsSync(filePath)) return {}
  const out = {}
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1)
    }
    out[match[1]] = value
  }
  return out
}

function writeSimpleYamlMap(filePath, entries) {
  ensureDirFor(filePath)
  const backupPath = backupIfExists(filePath)
  const lines = Object.keys(entries)
    .sort()
    .map((key) => `${key}: ${JSON.stringify(String(entries[key] ?? ''))}`)
  writeFileSync(filePath, lines.join('\n') + '\n')
  return backupPath
}

function canonicalizeToolMode(toolMode) {
  return toolMode === 'opencode-desktop' ? 'opencode' : toolMode
}

function getManagedProviderId(providerKey) {
  return `fcm-${providerKey}`
}

function getProviderLabel(providerKey) {
  return PROVIDER_METADATA[providerKey]?.label || sources[providerKey]?.name || providerKey
}

function getManagedProviderLabel(providerKey) {
  return `FCM ${getProviderLabel(providerKey)}`
}

function parseContextWindow(ctx) {
  if (typeof ctx !== 'string' || !ctx.trim()) return 128000
  const trimmed = ctx.trim().toLowerCase()
  const multiplier = trimmed.endsWith('m') ? 1_000_000 : trimmed.endsWith('k') ? 1_000 : 1
  const numeric = Number.parseFloat(trimmed.replace(/[mk]$/i, ''))
  if (!Number.isFinite(numeric) || numeric <= 0) return 128000
  return Math.round(numeric * multiplier)
}

function getDefaultMaxTokens(contextWindow) {
  return Math.max(4096, Math.min(contextWindow, 32768))
}

function resolveProviderBaseUrl(providerKey) {
  const providerUrl = sources[providerKey]?.url
  if (!providerUrl) return null

  if (providerKey === 'cloudflare') {
    const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()
    if (!accountId) return null
    return providerUrl.replace('{account_id}', accountId).replace(/\/chat\/completions$/i, '')
  }

  return providerUrl
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/responses$/i, '')
    .replace(/\/predictions$/i, '')
}

function resolveGooseBaseUrl(providerKey) {
  const providerUrl = sources[providerKey]?.url
  if (!providerUrl) return null
  if (providerKey === 'cloudflare') {
    const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()
    if (!accountId) return null
    return providerUrl.replace('{account_id}', accountId)
  }
  return providerUrl
}

function getDirectInstallSupport(providerKey) {
  if (!sources[providerKey]) {
    return { supported: false, reason: 'Unknown provider' }
  }
  if (DIRECT_INSTALL_UNSUPPORTED_PROVIDERS.has(providerKey)) {
    return { supported: false, reason: 'This provider needs a non-standard proxy/runtime bridge' }
  }
  if (providerKey === 'cloudflare' && !(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()) {
    return { supported: false, reason: 'CLOUDFLARE_ACCOUNT_ID is required for direct installs' }
  }
  return { supported: true, reason: null }
}

function buildInstallRecord(providerKey, toolMode, scope, modelIds) {
  return {
    providerKey,
    toolMode: canonicalizeToolMode(toolMode),
    scope: scope === 'selected' ? 'selected' : 'all',
    modelIds: scope === 'selected' ? [...new Set(modelIds)] : [],
    lastSyncedAt: new Date().toISOString(),
  }
}

function upsertInstallRecord(config, record) {
  if (!Array.isArray(config.endpointInstalls)) config.endpointInstalls = []
  const next = config.endpointInstalls.filter(
    (entry) => !(entry?.providerKey === record.providerKey && entry?.toolMode === record.toolMode)
  )
  next.push(record)
  config.endpointInstalls = next
}

function buildCatalogModel(modelId, label, tier, sweScore, ctx) {
  return { modelId, label, tier, sweScore, ctx }
}

export function getProviderCatalogModels(providerKey) {
  const seen = new Set()
  return MODELS
    .filter((entry) => entry[5] === providerKey)
    .map(([modelId, label, tier, sweScore, ctx]) => buildCatalogModel(modelId, label, tier, sweScore, ctx))
    .filter((entry) => {
      if (seen.has(entry.modelId)) return false
      seen.add(entry.modelId)
      return true
    })
}

export function getConfiguredInstallableProviders(config) {
  return Object.keys(sources)
    .filter((providerKey) => getApiKey(config, providerKey))
    .map((providerKey) => {
      const support = getDirectInstallSupport(providerKey)
      return {
        providerKey,
        label: getProviderLabel(providerKey),
        modelCount: getProviderCatalogModels(providerKey).length,
        supported: support.supported,
        reason: support.reason,
      }
    })
    .filter((provider) => provider.supported)
}

export function getInstallTargetModes() {
  return [...INSTALL_TARGET_MODES]
}

function requireConfiguredProviderKey(config, providerKey) {
  const apiKey = getApiKey(config, providerKey)
  if (!apiKey) {
    throw new Error(`No configured API key found for ${getProviderLabel(providerKey)}`)
  }
  return apiKey
}

function resolveSelectedModels(providerKey, scope, modelIds) {
  const catalog = getProviderCatalogModels(providerKey)
  if (scope !== 'selected') return catalog
  const selectedSet = new Set(modelIds)
  return catalog.filter((model) => selectedSet.has(model.modelId))
}

function installIntoOpenCode(providerKey, models, apiKey, paths) {
  const filePath = paths.opencodeConfigPath
  const providerId = getManagedProviderId(providerKey)
  const config = readJson(filePath, {})
  if (!config.provider || typeof config.provider !== 'object') config.provider = {}

  config.provider[providerId] = {
    npm: '@ai-sdk/openai-compatible',
    name: getManagedProviderLabel(providerKey),
    options: {
      baseURL: resolveProviderBaseUrl(providerKey),
      apiKey,
    },
    models: Object.fromEntries(models.map((model) => [model.modelId, { name: model.label }])),
  }

  const backupPath = writeJson(filePath, config)
  return { path: filePath, backupPath, providerId, modelCount: models.length }
}

function installIntoCrush(providerKey, models, apiKey, paths) {
  const filePath = paths.crushConfigPath
  const providerId = getManagedProviderId(providerKey)
  const config = readJson(filePath, { $schema: 'https://charm.land/crush.json' })
  if (!config.providers || typeof config.providers !== 'object') config.providers = {}

  config.providers[providerId] = {
    name: getManagedProviderLabel(providerKey),
    type: 'openai-compat',
    base_url: resolveProviderBaseUrl(providerKey),
    api_key: apiKey,
    models: models.map((model) => ({
      id: model.modelId,
      name: model.label,
      context_window: parseContextWindow(model.ctx),
      default_max_tokens: getDefaultMaxTokens(parseContextWindow(model.ctx)),
    })),
  }

  const backupPath = writeJson(filePath, config)
  return { path: filePath, backupPath, providerId, modelCount: models.length }
}

function installIntoGoose(providerKey, models, apiKey, paths) {
  const providerId = getManagedProviderId(providerKey)
  const providerFilePath = join(paths.gooseProvidersDir, `${providerId}.json`)
  const secretEnvName = `FCM_${providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

  const providerConfig = {
    name: providerId,
    engine: 'openai',
    display_name: getManagedProviderLabel(providerKey),
    description: `Managed by free-coding-models for ${getProviderLabel(providerKey)}`,
    api_key_env: secretEnvName,
    base_url: resolveGooseBaseUrl(providerKey),
    models: models.map((model) => ({
      name: model.modelId,
      context_limit: parseContextWindow(model.ctx),
    })),
    supports_streaming: true,
    requires_auth: true,
  }

  const providerBackupPath = writeJson(providerFilePath, providerConfig)

  const secrets = readSimpleYamlMap(paths.gooseSecretsPath)
  secrets[secretEnvName] = apiKey
  const secretsBackupPath = writeSimpleYamlMap(paths.gooseSecretsPath, secrets)

  return {
    path: providerFilePath,
    backupPath: providerBackupPath,
    providerId,
    modelCount: models.length,
    extraPath: paths.gooseSecretsPath,
    extraBackupPath: secretsBackupPath,
  }
}

function installIntoOpenClaw(providerKey, models, apiKey, paths) {
  const filePath = paths.openclawConfigPath
  const providerId = getManagedProviderId(providerKey)
  const config = readJson(filePath, {})

  if (!config.models || typeof config.models !== 'object') config.models = {}
  if (config.models.mode !== 'replace') config.models.mode = 'merge'
  if (!config.models.providers || typeof config.models.providers !== 'object') config.models.providers = {}
  if (!config.agents || typeof config.agents !== 'object') config.agents = {}
  if (!config.agents.defaults || typeof config.agents.defaults !== 'object') config.agents.defaults = {}
  if (!config.agents.defaults.models || typeof config.agents.defaults.models !== 'object') config.agents.defaults.models = {}

  config.models.providers[providerId] = {
    baseUrl: resolveProviderBaseUrl(providerKey),
    apiKey,
    api: 'openai-completions',
    models: models.map((model) => {
      const contextWindow = parseContextWindow(model.ctx)
      return {
        id: model.modelId,
        name: model.label,
        api: 'openai-completions',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: getDefaultMaxTokens(contextWindow),
      }
    }),
  }

  for (const modelRef of Object.keys(config.agents.defaults.models)) {
    if (modelRef.startsWith(`${providerId}/`)) delete config.agents.defaults.models[modelRef]
  }
  for (const model of models) {
    config.agents.defaults.models[`${providerId}/${model.modelId}`] = {}
  }

  const backupPath = writeJson(filePath, config)
  return { path: filePath, backupPath, providerId, modelCount: models.length }
}

export function installProviderEndpoints(config, providerKey, toolMode, options = {}) {
  const canonicalToolMode = canonicalizeToolMode(toolMode)
  const support = getDirectInstallSupport(providerKey)
  if (!support.supported) {
    throw new Error(support.reason || 'Direct install is not supported for this provider')
  }

  const apiKey = requireConfiguredProviderKey(config, providerKey)
  const scope = options.scope === 'selected' ? 'selected' : 'all'
  const models = resolveSelectedModels(providerKey, scope, options.modelIds || [])
  if (models.length === 0) {
    throw new Error(`No models available to install for ${getProviderLabel(providerKey)}`)
  }

  const paths = { ...getDefaultPaths(), ...(options.paths || {}) }
  let installResult
  if (canonicalToolMode === 'opencode') {
    installResult = installIntoOpenCode(providerKey, models, apiKey, paths)
  } else if (canonicalToolMode === 'openclaw') {
    installResult = installIntoOpenClaw(providerKey, models, apiKey, paths)
  } else if (canonicalToolMode === 'crush') {
    installResult = installIntoCrush(providerKey, models, apiKey, paths)
  } else if (canonicalToolMode === 'goose') {
    installResult = installIntoGoose(providerKey, models, apiKey, paths)
  } else {
    throw new Error(`Unsupported install target: ${toolMode}`)
  }

  if (options.track !== false) {
    upsertInstallRecord(config, buildInstallRecord(providerKey, canonicalToolMode, scope, models.map((model) => model.modelId)))
    saveConfig(config)
  }

  return {
    ...installResult,
    toolMode: canonicalToolMode,
    toolLabel: getToolMeta(toolMode).label,
    providerKey,
    providerLabel: getProviderLabel(providerKey),
    scope,
    autoRefreshEnabled: true,
    models,
  }
}

export function refreshInstalledEndpoints(config, options = {}) {
  if (!Array.isArray(config?.endpointInstalls) || config.endpointInstalls.length === 0) {
    return { refreshed: 0, failed: 0, errors: [] }
  }

  let refreshed = 0
  let failed = 0
  const errors = []

  for (const record of config.endpointInstalls) {
    try {
      installProviderEndpoints(config, record.providerKey, record.toolMode, {
        scope: record.scope,
        modelIds: record.modelIds,
        track: false,
        paths: options.paths,
      })
      refreshed += 1
    } catch (error) {
      failed += 1
      errors.push({
        providerKey: record.providerKey,
        toolMode: record.toolMode,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (refreshed > 0) {
    config.endpointInstalls = config.endpointInstalls.map((record) => ({
      ...record,
      lastSyncedAt: new Date().toISOString(),
    }))
    saveConfig(config)
  }

  return { refreshed, failed, errors }
}
