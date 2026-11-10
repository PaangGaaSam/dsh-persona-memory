import { normalizeForCompare, shortHash, similarity, todayKey } from './util.js'

/** Fixed section set and id prefixes for the user profile. */
export const PROFILE_SECTIONS = [
  { key: 'locked', title: '手动锁定', prefix: 'lock', userLocked: true },
  { key: 'preference', title: '稳定偏好', prefix: 'pref' },
  { key: 'style', title: '沟通习惯', prefix: 'style' },
  { key: 'thinking', title: '思维模式', prefix: 'think' },
  { key: 'avoid', title: '雷区', prefix: 'avoid' },
]

/** Fixed section set for the companion personality. */
export const PERSONA_SECTIONS = [
  { key: 'locked', title: '用户固定规则', prefix: 'lock', userLocked: true },
  { key: 'core', title: '核心性格', prefix: 'core' },
  { key: 'style', title: '相处风格', prefix: 'pstyle' },
  { key: 'candidate', title: '候选观察', prefix: 'cand' },
]

const KIND_TO_SECTION = {
  preference: 'preference',
  style: 'style',
  thinking: 'thinking',
  correction: 'avoid',
  friction: 'avoid',
}

const ENTRY_RE = /^-\s*(?:\[([a-z0-9-]+)\])?\s*(?:\[(P[01])\])?\s*(?:\[置信度\s*([0-9.]+)\])?\s*(?:\[最后验证\s*([0-9-]+)\])?\s*(.*)$/i

const EVIDENCE_SPLIT = /[、;；,，]+\s*/
const EVIDENCE_TOKEN = /^(\d{4}-\d{2}-\d{2})[/\s]+(.+)$/

/**
 * Parse the evidence string into `{date, session}` tokens.
 * Tolerates the separators people and models actually emit (`、`, `;`, `,`).
 */
export function parseEvidence(text) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) return []
  const tokens = []
  for (const part of raw.split(EVIDENCE_SPLIT)) {
    const value = part.trim()
    if (value.length === 0) continue
    const match = EVIDENCE_TOKEN.exec(value)
    tokens.push(match === null ? { date: '', session: value } : { date: match[1], session: match[2].trim() })
  }
  return tokens
}

/** Canonical evidence text: deduplicated, newest `max` tokens, `、`-joined. */
export function formatEvidence(tokens, max = 5) {
  const seen = new Set()
  const unique = []
  for (const token of tokens ?? []) {
    const session = String(token?.session ?? '').trim()
    const date = String(token?.date ?? '').trim()
    if (session.length === 0 && date.length === 0) continue
    const key = `${date}/${session}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ date, session })
  }
  return unique
    .slice(-max)
    .map((token) => (token.date === '' ? token.session : `${token.date}/${token.session}`))
    .join('、')
}

/** How many independent sessions and dates the evidence covers. */
export function evidenceStats(tokens) {
  const sessions = new Set()
  const dates = new Set()
  for (const token of tokens ?? []) {
    if (token?.session) sessions.add(token.session)
    if (token?.date) dates.add(token.date)
  }
  return { sessions: sessions.size, dates: dates.size }
}

function entryId(section, used) {
  const prefix = section.prefix
  let n = 1
  while (used.has(`${prefix}-${n}`)) n += 1
  used.add(`${prefix}-${n}`)
  return `${prefix}-${n}`
}

/**
 * Parse a profile/persona markdown document into sections of entries.
 * Unknown sections are ignored; the fixed section set is always present.
 */
export function parseProfile(text, sections) {
  const byKey = new Map(sections.map((s) => [s.key, s]))
  const state = new Map(sections.map((s) => [s.key, []]))
  let current = null
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trimEnd()
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim()
      const match = [...byKey.values()].find((s) => s.title === title)
      current = match === undefined ? null : match.key
      continue
    }
    if (current === null) continue
    const m = ENTRY_RE.exec(line.trim())
    if (m === null) continue
    const body = (m[5] ?? '').trim()
    if (body.length === 0) continue
    const evidenceMatch = /（证据：([^）]*)）\s*$/.exec(body)
    const evidence = evidenceMatch === null ? '' : evidenceMatch[1].trim()
    const textBody = evidenceMatch === null ? body : body.slice(0, evidenceMatch.index).trim()
    state.get(current).push({
      id: m[1] ?? entryId(byKey.get(current), new Set(state.get(current).map((e) => e.id))),
      pinned: m[2] === 'P0' || m[2] === 'P1',
      confidence: m[3] === undefined ? 0.5 : Math.max(0, Math.min(1, Number(m[3]))),
      lastVerified: m[4] ?? '',
      text: textBody,
      evidence,
      userLocked: byKey.get(current).userLocked === true,
    })
  }
  return state
}

export function emptyProfile(sections, title) {
  const head = [
    '---',
    'version: 0',
    `updatedAt: ${new Date().toISOString()}`,
    `title: ${title}`,
    '---',
    '',
    '<!-- 本文件由 dsh-persona-memory 自动维护；「手动锁定」区只读，不会被自动改写。 -->',
    '',
  ]
  const body = sections.map((s) => `## ${s.title}\n`).join('\n')
  return head.join('\n') + body
}

function serialize(sections, state, meta) {
  const lines = [
    '---',
    `version: ${meta.version}`,
    `updatedAt: ${meta.updatedAt}`,
    `title: ${meta.title}`,
    '---',
    '',
    '<!-- 本文件由 dsh-persona-memory 自动维护；「手动锁定」区只读，不会被自动改写。 -->',
    '',
  ]
  for (const section of sections) {
    lines.push(`## ${section.title}`)
    const entries = state.get(section.key) ?? []
    for (const entry of entries) {
      const parts = [`- [${entry.id}]`]
      if (entry.pinned) parts.push('[P1]')
      parts.push(`[置信度 ${Number(entry.confidence).toFixed(2)}]`)
      if (entry.lastVerified !== '') parts.push(`[最后验证 ${entry.lastVerified}]`)
      const evidence = entry.evidence !== '' ? `（证据：${entry.evidence}）` : ''
      parts.push(`${entry.text}${evidence}`)
      lines.push(parts.join(' ').replace(/ - \[/g, '- ['))
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Apply stage-3 suggestions to a document.
 * Suggestions are merged by near-duplicate text (similarity >= 0.85); otherwise
 * appended with a fresh id. Pinned and user-locked entries are never rewritten.
 * @returns {{text:string, applied:number, merged:number, version:number}}
 */
export function applySuggestions(text, sections, suggestions, options = {}) {
  const date = options.date ?? todayKey()
  const title = options.title ?? 'profile'
  const state = parseProfile(text.length > 0 ? text : emptyProfile(sections, title), sections)
  const used = new Set([...state.values()].flatMap((entries) => entries.map((e) => e.id)))
  const meta = { ...readMeta(text, title), updatedAt: new Date().toISOString() }
  let applied = 0
  let merged = 0
  for (const suggestion of suggestions ?? []) {
    const sectionKey = KIND_TO_SECTION[suggestion.kind] ?? suggestion.section
    const section = sections.find((s) => s.key === sectionKey)
    if (section === undefined || section.userLocked === true) continue
    const body = String(suggestion.text ?? '').trim()
    if (body.length === 0) continue
    const entries = state.get(sectionKey)
    const confidence = Math.max(0, Math.min(1, Number(suggestion.confidence ?? 0.6)))
    const evidenceTokens = parseEvidence(suggestion.evidence ?? '')
    if (evidenceTokens.length === 0) evidenceTokens.push({ date, session: '' })
    const evidence = formatEvidence(evidenceTokens)
    let best = null
    let bestScore = 0
    for (const entry of entries) {
      if (entry.pinned || entry.userLocked) continue
      const score = similarity(entry.text, body)
      if (score > bestScore) {
        best = entry
        bestScore = score
      }
    }
    if (best !== null && bestScore >= 0.85) {
      best.evidence = formatEvidence([...parseEvidence(best.evidence), ...evidenceTokens])
      best.confidence = Math.min(1, Math.max(best.confidence, confidence) + 0.02)
      best.lastVerified = date
      merged += 1
      continue
    }
    entries.push({
      id: entryId(section, used),
      pinned: false,
      confidence,
      lastVerified: date,
      text: body,
      evidence,
      userLocked: false,
    })
    applied += 1
  }
  if (applied + merged > 0) meta.version += 1
  meta.updatedAt = new Date().toISOString()
  return { text: serialize(sections, state, meta), applied, merged, version: meta.version }
}

/** Promotion thresholds for the companion personality. */
export const PERSONA_POLICY = {
  styleMinSessions: 3,
  coreMinSessions: 3,
  coreMinDates: 3,
  demoteAfterDays: 30,
}

const PERSONA_MOVABLE = ['core', 'style', 'candidate']

function personaSectionFor(entry, policy) {
  const stats = evidenceStats(parseEvidence(entry.evidence))
  if (stats.sessions >= policy.coreMinSessions && stats.dates >= policy.coreMinDates) return 'core'
  if (stats.sessions >= policy.styleMinSessions) return 'style'
  return 'candidate'
}

function moveEntry(state, fromKey, toKey, entry) {
  if (fromKey === toKey) return false
  const from = state.get(fromKey) ?? []
  const index = from.indexOf(entry)
  if (index >= 0) from.splice(index, 1)
  const target = state.get(toKey)
  if (target === undefined) return false
  target.push(entry)
  return true
}

/** Whole days between two `YYYY-MM-DD` keys; the reference is the digest date. */
function daysBetween(fromDay, toDay) {
  const from = Date.parse(`${fromDay}T00:00:00`)
  const to = Date.parse(`${toDay}T00:00:00`)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.floor((to - from) / 86400000)
}

/**
 * Merge personality suggestions with evidence-based promotion and decay.
 *
 * Observed behaviour: a suggestion only enters 核心性格 when it has enough
 * independent sessions *and* distinct dates, 相处风格 when it has enough
 * sessions (a single day may qualify), and 候选观察 otherwise. Entries move
 * between sections as evidence accumulates, a contradicting observation
 * (`supersedes`) pushes the old entry back to candidates, and entries that stop
 * collecting evidence for `demoteAfterDays` step back without being deleted.
 * Pinned and user-locked entries never move.
 */
export function applyPersonaSuggestions(text, sections, suggestions, options = {}) {
  const date = options.date ?? todayKey()
  const title = options.title ?? '助手性格'
  const policy = {
    styleMinSessions: Number(options.styleMinSessions ?? PERSONA_POLICY.styleMinSessions),
    coreMinSessions: Number(options.coreMinSessions ?? PERSONA_POLICY.coreMinSessions),
    coreMinDates: Number(options.coreMinDates ?? PERSONA_POLICY.coreMinDates),
    demoteAfterDays: Number(options.demoteAfterDays ?? PERSONA_POLICY.demoteAfterDays),
  }
  const state = parseProfile(text.length > 0 ? text : emptyProfile(sections, title), sections)
  const meta = { ...readMeta(text, title), updatedAt: new Date().toISOString() }
  const used = new Set([...state.values()].flatMap((entries) => entries.map((e) => e.id)))
  const result = { applied: 0, merged: 0, promoted: 0, demoted: 0, superseded: 0 }

  for (const suggestion of suggestions ?? []) {
    const body = String(suggestion.text ?? '').trim()
    if (body.length === 0) continue
    const evidenceTokens = parseEvidence(suggestion.evidence ?? '')
    if (evidenceTokens.length === 0) evidenceTokens.push({ date, session: '' })
    const confidence = Math.max(0, Math.min(1, Number(suggestion.confidence ?? 0.6)))

    // A contradicting observation names the entry it overrides; that entry steps
    // back to candidates instead of coexisting with its opposite.
    const supersededId = typeof suggestion.supersedes === 'string' ? suggestion.supersedes.trim() : ''
    if (supersededId !== '') {
      for (const key of PERSONA_MOVABLE) {
        const target = (state.get(key) ?? []).find((entry) => entry.id === supersededId)
        if (target === undefined) continue
        if (target.pinned || target.userLocked) break
        target.confidence = Math.max(0.05, Number((target.confidence - 0.3).toFixed(2)))
        if (moveEntry(state, key, 'candidate', target)) result.superseded += 1
        break
      }
    }

    let best = null
    let bestKey = ''
    let bestScore = 0
    for (const key of PERSONA_MOVABLE) {
      for (const entry of state.get(key) ?? []) {
        if (entry.pinned || entry.userLocked) continue
        const score = similarity(entry.text, body)
        if (score > bestScore) {
          best = entry
          bestKey = key
          bestScore = score
        }
      }
    }

    if (best !== null && bestScore >= 0.85) {
      best.evidence = formatEvidence([...parseEvidence(best.evidence), ...evidenceTokens])
      best.confidence = Math.min(1, Math.max(best.confidence, confidence) + 0.02)
      const dated = evidenceTokens.map((token) => token.date).filter(Boolean).sort()
      const latest = dated.length > 0 ? dated[dated.length - 1] : date
      best.lastVerified = best.lastVerified > latest ? best.lastVerified : latest
      best.userLocked = false
      result.merged += 1
      const target = personaSectionFor(best, policy)
      if (target !== bestKey && moveEntry(state, bestKey, target, best)) {
        if (PERSONA_MOVABLE.indexOf(target) < PERSONA_MOVABLE.indexOf(bestKey)) result.promoted += 1
      }
      continue
    }

    const entry = {
      id: entryId(sections.find((s) => s.key === 'candidate') ?? sections[0], used),
      pinned: false,
      confidence,
      lastVerified: evidenceTokens.map((token) => token.date).filter(Boolean).sort().pop() ?? date,
      text: body,
      evidence: formatEvidence(evidenceTokens),
      userLocked: false,
    }
    const target = personaSectionFor(entry, policy)
    state.get(target).push(entry)
    result.applied += 1
  }

  // Decay: an entry that stopped collecting evidence steps back, never deleted.
  for (const key of ['core', 'style']) {
    for (const entry of [...(state.get(key) ?? [])]) {
      if (entry.pinned || entry.userLocked || entry.lastVerified === '') continue
      if (daysBetween(entry.lastVerified, date) < policy.demoteAfterDays) continue
      if (moveEntry(state, key, 'candidate', entry)) result.demoted += 1
    }
  }

  const changed = result.applied + result.merged + result.promoted + result.demoted + result.superseded
  if (changed > 0) meta.version += 1
  return { text: serialize(sections, state, meta), ...result, version: meta.version }
}

/** Frontmatter version/title, so a rewrite never resets what the document already recorded. */
function readMeta(text, fallbackTitle) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)
  const source = fm === null ? '' : fm[1]
  const version = /version:\s*(\d+)/.exec(source)
  const title = /title:\s*(.+)/.exec(source)
  return {
    version: version === null ? 0 : Number(version[1]),
    title: title?.[1]?.trim() ?? fallbackTitle,
  }
}

/** Add one entry to the user-locked section, exactly as the user phrased it. */
export function appendLockedEntry(text, sections, content, options = {}) {
  const date = options.date ?? todayKey()
  const fallbackTitle = options.title ?? 'profile'
  const state = parseProfile(text.length > 0 ? text : emptyProfile(sections, fallbackTitle), sections)
  const locked = state.get('locked')
  const used = new Set([...state.values()].flatMap((entries) => entries.map((e) => e.id)))
  const body = String(content ?? '').trim()
  if (body.length === 0) return { text, added: false }
  locked.push({
    id: entryId(sections.find((s) => s.key === 'locked'), used),
    pinned: true,
    confidence: 1,
    lastVerified: date,
    text: body,
    evidence: '用户口述',
    userLocked: true,
  })
  const meta = readMeta(text, fallbackTitle)
  return {
    text: serialize(sections, state, { version: meta.version, updatedAt: new Date().toISOString(), title: meta.title }),
    added: true,
  }
}

/**
 * Render the injection text for a prompt section: pinned entries first, then the
 * most recently verified, until the character budget is spent.
 */
export function renderForInjection(text, sections, heading, maxChars) {
  if (text.length === 0 || maxChars <= 0) return ''
  const state = parseProfile(text, sections)
  const rows = []
  for (const section of sections) {
    for (const entry of state.get(section.key) ?? []) rows.push({ ...entry, sectionTitle: section.title })
  }
  if (rows.length === 0) return ''
  rows.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.lastVerified !== b.lastVerified) return a.lastVerified < b.lastVerified ? 1 : -1
    return b.confidence - a.confidence
  })
  const lines = [heading, '']
  let used = heading.length + 2
  for (const row of rows) {
    const line = `- [${row.sectionTitle}] ${row.pinned ? '[固定] ' : ''}${row.text}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.length > 2 ? lines.join('\n') : ''
}

/** Summarize document stats for status output. */
export function documentStats(text, sections) {
  const state = parseProfile(text, sections)
  const counts = {}
  let pinned = 0
  for (const section of sections) {
    const entries = state.get(section.key) ?? []
    counts[section.title] = entries.length
    pinned += entries.filter((e) => e.pinned).length
  }
  return { counts, pinned }
}

/** Pin or unpin one entry by id, keeping every other byte of the document. */
export function setPinned(text, sections, id, pinned, options = {}) {
  const state = parseProfile(text, sections)
  for (const entries of state.values()) {
    for (const entry of entries) {
      if (entry.id !== id) continue
      entry.pinned = pinned === true
      const meta = readMeta(text, options.title ?? 'profile')
      return {
        text: serialize(sections, state, { version: meta.version, updatedAt: new Date().toISOString(), title: meta.title }),
        changed: true,
      }
    }
  }
  return { text, changed: false }
}

/** Export for tests. */
export { serialize, KIND_TO_SECTION }
