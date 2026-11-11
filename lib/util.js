import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Harness home: $DSH_HOME when set, else ~/.dsh (same rule as the host). */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function exists(file) {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

/** Read UTF-8 text, dropping the BOM some editors (Windows PowerShell) prepend. */
export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return fallback
  }
}

/** Write via a sibling tmp file, then rename, so a crash never truncates the target. */
export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readText(file, ''))
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file, value) {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n')
}

export function todayKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Full-width digits and colon → ASCII, then trim.
 *
 * A Chinese IME writes `23：00` without being asked; a hand-edited config.json may
 * contain it too, so the host folds it before parsing instead of rejecting a time
 * that means exactly the same thing. Only these two classes are folded — `23.00`,
 * `23；00` and `23点` must stay invalid — and the `HH:mm` shape is otherwise strict.
 * Mirrored in `lib/client.js`, which cannot import from the host half.
 */
export function normalizeTimeText(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/[\uFF10-\uFF19\uFF1A]/g, (ch) => (ch === '\uFF1A' ? ':' : String.fromCharCode(ch.charCodeAt(0) - 0xfee0)))
    .trim()
}

/** Minutes since local midnight for an "HH:mm" string, or undefined when invalid. */
export function parseTimeOfDay(text) {
  if (typeof text !== 'string') return undefined
  const m = /^(\d{2}):(\d{2})$/.exec(normalizeTimeText(text))
  if (m === null) return undefined
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) return undefined
  return hh * 60 + mm
}

export function shortHash(text, len = 8) {
  return createHash('sha256').update(text).digest('hex').slice(0, len)
}

export function truncate(text, max) {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = max - head - 1
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}

/** Normalize for near-duplicate comparison: lowercase, strip punctuation and whitespace. */
export function normalizeForCompare(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Jaccard-ish containment score between two normalized Chinese/ASCII strings. */
export function similarity(a, b) {
  const x = normalizeForCompare(a)
  const y = normalizeForCompare(b)
  if (x.length === 0 || y.length === 0) return 0
  if (x === y) return 1
  const grams = (s) => {
    const set = new Set()
    for (let i = 0; i < Math.max(1, s.length - 1); i++) set.add(s.slice(i, i + 2))
    return set
  }
  const ga = grams(x)
  const gb = grams(y)
  let hit = 0
  for (const g of ga) if (gb.has(g)) hit += 1
  return hit / Math.max(ga.size, gb.size)
}
