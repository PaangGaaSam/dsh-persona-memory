import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { composeConfig, loadOverrides, saveOverrides } from './config.js'
import { runDigest } from './digest.js'
import { listHistory, restoreHistory } from './history.js'
import { registerRoutes } from './http.js'
import { buildSectionText } from './inject.js'
import { appendLockedEntry, PERSONA_SECTIONS, PROFILE_SECTIONS, setPinned } from './profile.js'
import { acquireLock, createLogger, loadState, recordRun, releaseLock, saveState, statusOf } from './state.js'
import { ensureDir, readText, resolveDshHome, todayKey, writeTextAtomic } from './util.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

function resolvePaths() {
  const home = resolveDshHome()
  const root = path.join(home, 'persona-memory')
  return {
    root,
    sessionsRoot: path.join(home, 'sessions'),
    dailyDir: path.join(root, 'daily'),
    profileFile: path.join(root, 'profile.md'),
    personaFile: path.join(root, 'persona.md'),
    stateFile: path.join(root, 'state.json'),
    configFile: path.join(root, 'config.json'),
    lockFile: path.join(root, '.run.lock'),
    logDir: path.join(root, 'logs'),
  }
}

function formatReport(report, opts = {}) {
  if (report.skipped === true) return `今日（${report.date}）没有可总结的会话：采集到 ${report.sessions} 个会话，但都为空或在窗口外。`
  const lines = [
    `已将 ${report.date} 的 ${report.sessions} 个会话总结为卡片 ${report.cards} 张。`,
    `日报：${report.daily}`,
  ]
  if (report.profile !== null) lines.push(`画像：新增 ${report.profile.applied} 条，合并 ${report.profile.merged} 条（v${report.profile.version}）。`)
  else lines.push('画像：本次未更新（模型未返回建议或 autoApply=false）。')
  if (report.persona !== null) {
    const moved = []
    if ((report.persona.promoted ?? 0) > 0) moved.push(`晋升 ${report.persona.promoted}`)
    if ((report.persona.demoted ?? 0) > 0) moved.push(`降级 ${report.persona.demoted}`)
    if ((report.persona.superseded ?? 0) > 0) moved.push(`推翻 ${report.persona.superseded}`)
    const suffix = moved.length > 0 ? `，${moved.join('、')}` : ''
    lines.push(`性格：新增 ${report.persona.applied} 条，合并 ${report.persona.merged} 条${suffix}（v${report.persona.version}）。`)
  } else if (opts.forcePersona === true) lines.push('性格：本次未生成新条目（模型未返回候选，或当前证据不足）。')
  else lines.push('性格：未到每周合并时间或未更新。')
  return lines.join('\n')
}

/**
 * Host half of dsh-persona-memory.
 * @param {object} ctx - Cordis context of the profile scope.
 * @param {object} rawConfig - patch-row config.
 */
export function apply(ctx, rawConfig) {
  const paths = resolvePaths()
  for (const dir of [paths.root, paths.dailyDir, paths.logDir]) ensureDir(dir)
  const logger = createLogger(paths.logDir)
  const state = loadState(paths.stateFile, (message) => logger.warn(message))
  // `running` is per-process: a previous process that died mid-run leaves it set,
  // and the UI would report a run forever. The lock file guards real concurrency.
  state.running = false
  // Settings-page overrides live in their own file so they survive restarts and
  // deleting it restores exactly what the patch row configured.
  let overrides = loadOverrides(paths.configFile)
  let config = composeConfig(rawConfig, overrides)
  let inFlight = false

  const getConfig = () => config
  const applyConfig = (patch) => {
    const result = saveOverrides(paths.configFile, rawConfig ?? {}, overrides, patch)
    overrides = result.overrides
    config = result.config
    return config
  }
  const status = () => statusOf(paths, config, state, VERSION)

  async function runOnce(manual, opts = {}) {
    if (inFlight) return '已有一次总结在运行，请稍后再试。'
    if (!acquireLock(paths.lockFile)) return '另一个进程正在运行总结（锁未释放），跳过本次。'
    inFlight = true
    state.running = true
    try {
      // The state file is authoritative: an operator may have adjusted the
      // schedule markers between runs (e.g. to force a persona consolidation).
      const disk = loadState(paths.stateFile, (message) => logger.warn(message))
      state.lastRunDay = disk.lastRunDay
      state.lastPersonaRunDay = disk.lastPersonaRunDay
      state.runs = disk.runs
      logger.info(`digest start (manual=${manual === true}, forcePersona=${opts.forcePersona === true})`)
      const report = await runDigest(ctx, config, paths, state, logger.log, opts)
      // Keep the outcome on the run record: the settings page turns it into the
      // completion banner (and system notification) without needing the log file.
      recordRun(state, {
        date: report.date ?? todayKey(),
        at: Date.now(),
        sessions: report.sessions ?? 0,
        cards: report.cards ?? 0,
        ok: true,
        skipped: report.skipped === true,
        profile: report.profile,
        persona: report.persona,
      })
      logger.info(`digest done sessions=${report.sessions} cards=${report.cards}`)
      return formatReport(report, opts)
    } catch (error) {
      recordRun(state, { date: todayKey(), at: Date.now(), sessions: 0, cards: 0, ok: false, error: error.message })
      logger.error(`digest failed: ${error.message}`)
      throw error
    } finally {
      state.running = false
      saveState(paths.stateFile, state)
      releaseLock(paths.lockFile)
      inFlight = false
    }
  }

  const textTool = (name, description, parameters, run) => ({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (exec.signal?.aborted) return '已取消。'
      try {
        return await run(args)
      } catch (error) {
        return `操作失败：${error.message}`
      }
    },
  })

  ctx.tools.register(defineTool(textTool(
    'persona_digest',
    'Run the persona-memory digest now: summarize today\'s sessions across all workspaces into a daily note, then merge observations into the user profile (and weekly personality). Set force_persona to also run the personality merge when the weekly window is closed. Returns a short report.',
    {
      days: { type: 'number', description: 'Reserved; the window is configured by windowHours.' },
      force_persona: { type: 'boolean', description: 'true runs the personality consolidation even when it is not due yet.' },
    },
    async (args) => runOnce(true, { forcePersona: args.force_persona === true }),
  )))
  ctx.tools.register(defineTool(textTool(
    'persona_profile',
    'Read the current user profile and companion personality files (markdown).',
    {},
    async () => {
      const profile = readText(paths.profileFile, '')
      const persona = readText(paths.personaFile, '')
      const parts = []
      parts.push(profile.trim().length > 0 ? profile : '（画像尚未生成，运行 persona_digest 或等待每日定时任务。）')
      if (config.personaEnabled) parts.push(persona.trim().length > 0 ? persona : '（性格尚未生成，每周合并后出现。）')
      return parts.join('\n\n---\n\n')
    },
  )))
  ctx.tools.register(defineTool(textTool(
    'persona_status',
    'Report the digest schedule, last run result, and file sizes.',
    {},
    async () => JSON.stringify(status(), null, 2),
  )))
  ctx.tools.register(defineTool(textTool(
    'persona_pin',
    'Pin (or unpin) one profile/persona entry by id so automatic merges never remove it. Ids appear in persona_profile output like [pref-1].',
    {
      id: { type: 'string', required: true, description: 'Entry id, e.g. "pref-1" or "core-2".' },
      pinned: { type: 'boolean', description: 'true (default) to pin, false to unpin.' },
    },
    async (args) => {
      const pin = args.pinned !== false
      let text = readText(paths.profileFile, '')
      let result = text.trim().length > 0 ? setPinned(text, PROFILE_SECTIONS, args.id, pin, { title: '用户画像' }) : { changed: false }
      let file = paths.profileFile
      if (!result.changed && config.personaEnabled) {
        const personaText = readText(paths.personaFile, '')
        if (personaText.trim().length > 0) {
          const personaResult = setPinned(personaText, PERSONA_SECTIONS, args.id, pin, { title: '助手性格' })
          if (personaResult.changed) {
            result = personaResult
            text = personaText
            file = paths.personaFile
          }
        }
      }
      if (!result.changed) return `没有找到 id 为 ${args.id} 的条目。`
      writeTextAtomic(file, result.text)
      logger.info(`pin ${args.id}=${pin}`)
      return `已${pin ? '置顶' : '取消置顶'} ${args.id}。`
    },
  )))
  ctx.tools.register(defineTool(textTool(
    'persona_rollback',
    'Restore the user profile or the companion personality from a pre-write backup. Call with no arguments to list the available backups first.',
    {
      document: { type: 'string', description: '"profile" or "persona". Omit to list backups for both.' },
      name: { type: 'string', description: 'Backup file name, e.g. "profile-2026-11-10-1794287363131.md".' },
    },
    async (args) => {
      if (typeof args.name !== 'string' || args.name.length === 0) {
        const rows = listHistory(paths, args.document === 'persona' ? 'persona' : undefined)
        if (rows.length === 0) return '还没有任何历史版本。'
        return ['可用备份（新→旧）：', ...rows.slice(0, 20).map((row) => `- ${row.doc}	${row.name}	${row.size} 字节`)].join('\n')
      }
      const doc = args.document === 'persona' || args.name.startsWith('persona-') ? 'persona' : 'profile'
      const result = restoreHistory(paths, doc, args.name)
      logger.info(`rollback ${doc} <- ${result.name}`)
      return `已用 ${result.name} 还原${doc === 'profile' ? '画像' : '性格'}。被替换的版本已存入 history。`
    },
  )))
  ctx.tools.register(defineTool(textTool(
    'persona_note',
    'Append one user-dictated rule (preference or red line) to the locked section of the user profile. Automatic merges never modify that section.',
    { text: { type: 'string', required: true, description: 'The rule, phrased by the user.' } },
    async (args) => {
      const body = String(args.text ?? '').trim()
      if (body.length === 0) return '内容为空，未写入。'
      const profileText = readText(paths.profileFile, '')
      const result = appendLockedEntry(profileText, PROFILE_SECTIONS, body, { title: '用户画像' })
      writeTextAtomic(paths.profileFile, result.text)
      logger.info(`note appended: ${body.slice(0, 60)}`)
      return '已写入「手动锁定」区，自动流程不会改写它。'
    },
  )))

  if (config.promptBudgetChars > 0) {
    ctx.systemPrompt.section({
      name: 'persona-memory',
      order: 20,
      text: () => (config.promptBudgetChars > 0 ? buildSectionText(paths, config) : ''),
    })
  }

  ctx.inject(['webServer'], (scope) => {
    registerRoutes(scope.webServer, {
      paths,
      state,
      getConfig,
      applyConfig,
      runOnce,
      logger,
      version: VERSION,
    })
  })

  const tick = () => {
    if (inFlight) return
    const now = new Date()
    const minutes = now.getHours() * 60 + now.getMinutes()
    if (minutes < config.scheduleMinutes) return
    if (state.lastRunDay === todayKey(now)) return
    void runOnce(false)
  }
  const timer = setInterval(tick, 60 * 1000)
  ctx.effect(() => () => clearInterval(timer))
  const startup = setTimeout(tick, 45 * 1000)
  ctx.effect(() => () => clearTimeout(startup))
  logger.info(`loaded: v${VERSION} schedule=${config.schedule} provider=${config.provider} model=${config.model}`)
}

export const name = 'dsh-persona-memory'
export const inject = ['tools', 'systemPrompt', 'llm']
