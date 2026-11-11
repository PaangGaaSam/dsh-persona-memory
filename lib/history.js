import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readText, todayKey, writeTextAtomic } from './util.js'

/** The documents that keep pre-write backups. */
export const HISTORY_DOCS = ['profile', 'persona', 'lessons']

const NAME_RE = /^(profile|persona|lessons)-(\d{4}-\d{2}-\d{2})-(\d+)\.md$/

export function historyDir(paths) {
  return path.join(paths.root, 'history')
}

function documentFile(paths, doc) {
  if (doc === 'profile') return paths.profileFile
  if (doc === 'persona') return paths.personaFile
  if (doc === 'lessons') return paths.lessonsFile
  throw new Error(`unknown document: ${doc}`)
}

/** Copy the current document into history before it is rewritten. */
export function backupDocument(paths, doc, text, date = todayKey(), now = Date.now()) {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  const dir = ensureDir(historyDir(paths))
  const file = path.join(dir, `${doc}-${date}-${now}.md`)
  writeTextAtomic(file, text)
  return file
}

/**
 * List backups newest first.
 * @param {object} paths - resolved plugin paths.
 * @param {'profile'|'persona'} [doc] - restrict to one document, or omit for both.
 */
export function listHistory(paths, doc) {
  let names = []
  try {
    names = fs.readdirSync(historyDir(paths))
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    const match = NAME_RE.exec(name)
    if (match === null) continue
    if (doc !== undefined && match[1] !== doc) continue
    const file = path.join(historyDir(paths), name)
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      continue
    }
    rows.push({ doc: match[1], name, date: match[2], at: Number(match[3]), size })
  }
  rows.sort((a, b) => b.at - a.at)
  return rows
}

/**
 * Restore one backup over its document. The version being replaced is backed up
 * first, so a rollback is itself reversible.
 * @returns {{doc:string, name:string, replaced:boolean}}
 */
export function restoreHistory(paths, doc, name) {
  if (!HISTORY_DOCS.includes(doc)) throw new Error(`unknown document: ${doc}`)
  const match = NAME_RE.exec(String(name ?? ''))
  if (match === null || match[1] !== doc) throw new Error(`not a ${doc} backup: ${name}`)
  const source = path.join(historyDir(paths), match[0])
  const text = readText(source, '')
  if (text.trim().length === 0) throw new Error(`backup is missing or empty: ${name}`)
  const target = documentFile(paths, doc)
  const current = readText(target, '')
  if (current.trim().length > 0) backupDocument(paths, doc, current)
  writeTextAtomic(target, text)
  return { doc, name: match[0], replaced: current.trim().length > 0 }
}
