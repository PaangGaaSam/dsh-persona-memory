import { parseTimeOfDay, readJson, writeJsonAtomic } from './util.js'

/** Every knob the patch row or the settings page may override. */
export const DEFAULTS = {
  schedule: '17:00',
  catchUpDays: 3,
  windowHours: 24,
  promptBudgetChars: 1200,
  sessionCharLimit: 6000,
  maxSessionsPerRun: 20,
  provider: 'deepseek-account',
  model: 'deepseek-v4-pro',
  temperature: 0.2,
  maxOutputTokens: 8000,
  autoApply: true,
  personaEnabled: true,
  personaUpdateEveryDays: 7,
  personaMinEvidence: 3,
  // 核心性格 additionally needs this many distinct dates; entries without new
  // evidence for this many days step back to candidates.
  personaCoreMinDates: 3,
  personaDemoteAfterDays: 30,
  excludeWorkspaces: [],
  excludeKeywords: [],
  keepRaw: false,
  // In-page banner whenever a run finishes; also asks the desktop shell for a
  // system notification when the browser grants it.
  notifyOnRun: false,
  // Per model call; a stalled stream must not pin the in-process run flag forever.
  llmTimeoutMs: 180000,
}

/**
 * Fields the settings page may write. `provider`/`model` stay editable so the
 * page can move to any host model; everything else is internal plumbing.
 */
export const EDITABLE_KEYS = [
  'schedule',
  'windowHours',
  'promptBudgetChars',
  'sessionCharLimit',
  'maxSessionsPerRun',
  'provider',
  'model',
  'temperature',
  'autoApply',
  'personaEnabled',
  'personaUpdateEveryDays',
  'personaMinEvidence',
  'personaCoreMinDates',
  'personaDemoteAfterDays',
  'excludeWorkspaces',
  'keepRaw',
  'notifyOnRun',
]

const POSITIVE_NUMBERS = [
  'windowHours',
  'sessionCharLimit',
  'maxSessionsPerRun',
  'maxOutputTokens',
  'personaUpdateEveryDays',
  'personaMinEvidence',
  'personaCoreMinDates',
  'personaDemoteAfterDays',
  'llmTimeoutMs',
]

/**
 * Validate a fully merged config and attach `scheduleMinutes`.
 * @param {object} raw - patch row config, defaults and stored overrides already merged.
 * @returns {object} the effective config.
 */
export function resolveConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) }
  const schedule = parseTimeOfDay(config.schedule)
  if (schedule === undefined) throw new Error('dsh-persona-memory: schedule must be "HH:mm" (e.g. "17:00")')
  for (const key of POSITIVE_NUMBERS) {
    if (!Number.isFinite(Number(config[key])) || Number(config[key]) <= 0) throw new Error(`dsh-persona-memory: ${key} must be a positive number`)
  }
  if (!Number.isFinite(Number(config.promptBudgetChars)) || Number(config.promptBudgetChars) < 0) throw new Error('dsh-persona-memory: promptBudgetChars must be >= 0')
  if (typeof config.provider !== 'string' || config.provider.length === 0) throw new Error('dsh-persona-memory: provider must be a non-empty string')
  if (typeof config.model !== 'string' || config.model.length === 0) throw new Error('dsh-persona-memory: model must be a non-empty string')
  if (!Array.isArray(config.excludeWorkspaces)) throw new Error('dsh-persona-memory: excludeWorkspaces must be an array')
  if (!Array.isArray(config.excludeKeywords)) throw new Error('dsh-persona-memory: excludeKeywords must be an array')
  const temperature = Number(config.temperature)
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('dsh-persona-memory: temperature must be between 0 and 2')
  return { ...config, scheduleMinutes: schedule }
}

/** Keep only the keys the settings page owns, normalized to their stored form. */
export function pickEditable(patch) {
  const out = {}
  if (patch === null || typeof patch !== 'object') return out
  for (const key of EDITABLE_KEYS) {
    if (!(key in patch)) continue
    out[key] = patch[key]
  }
  return out
}

/**
 * Read the overrides the settings page wrote. A malformed file is ignored rather
 * than fatal: the patch row and defaults still produce a working config.
 */
export function loadOverrides(file) {
  const raw = readJson(file, {})
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return pickEditable(raw)
}

/**
 * Merge patch-row config with stored overrides, validate, and return the result.
 * Overrides win: the user changed them explicitly in the settings page.
 */
export function composeConfig(rowConfig, overrides) {
  return resolveConfig({ ...DEFAULTS, ...(rowConfig ?? {}), ...pickEditable(overrides) })
}

/**
 * Validate a settings-page patch, persist it, and return the new effective config.
 * The stored file holds only overrides, so removing the file restores the row.
 * @returns {{config: object, overrides: object}}
 */
export function saveOverrides(file, rowConfig, currentOverrides, patch) {
  const next = { ...currentOverrides, ...pickEditable(patch) }
  const config = composeConfig(rowConfig, next)
  writeJsonAtomic(file, next)
  return { config, overrides: next }
}

/** The subset the settings page renders, with defaults for the "reset" affordance. */
export function publicConfig(config) {
  return {
    values: Object.fromEntries(EDITABLE_KEYS.map((key) => [key, config[key]])),
    defaults: Object.fromEntries(EDITABLE_KEYS.map((key) => [key, DEFAULTS[key]])),
  }
}
