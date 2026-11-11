/**
 * Identity block: a derived view of `profile.md`.
 *
 * It is **not** a second memory: no collection, no merge chain, no evidence
 * counting of its own. It reads the profile, asks a model for five one-line
 * judgments about the person, and caches them in `identity.json`.
 *
 * Two rules keep it from becoming a feedback loop:
 * - it never writes back into `profile.md` (a prediction must not become
 *   evidence for the next merge);
 * - it is never injected into the prompt (`lib/inject.js` does not know it).
 */
import { extractJson } from './digest.js'
import { callLlm } from './llm.js'
import { parseProfile, PROFILE_SECTIONS, readMeta } from './profile.js'
import { readJson, readText, writeJsonAtomic } from './util.js'

/** The five fields, in display order. */
export const IDENTITY_FIELDS = [
  { key: 'role', zh: '角色', en: 'Role' },
  { key: 'domain', zh: '领域', en: 'Domain' },
  { key: 'stack', zh: '技术栈', en: 'Stack' },
  { key: 'workflow', zh: '工作流', en: 'Workflow' },
  { key: 'impression', zh: '印象', en: 'Impression' },
]

/** Entries below this confidence are left out unless they are pinned. */
export const IDENTITY_THRESHOLD = 0.7

const TEXT_LIMIT = 160
const BASIS_LIMIT = 4

function emptyFields() {
  const fields = {}
  for (const field of IDENTITY_FIELDS) fields[field.key] = { text: '', basis: [] }
  return fields
}

function isFieldsObject(value) {
  if (value === null || typeof value !== 'object') return false
  return IDENTITY_FIELDS.every((field) => value[field.key] !== null && typeof value[field.key] === 'object')
}

/** Read the cache; a malformed or half-written file is treated as absent. */
export function readIdentity(file) {
  const value = readJson(file, null)
  if (value === null || typeof value !== 'object') return null
  if (typeof value.profileVersion !== 'number' || !isFieldsObject(value.fields)) return null
  return value
}

/**
 * Which entries may be used as evidence for the block.
 *
 * Pinned and manually locked entries always count: the user said they matter.
 * Everything else below the threshold is dropped, and the count is reported so
 * the panel can say how much was left out instead of silently guessing.
 */
export function identityInputs(profileText) {
  const state = parseProfile(String(profileText ?? ''), PROFILE_SECTIONS)
  const meta = readMeta(String(profileText ?? ''), '用户画像')
  const entries = []
  let excluded = 0
  for (const section of PROFILE_SECTIONS) {
    for (const entry of state.get(section.key) ?? []) {
      const pinned = entry.pinned === true || entry.userLocked === true
      if (!pinned && entry.confidence < IDENTITY_THRESHOLD) {
        excluded += 1
        continue
      }
      entries.push({
        id: entry.id,
        section: section.title,
        confidence: entry.confidence,
        pinned,
        text: entry.text,
      })
    }
  }
  return { version: meta.version, updatedAt: meta.updatedAt, entries, used: entries.length, excluded }
}

/** The cache is valid as long as the profile version it was built from is. */
export function identityIsStale(cache, version) {
  if (cache === null) return true
  return cache.profileVersion !== version
}

export const IDENTITY_SYSTEM = [
  '你是这个人的工作画像归纳器。只输出一个 JSON 对象，不要输出任何解释、markdown 代码块或多余文字。',
  '下面是从长期对话里沉淀下来的条目（id、置信度、文本）。从中归纳五个字段：',
  'role=他在做什么（角色/职能）；domain=他在什么领域；stack=他实际在用的技术；workflow=他做事的方式（推进顺序、验收标准、卡在哪里）；impression=和他协作时观察到的应对方式。',
  '允许外推，而且要足：从两三条线索直接落成一个具体判断，不要写成「A、B、C 反复出现，我猜测……」这种汇报腔。',
  '例：从「在意权限边界」「要求来源依据」「先讲清再动手」可以直接落到「大概率在做运维或平台工程这类会被事故追责的活」。',
  '主行只写判断句，推理链不进正文；依据只填进 basis —— 被引用条目的 id 数组，1 到 4 个。',
  '需要主语时用「他」或省略主语。禁止第三人称书面腔和评价性形容词：不写「用户是个谨慎的人」「他很强」「这位用户」。',
  '禁止推断敏感属性：健康、宗教、政治、性取向、经济状况、婚恋。只做与工作相关的判断。',
  '每条判断都要写成可以被反驳的口气（一个具体猜测，而不是放之四海皆准的概括）。没有依据的字段就留空字符串，不要编。',
  '印象那一条只写观察到的做事方式和应对，不写「他是什么样的人」。',
  '必须输出的 JSON 形状：',
  '{"fields":{"role":{"text":"","basis":[]},"domain":{"text":"","basis":[]},"stack":{"text":"","basis":[]},"workflow":{"text":"","basis":[]},"impression":{"text":"","basis":[]}}}',
].join('\n')

/** The user message: the filtered entries plus the profile version they came from. */
export function identityPrompt(inputs) {
  const lines = [
    `画像版本：v${inputs.version}（更新于 ${inputs.updatedAt || '未知'}）`,
    `条目：共 ${inputs.entries.length} 条（另有 ${inputs.excluded} 条置信度不足未提供）`,
    '',
  ]
  for (const entry of inputs.entries) lines.push(`- [${entry.id}] 置信度 ${entry.confidence} · ${entry.section}：${entry.text}`)
  return lines.join('\n')
}

/**
 * Normalize the model answer into the cached shape.
 *
 * Basis ids are filtered against the ids that were actually offered, so the
 * block can never cite an entry that does not exist (or one that was filtered
 * out by the threshold). An answer with no usable text at all is treated as a
 * failure by the caller — writing it would erase the previous block.
 */
export function parseIdentity(json, validIds = []) {
  if (json === undefined || json === null || typeof json !== 'object') return undefined
  const raw = json.fields !== null && typeof json.fields === 'object' ? json.fields : json
  const known = new Set(validIds)
  const fields = emptyFields()
  let filled = 0
  for (const field of IDENTITY_FIELDS) {
    const value = raw[field.key]
    const text = typeof value === 'string'
      ? value
      : (value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : '')
    const trimmed = text.trim().slice(0, TEXT_LIMIT)
    const basis = (value !== null && typeof value === 'object' && Array.isArray(value.basis) ? value.basis : [])
      .map((id) => String(id ?? '').trim())
      .filter((id) => id.length > 0 && known.has(id))
    const unique = [...new Set(basis)].slice(0, BASIS_LIMIT)
    fields[field.key] = { text: trimmed, basis: unique }
    if (trimmed.length > 0) filled += 1
  }
  return filled > 0 ? fields : undefined
}

/**
 * Ask the model for the block. Throws on any failure so the caller can keep the
 * previous cache instead of writing a half-empty one.
 */
export async function generateIdentity(ctx, config, profileText, log) {
  const inputs = identityInputs(profileText)
  if (inputs.entries.length === 0) throw new Error('画像没有可用条目')
  const raw = await callLlm(ctx, config, IDENTITY_SYSTEM, identityPrompt(inputs), 'identity')
  const json = extractJson(raw.text) ?? extractJson(raw.reasoning)
  if (json === undefined) {
    log(`identity raw: ${(raw.text || raw.reasoning).slice(0, 1500) || '(empty)'}`)
    throw new Error('no JSON object')
  }
  const fields = parseIdentity(json, inputs.entries.map((entry) => entry.id))
  if (fields === undefined) {
    log(`identity raw: ${(raw.text || raw.reasoning).slice(0, 1500)}`)
    throw new Error('模型没有给出任何判断')
  }
  return {
    profileVersion: inputs.version,
    profileUpdatedAt: inputs.updatedAt,
    generatedAt: new Date().toISOString(),
    used: inputs.used,
    excluded: inputs.excluded,
    fields,
  }
}

/**
 * The one entry point the digest and the refresh route use.
 *
 * Returns `{ identity, generated, cached, error }`. When the profile version has
 * not moved since the cache was built, **no model call is made** — most days
 * leave the profile untouched, and a daily LLM call for an unchanged document
 * would be pure cost. On failure the previous cache is kept.
 */
export async function ensureIdentity(ctx, config, paths, log, opts = {}) {
  const profileText = readText(paths.profileFile, '')
  const version = readMeta(profileText, '用户画像').version
  const cache = readIdentity(paths.identityFile)
  if (opts.force !== true && profileText.trim().length > 0 && !identityIsStale(cache, version)) {
    return { identity: cache, generated: false, cached: true, error: null }
  }
  try {
    const identity = await generateIdentity(ctx, config, profileText, log)
    writeJsonAtomic(paths.identityFile, identity)
    log(`identity: generated from profile v${identity.profileVersion} (${identity.used} used, ${identity.excluded} excluded)`)
    return { identity, generated: true, cached: false, error: null }
  } catch (error) {
    log(`identity failed: ${error.message}${cache === null ? '' : '（保留上一次缓存）'}`)
    return { identity: cache, generated: false, cached: cache !== null, error: error.message }
  }
}
