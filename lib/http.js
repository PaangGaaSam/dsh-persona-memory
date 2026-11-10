import fs from 'node:fs'
import path from 'node:path'
import { publicConfig } from './config.js'
import { personaIsDue } from './digest.js'
import { HISTORY_DOCS, listHistory, restoreHistory } from './history.js'
import { PERSONA_HEADING } from './inject.js'
import { parseProfile, PERSONA_SECTIONS, PROFILE_SECTIONS, documentStats, renderPersonaInjection, setPinned } from './profile.js'
import { statusOf } from './state.js'
import { readText, writeTextAtomic } from './util.js'

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

/** Project one markdown document into sections of plain entries for the UI. */
export function describeDocument(text, doc) {
  const sections = SECTIONS_BY_DOC[doc]
  const state = parseProfile(text.length > 0 ? text : '', sections)
  return sections.map((section) => ({
    key: section.key,
    title: section.title,
    entries: (state.get(section.key) ?? []).map((entry) => ({
      id: entry.id,
      pinned: entry.pinned,
      confidence: Number(entry.confidence.toFixed(2)),
      lastVerified: entry.lastVerified,
      text: entry.text,
      evidence: entry.evidence,
    })),
  }))
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
  const rendered = renderPersonaInjection(text, PERSONA_SECTIONS, PERSONA_HEADING, Math.floor(budget * 0.3))
  const count = rendered.split('\n').filter((line) => line.startsWith('- ')).length
  return { enabled: true, count, chars: rendered.length }
}

/**
 * Build the full panel payload: scheduler status, editable config, both
 * documents and their per-entry view, plus the latest daily note.
 */
export function documentsPayload(paths, config, state) {
  const profileText = readText(paths.profileFile, '')
  const personaText = readText(paths.personaFile, '')
  return {
    ok: true,
    documents: {
      profile: { text: profileText, sections: describeDocument(profileText, 'profile'), stats: documentStats(profileText, PROFILE_SECTIONS) },
      persona: {
        text: personaText,
        sections: describeDocument(personaText, 'persona'),
        stats: documentStats(personaText, PERSONA_SECTIONS),
        injected: personaInjection(personaText, config),
      },
    },
    personaIsDue: personaIsDue(state, config),
    daily: latestDaily(paths),
  }
}

/** Register every `/persona-memory/*` route on the host web server. */
export function registerRoutes(server, deps) {
  const { paths, state, getConfig, applyConfig, runOnce, logger, version, modelCatalogue } = deps

  const statusPayload = () => {
    const config = getConfig()
    const base = statusOf(paths, config, state, version)
    const profileText = readText(paths.profileFile, '')
    const personaText = readText(paths.personaFile, '')
    return {
      ...base,
      config: publicConfig(config),
      personaIsDue: personaIsDue(state, config),
      stats: {
        profile: documentStats(profileText, PROFILE_SECTIONS),
        persona: documentStats(personaText, PERSONA_SECTIONS),
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
    const doc = body.doc === 'persona' ? 'persona' : 'profile'
    const result = restoreHistory(paths, doc, body.name)
    logger.info(`rollback ${doc} <- ${result.name}`)
    sendJson(response, 200, { ok: true, restored: result, ...snapshot() })
  })
}
