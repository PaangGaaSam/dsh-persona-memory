import path from 'node:path'
import { collectSessions } from './collector.js'
import { backupDocument } from './history.js'
import { ensureIdentity } from './identity.js'
import {
  applyLessonSuggestions,
  formatDailyLesson,
  parseAnchor,
  parseDailyLessons,
  SUSPECT_SECTION,
} from './lessons.js'
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
  // Lesson candidates ("记一下" said in conversation, or a failure with an obvious
  // next step) are kept apart from the profile and persona paths. They are only
  // candidates: the merge decides, and a 铁律 still needs a human to arm it.
  const lessons = asArray(card.lessons ?? card.lessonCandidates)
    .map((item) => {
      const cited = evidenceFromCites(item?.cites ?? item?.cite, session, date)
      return {
        section: item?.section === 'rule' ? 'rule' : 'exp',
        text: textOf(item).slice(0, 200),
        scope: typeof session?.cwd === 'string' ? session.cwd : '',
        evidence: cited.length > 0
          ? formatEvidence(cited)
          : evidenceOf(item, `${date}/${sessionKey(session)}`),
      }
    })
    .filter((item) => item.text.length > 0 && !isSystemFactObservation(item.text))
    .slice(0, 3)
  return {
    sessionId: session.id,
    cwd: session.cwd,
    topic: typeof card.topic === 'string' ? card.topic.trim().slice(0, 200) : '',
    userNeeds: asArray(card.userNeeds ?? card.needs).map(textOf).filter(Boolean).slice(0, 3),
    observations,
    self,
    lessons,
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
  // The daily note's own answer to 「今天有没有可疑雷点」. An empty array is a
  // real answer, and it is recorded as such (`（无）`) so the streak counter can
  // tell "asked and nothing found" from "never asked".
  const lessons = asArray(json.lessons ?? json.suspects).map((item) => ({
    section: item?.section === 'rule' ? 'rule' : 'exp',
    text: textOf(item).slice(0, 200),
    evidence: evidenceOf(item, ''),
  })).filter((item) => item.text.length > 0).slice(0, 6)
  return { summary, unresolved, observations, lessons }
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

/** Normalize a lesson suggestion list. The merge decides caps, section and authorisation. */
export function parseLessonSuggestions(json, date = todayKey()) {
  if (json === undefined || typeof json !== 'object') return []
  const raw = asArray(json.add ?? json.lessons ?? json.suggestions ?? (Array.isArray(json) ? json : undefined))
  return raw
    .map((item) => ({
      section: item?.section === 'rule' ? 'rule' : 'exp',
      text: textOf(item).slice(0, 200),
      scope: typeof item?.scope === 'string' ? item.scope.trim().slice(0, 200) : '',
      anchor: parseAnchor(item?.anchor ?? item?.evidence ?? '', date),
      invalidates: typeof item?.invalidates === 'string' ? item.invalidates.trim().slice(0, 40) : '',
      invalidReason: typeof item?.invalidReason === 'string' ? item.invalidReason.trim().slice(0, 80) : '',
      appliesTo: typeof item?.appliesTo === 'string' ? item.appliesTo.trim().slice(0, 40) : '',
    }))
    .filter((item) => item.text.length > 0 || item.invalidates.length > 0)
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
  '从对话中抽取：主题、用户核心诉求、可长期复用的用户观察、我自己的判断、可疑雷点、未完成事项。',
  'observations 只描述这位用户本人：他的偏好、沟通习惯、思维模式、明确纠正、反复卡点。',
  'self 记我在这场对话里的判断、立场和自我修正，第一人称（我认为 / 我判断 / 我倾向 / 我后悔）。',
  'self 里不记技术结论：工具、插件、模型、环境、依赖、解析器怎么工作的，以及任务进度和未完成事项，都不要写；但我在具体事情上的判断要留下，别因为它是技术话题就整条丢掉。',
  'self 的每一条都必须挂在一件具体的事上：event 写清当时发生了什么（他要求了什么、我做了什么、结果怎样），没有事件就不要写这条。',
  'judgment 必须是我自己的口气，禁止写「助手应……」这类给别人的规范。允许自我修正，例如「我上次那样做不成立，因为……」，这类优先保留。',
  '观察必须一句话、自包含、来自对话事实；不要写密钥或隐私号码。',
  'kind 语义：preference=稳定偏好；style=沟通风格；thinking=思维模式；correction=用户明确纠正助手的做法（“不要这样”）；friction=用户反复遇到的问题。',
  'lessons 只记「我下次该怎么做」：上次怎么翻车的、下次具体改哪一步，一句可执行动作。用户说了「记一下」就抽到这里；用户的偏好/雷区仍然写 observations，两样都有的两边各写一条，不要混写。',
  'lessons.section：违反它会造成不可逆后果（删数据、覆盖文件、发布外部动作、权限）→ rule；只是返工、需要看版本/路径/API 形状 → exp。拿不准就 exp。',
  '每条观察、每条 self、每条 lessons 都必须带 cites：支撑它的一到三条消息编号数组，编号只能取自对话原文里 [#n 日期 时间] 标出的 n，不要自己编日期或会话号。',
  '必须输出的 JSON 形状（数组里每个元素都是对象）：',
  '{"topic":"一句话主题","userNeeds":["..."],"observations":[{"kind":"preference|style|thinking|correction|friction","text":"一句话观察","confidence":0.7,"cites":[3]}],"self":[{"event":"一句话：当时发生了什么","judgment":"我当时的判断（第一人称）","confidence":0.6,"cites":[3]}],"lessons":[{"section":"rule|exp","text":"下次先做这一步","cites":[3]}],"unresolved":["..."]}',
  '没有可长期复用的观察就把 observations 输出空数组 []；没有值得记的判断就把 self 输出空数组 []；没有可疑雷点就把 lessons 输出空数组 []。字段都不要省略。',
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
  '把当天所有会话卡片合并成一篇中文日报：今日摘要（3-6 条）、延续待办、值得记的观察、可疑雷点。',
  '可疑雷点只回答一个问题：今天有没有哪一步让我翻车、下次该改哪一步？一句可执行动作，section 只有 rule（不可逆后果）或 exp（环境/版本/路径这类会变的条件）。',
  '只是返工、只是慢、只是不顺，都不算雷点；想不到就输出空数组，空答也是答案，不要为了填满硬编。',
  '可疑雷点里不要写用户性格、不要写「我是谁」、不要写「要注意」这类空话。',
  '必须输出的 JSON 形状：',
  '{"summary":["..."],"unresolved":["..."],"observations":[{"kind":"","text":"","confidence":0.7,"evidence":""}],"lessons":[{"section":"rule|exp","text":"","evidence":""}]}',
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
 * Signals that something went wrong and is worth learning from later.
 *
 * Entry point 2 of the lesson flow: when one of these shows up, the digest also
 * re-reads the last few daily notes so the corrective step is inferred from the
 * original wording instead of a summary.
 */
const FAILURE_SIGNAL = /(exit code[:：]?\s*[1-9]|非零退出|命令失败|失败|报错|错误[:：]|异常|Error:|ERR_|EACCES|EPERM|EPIPE|permission denied|access denied|not found|timed out|超时|崩溃|沙箱拒绝)/i
const REWORK_SIGNAL = /(又改|再改|第二遍|同一处|还是不行|仍然失败|回退|还原|revert|rollback|重复踩)/i

/**
 * Detect the four consequence classes from what today actually produced.
 *
 * Tool failures and rework are mechanical text matches; user corrections come
 * from the cards (kind `correction`); silent errors are only reachable through
 * the "记一下" entry point, so they show up as candidates instead.
 * @returns {{kind:string, text:string, evidence:string}[]}
 */
export function detectConsequenceSignals(cards, sessions, date) {
  const signals = []
  const seen = new Set()
  const add = (kind, text, evidence) => {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (body.length === 0) return
    const key = `${kind}:${normalizeForCompare(body).slice(0, 40)}`
    if (seen.has(key)) return
    seen.add(key)
    signals.push({ kind, text: truncate(body, 160), evidence: String(evidence ?? '') })
  }
  for (const card of cards ?? []) {
    for (const observation of card.observations ?? []) {
      if (observation.kind === 'correction') add('correction', observation.text, observation.evidence)
      else if (FAILURE_SIGNAL.test(observation.text) || REWORK_SIGNAL.test(observation.text)) {
        add('consequence', observation.text, observation.evidence)
      }
    }
    for (const item of card.unresolved ?? []) {
      if (FAILURE_SIGNAL.test(item) || REWORK_SIGNAL.test(item)) add('unresolved', item, '')
    }
    for (const note of card.self ?? []) {
      if (FAILURE_SIGNAL.test(`${note.event} ${note.judgment}`)) add('self', `${note.event} ${note.judgment}`, note.evidence)
    }
  }
  for (const session of sessions ?? []) {
    for (const message of session.messages ?? []) {
      if (message.role !== 'assistant') continue
      if (!FAILURE_SIGNAL.test(message.text)) continue
      add('tool', truncate(message.text.replace(/\s+/g, ' ').trim(), 140), `${date}/${sessionKey(session)}`)
    }
  }
  return signals.slice(0, 8)
}

const LESSONS_SYSTEM = [
  '你是 DeepSeek Harness 的教训整理器。只输出一个 JSON 对象，不要输出任何解释、markdown 代码块或多余文字。',
  '教训只回答一件事：我上次怎么翻车的、下次具体改哪一步。不写用户性格，不写「我是谁」，不写「要注意」「小心」这类空话。',
  'text 必须是一句可执行动作：下次先做什么、改哪一步、先验证什么。一句话，不超过 60 字。',
  '分区由失效条件决定：成立条件依赖任务属性（规模、可逆性、破坏性）→ rule；依赖环境属性（版本、路径、API 形状、命令行为）→ exp。拿不准就 exp。',
  '写 rule 之前先自问：违反了它，会不会造成不可逆后果（删数据、覆盖文件、对外发布、权限变更）？只是返工，就不够格，放进 exp。',
  '宁可少写：这一轮没有值得写的就输出 {"add":[]}，不要凑数。',
  '已有教训如果和新观察冲突，不要改写它的原文：要么不输出它，要么用 invalidates 指向那条 exp 的 id 并给出 invalidReason（只有 exp 能被证伪，铁律不行）。',
  'scope 只能填「全局」或今天出现的工作区路径；只在这个工作区成立的经验写路径，别把环境细节扩大成全局。',
  'anchor 写成「日期/会话号 · 日报里的一句话」，日期和会话号只能取自给定材料，不要自己编。',
  '必须输出的 JSON 形状：',
  '{"add":[{"section":"rule|exp","text":"下次先做这一步","scope":"全局","anchor":"2026-11-11/session-xxxxxxxx · 日报里的一句话","invalidates":"","invalidReason":""}]}',
].join('\n')

function lessonsStagePrompt(payload) {
  const parts = [`日期：${payload.date}`]
  if (payload.cwdList.length > 0) parts.push(`今天的工作区：${payload.cwdList.join('、')}`)
  parts.push('', '当日可疑雷点（日报里的候选）：', payload.candidates.length > 0 ? JSON.stringify(payload.candidates, null, 1) : '（无）')
  parts.push('', '今天的后果信号：', payload.signals.length > 0 ? JSON.stringify(payload.signals, null, 1) : '（无）')
  if (payload.notes.length > 0) {
    parts.push('', '最近几天日报原文（只在有后果信号时回看，别整篇照抄）：', payload.notes.join('\n\n').slice(0, 6000))
  }
  // Deliberately no persona.md and no 我的判断 here: a lesson written while looking
  // at the self-account gets decorated with who I am instead of what went wrong.
  parts.push('', '已有教训（原文，只允许追加或作废，不能改写）：', payload.lessonsText.trim().length > 0 ? payload.lessonsText.slice(0, 4000) : '（还没有）')
  return parts.join('\n')
}

/** Raw daily notes for the last `days` days, newest first — input for consequence retrospection. */
export function readRecentDailyNotes(paths, days, date = todayKey()) {
  if (paths === undefined || typeof paths.dailyDir !== 'string') return []
  const notes = []
  const base = Date.parse(`${date}T00:00:00`)
  for (let index = 0; index < days; index += 1) {
    const day = Number.isNaN(base)
      ? date
      : todayKey(new Date(base - index * 86400000))
    const text = readText(path.join(paths.dailyDir, `${day}.md`), '')
    if (text.trim().length === 0) continue
    notes.push(`### ${day}\n${text.trim()}`)
  }
  return notes
}

async function lessonsStage(ctx, config, payload, log) {
  const raw = await callLlm(ctx, config, LESSONS_SYSTEM, lessonsStagePrompt(payload), 'lessons')
  const json = extractJson(raw.text) ?? extractJson(raw.reasoning)
  if (json === undefined) {
    log(`lessons raw: ${(raw.text || raw.reasoning).slice(0, 2000) || '(empty)'}`)
    throw new Error('lessons: no JSON object')
  }
  const suggestions = parseLessonSuggestions(json, payload.date)
  if (suggestions.length === 0) log(`lessons raw: ${(raw.text || raw.reasoning).slice(0, 1500)}`)
  return suggestions
}

/**
 * Render one daily note.
 *
 * `## 我的判断` persists the assistant's own first-person judgments, because the
 * persona window rebuilds its history from these files: without the section,
 * self-evidence could never cross a day and 我认为我是谁 would stay empty forever.
 * `## 可疑雷点` holds the day's lesson candidates — an empty answer is recorded as
 * `（无）` so the panel can tell "asked, nothing found" from "not asked".
 * @param {object[]} [selfNotes] - `{event, judgment, confidence, evidence}` rows from today's cards.
 * @param {object[]} [lessonRows] - `{section, text, evidence}` candidate rows.
 */
export function renderDaily(date, daily, selfNotes = [], lessonRows = []) {
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
  // 可疑雷点: the day's lesson candidates. They live in the daily note, never in
  // lessons.md — only the merge writes there, and only a human arms a 铁律.
  lines.push('', `## ${SUSPECT_SECTION}`)
  const suspects = []
  const seenSuspect = new Set()
  for (const row of lessonRows ?? []) {
    const body = String(row?.text ?? '').trim()
    if (body.length === 0) continue
    const key = normalizeForCompare(body)
    if (seenSuspect.has(key)) continue
    seenSuspect.add(key)
    suspects.push({
      section: row?.section === 'rule' ? 'rule' : 'exp',
      text: body.slice(0, 200),
      evidence: canonicalEvidence(row?.evidence ?? ''),
    })
    if (suspects.length >= 8) break
  }
  if (suspects.length === 0) lines.push(`- ${EMPTY_MARK}`)
  for (const suspect of suspects) lines.push(formatDailyLesson(suspect))
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
    return { date, sessions: 0, cards: 0, profile: null, persona: null, lessons: null, identity: null, skipped: true }
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
    return { date, sessions: sessions.length, cards: 0, profile: null, persona: null, lessons: null, identity: null, skipped: true }
  }
  let dailyReport = ''
  let profileResult = null
  let personaResult = null
  let lessonsResult = null
  try {
    const daily = await stage2(ctx, config, cards, date, log)
    // My judgments are persisted straight from the cards, not through stage2:
    // a model that rewrites them would turn first-person notes back into a script.
    const dailyText = renderDaily(
      date,
      daily,
      cards.flatMap((card) => card.self ?? []),
      // Both the day's own answer (`lessons`) and the per-session candidates
      // (someone said 「记一下」) land in the same 可疑雷点 section.
      [...(daily.lessons ?? []), ...cards.flatMap((card) => card.lessons ?? [])],
    )
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
  // Lessons are independent of `autoApply` (that flag is about the profile) and
  // run at the end of the day, once. They also run when the model proposes
  // nothing: 90-day expiry has to happen even on a quiet day.
  try {
    const lessonsText = readText(paths.lessonsFile, '')
    const candidates = []
    const seenCandidate = new Set()
    const addCandidate = (row) => {
      const body = String(row?.text ?? '').trim()
      if (body.length === 0) return
      const key = normalizeForCompare(body)
      if (seenCandidate.has(key)) return
      seenCandidate.add(key)
      candidates.push({
        section: row?.section === 'rule' ? 'rule' : 'exp',
        text: body.slice(0, 200),
        scope: String(row?.scope ?? '').trim(),
        evidence: String(row?.evidence ?? ''),
      })
    }
    if (dailyReport !== '') {
      for (const row of parseDailyLessons(readText(dailyReport, ''))) addCandidate(row)
    }
    // If stage2 failed there is no daily note to read back; the cards still hold
    // the same candidates, so nothing is lost.
    for (const card of cards) for (const row of card.lessons ?? []) addCandidate(row)
    const signals = detectConsequenceSignals(cards, selected, date)
    const cwdList = [...new Set(selected.map((session) => session.cwd).filter((cwd) => typeof cwd === 'string' && cwd.length > 0))]
    let suggestions = []
    if (candidates.length > 0 || signals.length > 0) {
      const notes = signals.length > 0 ? readRecentDailyNotes(paths, 3, date) : []
      suggestions = await lessonsStage(ctx, config, { date, cwdList, candidates, signals, notes, lessonsText }, log)
    }
    const merged = applyLessonSuggestions(lessonsText, suggestions, { date })
    if (merged.changed) {
      ensureDir(path.dirname(paths.lessonsFile))
      if (lessonsText.trim().length > 0) backupDocument(paths, 'lessons', lessonsText, date)
      writeTextAtomic(paths.lessonsFile, merged.text)
    }
    lessonsResult = {
      added: merged.added,
      pending: merged.pending,
      merged: merged.merged,
      expired: merged.expired,
      archived: merged.archived,
      dropped: merged.dropped,
      version: merged.version,
    }
    log(`lessons: +${merged.added} ?${merged.pending} ~${merged.merged} x${merged.archived} expired=${merged.expired} dropped=${merged.dropped} (v${merged.version})`)
  } catch (error) {
    log(`lessons failed: ${error.message}`)
    lessonsResult = { added: 0, pending: 0, merged: 0, archived: 0, error: error.message }
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
    lessons: lessonsResult,
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
