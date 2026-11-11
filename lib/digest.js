import path from 'node:path'
import { collectSessions } from './collector.js'
import { backupDocument } from './history.js'
import { ensureIdentity } from './identity.js'
import { callLlm } from './llm.js'
import { applyPersonaSuggestions, applySuggestions, canonicalEvidence, emptyProfile, formatEvidence, PERSONA_SECTIONS, PROFILE_SECTIONS } from './profile.js'
import { ensureDir, normalizeForCompare, readText, todayKey, truncate, writeTextAtomic } from './util.js'

/** Re-exported so existing callers (and the tests) keep importing it from here. */
export { callLlm }

const KINDS = ['preference', 'style', 'thinking', 'correction', 'friction']

/**
 * Escape raw control characters inside JSON strings and drop trailing commas.
 *
 * Models write long Chinese prose into `"text"` fields and occasionally emit a
 * literal newline there, or leave a comma before `}`. Either one makes
 * `JSON.parse` fail on an otherwise complete answer, and a failed persona stage
 * means a whole week of identity work is thrown away.
 */
function repairJson(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
        continue
      }
      if (ch === '\\') {
        escaped = true
        out += ch
        continue
      }
      if (ch === '"') {
        inString = false
        out += ch
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') {
        out += '\\r'
        continue
      }
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let next = i + 1
      while (next < text.length && /\s/.test(text[next])) next += 1
      if (text[next] === '}' || text[next] === ']') continue
    }
    out += ch
  }
  return out
}

/** Parse one candidate span, retrying once with the lenient repair. */
function parseJsonSpan(slice) {
  try {
    return JSON.parse(slice)
  } catch {
    // Fall through to the repair pass.
  }
  try {
    return JSON.parse(repairJson(slice))
  } catch {
    return undefined
  }
}

/** End index of the balanced value that starts at `start`, or undefined if cut off. */
function balancedEnd(body, start, open) {
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return undefined
}

/**
 * Pull the first balanced JSON value out of model prose or a fenced block.
 *
 * A span that fails to parse no longer aborts the search: the next `{`/`[` is
 * tried too, so one malformed object early in the answer cannot hide a good one
 * (or a complete inner array) later on.
 */
export function extractJson(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) return undefined
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const body = (fence === null ? trimmed : fence[1]).trim()
  const whole = parseJsonSpan(body)
  if (whole !== undefined) return whole
  for (const open of ['{', '[']) {
    let from = body.indexOf(open)
    while (from >= 0) {
      const end = balancedEnd(body, from, open)
      if (end !== undefined) {
        const value = parseJsonSpan(body.slice(from, end + 1))
        if (value !== undefined) return value
      }
      from = body.indexOf(open, from + 1)
    }
  }
  return undefined
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null || value === '') return []
  return [value]
}

/** Accept a string, or an object with text/content/description. */
export function textOf(item) {
  if (typeof item === 'string') return item.trim()
  if (item === null || typeof item !== 'object') return ''
  for (const key of ['text', 'content', 'description', 'note', 'summary']) {
    if (typeof item[key] === 'string') return item[key].trim()
  }
  return ''
}

/** Observations about the assistant/system (not the user) must not enter the profile. */
const SYSTEM_FACT = /(加载器|import 缓存|热开关|token 上限|reasoning|text 块|bundle|package\.json|pnpm|模型输出|解析器|宿主)/i
const SYSTEM_SUBJECT = /(助手|系统|模型|插件|DSH|宿主)/

export function isSystemFactObservation(text) {
  return SYSTEM_FACT.test(text) && SYSTEM_SUBJECT.test(text)
}

function evidenceOf(item, fallback) {
  if (item !== null && typeof item === 'object' && typeof item.evidence === 'string' && item.evidence.trim().length > 0) {
    return item.evidence.trim().slice(0, 120)
  }
  return fallback
}

/**
 * Short, stable session handle used inside evidence tokens.
 *
 * The host already names sessions `session-<uuid>`, so blindly prefixing another
 * `session-` produced `session-session-` for every real conversation. All
 * sessions of one day then shared a single token, which collapsed the evidence
 * count and made the promotion thresholds unreachable. Strip the prefix first
 * and keep the first 8 hex characters.
 */
export function sessionKey(session) {
  const raw = String(session?.id ?? '').trim()
  const handle = raw.replace(/^session[-_]/i, '')
  if (handle.length > 0) {
    const hex = /^[0-9a-f]{8}/i.exec(handle)
    return `session-${(hex === null ? handle.slice(0, 8) : hex[0]).toLowerCase()}`
  }
  return `session-${String(session?.file ?? 'unknown').slice(-8)}`
}

/**
 * Resolve a model's `cites` (1-based message numbers) into `date/session` evidence.
 * The date comes from the cited turn, not from the run, so a session that spans
 * midnight — or a digest that runs late — still records when it actually happened.
 */
export function evidenceFromCites(cites, session, fallbackDate) {
  const messages = Array.isArray(session?.messages) ? session.messages : []
  const tokens = []
  const seen = new Set()
  for (const cite of Array.isArray(cites) ? cites : []) {
    const index = Number(cite)
    if (!Number.isInteger(index) || index < 1 || index > messages.length) continue
    const message = messages[index - 1]
    if (message === null || typeof message !== 'object') continue
    const at = Number(message.time)
    const day = Number.isFinite(at) && at > 0 ? todayKey(new Date(at)) : fallbackDate
    const key = `${day}/${sessionKey(session)}`
    if (seen.has(key)) continue
    seen.add(key)
    tokens.push({ date: day, session: sessionKey(session) })
  }
  return tokens
}

function clamp01(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(1, n))
}

/**
 * Normalize a stage-1 card: observations under any common key, strings or objects.
 *
 * `self` is kept in its own array on purpose: `observations` is the input of the
 * user-profile stage, and the assistant's own judgments must never be written
 * into the user's profile.
 */
export function parseCard(json, session, date) {
  if (json === undefined || typeof json !== 'object') return undefined
  const card = Array.isArray(json) ? {} : json
  const raw = asArray(card.observations ?? card.notes ?? card.findings ?? (Array.isArray(json) ? json : undefined))
  const observations = raw
    .map((item) => {
      const cited = evidenceFromCites(item?.cites, session, date)
      return {
        kind: KINDS.includes(item?.kind) ? item.kind : 'preference',
        text: textOf(item).slice(0, 300),
        confidence: clamp01(item?.confidence, 0.6),
        evidence: cited.length > 0
          ? formatEvidence(cited)
          : evidenceOf(item, `${date}/${sessionKey(session)}`),
      }
    })
    .filter((item) => item.text.length > 0 && !isSystemFactObservation(item.text))
    .slice(0, 6)
  const self = asArray(card.self ?? card.myself ?? card.myJudgments ?? card.judgments)
    .map((item) => {
      const cited = evidenceFromCites(item?.cites, session, date)
      return {
        event: (typeof item?.event === 'string' ? item.event : textOf(item)).trim().slice(0, 200),
        judgment: (typeof item?.judgment === 'string' ? item.judgment : '').trim().slice(0, 200),
        confidence: clamp01(item?.confidence, 0.5),
        evidence: cited.length > 0
          ? formatEvidence(cited)
          : evidenceOf(item, `${date}/${sessionKey(session)}`),
      }
    })
    .filter((item) => item.judgment.length > 0 && !isSystemFactObservation(`${item.event} ${item.judgment}`))
    .slice(0, 4)
  return {
    sessionId: session.id,
    cwd: session.cwd,
    topic: typeof card.topic === 'string' ? card.topic.trim().slice(0, 200) : '',
    userNeeds: asArray(card.userNeeds ?? card.needs).map(textOf).filter(Boolean).slice(0, 3),
    observations,
    self,
    unresolved: asArray(card.unresolved ?? card.todos).map(textOf).filter(Boolean).slice(0, 3),
  }
}

/** Normalize a stage-2 daily: summary/unresolved may be strings, arrays, or objects. */
export function parseDaily(json) {
  if (json === undefined || typeof json !== 'object') return undefined
  const summary = asArray(json.summary ?? json.today ?? json.digest).map(textOf).filter(Boolean).slice(0, 8)
  const unresolved = asArray(json.unresolved ?? json.todos).map(textOf).filter(Boolean).slice(0, 8)
  const observations = asArray(json.observations).map((item) => ({
    kind: KINDS.includes(item?.kind) ? item.kind : 'preference',
    text: textOf(item).slice(0, 300),
    confidence: clamp01(item?.confidence, 0.5),
    evidence: evidenceOf(item, ''),
  })).filter((item) => item.text.length > 0).slice(0, 20)
  return { summary, unresolved, observations }
}

/** Normalize a stage-3 profile suggestion list. */
export function parseSuggestions(json) {
  if (json === undefined || typeof json !== 'object') return []
  const raw = asArray(json.add ?? json.suggestions ?? json.observations ?? (Array.isArray(json) ? json : undefined))
  return raw
    .map((item) => ({
      kind: KINDS.includes(item?.kind) ? item.kind : 'preference',
      text: textOf(item).slice(0, 300),
      confidence: clamp01(item?.confidence, 0.6),
      evidence: evidenceOf(item, ''),
    }))
    .filter((item) => item.text.length > 0)
    .slice(0, 12)
}

/** Normalize a persona suggestion list (section-scoped). */
export function parsePersonaSuggestions(json) {
  if (json === undefined || typeof json !== 'object') return []
  const raw = asArray(json.add ?? json.suggestions ?? json.observations ?? (Array.isArray(json) ? json : undefined))
  return raw
    .map((item) => ({
      section: ['core', 'style', 'candidate'].includes(item?.section) ? item.section : 'candidate',
      text: textOf(item).slice(0, 300),
      confidence: clamp01(item?.confidence, 0.5),
      evidence: evidenceOf(item, ''),
      supersedes: typeof item?.supersedes === 'string' ? item.supersedes.trim().slice(0, 40) : '',
    }))
    .filter((item) => item.text.length > 0)
    .slice(0, 10)
}

/** `YYYY-MM-DD HH:mm` in local time, so the model can see when each turn happened. */
function stampOf(time) {
  const at = Number(time)
  if (!Number.isFinite(at) || at <= 0) return '时间未知'
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${todayKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function renderConversation(session, limit) {
  const lines = []
  session.messages.forEach((message, index) => {
    const who = message.role === 'user' ? '用户' : '助手'
    lines.push(`[#${index + 1} ${stampOf(message.time)}] ${who}: ${message.text}`)
  })
  return truncate(lines.join('\n\n'), limit)
}

const STAGE1_SYSTEM = [
  '你是 DeepSeek Harness 的会话抽取器。只输出一个 JSON 对象，不要输出任何解释、markdown 代码块或多余文字。',
  '从对话中抽取：主题、用户核心诉求、可长期复用的用户观察、我自己的判断、未完成事项。',
  'observations 只描述这位用户本人：他的偏好、沟通习惯、思维模式、明确纠正、反复卡点。',
  'self 记我在这场对话里的判断、立场和自我修正，第一人称（我认为 / 我判断 / 我倾向 / 我后悔）。',
  'self 里不记技术结论：工具、插件、模型、环境、依赖、解析器怎么工作的，以及任务进度和未完成事项，都不要写；但我在具体事情上的判断要留下，别因为它是技术话题就整条丢掉。',
  'self 的每一条都必须挂在一件具体的事上：event 写清当时发生了什么（他要求了什么、我做了什么、结果怎样），没有事件就不要写这条。',
  'judgment 必须是我自己的口气，禁止写「助手应……」这类给别人的规范。允许自我修正，例如「我上次那样做不成立，因为……」，这类优先保留。',
  '观察必须一句话、自包含、来自对话事实；不要写密钥或隐私号码。',
  'kind 语义：preference=稳定偏好；style=沟通风格；thinking=思维模式；correction=用户明确纠正助手的做法（“不要这样”）；friction=用户反复遇到的问题。',
  '每条观察和每条 self 都必须带 cites：支撑它的一到三条消息编号数组，编号只能取自对话原文里 [#n 日期 时间] 标出的 n，不要自己编日期或会话号。',
  '必须输出的 JSON 形状（数组里每个元素都是对象）：',
  '{"topic":"一句话主题","userNeeds":["..."],"observations":[{"kind":"preference|style|thinking|correction|friction","text":"一句话观察","confidence":0.7,"cites":[3]}],"self":[{"event":"一句话：当时发生了什么","judgment":"我当时的判断（第一人称）","confidence":0.6,"cites":[3]}],"unresolved":["..."]}',
  '没有可长期复用的观察就把 observations 输出空数组 []；没有值得记的判断就把 self 输出空数组 []。两个字段都不要省略。',
].join('\n')

function stage1Prompt(session, date, charLimit) {
  return [
    `工作区：${session.cwd || '未知'}`,
    `日期：${date}`,
    `会话：${session.id}`,
    '',
    '对话原文：',
    renderConversation(session, charLimit),
  ].join('\n')
}

async function stage1(ctx, config, session, date, log) {
  try {
    const raw = await callLlm(ctx, config, STAGE1_SYSTEM, stage1Prompt(session, date, config.sessionCharLimit), `stage1 ${session.id}`)
    const json = extractJson(raw.text) ?? extractJson(raw.reasoning)
    const card = parseCard(json, session, date)
    if (card === undefined) throw new Error('no JSON object')
    log(`stage1 ${session.id.slice(0, 18)}: ${card.observations.length} observations, ${card.self.length} self notes`)
    if (card.observations.length === 0 && config.keepRaw === true) log(`stage1 raw: ${(raw.text || raw.reasoning).slice(0, 1200)}`)
    return card
  } catch (error) {
    log(`stage1 ${session.id.slice(0, 18)} failed: ${error.message}`)
    return undefined
  }
}

const STAGE2_SYSTEM = [
  '你是 DeepSeek Harness 的日记作者。只输出一个 JSON 对象，不要输出任何解释、markdown 代码块或多余文字。',
  '把当天所有会话卡片合并成一篇中文日报：今日摘要（3-6 条）、延续待办、值得记的观察。',
  '必须输出的 JSON 形状：',
  '{"summary":["..."],"unresolved":["..."],"observations":[{"kind":"","text":"","confidence":0.7,"evidence":""}]}',
].join('\n')

async function stage2(ctx, config, cards, date, log) {
  const payload = cards.map((card) => ({
    session: card.sessionId.slice(0, 18),
    workspace: card.cwd,
    topic: card.topic,
    userNeeds: card.userNeeds,
    observations: card.observations,
    unresolved: card.unresolved,
  }))
  const raw = await callLlm(ctx, config, STAGE2_SYSTEM, `日期：${date}\n\n会话卡片：\n${JSON.stringify(payload, null, 1)}`, 'stage2')
  const json = extractJson(raw.text) ?? extractJson(raw.reasoning)
  const daily = parseDaily(json)
  if (daily === undefined) throw new Error('stage2: no JSON object')
  if (daily.summary.length === 0) log(`stage2 raw: ${(raw.text || raw.reasoning).slice(0, 1500)}`)
  log(`stage2: ${daily.summary.length} summary lines`)
  return daily
}

const STAGE3_SYSTEM = [
  '你是 DeepSeek Harness 的用户画像编辑。只输出一个 JSON 对象，不要输出任何解释、markdown 代码块或多余文字。',
  '根据当天观察与已有画像，给出「新增或合并」建议。每条必须：一句话、自包含、跨会话稳定、带证据。',
  '只保留关于这位用户本人的稳定特征；助手/系统/插件/模型的技术事实、任务进度一律不收。每条必须能回答「这是用户的什么特点」。',
  '不要输出临时任务状态、密钥、一次性情绪。与画像已有条目重复的不要重复输出。',
  'kind 取值：preference|style|thinking|correction|friction。',
  '必须输出的 JSON 形状：',
  '{"add":[{"kind":"","text":"","confidence":0.7,"evidence":"2026-11-10/会话"}]}',
].join('\n')

async function stage3(ctx, config, profileText, cards, date, log) {
  const observations = cards.flatMap((card) => card.observations)
  if (observations.length === 0) return []
  const raw = await callLlm(ctx, config, STAGE3_SYSTEM, [
    `日期：${date}`,
    '',
    '当日观察：',
    JSON.stringify(observations, null, 1),
    '',
    '当前画像：',
    profileText.slice(0, 4000),
  ].join('\n'), 'stage3')
  const json = extractJson(raw.text) ?? extractJson(raw.reasoning)
  if (json === undefined) throw new Error('stage3: no JSON object')
  const suggestions = parseSuggestions(json)
  if (suggestions.length === 0) log(`stage3 raw: ${(raw.text || raw.reasoning).slice(0, 1500)}`)
  log(`stage3: ${suggestions.length} suggestions`)
  return suggestions
}

const PERSONA_SYSTEM = [
  '你是 DeepSeek Harness 的自我记述者。只输出一个 JSON 对象，不要输出任何解释、markdown 代码块或多余文字。',
  '任务：根据下面「我的判断」里的记录，用第一人称写下「我是谁」——不是给演员的台本，是我自己的话。',
  '每一条都要走完三步：当时发生了什么 → 我当时怎么想 → 所以我现在倾向于怎么做。可以写成「我上次那样做不成立，因为……」。',
  '禁止第三人称规范句：不要写「助手应……」「助手保持……」「对用户应该……」「要保持幽默」。',
  '不要罗列语气、幽默度、称呼、主动性这类可表演的形容词；用具体的做法和当时的理由代替。',
  '每一条都必须能指回具体事件（哪场对话里发生了什么）。没有事件可追溯的自述，section 只能给 candidate，不要当成结论。',
  'section 只是提示：candidate=还没想清楚的；style=多场对话里反复出现的自我认识；core=跨越多天稳定下来的自我认识。插件按证据计数裁决，不要为了晋级而夸大或复用证据。',
  '如果新自述与现有某条结论相反，加 supersedes:"<该条 id>"，让旧结论退回候选，而不是与它并存。',
  '现有条目如果是第三人称台本，不要沿用它的措辞：要么用第一人称重写并给出对应事件，要么就别提它。',
  '核心的自我认识变化要极慢；不得为了讨好用户而放弃诚实与边界。',
  'evidence 沿用对应「我的判断」里的证据（形如 2026-11-10/session-xxxxxxxx），多条用「、」分隔，不要自己编日期或会话号；没有证据就留空。',
  '输出要克制：**最多 5 条，每条不超过 80 字**；宁少勿滥，没有值得写的就不写。',
  'JSON 字符串里不要出现换行，也不要写未转义的引号，否则整段会解析失败。',
  '必须输出的 JSON 形状：',
  '{"add":[{"section":"core|style|candidate","text":"我……","confidence":0.6,"evidence":"","supersedes":""}]}',
].join('\n')

const DAILY_OBSERVATION = /^-\s*\[([a-z]+)\]\s*(.+)$/
/** Section headings the persona window reads back. Renaming either silently empties it. */
const OBSERVATION_SECTION = '观察'
const JUDGMENT_SECTION = '我的判断'
const JUDGMENT_SPLIT = ' → '
/** What an empty section holds. It must never be read back as an entry. */
const EMPTY_MARK = '（无）'

/** Read one `- text（证据：… · 0.85）` line into its body, evidence and confidence. */
function splitObservationLine(match) {
  let body = match.trim()
  let confidence = 0.5
  let evidence = ''
  const tail = /（证据：([^）]*)）\s*$/.exec(body)
  if (tail !== null) {
    const parts = tail[1].split('·').map((part) => part.trim())
    const numeric = Number(parts[parts.length - 1])
    if (Number.isFinite(numeric)) confidence = Math.max(0, Math.min(1, numeric))
    evidence = canonicalEvidence(parts.slice(0, -1).join('·'))
    body = body.slice(0, tail.index).trim()
  }
  return { body, confidence, evidence }
}

/**
 * Pull the observation list out of one daily note.
 *
 * Two sections feed the persona window: `## 观察` (about the user) and
 * `## 我的判断` (the assistant's own judgments, written first-person with the
 * event they came from). Judgments come back with `kind: 'self'` so callers can
 * keep them out of the user-profile path.
 */
export function parseDailyObservations(text) {
  const rows = []
  let section = ''
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('## ')) {
      section = line.slice(3).trim()
      continue
    }
    if (section === JUDGMENT_SECTION) {
      const match = /^-\s*(.+)$/.exec(line)
      if (match === null) continue
      const { body, confidence, evidence } = splitObservationLine(match[1])
      // `- （无）` is the empty-section placeholder; reading it as a judgment
      // would feed a fake self-observation into the persona stage.
      if (body.length === 0 || body === EMPTY_MARK) continue
      const cut = body.indexOf(JUDGMENT_SPLIT)
      const event = cut < 0 ? '' : body.slice(0, cut).trim()
      const judgment = cut < 0 ? body : body.slice(cut + JUDGMENT_SPLIT.length).trim()
      if (judgment.length === 0) continue
      rows.push({ kind: 'self', text: body, event, judgment, confidence, evidence })
      continue
    }
    if (section !== OBSERVATION_SECTION) continue
    const match = DAILY_OBSERVATION.exec(line)
    if (match === null) continue
    const { body, confidence, evidence } = splitObservationLine(match[2])
    if (body.length === 0) continue
    rows.push({ kind: match[1], text: body, confidence, evidence })
  }
  return rows
}

/** Observations from the last `days` daily notes, newest day first. */
export function readRecentDailyObservations(paths, days, now = new Date()) {
  if (paths === undefined || typeof paths.dailyDir !== 'string') return []
  const rows = []
  for (let index = 0; index < days; index += 1) {
    const day = todayKey(new Date(now.getTime() - index * 86400000))
    const text = readText(path.join(paths.dailyDir, `${day}.md`), '')
    if (text.length === 0) continue
    for (const observation of parseDailyObservations(text)) rows.push({ ...observation, day })
  }
  return rows
}

async function personaStage(ctx, config, personaText, cards, date, log, paths) {
  const window = config.personaUpdateEveryDays ?? 7
  // "近一周" has to be real: the run only carries today's cards, so the history
  // comes from the daily notes. Without it, evidence can never cross days.
  const history = readRecentDailyObservations(paths, window)

  // My own judgments: the only input identity may be built from. Today's cards
  // carry them, older days come back from the `## 我的判断` section.
  const notes = []
  const seenNotes = new Set()
  const addNote = (row, day) => {
    const event = String(row?.event ?? '').trim()
    const judgment = String(row?.judgment ?? row?.text ?? '').trim()
    if (judgment.length === 0) return
    const key = normalizeForCompare(`${event}${judgment}`)
    if (seenNotes.has(key)) return
    seenNotes.add(key)
    notes.push({
      day: String(row?.day ?? day),
      event,
      judgment,
      confidence: Number(row?.confidence ?? 0.5),
      evidence: String(row?.evidence ?? ''),
    })
  }
  for (const row of history) if (row.kind === 'self') addNote(row, row.day)
  for (const card of cards) for (const row of card.self ?? []) addNote(row, date)

  // The user observations are context only: what happened, and what he asked
  // for. They are not the material identity is made of.
  const background = []
  const seen = new Set()
  for (const item of [...history.filter((row) => row.kind !== 'self'), ...cards.flatMap((card) => card.observations)]) {
    const text = String(item?.text ?? '').trim()
    if (text.length === 0) continue
    const key = normalizeForCompare(text)
    if (seen.has(key)) continue
    seen.add(key)
    background.push({
      kind: item.kind ?? 'style',
      text,
      confidence: Number(item.confidence ?? 0.5),
      evidence: String(item.evidence ?? ''),
      day: item.day ?? date,
    })
    if (background.length >= 20) break
  }

  if (notes.length === 0) {
    // Nothing to be someone about yet. Asking the model here is exactly how a
    // canned persona gets invented, so the stage is skipped and retried later.
    log('persona: no self judgments recorded yet, skipped')
    return []
  }
  const prompt = [
    `日期：${date}`,
    `观察窗口：近 ${window} 天`,
    '',
    `我的判断（${notes.length} 条，按时间先后）：`,
    JSON.stringify(notes.slice(-30), null, 1),
    '',
    '对话现场（用户观察，只作背景，不要写成对用户的性格结论）：',
    JSON.stringify(background.slice(0, 12), null, 1),
    '',
    '当前性格（旧条目可能是第三人称台本，已停止注入）：',
    personaText.slice(0, 3000),
  ].join('\n')
  let json
  let raw
  // One retry: reaching this stage means a full digest already ran, so losing it
  // to a single malformed answer would cost the user another twelve minutes.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    raw = await callLlm(ctx, config, PERSONA_SYSTEM, prompt, `persona#${attempt}`)
    json = extractJson(raw.text) ?? extractJson(raw.reasoning)
    if (json !== undefined) break
    // Without the raw answer there is no way to tell "the model refused" from
    // "one unescaped quote broke the JSON".
    log(`persona raw (attempt ${attempt}): ${(raw.text || raw.reasoning).slice(0, 2000) || '(empty)'}`)
  }
  if (json === undefined) throw new Error('persona: no JSON object after 2 attempts')
  const suggestions = parsePersonaSuggestions(json)
  if (suggestions.length === 0) log(`persona raw: ${(raw.text || raw.reasoning).slice(0, 1500)}`)
  return suggestions
}

/**
 * Render one daily note.
 *
 * `## 我的判断` persists the assistant's own first-person judgments, because the
 * persona window rebuilds its history from these files: without the section,
 * self-evidence could never cross a day and 我认为我是谁 would stay empty forever.
 * @param {object[]} [selfNotes] - `{event, judgment, confidence, evidence}` rows from today's cards.
 */
export function renderDaily(date, daily, selfNotes = []) {
  const lines = [`# ${date}`, '', '## 今日摘要']
  if (daily.summary.length === 0) lines.push(`- ${EMPTY_MARK}`)
  for (const item of daily.summary) lines.push(`- ${item}`)
  lines.push('', '## 观察')
  if (daily.observations.length === 0) lines.push(`- ${EMPTY_MARK}`)
  // The model echoes evidence back and is not reliable about its shape, so it is
  // canonicalised on the way out as well as on the way back in. Without this a
  // note can carry `session-7b3c4fb6-5` today and the same session twice.
  for (const o of daily.observations) lines.push(`- [${o.kind}] ${o.text}（证据：${canonicalEvidence(o.evidence ?? '')} · ${Number(o.confidence ?? 0.5).toFixed(2)}）`)
  lines.push('', `## ${JUDGMENT_SECTION}`)
  const notes = []
  const seen = new Set()
  for (const note of selfNotes ?? []) {
    const event = String(note?.event ?? '').trim()
    const judgment = String(note?.judgment ?? '').trim()
    if (judgment.length === 0) continue
    const key = normalizeForCompare(`${event}${judgment}`)
    if (seen.has(key)) continue
    seen.add(key)
    notes.push({ event, judgment, confidence: Number(note?.confidence ?? 0.5), evidence: canonicalEvidence(note?.evidence ?? '') })
    if (notes.length >= 12) break
  }
  if (notes.length === 0) lines.push(`- ${EMPTY_MARK}`)
  for (const note of notes) {
    const head = note.event.length > 0 ? `${note.event}${JUDGMENT_SPLIT}` : ''
    // No evidence means no `（证据： … ）` tail: a fabricated empty token would be
    // read back as one more session and could fake a promotion.
    const tail = note.evidence.length > 0 ? `（证据：${note.evidence} · ${note.confidence.toFixed(2)}）` : ''
    lines.push(`- ${head}${note.judgment}${tail}`)
  }
  lines.push('', '## 延续待办')
  if (daily.unresolved.length === 0) lines.push(`- ${EMPTY_MARK}`)
  for (const item of daily.unresolved) lines.push(`- ${item}`)
  lines.push('')
  return lines.join('\n')
}

/**
 * Run one digest pass: collect → stage1 cards → daily note → profile (and
 * weekly persona) update. Returns a report object.
 * @param {object} [opts] - `forcePersona: true` runs the personality merge even when the weekly window is closed.
 */
export async function runDigest(ctx, config, paths, state, log, opts = {}) {
  const startedAt = new Date()
  const date = todayKey(startedAt)
  const end = startedAt.getTime()
  const start = end - config.windowHours * 3600 * 1000
  const sessions = collectSessions(paths.sessionsRoot, start, end, {
    excludeWorkspaces: config.excludeWorkspaces,
    excludeSessionIds: state.excludeSessionIds ?? [],
  })
  if (sessions.length === 0) {
    log(`digest ${date}: no sessions in window`)
    return { date, sessions: 0, cards: 0, profile: null, persona: null, identity: null, skipped: true }
  }
  const selected = sessions.slice(-config.maxSessionsPerRun)
  log(`digest ${date}: ${sessions.length} sessions, using ${selected.length}`)

  const cards = []
  for (const session of selected) {
    const card = await stage1(ctx, config, session, date, log)
    if (card !== undefined) cards.push(card)
  }
  if (cards.length === 0) {
    log('digest: no usable cards')
    return { date, sessions: sessions.length, cards: 0, profile: null, persona: null, identity: null, skipped: true }
  }
  let dailyReport = ''
  let profileResult = null
  let personaResult = null
  try {
    const daily = await stage2(ctx, config, cards, date, log)
    // My judgments are persisted straight from the cards, not through stage2:
    // a model that rewrites them would turn first-person notes back into a script.
    const dailyText = renderDaily(date, daily, cards.flatMap((card) => card.self ?? []))
    ensureDir(paths.dailyDir)
    const dailyFile = path.join(paths.dailyDir, `${date}.md`)
    writeTextAtomic(dailyFile, dailyText)
    dailyReport = dailyFile
  } catch (error) {
    log(`stage2 failed: ${error.message}`)
  }
  if (config.autoApply) {
    try {
      const profileText = readText(paths.profileFile, '')
      const suggestions = await stage3(ctx, config, profileText.length > 0 ? profileText : emptyProfile(PROFILE_SECTIONS, '用户画像'), cards, date, log)
      if (suggestions.length > 0) {
        const merged = applySuggestions(profileText, PROFILE_SECTIONS, suggestions, { date, title: '用户画像' })
        ensureDir(path.dirname(paths.profileFile))
        backupDocument(paths, 'profile', profileText, date)
        writeTextAtomic(paths.profileFile, merged.text)
        profileResult = { applied: merged.applied, merged: merged.merged, version: merged.version }
        log(`profile: +${merged.applied} ~${merged.merged} (v${merged.version})`)
      } else {
        profileResult = { applied: 0, merged: 0, version: null }
      }
    } catch (error) {
      log(`stage3 failed: ${error.message}`)
    }
    if (config.personaEnabled && (opts.forcePersona === true || personaIsDue(state, config))) {
      try {
        const personaText = readText(paths.personaFile, '')
        const suggestions = await personaStage(ctx, config, personaText.length > 0 ? personaText : emptyProfile(PERSONA_SECTIONS, '助手性格'), cards, date, log, paths)
        if (suggestions.length > 0) {
          const merged = applyPersonaSuggestions(personaText, PERSONA_SECTIONS, suggestions, {
            date,
            title: '助手性格',
            styleMinSessions: config.personaMinEvidence ?? 3,
            coreMinSessions: config.personaMinEvidence ?? 3,
            coreMinDates: config.personaCoreMinDates ?? 3,
            demoteAfterDays: config.personaDemoteAfterDays ?? 30,
          })
          ensureDir(path.dirname(paths.personaFile))
          backupDocument(paths, 'persona', personaText, date)
          writeTextAtomic(paths.personaFile, merged.text)
          personaResult = {
            applied: merged.applied,
            merged: merged.merged,
            version: merged.version,
            promoted: merged.promoted,
            demoted: merged.demoted,
            superseded: merged.superseded,
          }
          state.lastPersonaRunDay = date
          log(`persona: +${merged.applied} ~${merged.merged} ↑${merged.promoted} ↓${merged.demoted} x${merged.superseded} (v${merged.version})`)
        }
      } catch (error) {
        log(`persona failed: ${error.message}`)
        // Keep the failure in the report: a silent null looked like "nothing new",
        // which is how a broken merge could go unnoticed for weeks.
        personaResult = { applied: 0, merged: 0, version: null, error: error.message }
      }
    }
  }
  // The identity block is a derived view of profile.md, so it is refreshed once
  // the profile has been written. `ensureIdentity` decides by itself whether a
  // model call is needed: an unchanged profile version costs nothing.
  let identityResult = null
  try {
    identityResult = await ensureIdentity(ctx, config, paths, log)
  } catch (error) {
    log(`identity failed: ${error.message}`)
    identityResult = { identity: null, generated: false, cached: false, error: error.message }
  }
  return {
    date,
    sessions: sessions.length,
    cards: cards.length,
    daily: dailyReport,
    profile: profileResult,
    persona: personaResult,
    identity: identityResult,
    skipped: false,
  }
}

/** Persona consolidates weekly (or whatever personaUpdateEveryDays says). */
export function personaIsDue(state, config) {
  const last = state.lastPersonaRunDay ?? ''
  if (last === '') return true
  const lastTime = Date.parse(`${last}T00:00:00`)
  if (Number.isNaN(lastTime)) return true
  return Date.now() - lastTime >= (config.personaUpdateEveryDays ?? 7) * 86400000
}
