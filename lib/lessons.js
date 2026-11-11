import path from 'node:path'
import { readMeta } from './profile.js'
import { exists, normalizeForCompare, readText, similarity, todayKey } from './util.js'

/**
 * The lessons layer: what went wrong last time and which step to change next time.
 *
 * It answers 「该怎么做」, not 「你是谁」 (profile) or 「我是谁」 (persona). The whole
 * file is under one hard rule: **append-only and invalidate-only**. Existing
 * entries are never rewritten; a lesson that stops holding moves to 已作废 with
 * its original text plus a reason. `assertAppendOnly` enforces that on every
 * write, and the test suite asserts it across repeated merges.
 */
export const LESSON_SECTIONS = [
  { key: 'rule', title: '铁律', prefix: 'rule' },
  { key: 'exp', title: '时效经验', prefix: 'exp' },
  { key: 'archive', title: '已作废', prefix: 'arc' },
]

export const LESSONS_TITLE = '教训'

/** Hard caps. 铁律 宁滥勿漏 at the entry level, 时效经验 宁漏勿滥. */
export const LESSON_LIMITS = { rule: 5, exp: 5 }

/**
 * Rule proposals wait here until a human approves them. This is the landing
 * place for 「新铁律必须由人确认才生效」: the system may only stage, never arm.
 */
export const LESSON_STAGING_LIMIT = 5

/** An 时效经验 that nobody confirmed for this long is archived, not deleted. */
export const LESSON_EXP_TTL_DAYS = 90

/** Near-duplicate threshold, same number the profile and persona merges use. */
export const LESSON_MERGE_SIMILARITY = 0.85

/** Two entries must be about the same thing before their polarity counts. */
export const CONFLICT_MIN_SIMILARITY = 0.4

export const SCOPE_GLOBAL = '全局'

export const LESSONS_HEADING = '## 教训（我上次怎么翻车的、下次改哪一步）'

/** The daily-note section the day's candidates live in (never this file). */
export const SUSPECT_SECTION = '可疑雷点'

const LINE_RE = /^-\s*\[([a-z]+-\d+)\]\s*(.*)$/
const TAG_RE = /^\[(作用域|确认|适用|待确认|作废|原因)\s*([^\]]*)\]\s*/
const ANCHOR_RE = /（锚点：([^）]*)）\s*$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function daysBetween(fromDay, toDay) {
  const from = Date.parse(`${fromDay}T00:00:00`)
  const to = Date.parse(`${toDay}T00:00:00`)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.floor((to - from) / 86400000)
}

export function emptyLessons() {
  const head = [
    '---',
    'version: 0',
    `updatedAt: ${new Date().toISOString()}`,
    `title: ${LESSONS_TITLE}`,
    '---',
    '',
    '<!-- 本文件由 dsh-persona-memory 维护：只追加、只作废，不改写已有条目；铁律只有人能增删。 -->',
    '',
  ]
  const body = LESSON_SECTIONS.map((section) => `## ${section.title}\n`).join('\n')
  return head.join('\n') + body
}

/** `date/session · 日报里的一句话`, or an empty string when there is no anchor. */
export function formatAnchor(anchor) {
  if (anchor === undefined || anchor === null) return ''
  const date = String(anchor.date ?? '').trim()
  const session = String(anchor.session ?? '').trim()
  const note = String(anchor.note ?? '').trim()
  if (date === '' && session === '' && note === '') return ''
  const head = [date, session].filter((part) => part.length > 0).join('/')
  const value = note.length > 0 ? (head.length > 0 ? `${head} · ${note}` : note) : head
  return `（锚点：${value}）`
}

/** Parse an anchor string back into its three parts. */
export function parseAnchor(value, fallbackDate = '') {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return { date: String(fallbackDate ?? ''), session: '', note: '' }
  const parts = raw.split('·')
  const head = (parts[0] ?? '').trim()
  const note = parts.slice(1).join('·').trim().slice(0, 80)
  let date = ''
  let session = ''
  const slash = head.indexOf('/')
  if (slash > 0) {
    date = head.slice(0, slash).trim()
    session = head.slice(slash + 1).trim()
  } else if (DATE_RE.test(head)) {
    date = head
  } else {
    session = head
  }
  return { date: date.length > 0 ? date : String(fallbackDate ?? ''), session, note }
}

function anchorKey(anchor) {
  if (anchor === undefined || anchor === null) return ''
  return `${anchor.date ?? ''}/${anchor.session ?? ''}/${anchor.note ?? ''}`
}

function parseLine(rawLine, section) {
  const match = LINE_RE.exec(rawLine.trim())
  if (match === null) return undefined
  let rest = match[2]
  const tags = {}
  for (;;) {
    const tag = TAG_RE.exec(rest)
    if (tag === null) break
    tags[tag[1]] = tag[2].trim()
    rest = rest.slice(tag[0].length)
  }
  let anchor = { date: '', session: '', note: '' }
  let body = rest
  const anchorMatch = ANCHOR_RE.exec(rest)
  if (anchorMatch !== null) {
    anchor = parseAnchor(anchorMatch[1])
    body = rest.slice(0, anchorMatch.index)
  }
  const text = body.trim()
  if (text.length === 0) return undefined
  const appliable = tags['适用'] ?? ''
  return {
    id: match[1],
    section,
    text,
    scope: (tags['作用域'] ?? '').length > 0 ? tags['作用域'] : SCOPE_GLOBAL,
    lastConfirmed: tags['确认'] ?? '',
    appliesTo: appliable,
    pending: section === 'rule' && Object.prototype.hasOwnProperty.call(tags, '待确认'),
    invalidReason: tags['原因'] ?? '',
    invalidatedAt: tags['作废'] ?? '',
    anchor,
  }
}

/** Parse the lessons document into `Map<sectionKey, entry[]>`. */
export function parseLessons(text) {
  const state = new Map(LESSON_SECTIONS.map((section) => [section.key, []]))
  let current = null
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trimEnd()
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim()
      const match = LESSON_SECTIONS.find((section) => section.title === title)
      current = match === undefined ? null : match.key
      continue
    }
    if (current === null) continue
    const entry = parseLine(line, current)
    if (entry === undefined) continue
    state.get(current).push(entry)
  }
  return state
}

/** Every entry in the document, in section order. */
export function allLessons(state) {
  return LESSON_SECTIONS.flatMap((section) => state.get(section.key) ?? [])
}

function findLesson(state, id) {
  return allLessons(state).find((entry) => entry.id === id)
}

/** Active entries only: a pending rule is not a lesson yet, archive is history. */
export function activeLessons(state) {
  return [...(state.get('rule') ?? []), ...(state.get('exp') ?? [])].filter((entry) => entry.pending !== true)
}

function renderLessonLine(entry) {
  const parts = [`- [${entry.id}]`, `[作用域 ${entry.scope.length > 0 ? entry.scope : SCOPE_GLOBAL}]`]
  if (entry.section === 'archive') {
    if (entry.invalidatedAt.length > 0) parts.push(`[作废 ${entry.invalidatedAt}]`)
    if (entry.invalidReason.length > 0) parts.push(`[原因 ${entry.invalidReason}]`)
    if (entry.lastConfirmed.length > 0) parts.push(`[确认 ${entry.lastConfirmed}]`)
  } else {
    if (entry.pending === true) parts.push('[待确认]')
    if (entry.lastConfirmed.length > 0) parts.push(`[确认 ${entry.lastConfirmed}]`)
  }
  if (entry.appliesTo.length > 0) parts.push(`[适用 ${entry.appliesTo}]`)
  const anchor = formatAnchor(entry.anchor)
  return `${parts.join(' ')} ${entry.text}${anchor}`
}

function docLines(text) {
  return String(text ?? '').split('\n')
}

function sectionRange(lines, key) {
  const section = LESSON_SECTIONS.find((candidate) => candidate.key === key)
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
  return { start: start + 1, end, title: section.title }
}

/** Insert one rendered line at the end of its section, before the trailing blanks. */
function insertLessonLine(lines, key, line) {
  const range = sectionRange(lines, key)
  if (range === undefined) {
    const section = LESSON_SECTIONS.find((candidate) => candidate.key === key)
    lines.push(`## ${section.title}`, '', line, '')
    return
  }
  let at = range.end
  while (at > range.start && lines[at - 1].trim() === '') at -= 1
  lines.splice(at, 0, line)
}

function removeLessonLine(lines, id) {
  const index = lines.findIndex((line) => line.trim().startsWith(`- [${id}]`))
  if (index < 0) return false
  lines.splice(index, 1)
  return true
}

function replaceLessonLine(lines, id, line) {
  const index = lines.findIndex((candidate) => candidate.trim().startsWith(`- [${id}]`))
  if (index < 0) return false
  lines[index] = line
  return true
}

function bumpVersion(text) {
  const meta = readMeta(text, LESSONS_TITLE)
  const version = meta.version + 1
  const stamp = new Date().toISOString()
  if (!/^---\n[\s\S]*?\n---/.test(text)) return text
  return text
    .replace(/^version:\s*\d+/m, `version: ${version}`)
    .replace(/^updatedAt:.*$/m, `updatedAt: ${stamp}`)
}

function nextLessonId(state, sectionKey) {
  const section = LESSON_SECTIONS.find((candidate) => candidate.key === sectionKey) ?? LESSON_SECTIONS[0]
  const used = new Set(allLessons(state).map((entry) => entry.id))
  let index = 1
  while (used.has(`${section.prefix}-${index}`)) index += 1
  return `${section.prefix}-${index}`
}

/**
 * The append-only guarantee, checked instead of assumed.
 *
 * Every id that existed before must still exist with the same text, scope and
 * anchor; only a move into 已作废 (with the original text preserved there) is
 * legitimate. A merge may refresh `lastConfirmed`, never the sentence.
 * @returns {string[]} violations; empty means the write is append-only.
 */
export function assertAppendOnly(beforeText, afterText) {
  const before = parseLessons(beforeText)
  const after = parseLessons(afterText)
  const index = new Map(allLessons(after).map((entry) => [entry.id, entry]))
  const violations = []
  for (const entry of allLessons(before)) {
    const now = index.get(entry.id)
    if (now === undefined) {
      violations.push(`[${entry.id}] 被删除`)
      continue
    }
    if (now.text !== entry.text) violations.push(`[${entry.id}] 文本被改写`)
    if (now.scope !== entry.scope) violations.push(`[${entry.id}] 作用域被改写`)
    if (anchorKey(now.anchor) !== anchorKey(entry.anchor)) violations.push(`[${entry.id}] 锚点被改写`)
    if (now.section !== entry.section && now.section !== 'archive') {
      violations.push(`[${entry.id}] 从 ${entry.section} 移到 ${now.section}`)
    }
  }
  return violations
}

/**
 * Move one entry into 已作废, keeping its original text and anchor.
 * The only change is the new `[作废 …] [原因 …]` metadata.
 */
function archiveEntry(lines, entry, reason, date) {
  removeLessonLine(lines, entry.id)
  insertLessonLine(lines, 'archive', renderLessonLine({
    ...entry,
    section: 'archive',
    pending: false,
    invalidatedAt: date,
    invalidReason: reason,
  }))
}

function finishWrite(beforeText, lines, result) {
  const after = bumpVersion(lines.join('\n'))
  const violations = assertAppendOnly(beforeText, after)
  if (violations.length > 0) {
    // Never write a document that lost or rewrote an existing entry.
    return { text: beforeText, changed: false, error: `拒绝写入：${violations.join('；')}`, ...result }
  }
  return { text: after, changed: true, ...result, version: readMeta(after, LESSONS_TITLE).version }
}

/** Closest active entry at or above the merge threshold, or undefined. */
function bestDuplicate(entries, body, threshold = LESSON_MERGE_SIMILARITY) {
  let best
  let bestScore = 0
  for (const entry of entries) {
    const score = similarity(entry.text, body)
    if (score > bestScore) {
      best = entry
      bestScore = score
    }
  }
  return bestScore >= threshold ? best : undefined
}

/**
 * Apply one digest's lesson suggestions: caps, near-duplicate merge (时效经验
 * only), 90-day expiry, and every new 铁律 parked as 待确认.
 *
 * The model proposes text/section/scope/anchor; everything that decides whether
 * a sentence becomes armed memory happens here.
 */
export function applyLessonSuggestions(text, suggestions, options = {}) {
  const date = String(options.date ?? todayKey())
  const limits = { ...LESSON_LIMITS, ...(options.limits ?? {}) }
  const ttl = Number(options.expTtlDays ?? LESSON_EXP_TTL_DAYS)
  const stagingLimit = Number(options.stagingLimit ?? LESSON_STAGING_LIMIT)
  const beforeText = typeof text === 'string' && text.trim().length > 0 ? text : emptyLessons()
  const lines = docLines(beforeText)
  let state = parseLessons(lines.join('\n'))
  const result = { added: 0, pending: 0, merged: 0, expired: 0, archived: 0, dropped: 0 }

  // 1. Expiry. Runs even when the model proposes nothing: an unconfirmed 时效经验
  //    must age out on its own, but a 铁律 never does.
  for (const entry of [...(state.get('exp') ?? [])]) {
    const basis = entry.lastConfirmed.length > 0 ? entry.lastConfirmed : entry.anchor.date
    if (basis.length === 0) continue
    if (daysBetween(basis, date) < ttl) continue
    archiveEntry(lines, entry, `${ttl} 天无确认`, date)
    result.expired += 1
    result.archived += 1
  }
  state = parseLessons(lines.join('\n'))

  // 2. Invalidation named by a suggestion: 时效经验 may be disproved, a 铁律 may not.
  for (const suggestion of suggestions ?? []) {
    const id = String(suggestion?.invalidates ?? '').trim()
    if (id.length === 0) continue
    const target = findLesson(state, id)
    if (target === undefined || target.section !== 'exp') {
      result.dropped += 1
      continue
    }
    const reason = String(suggestion?.invalidReason ?? '').trim().slice(0, 80) || '被新观察证伪'
    archiveEntry(lines, target, reason, date)
    result.archived += 1
    state = parseLessons(lines.join('\n'))
  }

  // 3. Additions.
  for (const suggestion of suggestions ?? []) {
    const body = String(suggestion?.text ?? '').trim().slice(0, 200)
    if (body.length === 0) continue
    const section = suggestion?.section === 'rule' ? 'rule' : 'exp'
    const scope = String(suggestion?.scope ?? '').trim().slice(0, 200) || SCOPE_GLOBAL
    const anchor = suggestion?.anchor ?? { date, session: '', note: '' }
    const entries = allLessons(state)

    if (section === 'exp') {
      const match = bestDuplicate(state.get('exp') ?? [], body)
      if (match !== undefined) {
        // Same pit, same lesson: refresh the confirmation instead of appending a
        // near-copy. The sentence itself is never touched.
        replaceLessonLine(lines, match.id, renderLessonLine({ ...match, lastConfirmed: date }))
        result.merged += 1
        state = parseLessons(lines.join('\n'))
        continue
      }
      if (bestDuplicate([...entries.filter((entry) => entry.section !== 'exp')], body) !== undefined) {
        result.dropped += 1
        continue
      }
      if ((state.get('exp') ?? []).length >= limits.exp) {
        // Full and not a duplicate: keep the lesson in the daily note only.
        result.dropped += 1
        continue
      }
      const entry = {
        id: nextLessonId(state, 'exp'),
        section: 'exp',
        text: body,
        scope,
        lastConfirmed: date,
        appliesTo: String(suggestion?.appliesTo ?? '').trim().slice(0, 40),
        pending: false,
        invalidReason: '',
        invalidatedAt: '',
        anchor,
      }
      insertLessonLine(lines, 'exp', renderLessonLine(entry))
      result.added += 1
      state = parseLessons(lines.join('\n'))
      continue
    }

    const rules = state.get('rule') ?? []
    if (bestDuplicate(rules, body) !== undefined) {
      result.dropped += 1
      continue
    }
    if (bestDuplicate([...entries.filter((entry) => entry.section !== 'rule')], body) !== undefined) {
      result.dropped += 1
      continue
    }
    if (rules.filter((entry) => entry.pending === true).length >= stagingLimit) {
      result.dropped += 1
      continue
    }
    const entry = {
      id: nextLessonId(state, 'rule'),
      section: 'rule',
      text: body,
      scope,
      lastConfirmed: date,
      appliesTo: String(suggestion?.appliesTo ?? '').trim().slice(0, 40),
      // A rule the system proposed is never armed: it waits for a human.
      pending: true,
      invalidReason: '',
      invalidatedAt: '',
      anchor,
    }
    insertLessonLine(lines, 'rule', renderLessonLine(entry))
    result.pending += 1
    state = parseLessons(lines.join('\n'))
  }

  const changed = result.added + result.pending + result.merged + result.archived
  if (changed === 0) {
    return { text: beforeText, changed: false, ...result, version: readMeta(beforeText, LESSONS_TITLE).version }
  }
  return finishWrite(beforeText, lines, result)
}

/** Human adds an entry. A 铁律 added by hand is armed immediately: that is the authority. */
export function addManualLesson(text, entry, options = {}) {
  const date = String(options.date ?? todayKey())
  const beforeText = typeof text === 'string' && text.trim().length > 0 ? text : emptyLessons()
  const body = String(entry?.text ?? '').trim().slice(0, 200)
  if (body.length === 0) return { text: beforeText, changed: false, error: '内容为空' }
  const section = entry?.section === 'exp' ? 'exp' : 'rule'
  const limit = section === 'rule' ? LESSON_LIMITS.rule : LESSON_LIMITS.exp
  const state = parseLessons(beforeText)
  const entries = allLessons(state)
  if (bestDuplicate(entries, body) !== undefined) {
    return { text: beforeText, changed: false, error: '已经有一条很接近的教训了' }
  }
  const active = (state.get(section) ?? []).filter((candidate) => candidate.pending !== true)
  if (active.length >= limit) {
    return { text: beforeText, changed: false, error: `${section === 'rule' ? '铁律' : '时效经验'}已满 ${limit} 条，先作废一条` }
  }
  const lines = docLines(beforeText)
  insertLessonLine(lines, section, renderLessonLine({
    id: nextLessonId(state, section),
    section,
    text: body,
    scope: String(entry?.scope ?? '').trim().slice(0, 200) || SCOPE_GLOBAL,
    lastConfirmed: date,
    appliesTo: '',
    pending: false,
    invalidReason: '',
    invalidatedAt: '',
    anchor: { date, session: '', note: '人工新增' },
  }))
  return finishWrite(beforeText, lines, { added: 1 })
}

/** Approve one 待确认 铁律: clear the marker, keep the sentence. */
export function approveLesson(text, id, options = {}) {
  const date = String(options.date ?? todayKey())
  const beforeText = String(text ?? '')
  const state = parseLessons(beforeText)
  const target = findLesson(state, id)
  if (target === undefined || target.section !== 'rule') {
    return { text: beforeText, changed: false, error: '没有找到这条待确认铁律' }
  }
  if (target.pending !== true) return { text: beforeText, changed: false, error: '这条已经是生效的铁律' }
  if ((state.get('rule') ?? []).filter((entry) => entry.pending !== true).length >= LESSON_LIMITS.rule) {
    return { text: beforeText, changed: false, error: `铁律已满 ${LESSON_LIMITS.rule} 条，先作废一条再批准` }
  }
  const lines = docLines(beforeText)
  replaceLessonLine(lines, target.id, renderLessonLine({ ...target, pending: false, lastConfirmed: date }))
  return finishWrite(beforeText, lines, { approved: 1 })
}

/** Reject (or delete) one entry: it moves to 已作废 with a required reason. */
export function archiveLesson(text, id, reason, options = {}) {
  const date = String(options.date ?? todayKey())
  const beforeText = String(text ?? '')
  const state = parseLessons(beforeText)
  const target = findLesson(state, id)
  if (target === undefined || target.section === 'archive') {
    return { text: beforeText, changed: false, error: '没有找到这条教训' }
  }
  const value = String(reason ?? '').trim().slice(0, 80)
  if (value.length === 0) return { text: beforeText, changed: false, error: '作废必须填原因' }
  const lines = docLines(beforeText)
  archiveEntry(lines, target, value, date)
  return finishWrite(beforeText, lines, { archived: 1 })
}

/**
 * Human replace: the only path allowed to write a new sentence for an existing
 * 铁律. The old line still goes to 已作废 first, so the previous wording stays
 * readable and the system can never do this on its own.
 */
export function replaceLesson(text, id, newText, options = {}) {
  const date = String(options.date ?? todayKey())
  const beforeText = String(text ?? '')
  const state = parseLessons(beforeText)
  const target = findLesson(state, id)
  if (target === undefined || target.section !== 'rule') {
    return { text: beforeText, changed: false, error: '只有铁律可以替换' }
  }
  const body = String(newText ?? '').trim().slice(0, 200)
  if (body.length === 0) return { text: beforeText, changed: false, error: '新的写法不能为空' }
  if (normalizeForCompare(body) === normalizeForCompare(target.text)) {
    return { text: beforeText, changed: false, error: '和原文一样，没有需要替换的内容' }
  }
  const lines = docLines(beforeText)
  archiveEntry(lines, target, '人工替换', date)
  const afterArchive = parseLessons(lines.join('\n'))
  insertLessonLine(lines, 'rule', renderLessonLine({
    id: nextLessonId(afterArchive, 'rule'),
    section: 'rule',
    text: body,
    scope: target.scope,
    lastConfirmed: date,
    appliesTo: target.appliesTo,
    pending: target.pending === true,
    invalidReason: '',
    invalidatedAt: '',
    anchor: { date, session: '', note: '人工替换' },
  }))
  return finishWrite(beforeText, lines, { replaced: 1 })
}

/** Does this scope apply to the given working directory? v1: workspace + global. */
export function normalizeScopePath(value) {
  return String(value ?? '').trim().replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function scopeMatches(scope, cwd) {
  const value = String(scope ?? '').trim()
  if (value.length === 0 || value === SCOPE_GLOBAL || value.toLowerCase() === 'global') return true
  const current = normalizeScopePath(cwd)
  if (current.length === 0) return false
  return normalizeScopePath(value) === current
}

const POSITIVE_POLARITY = /(必须|务必|一定要|总是|只能|始终|要先|先要|需要先|一律)/
// `别` only counts as a negation when it starts a verb phrase; otherwise a word
// like 特别 would make an unrelated lesson look like it says "never".
const NEGATIVE_POLARITY = /(不要|不用|不必|禁止|切勿|绝不|不能|避免|无需|不需要|别(?:把|再|去|动|改|删|忘|急着|直接))/

/** +1 must, -1 never, 0 unclear (both markers or none). */
export function polarityOf(text) {
  const body = String(text ?? '')
  const positive = POSITIVE_POLARITY.test(body)
  const negative = NEGATIVE_POLARITY.test(body)
  if (positive === negative) return 0
  return positive ? 1 : -1
}

/**
 * Mechanical conflict scan: two active lessons about the same thing, one saying
 * 「必须」 and the other 「不要」.
 *
 * Detection belongs to the system so it is deterministic and visible; deciding
 * what to do about a conflict belongs to the self-account, which is why nothing
 * here resolves anything. The mark travels into the prompt unchanged.
 */
export function conflictPairs(state) {
  const entries = activeLessons(state)
  const pairs = []
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]
      const b = entries[j]
      if (normalizeScopePath(a.scope) !== normalizeScopePath(b.scope)) continue
      const polarityA = polarityOf(a.text)
      const polarityB = polarityOf(b.text)
      if (polarityA === 0 || polarityB === 0 || polarityA === polarityB) continue
      const score = similarity(a.text, b.text)
      if (score < CONFLICT_MIN_SIMILARITY || score >= LESSON_MERGE_SIMILARITY) continue
      pairs.push({ a, b, score })
    }
  }
  return pairs
}

export function conflictIds(state) {
  const ids = new Set()
  for (const pair of conflictPairs(state)) {
    ids.add(pair.a.id)
    ids.add(pair.b.id)
  }
  return ids
}

/** Active lessons that apply to `cwd`, plus how many belong to other workspaces. */
export function lessonsForScope(text, cwd) {
  const state = parseLessons(typeof text === 'string' ? text : '')
  const conflicts = conflictIds(state)
  const active = activeLessons(state)
  const rows = active.filter((entry) => scopeMatches(entry.scope, cwd))
  return {
    state,
    conflicts,
    rows,
    skipped: active.length - rows.length,
  }
}

/**
 * Render the lessons block for the prompt.
 *
 * Only the sentence reaches the model: no anchor, no evidence token, no
 * re-summary. `[冲突]` is kept on the line because ignoring a known conflict is
 * worse than seeing one.
 */
export function renderLessonsInjection(text, maxChars, options = {}) {
  if (typeof text !== 'string' || text.trim().length === 0 || maxChars <= 0) return ''
  const cwd = options.cwd
  const { conflicts, rows } = lessonsForScope(text, cwd)
  if (rows.length === 0) return ''
  rows.sort((a, b) => {
    if (a.section !== b.section) return a.section === 'rule' ? -1 : 1
    const aLocal = scopeMatches(a.scope, cwd) && a.scope !== SCOPE_GLOBAL
    const bLocal = scopeMatches(b.scope, cwd) && b.scope !== SCOPE_GLOBAL
    if (aLocal !== bLocal) return aLocal ? -1 : 1
    return b.lastConfirmed < a.lastConfirmed ? -1 : 1
  })
  const lines = [LESSONS_HEADING, '']
  let used = LESSONS_HEADING.length + 2
  let emittedConflict = false
  for (const row of rows) {
    const marked = conflicts.has(row.id)
    const line = `- [${row.section === 'rule' ? '铁律' : '时效经验'}] ${marked ? '[冲突] ' : ''}${row.text}`
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length + 1
    if (marked) emittedConflict = true
  }
  // Soft default while the self-account is empty: nobody has decided how this
  // assistant handles contradictory orders yet, so ask once before acting. Once
  // 「我是谁」 has lines, the caller stops passing `askOnConflict` and the line goes
  // away by itself.
  if (options.askOnConflict === true && emittedConflict) {
    const line = '- 两条教训互相冲突，我还没有自己的判断：动手前先问一次。'
    if (used + line.length <= maxChars) lines.push(line)
  }
  return lines.length > 2 ? lines.join('\n') : ''
}

export function lessonsStats(text) {
  const state = parseLessons(text)
  const rules = state.get('rule') ?? []
  const counts = {
    rule: rules.filter((entry) => entry.pending !== true).length,
    exp: (state.get('exp') ?? []).length,
    archive: (state.get('archive') ?? []).length,
  }
  return {
    counts,
    pending: rules.filter((entry) => entry.pending === true).length,
    conflicts: conflictIds(state).size,
  }
}

/**
 * Project the lessons document for the settings page.
 *
 * Archive rows are shown newest first (the file is append-only, so the newest
 * invalidation is at the bottom), and an anchor whose daily entry is gone says
 * so instead of pointing at nothing. The lesson itself is never dropped.
 */
export function describeLessons(text, options = {}) {
  const source = typeof text === 'string' && text.trim().length > 0 ? text : emptyLessons()
  const state = parseLessons(source)
  const conflicts = conflictIds(state)
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 3
  const dailyText = typeof options.dailyText === 'function' ? options.dailyText : undefined
  return LESSON_SECTIONS.map((section) => {
    const entries = (state.get(section.key) ?? []).map((entry) => {
      const note = entry.anchor.note
      const anchorGone = section.key === 'archive' || note.length === 0 || dailyText === undefined
        ? false
        : !String(dailyText(entry.anchor.date) ?? '').includes(note)
      return {
        id: entry.id,
        text: entry.text,
        scope: entry.scope,
        anchor: entry.anchor,
        anchorGone,
        lastConfirmed: entry.lastConfirmed,
        appliesTo: entry.appliesTo,
        pending: entry.pending,
        conflict: conflicts.has(entry.id),
        invalidReason: entry.invalidReason,
        invalidatedAt: entry.invalidatedAt,
      }
    })
    const ordered = section.key === 'archive' ? [...entries].reverse() : entries
    return {
      key: section.key,
      title: section.title,
      total: entries.length,
      // 铁律 and 时效经验 are already capped at five; only the archive folds.
      limit: section.key === 'archive' ? limit : 0,
      entries: ordered,
    }
  })
}

/** One daily-note candidate line: `- [rule] 下次先做这一步（证据：…）`. */
export function formatDailyLesson(row) {
  const evidence = String(row?.evidence ?? '').trim()
  const tail = evidence.length > 0 ? `（证据：${evidence}）` : ''
  return `- [${row?.section === 'rule' ? 'rule' : 'exp'}] ${String(row?.text ?? '').trim()}${tail}`
}

/**
 * Read the candidates back out of `## 可疑雷点`.
 * `- （无）` is the empty answer and must never come back as a candidate.
 */
export function parseDailyLessons(text) {
  const rows = []
  let section = ''
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('## ')) {
      section = line.slice(3).trim()
      continue
    }
    if (section !== SUSPECT_SECTION) continue
    const match = /^-\s*(?:\[(rule|exp)\])?\s*(.*)$/.exec(line)
    if (match === null) continue
    let body = match[2].trim()
    let evidence = ''
    const tail = /（证据：([^）]*)）\s*$/.exec(body)
    if (tail !== null) {
      evidence = tail[1].trim()
      body = body.slice(0, tail.index).trim()
    }
    if (body.length === 0 || body === '（无）') continue
    rows.push({ section: match[1] ?? 'exp', text: body, evidence })
  }
  return rows
}

/**
 * How many completed days in a row wrote 「（无）」 into 可疑雷点.
 *
 * Today is skipped: its note does not exist until the digest runs, and counting
 * it as empty would report a streak that has not happened yet. A note without the
 * section (written before this feature existed) also breaks the streak — it was
 * never asked, so it is not an empty answer.
 */
export function consecutiveEmptyDays(paths, now = new Date(), maxDays = 60) {
  if (paths === undefined || typeof paths.dailyDir !== 'string') return 0
  let count = 0
  for (let index = 1; index <= maxDays; index += 1) {
    const day = todayKey(new Date(now.getTime() - index * 86400000))
    const file = path.join(paths.dailyDir, `${day}.md`)
    if (!exists(file)) break
    const text = readText(file, '')
    if (!text.includes(`## ${SUSPECT_SECTION}`)) break
    if (parseDailyLessons(text).length > 0) break
    count += 1
  }
  return count
}

/** Export for tests. */
export { renderLessonLine }
