import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readText, todayKey, writeJsonAtomic } from './util.js'

/**
 * Persistent scheduler/digest state. An unreadable file falls back to a fresh
 * state — but reports it, because a silent fallback makes the plugin think it
 * never ran (a BOM once hid exactly that).
 * @param {string} file - state.json path.
 * @param {(message: string) => void} [onCorrupt] - called when the file exists but cannot be parsed.
 */
export function loadState(file, onCorrupt) {
  let parsed = {}
  const raw = readText(file, '')
  if (raw.trim().length > 0) {
    try {
      const value = JSON.parse(raw)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) parsed = value
    } catch {
      if (typeof onCorrupt === 'function') onCorrupt('state.json is not valid JSON; continuing with a fresh state')
    }
  }
  return {
    lastRunDay: '',
    lastRunAt: 0,
    lastResult: null,
    lastError: null,
    lastPersonaRunDay: '',
    runs: [],
    excludeSessionIds: [],
    ...parsed,
  }
}

export function saveState(file, state) {
  writeJsonAtomic(file, state)
}

export function recordRun(state, entry) {
  state.runs = [...(state.runs ?? []), entry].slice(-30)
  state.lastRunDay = entry.date
  state.lastRunAt = entry.at
  state.lastResult = entry.ok === true ? 'ok' : 'failed'
  state.lastError = entry.ok === true ? null : (entry.error ?? 'unknown error')
}

/** Append one line to the per-day audit log. Never throws into the caller. */
export function createLogger(logDir) {
  const ensure = () => ensureDir(logDir)
  const fileFor = (date) => path.join(logDir, `run-${date}.jsonl`)
  const append = (level, message) => {
    try {
      ensure()
      const line = JSON.stringify({ at: new Date().toISOString(), level, message: String(message) }) + '\n'
      fs.appendFileSync(fileFor(todayKey()), line, 'utf8')
    } catch {
      // Logging must never break a digest run.
    }
  }
  return {
    info: (message) => append('info', message),
    warn: (message) => append('warn', message),
    error: (message) => append('error', message),
    log: (message) => append('info', message),
  }
}

/** Single-process run guard: a stale lock older than 10 minutes is ignored. */
export function acquireLock(lockFile) {
  try {
    const stat = fs.statSync(lockFile)
    if (Date.now() - stat.mtimeMs < 10 * 60 * 1000) return false
  } catch {
    // No lock yet.
  }
  ensureDir(path.dirname(lockFile))
  fs.writeFileSync(lockFile, String(process.pid), 'utf8')
  return true
}

export function releaseLock(lockFile) {
  try {
    fs.unlinkSync(lockFile)
  } catch {
    // Already gone.
  }
}

/** Snapshot of the files the status route reports. */
export function statusOf(paths, config, state, version = '0.2.0') {
  const stat = (file) => {
    try {
      const s = fs.statSync(file)
      return { exists: true, size: s.size, mtime: s.mtimeMs }
    } catch {
      return { exists: false }
    }
  }
  return {
    plugin: 'dsh-persona-memory',
    version,
    running: state.running === true,
    lastRunDay: state.lastRunDay ?? '',
    lastRunAt: state.lastRunAt ?? 0,
    lastResult: state.lastResult ?? null,
    lastError: state.lastError ?? null,
    lastPersonaRunDay: state.lastPersonaRunDay ?? '',
    schedule: config.schedule,
    provider: config.provider,
    model: config.model,
    personaEnabled: config.personaEnabled,
    profile: stat(paths.profileFile),
    persona: stat(paths.personaFile),
    dailyDir: paths.dailyDir,
  }
}
