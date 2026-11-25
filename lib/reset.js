import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './util.js'

/**
 * The memory set: what `/new` clears, what `/backup` snapshots and what
 * `/reload` overwrites.
 *
 * `config.json` is deliberately absent — clearing memory must not clear the
 * schedule, the model route or the budget. `backups/` is absent too: a reset has
 * to stay undoable, so the snapshot that precedes it cannot be inside the set
 * it deletes. `.run.lock` is also left alone; it belongs to a running digest,
 * not to memory.
 *
 * Only `paths.root` is needed, so the whole module can run against a temp
 * directory in tests without a host.
 */
export const MEMORY_FILES = ['profile.md', 'persona.md', 'lessons.md', 'facts.md', 'identity.json', 'state.json']
export const MEMORY_DIRS = ['daily', 'history', 'logs']

/** Kinds of snapshot directory; the name carries the timestamp. */
export const SNAPSHOT_KINDS = ['backup', 'reset', 'safety']

/** `<kind>-<yyyyMMdd>-<HHmmss>`, optionally `-2`/`-3` on a same-second clash. */
const SNAPSHOT_NAME = /^(backup|reset|safety)-(\d{8})-(\d{6})(?:-(\d+))?$/

function statOf(target) {
  try {
    return fs.statSync(target)
  } catch {
    return undefined
  }
}

/** Forward-slash relative path, so a reply reads the same on every platform. */
function relOf(root, target) {
  return path.relative(root, target).split(path.sep).join('/')
}

/**
 * Refuse to touch anything outside the plugin's own directory.
 *
 * The callers only build paths from constants, so this is insurance rather than
 * a live check: the two functions that delete or overwrite (clearMemory,
 * restoreSnapshot) must be unable to reach a path outside `root` even if a
 * future edit computes one wrongly.
 */
function assertInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to touch ${target}: outside ${root}`)
  }
}

/** Every file under `dir`, recursively; an unreadable directory yields none. */
function walkFiles(dir) {
  const files = []
  let dirents
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const dirent of dirents) {
    const abs = path.join(dir, dirent.name)
    if (dirent.isDirectory()) {
      files.push(...walkFiles(abs))
      continue
    }
    // A symlink is one entry that must not be left behind. Its size is the
    // target's when readable, else zero — the preview only needs an estimate,
    // the clear needs the entry.
    files.push({ abs, bytes: statOf(abs)?.size ?? 0 })
  }
  return files
}

/**
 * The memory set as it exists right now, one row per top-level entry.
 * A directory row counts the files inside it, so the preview has no hidden
 * bytes: `daily/` reports its notes rather than a directory inode size.
 */
export function memoryEntries(paths) {
  const root = path.resolve(paths.root)
  const entries = []
  for (const rel of MEMORY_FILES) {
    const abs = path.join(root, rel)
    const stat = statOf(abs)
    if (stat === undefined || !stat.isFile()) continue
    entries.push({ rel, abs, type: 'file', files: 1, bytes: stat.size })
  }
  for (const rel of MEMORY_DIRS) {
    const abs = path.join(root, rel)
    const stat = statOf(abs)
    if (stat === undefined) continue
    if (!stat.isDirectory()) {
      // A stray file where a directory belongs is still part of memory.
      entries.push({ rel, abs, type: 'file', files: 1, bytes: stat.size })
      continue
    }
    const files = walkFiles(abs)
    entries.push({
      rel,
      abs,
      type: 'dir',
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    })
  }
  return entries.sort((a, b) => a.rel.localeCompare(b.rel))
}

/** Read-only: stat only, so a preview can never change a byte or an mtime. */
export function previewReset(paths) {
  const entries = memoryEntries(paths)
  return {
    entries,
    files: entries.reduce((sum, entry) => sum + entry.files, 0),
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  }
}

function stampOf(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function uniqueName(backups, kind, stamp) {
  let name = `${kind}-${stamp}`
  for (let serial = 2; serial < 1000; serial += 1) {
    if (!fs.existsSync(path.join(backups, name))) return name
    name = `${kind}-${stamp}-${serial}`
  }
  throw new Error(`cannot find a free snapshot name for ${kind}-${stamp}`)
}

function totals(entries) {
  return {
    files: entries.reduce((sum, entry) => sum + entry.files, 0),
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  }
}

/**
 * Copy the whole memory set into `backups/<kind>-<stamp>/`, keeping the
 * relative layout (`daily/…`, `logs/…`).
 *
 * Callers snapshot before they delete or overwrite; a throw here is the
 * intended "abort, nothing has been touched yet" signal. The first write is the
 * `mkdir` of `backups/` itself, which is why an unusable backup area fails
 * before anything is removed.
 */
export function snapshotMemory(paths, kind = 'backup', now = new Date()) {
  if (!SNAPSHOT_KINDS.includes(kind)) throw new Error(`unknown snapshot kind: ${kind}`)
  const root = path.resolve(paths.root)
  const backups = path.join(root, 'backups')
  const entries = memoryEntries(paths)
  ensureDir(backups)
  const name = uniqueName(backups, kind, stampOf(now))
  const dir = path.join(backups, name)
  ensureDir(dir)
  for (const entry of entries) {
    const target = path.join(dir, entry.rel)
    ensureDir(path.dirname(target))
    // cpSync keeps empty directories and symlinks intact; copyFileSync would
    // lose the former and follow the latter.
    if (entry.type === 'dir') fs.cpSync(entry.abs, target, { recursive: true })
    else fs.copyFileSync(entry.abs, target)
  }
  return { kind, name, dir, ...totals(entries) }
}

/**
 * Delete the memory set and recreate the directories empty.
 *
 * The directories stay on purpose: the next digest writes `daily/` and `logs/`
 * unconditionally, and a missing folder would surface as an ENOENT inside a
 * scheduled run instead of a fresh file.
 */
export function clearMemory(paths) {
  const root = path.resolve(paths.root)
  const entries = memoryEntries(paths)
  for (const entry of entries) {
    assertInside(root, entry.abs)
    fs.rmSync(entry.abs, { recursive: true, force: true })
  }
  for (const rel of MEMORY_DIRS) ensureDir(path.join(root, rel))
  const { files, bytes } = totals(entries)
  return { entries: entries.map((entry) => entry.rel), files, bytes }
}

/** Snapshot then clear; a failed snapshot throws before anything is deleted. */
export function resetMemory(paths, options = {}) {
  const now = options.now ?? new Date()
  const snapshot = snapshotMemory(paths, 'reset', now)
  try {
    return { snapshot, cleared: clearMemory(paths) }
  } catch (error) {
    // The snapshot already exists, so the caller can name it for a /reload.
    error.snapshot = snapshot
    throw error
  }
}

function parseSnapshotName(name) {
  const match = SNAPSHOT_NAME.exec(name)
  if (match === null) return undefined
  const at = Date.parse(
    `${match[2].slice(0, 4)}-${match[2].slice(4, 6)}-${match[2].slice(6, 8)}`
    + `T${match[3].slice(0, 2)}:${match[3].slice(2, 4)}:${match[3].slice(4, 6)}`,
  )
  if (!Number.isFinite(at)) return undefined
  return { kind: match[1], at, serial: match[4] === undefined ? 1 : Number(match[4]) }
}

/**
 * Whether `/reload <name>` names a snapshot. The regex also rejects `..`,
 * separators and absolute paths before any path is built from the input.
 */
export function isSnapshotName(name) {
  return SNAPSHOT_NAME.test(String(name ?? '').trim())
}

/**
 * All snapshots of the given kinds, newest first. `at` comes from the name, not
 * from the file system: copying or restoring a directory changes its mtime, and
 * "newest" must still mean "taken last".
 */
export function listSnapshots(paths, kinds = SNAPSHOT_KINDS) {
  const backups = path.join(path.resolve(paths.root), 'backups')
  let dirents = []
  try {
    dirents = fs.readdirSync(backups, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const parsed = parseSnapshotName(dirent.name)
    if (parsed === undefined || !kinds.includes(parsed.kind)) continue
    rows.push({ ...parsed, name: dirent.name, dir: path.join(backups, dirent.name) })
  }
  rows.sort((a, b) => b.at - a.at || b.serial - a.serial || b.name.localeCompare(a.name))
  return rows
}

/**
 * The snapshot `/reload` takes when it gets no argument: `backup-` and
 * `reset-` compete (a reset must be undoable), `safety-` never does — it exists
 * only to be named explicitly.
 */
export function latestSnapshot(paths, kinds = ['backup', 'reset']) {
  return listSnapshots(paths, kinds)[0]
}

function currentFiles(paths) {
  const root = path.resolve(paths.root)
  const rels = []
  for (const entry of memoryEntries(paths)) {
    if (entry.type === 'file') {
      rels.push(entry.rel)
      continue
    }
    for (const file of walkFiles(entry.abs)) rels.push(relOf(root, file.abs))
  }
  return rels
}

/**
 * Overwrite memory with one snapshot.
 *
 * Two semantics, chosen by the snapshot's own kind:
 * - `backup-*` / `reset-*` are a merge: files the snapshot does not contain are
 *   left alone and reported as `kept`, so a restore cannot silently delete a
 *   daily note written after the snapshot.
 * - `safety-*` is a mirror: it is the complete state at the moment a restore
 *   began, so undoing that restore has to delete what the restore added.
 *   Without this branch "undo the restore" restored the overwritten files but
 *   left every file the restore had just brought back alive.
 *
 * A `safety-*` snapshot of the current state is taken first; a failed one
 * aborts before the first byte is overwritten.
 */
export function restoreSnapshot(paths, name, now = new Date()) {
  const root = path.resolve(paths.root)
  const backups = path.join(root, 'backups')
  const clean = String(name ?? '').trim()
  const parsed = parseSnapshotName(clean)
  if (parsed === undefined) throw new Error(`${clean} is not a snapshot directory name`)
  const source = path.join(backups, clean)
  assertInside(root, source)
  if (statOf(source)?.isDirectory() !== true) throw new Error(`snapshot not found: ${clean}`)
  // Only memory paths are written back: a snapshot directory that also contains
  // (say) config.json must not be able to rewrite settings, because "config.json
  // is never touched" is a promise these commands make.
  const allowed = new Set([...MEMORY_FILES, ...MEMORY_DIRS])
  const snapshotFiles = walkFiles(source)
    .map((file) => path.relative(source, file.abs).split(path.sep).join('/'))
    .filter((rel) => allowed.has(rel.split('/')[0]))
    .sort()
  const mirror = parsed.kind === 'safety'
  const safety = snapshotMemory(paths, 'safety', now)
  const removed = []
  if (mirror) {
    for (const rel of currentFiles(paths)) {
      if (snapshotFiles.includes(rel)) continue
      const target = path.join(root, rel)
      assertInside(root, target)
      fs.rmSync(target, { force: true })
      removed.push(rel)
    }
  }
  for (const rel of snapshotFiles) {
    const target = path.join(root, rel)
    assertInside(root, target)
    ensureDir(path.dirname(target))
    fs.copyFileSync(path.join(source, rel), target)
  }
  // A snapshot may carry a memory directory with no files; the folders still
  // exist afterwards so the next digest does not hit ENOENT.
  for (const rel of MEMORY_DIRS) ensureDir(path.join(root, rel))
  const kept = mirror ? [] : currentFiles(paths).filter((rel) => !snapshotFiles.includes(rel))
  return {
    name: clean,
    dir: source,
    mirror,
    safety: safety.name,
    safetyDir: safety.dir,
    restored: snapshotFiles,
    removed,
    kept,
    files: snapshotFiles.length,
  }
}
