import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Skip harness-injected user turns so only what the human typed reaches the digest. */
const INJECTED_PREFIXES = [
  'current runtime context',
  'the user sent you',
  'this is an automatically generated checkpoint',
  'compacted context',
]

/** Text that means the plugin's own injection leaked into a conversation. */
const SELF_MARKERS = ['persona-memory', '与用户协作的已知偏好']

/**
 * Decode a DSH session log. The file is a sequence of concatenated zstd frames
 * (one frame per append), which `zstdDecompressSync` alone would stop after the
 * first frame of — so split on the frame magic and decode each slice.
 */
export function decodeSessionLog(buffer) {
  const positions = []
  let index = -1
  while ((index = buffer.indexOf(ZSTD_MAGIC, index + 1)) !== -1) positions.push(index)
  if (positions.length === 0) return ''
  positions.push(buffer.length)
  const parts = []
  for (let i = 0; i < positions.length - 1; i += 1) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(positions[i], positions[i + 1])))
    } catch {
      // A truncated tail frame is normal for a log being appended to; skip it.
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

function textsOf(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const text = block.text.trim()
    if (text.length > 0) out.push(text)
  }
  return out
}

function isInjectedUserText(text) {
  const lower = text.trim().toLowerCase()
  if (INJECTED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true
  if (SELF_MARKERS.some((marker) => lower.includes(marker))) return true
  return false
}

/**
 * Parse one decoded session log into a conversation.
 * @returns {{id:string, cwd:string, createdAt:number, messages:Array<{role:'user'|'assistant',text:string,time:number}>}}
 */
export function parseSessionLog(text, fallbackId = '') {
  const session = { id: fallbackId, cwd: '', createdAt: 0, messages: [] }
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object') continue
    const time = typeof record.time === 'number' ? record.time : 0
    const data = record.data ?? {}
    switch (record.type) {
      case 'session':
        if (typeof data.id === 'string') session.id = data.id
        if (typeof data.cwd === 'string') session.cwd = data.cwd
        if (typeof data.createdAt === 'number') session.createdAt = data.createdAt
        break
      case 'user/message': {
        const source = data.source ?? {}
        if (source.kind !== 'user') break
        for (const text of textsOf(data.content)) {
          if (!isInjectedUserText(text)) session.messages.push({ role: 'user', text, time })
        }
        break
      }
      case 'assistant/message': {
        const message = data.message ?? {}
        for (const text of textsOf(message.content)) {
          session.messages.push({ role: 'assistant', text, time })
        }
        break
      }
      default:
        break
    }
  }
  return session
}

function listSessionDirs(root) {
  const out = []
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return out
  }
  for (const workspace of workspaces) {
    const workspaceDir = path.join(root, workspace.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(workspaceDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      const sessionDir = path.join(workspaceDir, session.name)
      let files = []
      try {
        files = fs.readdirSync(sessionDir, { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith('.jsonl.zstd'))
      } catch {
        continue
      }
      for (const file of files) out.push({ workspace: workspace.name, dir: sessionDir, file: path.join(sessionDir, file.name) })
    }
  }
  return out
}

/**
 * Collect the conversations that produced activity in [start, end).
 * @param {string} sessionsRoot - $DSH_HOME/sessions
 * @param {number} start - window start (epoch ms)
 * @param {number} end - window end (epoch ms)
 * @param {{excludeWorkspaces?: string[], excludeSessionIds?: string[]}} options
 */
export function collectSessions(sessionsRoot, start, end, options = {}) {
  const excludeWorkspaces = new Set((options.excludeWorkspaces ?? []).map((w) => w.toLowerCase()))
  const excludeSessionIds = new Set(options.excludeSessionIds ?? [])
  const result = []
  for (const entry of listSessionDirs(sessionsRoot)) {
    if (excludeWorkspaces.size > 0) {
      const workspacePath = entry.dir
      if ([...excludeWorkspaces].some((w) => workspacePath.toLowerCase().includes(w))) continue
    }
    let parsed
    try {
      const buffer = fs.readFileSync(entry.file)
      parsed = parseSessionLog(decodeSessionLog(buffer), path.basename(entry.dir))
    } catch {
      continue
    }
    if (excludeSessionIds.has(parsed.id)) continue
    const inWindow = parsed.messages.filter((m) => m.time >= start && m.time < end)
    if (inWindow.length === 0) continue
    const userTurns = inWindow.filter((m) => m.role === 'user')
    if (userTurns.length === 0) continue
    result.push({
      id: parsed.id,
      cwd: parsed.cwd,
      createdAt: parsed.createdAt,
      messages: inWindow,
      startedAt: Math.min(...inWindow.map((m) => m.time)),
      endedAt: Math.max(...inWindow.map((m) => m.time)),
      file: entry.file,
    })
  }
  result.sort((a, b) => a.startedAt - b.startedAt)
  return result
}
