import { normalizeForCompare, similarity, todayKey } from './util.js'
import { formatAnchor, parseAnchor, scopeMatches, SCOPE_GLOBAL } from './lessons.js'

/**
 * 事实层：关于世界「是什么」的条目。
 *
 * 和教训层刻意相反：教训常驻注入（该怎么做），事实按需检索（是什么）。所以这里
 * 没有任何进入提示词的渲染函数——唯一的读出口是 `searchFacts`，由工具调用触发。
 * 这样事实库可以一直长，而每轮提示词的字符数不变。
 *
 * 写入在 v1 只有人工（设置页 / `facts/add`）；日更自动提取留到下一阶段，因为把
 * 判断当事实的代价比漏记一条高得多。
 */

export const FACTS_TITLE = '事实'

export const FACT_SECTIONS = [
  { key: 'fact', title: '事实', prefix: 'fact' },
  { key: 'archive', title: '已作废', prefix: 'arc' },
]

/** 「本机」= 这台机器上的事实，换机器就不再成立。全局/工作区沿用教训层的语义。 */
export const SCOPE_LOCAL = '本机'

/** 一条事实超过这么久没被再确认，检索结果里标「可能过期」，但不删除。 */
export const FACT_STALE_DAYS = 180

/** Hard cap on live rows. Archive never counts: retiring must always be possible. */
export const FACT_LIMITS = { fact: 300 }

export const FACT_SEARCH_LIMIT = 5
export const FACT_SEARCH_CHARS = 800

export const FACTS_HEADING = '## 事实'

const FACT_LINE_RE = /^-\s*\[([a-z]+-\d+)\]\s*(.*)$/
const FACT_TAG_RE = /^\[(作用域|确认|作废|原因)\s*([^\]]*)\]\s*/
const FACT_ANCHOR_RE = /（锚点：([^）]*)）\s*$/
const VERIFY_RE = /^\s*\[验证\]\s*(.+)$/
const PROMPT_RE = /^\s*\[回注\]\s*(.+)$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function daysBetween(fromDay, toDay) {
  const from = Date.parse(`${fromDay}T00:00:00`)
  const to = Date.parse(`${toDay}T00:00:00`)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.floor((to - from) / 86400000)
}

/**
 * Every stored field occupies exactly one physical line.
 *
 * A newline inside the sentence (or in a verify command pasted from a shell) would
 * turn into an orphan line on the next parse — the entry would silently lose its
 * tail, and only a hand edit could get it back. Collapsing at the input boundary is
 * the only place where it can be prevented.
 */
function oneLine(value, max) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max)
}

export function emptyFacts() {
  const head = [
    '---',
    'version: 0',
    `updatedAt: ${new Date().toISOString()}`,
    `title: ${FACTS_TITLE}`,
    '---',
    '',
    '<!-- 本文件由 dsh-persona-memory 维护：只追加、只作废，不改写已有条目；事实不写「该怎么做」，那是教训的事。 -->',
    '',
  ]
  const body = FACT_SECTIONS.map((section) => `## ${section.title}\n`).join('\n')
  return head.join('\n') + body
}

function readVersion(text) {
  const match = /^---\n[\s\S]*?\n---/.exec(String(text ?? ''))
  if (match === null) return 0
  const version = /^version:\s*(\d+)/m.exec(match[0])
  return version === null ? 0 : Number(version[1])
}

function bumpVersion(text) {
  const version = readVersion(text) + 1
  if (!/^---\n[\s\S]*?\n---/.test(text)) return text
  return text
    .replace(/^version:\s*\d+/m, `version: ${version}`)
    .replace(/^updatedAt:.*$/m, `updatedAt: ${new Date().toISOString()}`)
}

function parseFactLine(rawLine, section) {
  const match = FACT_LINE_RE.exec(rawLine.trim())
  if (match === null) return undefined
  let rest = match[2]
  const tags = {}
  for (;;) {
    const tag = FACT_TAG_RE.exec(rest)
    if (tag === null) break
    tags[tag[1]] = tag[2].trim()
    rest = rest.slice(tag[0].length)
  }
  let anchor = { date: '', session: '', note: '' }
  let body = rest
  const anchorMatch = FACT_ANCHOR_RE.exec(rest)
  if (anchorMatch !== null) {
    anchor = parseAnchor(anchorMatch[1])
    body = rest.slice(0, anchorMatch.index)
  }
  const text = body.trim()
  if (text.length === 0) return undefined
  return {
    id: match[1],
    section,
    text,
    scope: (tags['作用域'] ?? '').length > 0 ? tags['作用域'] : SCOPE_GLOBAL,
    lastConfirmed: tags['确认'] ?? '',
    invalidReason: tags['原因'] ?? '',
    invalidatedAt: tags['作废'] ?? '',
    anchor,
    verify: '',
    prompt: '',
  }
}

/**
 * Parse the facts document into `Map<sectionKey, entry[]>`.
 *
 * `[验证]` and `[回注]` are continuation lines: they belong to the entry above
 * them. Keeping them off the bullet line is what lets a shell command contain
 * brackets without breaking the parser.
 */
export function parseFacts(text) {
  const state = new Map(FACT_SECTIONS.map((section) => [section.key, []]))
  let current = null
  let last
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trimEnd()
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim()
      const match = FACT_SECTIONS.find((section) => section.title === title)
      current = match === undefined ? null : match.key
      last = undefined
      continue
    }
    if (current === null) continue
    const verify = VERIFY_RE.exec(line)
    if (verify !== null) {
      if (last !== undefined) last.verify = verify[1].trim()
      continue
    }
    const prompt = PROMPT_RE.exec(line)
    if (prompt !== null) {
      if (last !== undefined) last.prompt = prompt[1].trim()
      continue
    }
    const entry = parseFactLine(line, current)
    if (entry === undefined) continue
    state.get(current).push(entry)
    last = entry
  }
  return state
}

export function allFacts(state) {
  return FACT_SECTIONS.flatMap((section) => state.get(section.key) ?? [])
}

export function activeFacts(state) {
  return state.get('fact') ?? []
}

/** One entry as it appears in the document (one or two lines). */
export function renderFactLine(entry) {
  const parts = [`- [${entry.id}]`, `[作用域 ${entry.scope.length > 0 ? entry.scope : SCOPE_GLOBAL}]`]
  if (entry.section === 'archive') {
    if (entry.invalidatedAt.length > 0) parts.push(`[作废 ${entry.invalidatedAt}]`)
    if (entry.invalidReason.length > 0) parts.push(`[原因 ${entry.invalidReason}]`)
    if (entry.lastConfirmed.length > 0) parts.push(`[确认 ${entry.lastConfirmed}]`)
  } else if (entry.lastConfirmed.length > 0) {
    parts.push(`[确认 ${entry.lastConfirmed}]`)
  }
  const anchor = formatAnchor(entry.anchor)
  const lines = [`${parts.join(' ')} ${entry.text}${anchor}`]
  // 验证命令是给人（和给调用的模型）现场自证用的，不是事实本身的一部分。
  if (String(entry.verify ?? '').length > 0) lines.push(`  [验证] ${entry.verify}`)
  if (String(entry.prompt ?? '').length > 0) lines.push(`  [回注] ${entry.prompt}`)
  return lines.join('\n')
}

function docLines(text) {
  return String(text ?? '').split('\n')
}

function sectionRange(lines, key) {
  const section = FACT_SECTIONS.find((candidate) => candidate.key === key)
  if (section === undefined) return undefined
  const start = lines.findIndex((line) => line.trim() === `## ${section.title}`)
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## ')) {
      end = index
      break
    }
  }
  return { start: start + 1, end }
}

function insertFactBlock(lines, key, block) {
  const range = sectionRange(lines, key)
  if (range === undefined) {
    const section = FACT_SECTIONS.find((candidate) => candidate.key === key)
    lines.push(`## ${section.title}`, '', ...block.split('\n'), '')
    return
  }
  let at = range.end
  while (at > range.start && lines[at - 1].trim() === '') at -= 1
  lines.splice(at, 0, ...block.split('\n'))
}

/** Remove the entry line plus its continuation lines. */
function removeFactEntry(lines, id) {
  const index = lines.findIndex((line) => line.trim().startsWith(`- [${id}]`))
  if (index < 0) return false
  let end = index + 1
  while (end < lines.length && (VERIFY_RE.test(lines[end]) || PROMPT_RE.test(lines[end]))) end += 1
  lines.splice(index, end - index)
  return true
}

function nextFactId(state) {
  const used = new Set(allFacts(state).map((entry) => entry.id))
  let index = 1
  while (used.has(`fact-${index}`)) index += 1
  return `fact-${index}`
}

/**
 * Append-only check, mirrored from the lessons layer.
 * @returns {string[]} violations; empty means the write preserved every row.
 */
export function assertFactsAppendOnly(beforeText, afterText) {
  const before = parseFacts(beforeText)
  const after = parseFacts(afterText)
  const index = new Map(allFacts(after).map((entry) => [entry.id, entry]))
  const violations = []
  for (const entry of allFacts(before)) {
    const now = index.get(entry.id)
    if (now === undefined) {
      violations.push(`[${entry.id}] 被删除`)
      continue
    }
    if (now.text !== entry.text) violations.push(`[${entry.id}] 文本被改写`)
    if (now.scope !== entry.scope) violations.push(`[${entry.id}] 作用域被改写`)
    if (now.verify !== entry.verify) violations.push(`[${entry.id}] 验证命令被改写`)
    if (now.section !== entry.section && now.section !== 'archive') {
      violations.push(`[${entry.id}] 从 ${entry.section} 移到 ${now.section}`)
    }
  }
  return violations
}

function finishWrite(beforeText, lines, result) {
  const after = bumpVersion(lines.join('\n'))
  const violations = assertFactsAppendOnly(beforeText, after)
  if (violations.length > 0) {
    return { text: beforeText, changed: false, error: `拒绝写入：${violations.join('；')}`, ...result }
  }
  return { text: after, changed: true, ...result, version: readVersion(after) }
}

/**
 * Human adds one fact.
 *
 * `verify` is optional but recommended for machine facts: it lets the caller
 * prove the claim instead of trusting the document. `prompt` is the short cue
 * that a later injection stage may show; v1 only stores it.
 */
export function addManualFact(text, entry, options = {}) {
  const date = String(options.date ?? todayKey())
  const beforeText = typeof text === 'string' && text.trim().length > 0 ? text : emptyFacts()
  const body = oneLine(entry?.text, 400)
  if (body.length === 0) return { text: beforeText, changed: false, error: '内容为空' }
  const scope = oneLine(entry?.scope, 200) || SCOPE_GLOBAL
  const state = parseFacts(beforeText)
  const active = activeFacts(state)
  if (active.length >= FACT_LIMITS.fact) {
    return { text: beforeText, changed: false, error: `事实已满 ${FACT_LIMITS.fact} 条，先作废一条` }
  }
  // Duplicates are judged on the sentence alone: the same claim filed under two
  // scopes reads as two facts in search results, which is exactly the noise this
  // layer is supposed to avoid.
  const duplicate = active.find((candidate) => similarity(candidate.text, body) >= 0.85)
  if (duplicate !== undefined) {
    return { text: beforeText, changed: false, error: `已经有很接近的一条了：${duplicate.id}` }
  }
  const anchorDate = String(entry?.anchor?.date ?? date)
  const lines = docLines(beforeText)
  insertFactBlock(lines, 'fact', renderFactLine({
    id: nextFactId(state),
    section: 'fact',
    text: body,
    scope,
    lastConfirmed: date,
    invalidReason: '',
    invalidatedAt: '',
    anchor: {
      date: DATE_RE.test(anchorDate) ? anchorDate : date,
      session: oneLine(entry?.anchor?.session, 80),
      note: oneLine(entry?.anchor?.note, 120) || '人工新增',
    },
    verify: oneLine(entry?.verify, 300),
    prompt: oneLine(entry?.prompt, 120),
  }))
  return finishWrite(beforeText, lines, { added: 1 })
}

/** Retire one fact with a required reason; the sentence and anchor survive. */
export function archiveFact(text, id, reason, options = {}) {
  const date = String(options.date ?? todayKey())
  const beforeText = String(text ?? '')
  const state = parseFacts(beforeText)
  const target = allFacts(state).find((entry) => entry.id === id)
  if (target === undefined || target.section === 'archive') {
    return { text: beforeText, changed: false, error: '没有找到这条事实' }
  }
  const value = oneLine(reason, 80)
  if (value.length === 0) return { text: beforeText, changed: false, error: '作废必须填原因' }
  const lines = docLines(beforeText)
  removeFactEntry(lines, target.id)
  insertFactBlock(lines, 'archive', renderFactLine({
    ...target,
    section: 'archive',
    invalidatedAt: date,
    invalidReason: value,
  }))
  return finishWrite(beforeText, lines, { archived: 1 })
}

/** Refresh the confirmation date of one fact (it is still true today). */
export function confirmFact(text, id, options = {}) {
  const date = String(options.date ?? todayKey())
  const beforeText = String(text ?? '')
  const state = parseFacts(beforeText)
  const target = allFacts(state).find((entry) => entry.id === id)
  if (target === undefined || target.section === 'archive') {
    return { text: beforeText, changed: false, error: '没有找到这条事实' }
  }
  const lines = docLines(beforeText)
  const index = lines.findIndex((line) => line.trim().startsWith(`- [${target.id}]`))
  if (index < 0) return { text: beforeText, changed: false, error: '没有找到这条事实' }
  // A hand-edited row may have lost its [确认 …] tag. Rewriting it only when the
  // tag exists would report a successful confirmation that changed nothing.
  const line = lines[index]
  if (/\[确认 [^\]]*\]/.test(line)) {
    lines[index] = line.replace(/\[确认 [^\]]*\]/, `[确认 ${date}]`)
  } else if (/\[作用域 [^\]]*\]/.test(line)) {
    lines[index] = line.replace(/\[作用域 [^\]]*\]/, (tag) => `${tag} [确认 ${date}]`)
  } else {
    lines[index] = line.replace(/^(-\s*\[[a-z]+-\d+\])/, `$1 [确认 ${date}]`)
  }
  return finishWrite(beforeText, lines, { confirmed: 1 })
}

export function factsStats(text) {
  const state = parseFacts(text)
  return {
    counts: {
      fact: activeFacts(state).length,
      archive: (state.get('archive') ?? []).length,
    },
  }
}

/**
 * Project the facts document for the settings page: newest confirmation first,
 * archive last. Stale rows are flagged, never hidden.
 */
export function describeFacts(text, options = {}) {
  const today = String(options.today ?? todayKey())
  const state = parseFacts(text)
  const project = (entry) => ({
    id: entry.id,
    text: entry.text,
    scope: entry.scope,
    lastConfirmed: entry.lastConfirmed,
    anchor: entry.anchor,
    verify: entry.verify,
    prompt: entry.prompt,
    invalidatedAt: entry.invalidatedAt,
    invalidReason: entry.invalidReason,
    stale: entry.section === 'fact' && entry.lastConfirmed.length > 0 && daysBetween(entry.lastConfirmed, today) >= FACT_STALE_DAYS,
  })
  return {
    sections: [
      { key: 'fact', title: '事实', total: (state.get('fact') ?? []).length, entries: [...(state.get('fact') ?? [])].sort(confirmedSort).map(project) },
      { key: 'archive', title: '已作废', total: (state.get('archive') ?? []).length, entries: (state.get('archive') ?? []).map(project) },
    ],
    stats: factsStats(text),
  }
}

function confirmedSort(a, b) {
  if (a.lastConfirmed === b.lastConfirmed) return a.id < b.id ? -1 : 1
  return a.lastConfirmed < b.lastConfirmed ? 1 : -1
}

function queryTerms(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[\s,，。;；:：、/\\|（）()「」【】\[\]<>“”"'’]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
}

function formatHit(entry, today, maxChars) {
  const stale = entry.lastConfirmed.length > 0 && daysBetween(entry.lastConfirmed, today) >= FACT_STALE_DAYS
  const head = `- [${entry.id}] [${entry.scope}]${stale ? ' [可能过期]' : ''} ${entry.text}`
  const meta = [entry.lastConfirmed.length > 0 ? `确认 ${entry.lastConfirmed}` : '', formatAnchor(entry.anchor).replace(/^（|）$/g, '')]
    .filter((part) => part.length > 0)
    .join(' · ')
  const lines = [head]
  if (meta.length > 0) lines.push(`  ${meta}`)
  if (entry.verify.length > 0) lines.push(`  验证：${entry.verify}`)
  const block = lines.join('\n')
  if (maxChars > 0 && block.length > maxChars) return block.slice(0, maxChars) + '…'
  return block
}

/**
 * Retrieve facts for one query. This is the only read path into a prompt.
 *
 * Scope mirrors the lessons layer (global + the current workspace), plus 本机,
 * which applies on the machine the host runs on. No semantic search: substring
 * and term matches only, because a wrong fact is worse than a missing one.
 * @returns {{text: string, hits: number, total: number, skipped: number}}
 */
export function searchFacts(text, options = {}) {
  const query = String(options.query ?? '').trim()
  const cwd = options.cwd
  const today = String(options.today ?? todayKey())
  const limit = Math.max(1, Math.min(20, Number(options.limit ?? FACT_SEARCH_LIMIT)))
  const maxChars = Math.max(200, Number(options.maxChars ?? FACT_SEARCH_CHARS))
  const state = parseFacts(text)
  const rows = activeFacts(state)
  const local = rows.filter((entry) => entry.scope === SCOPE_LOCAL || scopeMatches(entry.scope, cwd))
  const skipped = rows.length - local.length
  if (local.length === 0) {
    return {
      text: `没有记录中的事实（共 ${rows.length} 条，都不适用于当前工作区；用 facts/add 或设置页新增）。不要据此推测，直接说没有记录或问对方。`,
      hits: 0,
      total: 0,
      skipped,
    }
  }
  const terms = queryTerms(query)
  let picked
  if (query.length === 0) {
    picked = [...local].sort(confirmedSort).slice(0, limit).map((entry) => ({ entry, score: 0 }))
  } else {
    const needle = normalizeForCompare(query)
    picked = local
      .map((entry) => {
        const hay = normalizeForCompare(`${entry.text} ${entry.verify} ${entry.prompt}`)
        let score = needle.length > 0 && hay.includes(needle) ? 20 : 0
        for (const term of terms) {
          if (hay.includes(normalizeForCompare(term))) score += Math.min(6, term.length)
        }
        return { entry, score }
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => (b.score - a.score) || (confirmedSort(a.entry, b.entry)))
      .slice(0, limit)
  }
  if (picked.length === 0) {
    return {
      text: `没有找到与「${query}」相关的事实（可检索 ${local.length} 条）。不要据此推测，直接说没有记录或问对方。`,
      hits: 0,
      total: local.length,
      skipped,
    }
  }
  const head = query.length === 0
    ? `## 事实（最近确认的 ${picked.length} / ${local.length} 条）`
    : `## 事实（命中 ${picked.length} / 可检索 ${local.length} 条）`
  const blocks = []
  let used = head.length
  for (const { entry } of picked) {
    const budget = Math.max(120, maxChars - used)
    const block = formatHit(entry, today, budget)
    if (used + block.length > maxChars && blocks.length > 0) break
    blocks.push(block)
    used += block.length + 1
  }
  const tail = skipped > 0 ? `\n另有 ${skipped} 条只属于别的工作区。` : ''
  return { text: [head, '', ...blocks].join('\n') + tail, hits: blocks.length, total: local.length, skipped }
}
