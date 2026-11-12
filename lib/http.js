import fs from 'node:fs'
import path from 'node:path'
import { publicConfig } from './config.js'
import { personaIsDue } from './digest.js'
import { backupDocument, HISTORY_DOCS, listHistory, restoreHistory } from './history.js'
import { addManualFact, archiveFact, confirmFact, describeFacts, factsStats } from './facts.js'
import { readIdentity } from './identity.js'
import { PERSONA_HEADING, renderLayers } from './inject.js'
import {
  addManualLesson,
  approveLesson,
  archiveLesson,
  consecutiveEmptyDays,
  describeLessons,
  lessonsStats,
  replaceLesson,
  SCOPE_GLOBAL,
} from './lessons.js'
import { parseProfile, PERSONA_SECTIONS, PROFILE_SECTIONS, documentStats, renderPersonaInjection, setPinned } from './profile.js'
import { statusOf } from './state.js'
import { readText, todayKey, writeTextAtomic } from './util.js'

/** Routes only answer the local machine, never a proxied remote caller. */
export function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? ''
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function sendError(response, status, message) {
  sendJson(response, status, { ok: false, error: message })
}

/** Read a small JSON body; anything larger is rejected instead of buffered. */
export function readJsonBody(request, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve({})
        return
      }
      try {
        const value = JSON.parse(text)
        resolve(value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
      } catch {
        reject(new Error('request body must be JSON'))
      }
    })
    request.on('error', reject)
  })
}

const SECTIONS_BY_DOC = { profile: PROFILE_SECTIONS, persona: PERSONA_SECTIONS }

/** Pinned first, then most recently verified, then most confident. */
export function sortForDisplay(entries) {
  return [...entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.lastVerified !== b.lastVerified) return a.lastVerified < b.lastVerified ? 1 : -1
    return b.confidence - a.confidence
  })
}

/** How many rows a section shows before the page offers to expand it. */
export const SECTION_PREVIEW_ROWS = 3

/**
 * Project one markdown document into sections of plain entries for the UI.
 *
 * Both documents fold by default: three rows per section, ordered pinned →
 * most recently verified → most confident, so a pinned entry can never hide
 * behind the fold. The user-locked section is exempt — it is the user's own
 * list and is always shown whole.
 *
 * `limit: 0` disables folding for a caller that needs the full list; `sort:
 * false` keeps document order. Neither document passes options today.
 */
export function describeDocument(text, doc, options = {}) {
  const sections = SECTIONS_BY_DOC[doc]
  const state = parseProfile(text.length > 0 ? text : '', sections)
  const requested = options.limit === undefined ? SECTION_PREVIEW_ROWS : Number(options.limit)
  const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0
  const sorted = options.sort !== false
  return sections.map((section) => {
    const raw = state.get(section.key) ?? []
    const ordered = sorted ? sortForDisplay(raw) : raw
    const entries = ordered.map((entry) => ({
      id: entry.id,
      pinned: entry.pinned,
      confidence: Number(entry.confidence.toFixed(2)),
      lastVerified: entry.lastVerified,
      text: entry.text,
      evidence: entry.evidence,
    }))
    return {
      key: section.key,
      title: section.title,
      total: entries.length,
      limit: section.userLocked === true ? 0 : limit,
      entries,
    }
  })
}

function latestDaily(paths) {
  let names = []
  try {
    names = fs.readdirSync(paths.dailyDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
  } catch {
    return { date: '', text: '' }
  }
  if (names.length === 0) return { date: '', text: '' }
  names.sort()
  const name = names[names.length - 1]
  return { date: name.slice(0, 10), text: readText(path.join(paths.dailyDir, name), '') }
}

/**
 * What the persona layer actually puts into the prompt right now.
 *
 * The file can hold a dozen self-accounts and still inject nothing, because
 * candidates never qualify and legacy stage directions are filtered out. Without
 * this number the panel shows a full document next to an empty prompt and the
 * user has no way to tell why.
 */
export function personaInjection(text, config) {
  const budget = Math.max(0, Number(config.promptBudgetChars) || 0)
  if (budget === 0) return { enabled: false, count: 0, chars: 0 }
  if (config.personaEnabled === false) return { enabled: false, count: 0, chars: 0 }
  const rendered = renderPersonaInjection(text, PERSONA_SECTIONS, PERSONA_HEADING, Math.floor(budget * 0.2))
  const count = rendered.split('\n').filter((line) => line.startsWith('- ')).length
  return { enabled: true, count, chars: rendered.length }
}

/** One daily note, cached per payload because anchors are checked per lesson. */
function dailyTextReader(paths) {
  const cache = new Map()
  return (day) => {
    if (typeof day !== 'string' || day.length === 0) return ''
    if (!cache.has(day)) cache.set(day, readText(path.join(paths.dailyDir, `${day}.md`), ''))
    return cache.get(day)
  }
}

/**
 * Build the full panel payload: scheduler status, editable config, all three
 * documents and their per-entry view, plus the latest daily note.
 */
export function documentsPayload(paths, config, state, options = {}) {
  const profileText = readText(paths.profileFile, '')
  const personaText = readText(paths.personaFile, '')
  const lessonsText = readText(paths.lessonsFile, '')
  // Same cwd rule as the prompt builder: the host context when it exists, else
  // the process cwd. The panel's "injected now" count then matches the prompt.
  const cwd = options.cwd ?? (typeof process.cwd === 'function' ? process.cwd() : undefined)
  const layers = renderLayers(paths, config, { cwd })
  const lessonStats = lessonsStats(lessonsText)
  return {
    ok: true,
    documents: {
      profile: {
        text: profileText,
        // Both documents fold by default (three rows per section, pinned first)
        // so pinning a hidden row is possible once the section is expanded.
        sections: describeDocument(profileText, 'profile'),
        stats: documentStats(profileText, PROFILE_SECTIONS),
      },
      persona: {
        text: personaText,
        sections: describeDocument(personaText, 'persona'),
        stats: documentStats(personaText, PERSONA_SECTIONS),
        injected: {
          enabled: layers.enabled,
          count: layers.layers.persona.count,
          chars: layers.layers.persona.chars,
        },
      },
    },
    // The lessons layer has its own card: it answers 「该怎么做」, not 「你是谁」.
    lessons: {
      text: lessonsText,
      sections: describeLessons(lessonsText, { dailyText: dailyTextReader(paths) }),
      stats: lessonStats,
      injected: {
        enabled: layers.enabled,
        count: layers.layers.lessons.count,
        chars: layers.layers.lessons.chars,
        skipped: layers.layers.lessons.skipped,
        budgetSkipped: layers.layers.lessons.budgetSkipped,
        conflicts: lessonStats.conflicts,
      },
      emptyDays: consecutiveEmptyDays(paths),
    },
    // 事实层：唯一读出口是 facts_search 工具，所以这里没有 injected 字段——
    // 它本来就不进提示。面板只负责「有哪些条、锚点是什么、验证命令是什么」。
    facts: (() => {
      const factsText = readText(paths.factsFile, '')
      const described = describeFacts(factsText)
      return { text: factsText, sections: described.sections, stats: described.stats }
    })(),
    // A derived view of profile.md: no cache yet means the page says so instead
    // of showing five empty fields.
    identity: readIdentity(paths.identityFile),
    personaIsDue: personaIsDue(state, config),
    daily: latestDaily(paths),
  }
}

/** Register every `/persona-memory/*` route on the host web server. */
export function registerRoutes(server, deps) {
  const { paths, state, getConfig, applyConfig, runOnce, logger, version, modelCatalogue, refreshIdentity } = deps

  const statusPayload = () => {
    const config = getConfig()
    const base = statusOf(paths, config, state, version)
    const profileText = readText(paths.profileFile, '')
    const personaText = readText(paths.personaFile, '')
    const lessonsText = readText(paths.lessonsFile, '')
    return {
      ...base,
      config: publicConfig(config),
      personaIsDue: personaIsDue(state, config),
      stats: {
        profile: documentStats(profileText, PROFILE_SECTIONS),
        persona: documentStats(personaText, PERSONA_SECTIONS),
        lessons: lessonsStats(lessonsText),
      },
      runs: (state.runs ?? []).slice(-8).reverse(),
      history: listHistory(paths).slice(0, 20),
    }
  }

  const handle = (name, handler) => {
    server.register({
      kind: 'exact',
      path: `/persona-memory/${name}`,
      handler: (request, response) => {
        if (!isLoopback(request)) {
          sendError(response, 403, 'loopback only')
          return
        }
        Promise.resolve(handler(request, response)).catch((error) => {
          logger.error(`${name}: ${error.message}`)
          if (!response.headersSent) sendError(response, 500, error.message)
        })
      },
    })
  }

  const requireMethod = (request, response, method) => {
    if (request.method === method) return true
    response.writeHead(405, { allow: method })
    response.end()
    return false
  }

  const snapshot = () => {
    const payload = documentsPayload(paths, getConfig(), state)
    return { ...payload, status: statusPayload() }
  }

  handle('status', (request, response) => {
    if (!requireMethod(request, response, 'GET')) return
    sendJson(response, 200, { ok: true, status: statusPayload(), ...documentsPayload(paths, getConfig(), state) })
  })

  handle('config', async (request, response) => {
    if (request.method === 'GET') {
      const config = getConfig()
      sendJson(response, 200, { ok: true, ...publicConfig(config) })
      return
    }
    if (!requireMethod(request, response, 'POST')) return
    const body = await readJsonBody(request)
    const patch = body.patch !== null && typeof body.patch === 'object' ? body.patch : body
    const config = applyConfig(patch)
    logger.info(`config updated: ${JSON.stringify(patch)}`)
    sendJson(response, 200, { ok: true, ...publicConfig(config) })
  })

  handle('run', async (request, response) => {
    if (!requireMethod(request, response, 'POST')) return
    const body = await readJsonBody(request)
    const report = await runOnce(true, { forcePersona: body.forcePersona === true })
    sendJson(response, 200, { ok: true, report, status: statusPayload() })
  })

  handle('documents', (request, response) => {
    if (!requireMethod(request, response, 'GET')) return
    sendJson(response, 200, documentsPayload(paths, getConfig(), state))
  })

  // The dropdown behind the provider/model fields. Kept separate from `status`
  // because model discovery can be slow (it may hit the provider) and the page
  // must stay usable while it runs.
  handle('models', async (request, response) => {
    if (!requireMethod(request, response, 'GET')) return
    const catalogue = typeof modelCatalogue === 'function' ? await modelCatalogue() : { providers: [], models: {} }
    sendJson(response, 200, { ok: true, providers: catalogue.providers ?? [], models: catalogue.models ?? {} })
  })

  handle('pin', async (request, response) => {
    if (!requireMethod(request, response, 'POST')) return
    const body = await readJsonBody(request)
    const doc = body.doc === 'persona' ? 'persona' : 'profile'
    const pinned = body.pinned !== false
    const file = doc === 'profile' ? paths.profileFile : paths.personaFile
    const sections = SECTIONS_BY_DOC[doc]
    const current = readText(file, '')
    if (current.trim().length === 0) {
      sendError(response, 400, `${doc} 尚未生成`)
      return
    }
    const result = setPinned(current, sections, String(body.id ?? ''), pinned, { title: doc === 'profile' ? '用户画像' : '助手性格' })
    if (!result.changed) {
      sendError(response, 404, `没有找到 id 为 ${body.id} 的条目`)
      return
    }
    writeTextAtomic(file, result.text)
    logger.info(`pin ${doc}/${body.id}=${pinned}`)
    sendJson(response, 200, snapshot())
  })

  // The identity block has exactly one write action: regenerate it from the
  // current profile. There is deliberately no way to edit its text — it is a
  // derived view, not a second memory the user can steer.
  handle('identity/refresh', async (request, response) => {
    if (!requireMethod(request, response, 'POST')) return
    if (typeof refreshIdentity !== 'function') {
      sendError(response, 503, 'identity generation is unavailable')
      return
    }
    const result = await refreshIdentity()
    logger.info(`identity refresh: generated=${result?.generated === true}${result?.error ? ` error=${result.error}` : ''}`)
    sendJson(response, 200, {
      ok: true,
      ...documentsPayload(paths, getConfig(), state),
      identityError: result?.error ?? null,
      identityGenerated: result?.generated === true,
    })
  })

  // ── lessons ────────────────────────────────────────────────────────────────
  // Every lesson route is a human action on the lessons document. There is no
  // route that lets the system rewrite an entry, and none that arms a 铁律
  // without the approve click: that is how 「只有人能增删铁律」 is enforced.
  const lessonsMutation = async (request, response, name, run) => {
    if (!requireMethod(request, response, 'POST')) return
    const body = await readJsonBody(request)
    const current = readText(paths.lessonsFile, '')
    const result = run(current, body)
    if (result.changed !== true) {
      sendError(response, 400, result.error ?? '未写入')
      return
    }
    backupDocument(paths, 'lessons', current)
    writeTextAtomic(paths.lessonsFile, result.text)
    logger.info(`lessons ${name}: ${String(body.id ?? body.text ?? '').slice(0, 40)}`)
    sendJson(response, 200, snapshot())
  }

  handle('lessons/add', (request, response) => lessonsMutation(request, response, 'add', (current, body) => addManualLesson(current, {
    section: body.section === 'exp' ? 'exp' : 'rule',
    text: body.text,
    scope: typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope : SCOPE_GLOBAL,
  }, { date: todayKey() })))

  handle('lessons/approve', (request, response) => lessonsMutation(request, response, 'approve', (current, body) => approveLesson(current, String(body.id ?? ''), { date: todayKey() })))

  handle('lessons/reject', (request, response) => lessonsMutation(request, response, 'reject', (current, body) => archiveLesson(current, String(body.id ?? ''), body.reason, { date: todayKey() })))

  handle('lessons/replace', (request, response) => lessonsMutation(request, response, 'replace', (current, body) => replaceLesson(current, String(body.id ?? ''), body.text, { date: todayKey() })))

  // ── facts ──────────────────────────────────────────────────────────────────
  // 事实层 v1 只由人写。这里刻意没有「模型可以调用」的写路由：事实不改写事实，
  // 也不回写画像/自述。写入一律先备份，作废必须给原因。
  const factsMutation = async (request, response, name, run) => {
    if (!requireMethod(request, response, 'POST')) return
    const body = await readJsonBody(request)
    const current = readText(paths.factsFile, '')
    const result = run(current, body)
    if (result.changed !== true) {
      sendError(response, 400, result.error ?? '未写入')
      return
    }
    backupDocument(paths, 'facts', current)
    writeTextAtomic(paths.factsFile, result.text)
    logger.info(`facts ${name}: ${String(body.id ?? body.text ?? '').slice(0, 40)}`)
    sendJson(response, 200, snapshot())
  }

  handle('facts/add', (request, response) => factsMutation(request, response, 'add', (current, body) => addManualFact(current, {
    text: body.text,
    scope: body.scope,
    verify: body.verify,
    prompt: body.prompt,
    anchor: { date: body.date, note: body.note },
  }, { date: body.date ?? todayKey() })))

  handle('facts/archive', (request, response) => factsMutation(request, response, 'archive', (current, body) => archiveFact(current, String(body.id ?? ''), body.reason, { date: todayKey() })))

  handle('facts/confirm', (request, response) => factsMutation(request, response, 'confirm', (current, body) => confirmFact(current, String(body.id ?? ''), { date: todayKey() })))

  handle('history', (request, response) => {
    if (!requireMethod(request, response, 'GET')) return
    const url = new URL(request.url ?? '/', 'http://localhost')
    const doc = url.searchParams.get('doc') ?? undefined
    if (doc !== undefined && !HISTORY_DOCS.includes(doc)) {
      sendError(response, 400, `unknown document: ${doc}`)
      return
    }
    sendJson(response, 200, { ok: true, files: listHistory(paths, doc) })
  })

  handle('rollback', async (request, response) => {
    if (!requireMethod(request, response, 'POST')) return
    const body = await readJsonBody(request)
    // Lessons backups appear in the same history list, so the restore action has
    // to accept them too — otherwise the button fails with "not a profile backup".
    const doc = body.doc === 'persona' ? 'persona' : body.doc === 'lessons' ? 'lessons' : body.doc === 'facts' ? 'facts' : 'profile'
    const result = restoreHistory(paths, doc, body.name)
    logger.info(`rollback ${doc} <- ${result.name}`)
    sendJson(response, 200, { ok: true, restored: result, ...snapshot() })
  })
}
