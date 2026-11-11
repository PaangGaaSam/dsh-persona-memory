import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { collectSessions, decodeSessionLog, parseSessionLog } from '../lib/collector.js'
import { composeConfig, EDITABLE_KEYS, loadOverrides, publicConfig, saveOverrides } from '../lib/config.js'
import { backupDocument, listHistory, restoreHistory } from '../lib/history.js'
import { describeDocument, documentsPayload, personaInjection, readJsonBody, registerRoutes } from '../lib/http.js'
import { ensureIdentity, identityInputs, parseIdentity, readIdentity } from '../lib/identity.js'
import {
  addManualLesson,
  applyLessonSuggestions,
  approveLesson,
  archiveLesson,
  assertAppendOnly,
  conflictPairs,
  consecutiveEmptyDays,
  describeLessons,
  emptyLessons,
  formatDailyLesson,
  lessonsStats,
  parseDailyLessons,
  parseLessons,
  renderLessonsInjection,
  replaceLesson,
  scopeMatches,
} from '../lib/lessons.js'
import {
  appendLockedEntry,
  applyPersonaSuggestions,
  applySuggestions,
  canonicalEvidence,
  emptyProfile,
  evidenceStats,
  formatEvidence,
  isSelfNarrative,
  parseEvidence,
  parseProfile,
  PERSONA_SECTIONS,
  PROFILE_SECTIONS,
  renderForInjection,
  renderPersonaInjection,
  setPinned,
} from '../lib/profile.js'
import { extractJson, parseCard, parseDaily, parseDailyObservations, parseLessonSuggestions, parsePersonaSuggestions, parseSuggestions, readRecentDailyObservations, renderDaily, runDigest, sessionKey, evidenceFromCites, detectConsequenceSignals } from '../lib/digest.js'
import { PERSONA_HEADING, buildSectionText, planBudget, renderLayers } from '../lib/inject.js'
import { resolveDshHome } from '../lib/util.js'

let passed = 0
const pending = []
async function ok(name, fn) {
  const task = (async () => {
    const result = fn()
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') await result
    passed += 1
    console.log('ok -', name)
  })()
  pending.push(task)
  return task
}

ok('empty profile has every section', () => {
  const text = emptyProfile(PROFILE_SECTIONS, '用户画像')
  for (const section of PROFILE_SECTIONS) assert.ok(text.includes(`## ${section.title}`))
})

ok('suggestions add then merge near-duplicates', () => {
  const base = emptyProfile(PROFILE_SECTIONS, '用户画像')
  const first = applySuggestions(base, PROFILE_SECTIONS, [
    { kind: 'style', text: '喜欢先给结论再展开细节', confidence: 0.7, evidence: '2026-11-10/session-a' },
  ], { date: '2026-11-10' })
  assert.strictEqual(first.applied, 1)
  assert.strictEqual(first.merged, 0)
  const second = applySuggestions(first.text, PROFILE_SECTIONS, [
    { kind: 'style', text: '喜欢先给结论，再展开细节。', confidence: 0.8, evidence: '2026-11-11/session-b' },
  ], { date: '2026-11-11' })
  assert.strictEqual(second.applied, 0)
  assert.strictEqual(second.merged, 1)
  assert.ok(second.text.includes('2026-11-10/session-a、2026-11-11/session-b'))
})

ok('user-locked entries survive merges and stay first in injection', () => {
  let text = emptyProfile(PROFILE_SECTIONS, '用户画像')
  text = appendLockedEntry(text, PROFILE_SECTIONS, '不要用「您」', { date: '2026-11-01' }).text
  const merged = applySuggestions(text, PROFILE_SECTIONS, [
    { kind: 'preference', text: '偏好中文回复', confidence: 0.9, evidence: '2026-11-02/session-c' },
  ], { date: '2026-11-02' })
  assert.ok(merged.text.includes('不要用「您」'))
  const injection = renderForInjection(merged.text, PROFILE_SECTIONS, '## 已知偏好', 500)
  assert.ok(injection.startsWith('## 已知偏好'))
  assert.ok(injection.length <= 500)
})

ok('pin then unpin keeps the entry', () => {
  const text = emptyProfile(PROFILE_SECTIONS, '用户画像')
  const added = applySuggestions(text, PROFILE_SECTIONS, [
    { kind: 'thinking', text: '喜欢先验证再动手', confidence: 0.7, evidence: '2026-11-03/session-d' },
  ], { date: '2026-11-03' })
  const entry = parseProfile(added.text, PROFILE_SECTIONS).get('thinking')[0]
  const pinned = setPinned(added.text, PROFILE_SECTIONS, entry.id, true, { title: '用户画像' })
  assert.ok(pinned.text.includes('[P1]'))
  const unpinned = setPinned(pinned.text, PROFILE_SECTIONS, entry.id, false, { title: '用户画像' })
  assert.ok(!unpinned.text.includes('[P1]'))
})

ok('pin and locked notes preserve the document version', () => {
  const added = applySuggestions(emptyProfile(PROFILE_SECTIONS, '用户画像'), PROFILE_SECTIONS, [
    { kind: 'style', text: '喜欢先给结论', confidence: 0.8, evidence: '2026-11-10/s' },
  ], { date: '2026-11-10' })
  assert.strictEqual(added.version, 1)
  assert.ok(added.text.includes('\nversion: 1\n'))
  const entry = parseProfile(added.text, PROFILE_SECTIONS).get('style')[0]
  const pinned = setPinned(added.text, PROFILE_SECTIONS, entry.id, true, { title: '用户画像' })
  assert.strictEqual(pinned.changed, true)
  assert.ok(pinned.text.includes('\nversion: 1\n'), 'pinning must not reset the version')
  const noted = appendLockedEntry(pinned.text, PROFILE_SECTIONS, '不要用「您」', { date: '2026-11-10' })
  assert.ok(noted.text.includes('\nversion: 1\n'), 'locked notes must not reset the version')
  assert.ok(noted.text.includes('不要用「您」'))
})

ok('persona document keeps its own sections', () => {
  const text = emptyProfile(PERSONA_SECTIONS, '助手性格')
  const merged = applySuggestions(text, PERSONA_SECTIONS, [
    { section: 'core', text: '我判断先跑测试再重启（当时刚踩过一次坑）', confidence: 0.6, evidence: '2026-11-05/session-e' },
  ], { date: '2026-11-05' })
  assert.ok(merged.text.includes('## 我认为我是谁'))
  assert.ok(merged.text.includes('先跑测试再重启'))
})

const home = resolveDshHome()
const sessionsRoot = `${home}/sessions`
if (fs.existsSync(sessionsRoot)) {
  const now = Date.now()
  const sessions = collectSessions(sessionsRoot, now - 7 * 86400000, now, {})
  ok(`collector found ${sessions.length} sessions in the last 7 days`, () => {
    assert.ok(Array.isArray(sessions))
    for (const session of sessions) {
      assert.ok(session.messages.length > 0)
      assert.ok(session.messages.some((m) => m.role === 'user'))
      for (const message of session.messages) assert.ok(!message.text.startsWith('Current runtime context'))
    }
  })
  if (sessions.length > 0) {
    const sample = sessions[sessions.length - 1]
    assert.ok(sample.messages.some((m) => m.role === 'assistant'))
    console.log(`  sample: ${sample.id} @ ${sample.cwd} — ${sample.messages.length} messages`)
    const raw = fs.readFileSync(sample.file)
    const decoded = decodeSessionLog(raw)
    assert.ok(decoded.includes('"type":"session"'))
    const parsed = parseSessionLog(decoded, sample.id)
    assert.ok(parsed.messages.length >= sample.messages.length)
  }
} else {
  console.log('(no sessions root; collector live test skipped)')
}

ok('system-fact observations are filtered out of the profile', async () => {
  const { isSystemFactObservation } = await import('../lib/digest.js')
  assert.strictEqual(isSystemFactObservation('DSH 插件加载器按包名复用模块 import 缓存，重启才能加载新代码'), true)
  assert.strictEqual(isSystemFactObservation('用户偏好先给结论再展开细节'), false)
  assert.strictEqual(isSystemFactObservation('用户希望回复尽量用中文'), false)
})

ok('extractJson handles prose, fences, and braces inside strings', () => {
  const prose = '好的，结果如下：\n```json\n{"topic":"含 {花括号} 的主题","observations":[{"text":"a"}]}\n```\n希望有帮助。'
  const json = extractJson(prose)
  assert.strictEqual(json.topic, '含 {花括号} 的主题')
  assert.strictEqual(json.observations[0].text, 'a')
})

ok('parseCard accepts objects, plain strings, and missing keys', () => {
  const card = parseCard({
    topic: 'T',
    observations: [{ kind: 'style', text: '喜欢结论先行', confidence: 0.7 }, '字符串观察'],
    userNeeds: '一个需求',
  }, { id: 'session-x', cwd: 'C:\\w' }, '2026-11-10')
  assert.strictEqual(card.observations.length, 2)
  assert.ok(card.observations.every((o) => o.text.length > 0))
  assert.deepStrictEqual(card.userNeeds, ['一个需求'])
})

ok('parseDaily accepts a string summary and object observations', () => {
  const daily = parseDaily({ summary: '一句话总结', observations: [{ kind: 'thinking', text: '先验证再动手' }] })
  assert.deepStrictEqual(daily.summary, ['一句话总结'])
  assert.strictEqual(daily.observations[0].text, '先验证再动手')
})

ok('parseSuggestions and parsePersonaSuggestions normalize arrays', () => {
  const suggestions = parseSuggestions({ add: [{ kind: 'preference', text: '偏好中文', confidence: 0.9 }] })
  assert.strictEqual(suggestions.length, 1)
  assert.strictEqual(suggestions[0].kind, 'preference')
  const persona = parsePersonaSuggestions({ add: [{ section: 'core', text: '直接', confidence: 0.6 }] })
  assert.strictEqual(persona[0].section, 'core')
})

if (fs.existsSync(sessionsRoot)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-test-'))

  const paths = {
    root: tmp,
    sessionsRoot,
    dailyDir: path.join(tmp, 'daily'),
    profileFile: path.join(tmp, 'profile.md'),
    personaFile: path.join(tmp, 'persona.md'),
    identityFile: path.join(tmp, 'identity.json'),
    stateFile: path.join(tmp, 'state.json'),
    lockFile: path.join(tmp, '.lock'),
    logDir: path.join(tmp, 'logs'),
  }
  const config = {
    windowHours: 24,
    maxSessionsPerRun: 5,
    sessionCharLimit: 3000,
    provider: 'test-provider',
    model: 'test-model',
    temperature: 0.2,
    maxOutputTokens: 2000,
    autoApply: true,
    personaEnabled: true,
    personaUpdateEveryDays: 7,
    excludeWorkspaces: [],
  }
  const state = { lastPersonaRunDay: '', excludeSessionIds: [] }
  const ctx = {
    llm: {
      stream: async function* (options) {
        const system = options.messages[0].content[0].text
        let out
        if (system.includes('会话抽取器')) {
          out = JSON.stringify({
            topic: '测试主题',
            userNeeds: ['要一个插件'],
            observations: [{ kind: 'style', text: '喜欢先给结论再展开细节', confidence: 0.8 }],
            self: [{ event: '他要求先验证再重启', judgment: '我认为重启前该先跑一遍测试', confidence: 0.7 }],
            unresolved: ['重启后验证'],
          })
        } else if (system.includes('日记作者')) {
          out = JSON.stringify({ summary: ['完成了 v0.1 骨架'], unresolved: ['重启后验证'], observations: [{ kind: 'style', text: '喜欢直接看到结果', confidence: 0.7 }] })
        } else if (system.includes('用户画像编辑')) {
          out = JSON.stringify({ add: [{ kind: 'style', text: '喜欢先给结论再展开细节', confidence: 0.8, evidence: '2026-11-10/s' }] })
        } else if (system.includes('工作画像归纳器')) {
          out = JSON.stringify({
            fields: {
              role: { text: '大概率在做需要自己动手排障的开发或平台工作', basis: ['style-1'] },
              domain: { text: '插件与工具链', basis: ['style-1'] },
              stack: { text: '', basis: [] },
              workflow: { text: '先跑通再谈优化', basis: ['style-1'] },
              impression: { text: '', basis: [] },
            },
          })
        } else {
          out = JSON.stringify({ add: [{ section: 'core', text: '我第一次接手这个插件时想先跑测试再重启，所以现在默认先验证', confidence: 0.6, evidence: '2026-11-10/s' }] })
        }
        yield { type: 'text', text: out }
      },
    },
  }
  await ok('mock digest writes daily, profile, and persona files', async () => {
    const report = await runDigest(ctx, config, paths, state, () => {})
    assert.ok(report.skipped === false)
    assert.ok(fs.existsSync(report.daily))
    const note = fs.readFileSync(report.daily, 'utf8')
    assert.ok(note.includes('完成了 v0.1 骨架'))
    // The assistant's own judgment must be persisted, or the persona window can
    // never see evidence from an earlier day.
    assert.ok(note.includes('## 我的判断'))
    assert.ok(note.includes('他要求先验证再重启 → 我认为重启前该先跑一遍测试'))
    assert.ok(fs.readFileSync(paths.profileFile, 'utf8').includes('喜欢先给结论再展开细节'))
    const persona = fs.readFileSync(paths.personaFile, 'utf8')
    assert.ok(persona.includes('我第一次接手这个插件时想先跑测试再重启'))
    // The identity block is generated from the profile written above, and it is
    // cached beside it (never inside it).
    assert.strictEqual(report.identity.generated, true)
    const identity = JSON.parse(fs.readFileSync(paths.identityFile, 'utf8'))
    assert.strictEqual(identity.profileVersion, report.profile.version)
    assert.ok(identity.fields.role.text.length > 0)
    const now = new Date()
    const localDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    assert.strictEqual(state.lastPersonaRunDay, localDay)
  })

  await ok('lessons: the merge never reads persona.md', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-lessons-stage-'))
    const paths2 = {
      root: dir,
      sessionsRoot,
      dailyDir: path.join(dir, 'daily'),
      profileFile: path.join(dir, 'profile.md'),
      personaFile: path.join(dir, 'persona.md'),
      lessonsFile: path.join(dir, 'lessons.md'),
      identityFile: path.join(dir, 'identity.json'),
      stateFile: path.join(dir, 'state.json'),
      lockFile: path.join(dir, '.lock'),
      logDir: path.join(dir, 'logs'),
    }
    fs.mkdirSync(paths2.dailyDir, { recursive: true })
    fs.writeFileSync(paths2.personaFile, [
      '---', 'version: 1', 'updatedAt: 2026-11-10T00:00:00.000Z', 'title: 助手性格', '---', '',
      '## 我认为我是谁',
      '- [core-1] [置信度 0.90] 我是 MARKER-PERSONA 那种人（证据：2026-11-10/session-aaaa1111、2026-11-11/session-bbbb2222、2026-11-12/session-cccc3333）',
      '', '## 我和你相处时的样子', '', '## 还没想清楚的', '',
    ].join('\n'), 'utf8')
    const prompts = []
    const ctx2 = {
      llm: {
        stream: async function* (options) {
          const system = options.messages[0].content[0].text
          const user = options.messages[1].content[0].text
          prompts.push({ system, user })
          let out
          if (system.includes('会话抽取器')) {
            out = JSON.stringify({
              topic: '测试',
              observations: [{ kind: 'correction', text: '他纠正我不该先改', cites: [1] }],
              self: [{ event: '我直接改了代码', judgment: '我认为该先复现', confidence: 0.7, cites: [1] }],
              lessons: [{ section: 'exp', text: '改之前先复现', cites: [1] }],
              unresolved: ['测试失败'],
            })
          } else if (system.includes('日记作者')) {
            out = JSON.stringify({
              summary: ['一天'],
              unresolved: [],
              observations: [],
              lessons: [{ section: 'exp', text: '重启后确认注入段真的出现', evidence: '' }],
            })
          } else if (system.includes('用户画像编辑')) {
            out = JSON.stringify({ add: [] })
          } else if (system.includes('自我记述者')) {
            out = JSON.stringify({ add: [] })
          } else if (system.includes('教训整理器')) {
            out = JSON.stringify({ add: [{ section: 'exp', text: '改之前先复现，再动手改代码', scope: '全局', anchor: '2026-11-10/session-aaaa1111 · 他纠正我不该先改' }] })
          } else if (system.includes('工作画像归纳器')) {
            out = JSON.stringify({ fields: { role: { text: '', basis: [] } } })
          } else {
            out = '{}'
          }
          yield { type: 'text', text: out }
        },
      },
    }
    const report = await runDigest(ctx2, config, paths2, { lastPersonaRunDay: '', excludeSessionIds: [] }, () => {}, { forcePersona: true })
    const lessonPrompt = prompts.find((prompt) => prompt.system.includes('教训整理器'))
    assert.ok(lessonPrompt !== undefined, 'the lessons stage ran')
    assert.ok(!lessonPrompt.user.includes('MARKER-PERSONA'), 'persona.md is not part of the lessons input')
    assert.ok(!lessonPrompt.system.includes('MARKER-PERSONA'))
    const personaPrompt = prompts.find((prompt) => prompt.system.includes('自我记述者'))
    assert.ok(personaPrompt !== undefined, 'the persona stage ran in the same pass')
    assert.ok(personaPrompt.user.includes('MARKER-PERSONA'), 'the persona stage did read it — only the lessons stage may not')
    assert.ok(fs.readFileSync(paths2.lessonsFile, 'utf8').includes('改之前先复现'), 'the suggestion landed in lessons.md')
    assert.ok(report.lessons !== null && report.lessons.error === undefined)
    assert.strictEqual(report.lessons.added, 1)
  })
}

ok('config: overrides win over the patch row and only editable keys persist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-config-'))
  const file = path.join(dir, 'config.json')
  const row = { schedule: '18:30', model: 'row-model' }
  const initial = composeConfig(row, {})
  assert.strictEqual(initial.schedule, '18:30')
  assert.strictEqual(initial.scheduleMinutes, 18 * 60 + 30)
  assert.strictEqual(initial.model, 'row-model')

  const saved = saveOverrides(file, row, {}, { schedule: '09:05', model: 'ui-model', bogus: true })
  assert.strictEqual(saved.config.schedule, '09:05')
  assert.strictEqual(saved.config.scheduleMinutes, 9 * 60 + 5)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepStrictEqual(Object.keys(stored).sort(), ['model', 'schedule'])
  assert.strictEqual(stored.bogus, undefined)

  const reread = composeConfig(row, loadOverrides(file))
  assert.strictEqual(reread.schedule, '09:05')
  assert.strictEqual(reread.model, 'ui-model')

  const before = fs.readFileSync(file, 'utf8')
  assert.throws(() => saveOverrides(file, row, loadOverrides(file), { schedule: '25:00' }), /schedule/)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before)

  const exposed = publicConfig(initial)
  assert.deepStrictEqual(Object.keys(exposed.values).sort(), [...EDITABLE_KEYS].sort())
  assert.strictEqual(exposed.values.promptBudgetChars, 1200)
  assert.strictEqual(exposed.values.notifyOnRun, false)
  assert.strictEqual(exposed.values.personaCoreMinDates, 3)
})

ok('run records keep the outcome for the completion banner', async () => {
  const { recordRun } = await import('../lib/state.js')
  const state = { runs: [] }
  recordRun(state, {
    date: '2026-11-10',
    at: 100,
    sessions: 2,
    cards: 2,
    ok: true,
    skipped: false,
    profile: { applied: 3, merged: 1 },
    persona: { applied: 1, merged: 0, promoted: 1, demoted: 0, superseded: 0 },
  })
  assert.strictEqual(state.runs[0].profile.applied, 3)
  assert.strictEqual(state.runs[0].persona.promoted, 1)
  assert.strictEqual(state.lastResult, 'ok')
})

ok('history: backups list newest first and restore is reversible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-history-'))
  const paths = {
    root: dir,
    profileFile: path.join(dir, 'profile.md'),
    personaFile: path.join(dir, 'persona.md'),
  }
  fs.writeFileSync(paths.profileFile, 'v1', 'utf8')
  backupDocument(paths, 'profile', 'v1', '2026-11-10', 1000)
  fs.writeFileSync(paths.profileFile, 'v2', 'utf8')
  backupDocument(paths, 'profile', 'v2', '2026-11-11', 2000)
  assert.strictEqual(backupDocument(paths, 'profile', '   ', '2026-11-11', 3000), undefined)

  const rows = listHistory(paths, 'profile')
  assert.strictEqual(rows.length, 2)
  assert.deepStrictEqual(rows.map((row) => row.at), [2000, 1000])
  assert.ok(rows.every((row) => row.doc === 'profile'))

  const restored = restoreHistory(paths, 'profile', rows[1].name)
  assert.strictEqual(restored.replaced, true)
  assert.strictEqual(fs.readFileSync(paths.profileFile, 'utf8'), 'v1')
  assert.strictEqual(listHistory(paths, 'profile').length, 3)

  assert.throws(() => restoreHistory(paths, 'profile', 'persona-2026-11-10-1000.md'), /not a profile backup/)
  assert.throws(() => restoreHistory(paths, 'profile', '../../etc/passwd'), /not a profile backup/)
})

ok('http: documents project entries and the panel payload carries the daily note', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-http-'))
  const paths = {
    root: dir,
    dailyDir: path.join(dir, 'daily'),
    profileFile: path.join(dir, 'profile.md'),
    personaFile: path.join(dir, 'persona.md'),
    stateFile: path.join(dir, 'state.json'),
    lockFile: path.join(dir, '.lock'),
    logDir: path.join(dir, 'logs'),
  }
  fs.mkdirSync(paths.dailyDir, { recursive: true })
  fs.writeFileSync(path.join(paths.dailyDir, '2026-11-09.md'), '# 旧\n', 'utf8')
  fs.writeFileSync(path.join(paths.dailyDir, '2026-11-10.md'), '# 今天\n', 'utf8')
  const merged = applySuggestions(emptyProfile(PROFILE_SECTIONS, '用户画像'), PROFILE_SECTIONS, [
    { kind: 'style', text: '喜欢先给结论', confidence: 0.8, evidence: '2026-11-10/s' },
  ], { date: '2026-11-10' })
  fs.writeFileSync(paths.profileFile, merged.text, 'utf8')

  const doc = describeDocument(merged.text, 'profile')
  assert.strictEqual(doc.length, PROFILE_SECTIONS.length)
  const styleSection = doc.find((section) => section.key === 'style')
  assert.strictEqual(styleSection.entries.length, 1)
  assert.strictEqual(styleSection.entries[0].id, 'style-1')
  assert.strictEqual(styleSection.entries[0].pinned, false)

  const payload = documentsPayload(paths, composeConfig({}, {}), { lastPersonaRunDay: '' })
  assert.strictEqual(payload.ok, true)
  assert.strictEqual(payload.daily.date, '2026-11-10')
  assert.strictEqual(payload.daily.text, '# 今天\n')
  assert.strictEqual(payload.personaIsDue, true)
  assert.strictEqual(payload.documents.profile.stats.counts['沟通习惯'], 1)
  // The panel must be able to tell "the file has entries" from "the prompt gets
  // any": an empty persona document injects nothing, and the count says so.
  assert.deepStrictEqual(payload.documents.persona.injected, { enabled: true, count: 0, chars: 0 })
  assert.deepStrictEqual(documentsPayload(paths, composeConfig({}, { promptBudgetChars: 0 }), {}).documents.persona.injected, { enabled: false, count: 0, chars: 0 })
  // The lessons layer is always projected, even before lessons.md exists.
  assert.strictEqual(payload.lessons.sections.length, 3)
  assert.deepStrictEqual(payload.lessons.sections.map((section) => section.key), ['rule', 'exp', 'archive'])
  assert.deepStrictEqual(payload.lessons.stats.counts, { rule: 0, exp: 0, archive: 0 })
  assert.strictEqual(payload.lessons.injected.count, 0)
  // The two older daily notes have no 可疑雷点 section (they predate the feature),
  // so they were never asked — the streak is 0, not 2.
  assert.strictEqual(payload.lessons.emptyDays, 0)
})

ok('persona injection count matches what actually reaches the prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-inject-'))
  const paths = { root: dir, personaFile: path.join(dir, 'persona.md') }
  const config = composeConfig({}, {})
  const rule = { date: '2026-11-10', title: '助手性格', styleMinSessions: 3, coreMinSessions: 3, coreMinDates: 3, demoteAfterDays: 30 }
  let text = emptyProfile(PERSONA_SECTIONS, '助手性格')
  // One candidate: no sessions yet, so nothing is injected.
  text = applyPersonaSuggestions(text, PERSONA_SECTIONS, [
    { section: 'candidate', text: '我上次先给结论是对的（当时他没追问）', confidence: 0.7, evidence: '2026-11-10/session-a' },
  ], rule).text
  assert.strictEqual(personaInjection(text, config).count, 0, 'a candidate is never injected')
  // Three distinct sessions promote it to 我和你相处时的样子.
  for (const session of ['session-b', 'session-c', 'session-d']) {
    text = applyPersonaSuggestions(text, PERSONA_SECTIONS, [
      { section: 'style', text: '我上次先给结论是对的（当时他没追问）', confidence: 0.7, evidence: `2026-11-10/${session}` },
    ], rule).text
  }
  const injected = personaInjection(text, config)
  assert.strictEqual(injected.count, 1)
  assert.ok(injected.chars > 0)
})

ok('the persona document has no user-locked section left', () => {
  assert.deepStrictEqual(PERSONA_SECTIONS.map((section) => section.key), ['core', 'style', 'candidate'])
  // A leftover heading from an older document must be ignored, not crash parse.
  const legacy = ['## 用户固定规则', '- [lock-1] 不要用「您」', '## 我认为我是谁', ''].join('\n')
  const state = parseProfile(legacy, PERSONA_SECTIONS)
  assert.strictEqual(state.size, 3)
  assert.deepStrictEqual(appendLockedEntry(legacy, PERSONA_SECTIONS, '不要用「您」'), { text: legacy, added: false })
})

ok('http: readJsonBody accepts JSON, rejects junk, treats an empty body as {}', async () => {
  const parsed = await readJsonBody(Readable.from([Buffer.from('{"patch":{"model":"m"}}')]))
  assert.strictEqual(parsed.patch.model, 'm')
  await assert.rejects(() => readJsonBody(Readable.from([Buffer.from('not json')])), /must be JSON/)
  assert.deepStrictEqual(await readJsonBody(Readable.from([])), {})
})

ok('client bundle registers a settings section and renders the loaded panel', async () => {
  const code = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const stores = new Map()
  const rendered = []
  let activeStore = null
  let cursor = 0
  const sameDeps = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const fakeReact = {
    begin(component) {
      if (!stores.has(component)) stores.set(component, { values: [], refs: [], deps: [], memo: [], pendingEffects: [] })
      activeStore = stores.get(component)
      cursor = 0
      activeStore.pendingEffects = []
    },
    end() {
      const disposers = []
      for (const entry of activeStore.pendingEffects) {
        const previous = activeStore.deps[entry.index]
        if (previous !== undefined && sameDeps(entry.deps, previous)) continue
        activeStore.deps[entry.index] = entry.deps
        const dispose = entry.fn()
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      activeStore.pendingEffects = []
      return disposers
    },
    useState(initial) {
      const store = activeStore
      const index = cursor++
      if (index >= store.values.length) store.values[index] = typeof initial === 'function' ? initial() : initial
      return [store.values[index], (next) => {
        store.values[index] = typeof next === 'function' ? next(store.values[index]) : next
      }]
    },
    useEffect(fn, deps) {
      const index = cursor++
      activeStore.pendingEffects.push({ index, fn, deps })
    },
    useMemo(fn, deps) {
      const index = cursor++
      const slot = activeStore.memo[index]
      if (slot !== undefined && sameDeps(deps, slot.deps)) return slot.value
      const value = fn()
      activeStore.memo[index] = { deps, value }
      return value
    },
    useCallback(fn, deps) {
      const index = cursor++
      const slot = activeStore.memo[index]
      if (slot !== undefined && sameDeps(deps, slot.deps)) return slot.value
      activeStore.memo[index] = { deps, value: fn }
      return fn
    },
    useRef(initial) {
      const index = cursor++
      if (activeStore.refs[index] === undefined) activeStore.refs[index] = { current: initial }
      return activeStore.refs[index]
    },
  }
  const fakeJsxRuntime = {
    Fragment: Symbol('Fragment'),
    // React's automatic runtime takes a *key* as the third argument, so a string
    // is legitimate. An element or array there is the settings-card bug: the
    // children were handed over as the key and silently dropped. Refuse that.
    jsx: (type, props, maybeKey) => {
      if (maybeKey !== undefined && typeof maybeKey === 'object') {
        throw new Error(`jsx third argument is the key, not children: ${typeof type === 'function' ? type.name : String(type)}`)
      }
      return { type, props: props ?? {} }
    },
    jsxs: (type, props, maybeKey) => {
      if (maybeKey !== undefined && typeof maybeKey === 'object') {
        throw new Error(`jsxs third argument is the key, not children: ${typeof type === 'function' ? type.name : String(type)}`)
      }
      return { type, props: props ?? {} }
    },
  }
  const payload = {
    ok: true,
    status: {
      plugin: 'dsh-persona-memory',
      version: '0.2.0',
      running: false,
      lastRunDay: '2026-11-10',
      lastRunAt: 1794287363131,
      lastResult: 'ok',
      lastError: null,
      lastPersonaRunDay: '',
      schedule: '17:00',
      provider: 'deepseek-account',
      model: 'deepseek-v4-pro',
      config: publicConfig(composeConfig({}, {})),
      history: [{ doc: 'profile', name: 'profile-2026-11-10-1000.md', date: '2026-11-10', at: 1000, size: 10 }],
    },
    documents: {
      profile: {
        text: '',
        sections: describeDocument((() => {
          let text = emptyProfile(PROFILE_SECTIONS, '用户画像')
          text = appendLockedEntry(text, PROFILE_SECTIONS, '不要用「您」', { date: '2026-11-09' }).text
          text = appendLockedEntry(text, PROFILE_SECTIONS, '结论写在第一行', { date: '2026-11-09' }).text
          text = appendLockedEntry(text, PROFILE_SECTIONS, '不要加寒暄', { date: '2026-11-09' }).text
          text = appendLockedEntry(text, PROFILE_SECTIONS, '引用要给出处', { date: '2026-11-09' }).text
          return applySuggestions(text, PROFILE_SECTIONS, [
            { kind: 'preference', text: '偏好一', confidence: 0.9, evidence: '2026-11-10/p1' },
            { kind: 'preference', text: '偏好二', confidence: 0.8, evidence: '2026-11-10/p2' },
            { kind: 'preference', text: '偏好三', confidence: 0.7, evidence: '2026-11-10/p3' },
            { kind: 'style', text: '喜欢先给结论', confidence: 0.8, evidence: '2026-11-10/s' },
            { kind: 'style', text: '夹在中间的一条', confidence: 0.7, evidence: '2026-11-10/s2' },
            { kind: 'style', text: '第三条刚好还在前三', confidence: 0.6, evidence: '2026-11-10/s3' },
            { kind: 'style', text: '第四条应当被折叠', confidence: 0.5, evidence: '2026-11-10/s4' },
            { kind: 'style', text: '第五条也应当被折叠', confidence: 0.4, evidence: '2026-11-10/s5' },
          ], { date: '2026-11-10' }).text
        })(), 'profile'),
        stats: { counts: {}, pinned: 0 },
      },
      persona: {
        text: '',
        sections: describeDocument((() => {
          let text = emptyProfile(PERSONA_SECTIONS, '助手性格')
          text = applyPersonaSuggestions(text, PERSONA_SECTIONS, [
            { section: 'candidate', text: '自述一', confidence: 0.9, evidence: '2026-11-08/s1' },
            { section: 'candidate', text: '自述二', confidence: 0.7, evidence: '2026-11-10/s2' },
            { section: 'candidate', text: '自述三', confidence: 0.6, evidence: '2026-11-10/s3' },
            { section: 'candidate', text: '自述四被折起来', confidence: 0.5, evidence: '2026-11-10/s4' },
            { section: 'candidate', text: '自述五被折起来', confidence: 0.4, evidence: '2026-11-10/s5' },
          ], { date: '2026-11-10' }).text
          // Persona rows can be pinned too; the pin must float above the fold.
          return setPinned(text, PERSONA_SECTIONS, 'cand-1', true, { title: '助手性格' }).text
        })(), 'persona'),
        stats: { counts: {}, pinned: 0 },
        injected: { enabled: true, count: 0, chars: 0 },
      },
    },
    identity: {
      profileVersion: 4,
      profileUpdatedAt: '2026-11-10T06:54:21.111Z',
      generatedAt: '2026-11-10T07:00:00.000Z',
      used: 3,
      excluded: 2,
      fields: {
        role: { text: '大概率在做平台工程', basis: ['style-1', 'style-2'] },
        domain: { text: '插件与工具链', basis: ['style-1'] },
        stack: { text: '', basis: [] },
        workflow: { text: '先跑通再谈优化', basis: [] },
        impression: { text: '对不确定的地方会先问清楚', basis: [] },
      },
    },
    personaIsDue: false,
    daily: { date: '2026-11-10', text: '# 今天\n- 完成 v0.2' },
    // The lessons card: two active rules (one conflicting with an experience),
    // one 待确认 rule, two active experiences, two retired rows. Nothing here
    // folds except the archive, which is exactly what the page must show.
    lessons: {
      text: '',
      sections: describeLessons((() => {
        let text = emptyLessons()
        text = addManualLesson(text, { section: 'rule', text: '删文件前先确认绝对路径', scope: '全局' }, { date: '2026-11-09' }).text
        text = addManualLesson(text, { section: 'rule', text: '改完代码必须先跑测试再重启', scope: '全局' }, { date: '2026-11-09' }).text
        text = addManualLesson(text, { section: 'exp', text: '改完代码不要跑测试，直接重启更快', scope: '全局' }, { date: '2026-11-09' }).text
        text = addManualLesson(text, { section: 'exp', text: '这个仓库要先构建客户端', scope: 'D:\\repo-a' }, { date: '2026-11-09' }).text
        text = addManualLesson(text, { section: 'exp', text: '写状态文件别用 Set-Content', scope: '全局' }, { date: '2026-11-09' }).text
        text = archiveLesson(text, 'exp-2', '环境已经变了', { date: '2026-11-10' }).text
        text = archiveLesson(text, 'exp-3', '已经改成自动写盘', { date: '2026-11-10' }).text
        return applyLessonSuggestions(text, [
          { section: 'rule', text: '覆盖文件前先备份', scope: '全局', anchor: { date: '2026-11-10', session: 'session-x', note: '改错配置' } },
        ], { date: '2026-11-10' }).text
      })(), {}),
      stats: { counts: { rule: 2, exp: 1, archive: 2 }, pending: 1, conflicts: 2 },
      injected: { enabled: true, count: 2, chars: 60, skipped: 1, conflicts: 2 },
      emptyDays: 2,
    },
  }
  const fetchCalls = []
  let currentPayload = payload
  const modelsPayload = {
    ok: true,
    providers: [{ id: 'deepseek-account', name: 'DeepSeek' }],
    models: { 'deepseek-account': [{ id: 'deepseek-flash', name: 'deepseek-flash' }, { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }] },
  }
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET', body: init?.body })
    // The panel asks for the model catalogue separately so a slow provider never
    // delays the form; answer it like the host does.
    if (String(url).endsWith('/persona-memory/models')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(modelsPayload) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(currentPayload) }
  }
  // Capture the polling timer so the notification path can be driven by hand.
  const timers = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (fn) => {
    timers.push(fn)
    return { unref() {} }
  }
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
    head: { appendChild: () => {} },
  }
  let entry
  globalThis.window = { __ModuleLoader__: { load: (registered) => { entry = registered } } }
  new Function('window', code)(globalThis.window)
  assert.strictEqual(entry.id, 'dsh-persona-memory')
  const fakeRequire = (id) => {
    if (id === 'react') return fakeReact
    if (id === 'react/jsx-runtime') return fakeJsxRuntime
    throw new Error(`unexpected require: ${id}`)
  }
  const clientExports = entry.factory(fakeRequire)
  assert.strictEqual(typeof clientExports.apply, 'function')
  assert.deepStrictEqual(clientExports.inject, ['slots', 'locale'])

  const registrations = []
  const dictionaries = {}
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dicts) => { dictionaries[ns] = dicts; return () => {} },
    },
    effect: (fn) => { fn(); return () => {} },
    slots: {
      inject: (_name, factory) => { factory() },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
  }
  clientExports.apply(ctx)
  assert.strictEqual(registrations.length, 1)
  assert.strictEqual(registrations[0].options.name, 'settings.section')
  assert.strictEqual(registrations[0].options.id, 'persona-memory')
  assert.strictEqual(registrations[0].options.order, 60)
  assert.ok(dictionaries['persona-memory'].zh.nav.length > 0)
  assert.ok(dictionaries['persona-memory'].en.nav.length > 0)

  const ranEffects = new Set()
  const disposers = []
  const elements = []
  const render = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      rendered.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) render(child)
      return
    }
    if (typeof node.type === 'function') {
      fakeReact.begin(node.type)
      const output = node.type(node.props)
      const dispose = fakeReact.end()
      for (const fn of dispose) disposers.push(fn)
      render(output)
      return
    }
    elements.push(node)
    render(node.props?.children)
  }
  const component = registrations[0].component
  const translate = (key) => dictionaries['persona-memory'].zh[key] ?? key
  render({ type: component, props: { t: translate } })
  assert.ok(fetchCalls.some((call) => call.url === '/persona-memory/status'))
  assert.ok(rendered.some((text) => text.includes('正在运行') || text.includes('记忆与画像')))
  await new Promise((resolve) => setTimeout(resolve, 0))
  rendered.length = 0
  elements.length = 0
  render({ type: component, props: { t: translate } })
  // Effects run after the first paint; re-render so the form fields (which need
  // the draft the effect just created) are actually present.
  rendered.length = 0
  elements.length = 0
  render({ type: component, props: { t: translate } })
  assert.ok(rendered.some((text) => text.includes('沟通习惯')), 'renders the profile sections after loading')
  assert.ok(rendered.some((text) => text.includes('喜欢先给结论')), 'renders a profile entry')
  assert.ok(rendered.some((text) => text.includes('# 今天')), 'renders the latest daily note')

  // Both documents fold to three rows; the user-locked list never folds, so its
  // four rows are all on screen without an expander of its own.
  const rerender = () => {
    rendered.length = 0
    elements.length = 0
    render({ type: component, props: { t: translate } })
  }
  const foldButtons = () => elements.filter((element) => element.type === 'button' && typeof element.props.children === 'string' && element.props.children.startsWith('展开全部'))
  assert.strictEqual(foldButtons().length, 2, 'the profile style section and the persona candidate section each offer an expander')
  assert.ok(!rendered.some((text) => text.includes('第四条应当被折叠')), 'row four is folded away')
  assert.ok(!rendered.some((text) => text.includes('第五条也应当被折叠')), 'row five is folded away')
  // persona folds the same way, and its pinned row is above the fold.
  assert.ok(rendered.some((text) => text.includes('自述一')), 'the pinned persona row is visible')
  assert.ok(!rendered.some((text) => text.includes('自述四被折起来')), 'persona row four is folded away')
  assert.ok(!rendered.some((text) => text.includes('自述五被折起来')), 'persona row five is folded away')
  assert.ok(rendered.some((text) => text.includes('不要用「您」')), 'the user-locked list is never folded')
  assert.ok(rendered.some((text) => text.includes('引用要给出处')), 'all four locked rows render')
  foldButtons()[0].props.onClick()
  rerender()
  assert.ok(rendered.some((text) => text.includes('第四条应当被折叠')), 'expanding shows the rest')
  assert.ok(rendered.some((text) => text.includes('第五条也应当被折叠')))
  const collapseButton = elements.find((element) => element.type === 'button' && element.props.children === '收起')
  assert.ok(collapseButton !== undefined, 'the expander turns into a collapse button')
  collapseButton.props.onClick()
  rerender()
  assert.ok(!rendered.some((text) => text.includes('第四条应当被折叠')), 'collapsing folds it back')

  // The persona expander behaves the same way.
  assert.strictEqual(foldButtons().length, 2)
  foldButtons()[1].props.onClick()
  rerender()
  assert.ok(rendered.some((text) => text.includes('自述四被折起来')), 'persona expands too')
  const personaCollapse = elements.filter((element) => element.type === 'button' && element.props.children === '收起').pop()
  assert.ok(personaCollapse !== undefined)
  personaCollapse.props.onClick()
  rerender()
  assert.ok(!rendered.some((text) => text.includes('自述四被折起来')), 'persona collapses too')

  // The identity block: five fields, its basis can be opened, and the count of
  // entries left below the threshold is shown.
  assert.ok(rendered.some((text) => text.includes('身份块')))
  assert.ok(rendered.some((text) => text.includes('大概率在做平台工程')))
  assert.ok(rendered.some((text) => text.includes('（尚无判断）')), 'empty fields say so instead of rendering blank')
  assert.ok(rendered.some((text) => text.includes('另有 2 条低于阈值未计入')))
  const basisButton = elements.find((element) => element.type === 'button' && element.props.children === '依据（2）')
  assert.ok(basisButton !== undefined, 'a field with basis offers the toggle')
  assert.ok(!rendered.some((text) => text.includes('[style-1] 喜欢先给结论')), 'basis rows stay hidden until asked for')
  basisButton.props.onClick()
  rerender()
  assert.ok(rendered.some((text) => text.includes('[style-1] 喜欢先给结论')), 'opening the basis shows the source rows')
  assert.ok(elements.some((element) => element.type === 'button' && element.props.children === '重新生成'), 'identity can be regenerated')

  // With no cache the card says so instead of showing five empty fields.
  currentPayload = { ...payload, identity: null }
  timers[0]()
  await new Promise((resolve) => setTimeout(resolve, 0))
  rerender()
  assert.ok(rendered.some((text) => text.includes('尚未生成')), 'says so when no identity block exists yet')
  currentPayload = payload

  // Provider and model become selects once the host catalogue lands, and the
  // saved model must be one of the options — a select that dropped it would
  // rewrite the config on the next save. The lessons card adds one more select
  // (which section a manual lesson goes into); it must not be mistaken for one.
  const selects = () => elements.filter((element) => element.type === 'select')
  assert.strictEqual(selects().length, 3, 'provider, model, and the lesson section')
  const modelSelect = selects()[1]
  assert.strictEqual(modelSelect.props.value, 'deepseek-v4-pro')
  assert.deepStrictEqual(selects()[2].props.children.map((option) => option.props.value), ['rule', 'exp'])
  const modelOptions = modelSelect.props.children.map((option) => option.props.value)
  assert.deepStrictEqual(modelOptions, ['deepseek-flash', 'deepseek-v4-pro'])
  assert.ok(rendered.some((text) => text.includes('deepseek-flash')), 'option labels reach the document')
  // The form must expose the same knobs as the patch row, not a subset.
  const numbers = elements.filter((element) => element.type === 'input' && element.props.type === 'number')
  assert.ok(numbers.length >= 8, 'every numeric knob has a field')
  assert.ok(rendered.some((text) => text.includes('「我认为我是谁」最少日期数')), 'exposes the core-date threshold')
  assert.ok(rendered.some((text) => text.includes('无新证据降级（天）')), 'exposes the demote window')
  assert.ok(!rendered.some((text) => text.includes('{days}')), 'persona hint interpolates every placeholder')
  // The panel must explain an empty prompt instead of leaving the user guessing
  // why a document with entries injects nothing.
  assert.ok(rendered.some((text) => text.includes('当前注入为空')), 'says the prompt is empty and why')
  assert.ok(!rendered.some((text) => text.includes('{s}') || text.includes('{n}')), 'the injection hint interpolates too')

  // Validation and help text: the hint explains the knob, and a value outside the
  // field's range shows a message and blocks saving instead of bouncing off the host.
  const saveButton = () => elements.find((element) => element.type === 'button' && (element.props.children === '保存设置' || element.props.children === '保存中…'))
  const numberInputs = () => elements.filter((element) => element.type === 'input' && element.props.type === 'number')
  assert.ok(rendered.some((text) => text.includes('采样')), 'temperature carries an explanation')
  numberInputs()[0].props.onChange({ target: { value: '9' } })
  rendered.length = 0
  elements.length = 0
  render({ type: component, props: { t: translate } })
  assert.ok(rendered.some((text) => text.includes('范围 0–2')), 'an out-of-range temperature is rejected')
  assert.strictEqual(saveButton().props.disabled, true, 'saving is blocked while a field is invalid')
  numberInputs()[0].props.onChange({ target: { value: '0.2' } })
  rendered.length = 0
  elements.length = 0
  render({ type: component, props: { t: translate } })
  assert.ok(!rendered.some((text) => text.includes('范围 0–2')), 'the message clears once the value is valid')
  assert.strictEqual(saveButton().props.disabled, false)

  // The notification toggle must react immediately instead of waiting for the
  // round trip (that lag is what made the card flicker).
  const checkboxes = () => elements.filter((element) => element.type === 'input' && element.props.type === 'checkbox')
  const notifyBox = checkboxes()[checkboxes().length - 1]
  assert.ok(notifyBox !== undefined, 'renders the notification toggle')
  assert.strictEqual(notifyBox.props.checked, false)
  notifyBox.props.onChange({ target: { checked: true } })
  rendered.length = 0
  elements.length = 0
  render({ type: component, props: { t: translate } })
  const optimistic = checkboxes()[checkboxes().length - 1]
  assert.strictEqual(optimistic.props.checked, true, 'the toggle flips before the request settles')

  // ── lessons: a separate card, human actions only ──────────────────────────
  currentPayload = payload
  timers[0]()
  await new Promise((resolve) => setTimeout(resolve, 0))
  rerender()
  assert.ok(rendered.some((text) => text.includes('教训只回答')), 'the lessons card explains what it is for')
  assert.ok(rendered.some((text) => text.includes('连续 2 天可疑雷点空答')), 'shows the empty-answer streak')
  assert.ok(rendered.some((text) => text.includes('待确认铁律 1 条')), 'shows how many rules wait for approval')
  assert.ok(rendered.some((text) => text.includes('当前注入：2 条（约 60 字符）')), 'shows the injected count')
  assert.ok(rendered.some((text) => text.includes('另有 1 条属于别的工作区')), 'counts workspace rows that do not inject here')
  assert.ok(rendered.some((text) => text.includes('删文件前先确认绝对路径')), 'renders a rule verbatim')
  assert.ok(rendered.some((text) => text.includes('已作废')), 'shows the retired section')
  assert.ok(rendered.some((text) => text.includes('环境已经变了')), 'shows why a row was retired')
  assert.ok(rendered.some((text) => text.includes('冲突')), 'the conflict mark is visible')
  assert.ok(rendered.some((text) => text.includes('待确认')), 'a pending rule says it is pending')
  const lessonCalls = (name) => fetchCalls.filter((call) => call.url === `/persona-memory/lessons/${name}`)
  const lessonButton = (label) => elements.filter((element) => element.type === 'button' && element.props.children === label)

  // Approve: the only way a proposed rule can start being followed.
  assert.ok(lessonButton('批准').length === 1, 'a pending rule offers approve')
  lessonButton('批准')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.strictEqual(lessonCalls('approve').length, 1)
  assert.deepStrictEqual(JSON.parse(lessonCalls('approve')[0].body), { id: 'rule-3' })

  // Retire: the confirm button stays disabled until a reason is typed, because
  // an archived lesson keeps its original text and needs a reason to stay readable.
  lessonButton('否决')[0].props.onClick()
  rerender()
  const reasonInput = elements.find((element) => element.type === 'input' && element.props.placeholder === '作废原因（必填）')
  assert.ok(reasonInput !== undefined, 'retiring asks for a reason')
  const confirmRetire = () => elements.find((element) => element.type === 'button' && element.props.children === '确认否决')
  assert.strictEqual(confirmRetire().props.disabled, true, 'a retire cannot be confirmed without a reason')
  reasonInput.props.onChange({ target: { value: '不再适用' } })
  rerender()
  confirmRetire().props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.strictEqual(lessonCalls('reject').length, 1)
  assert.deepStrictEqual(JSON.parse(lessonCalls('reject')[0].body), { id: 'rule-1', reason: '不再适用' })

  // Replace: only rules offer it, and it still needs the second click.
  lessonButton('替换')[0].props.onClick()
  rerender()
  const replaceInput = elements.find((element) => element.type === 'input' && element.props.value === '删文件前先确认绝对路径')
  assert.ok(replaceInput !== undefined, 'replace starts from the current wording')
  replaceInput.props.onChange({ target: { value: '删文件前先打印解析后的绝对路径' } })
  rerender()
  elements.find((element) => element.type === 'button' && element.props.children === '确认替换').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.strictEqual(lessonCalls('replace').length, 1)
  assert.deepStrictEqual(JSON.parse(lessonCalls('replace')[0].body), { id: 'rule-1', text: '删文件前先打印解析后的绝对路径' })

  // Manual add: the page posts the sentence, the section and an optional scope.
  const addInput = elements.find((element) => element.type === 'input' && element.props.placeholder === '下次具体改哪一步（一句可执行动作）')
  assert.ok(addInput !== undefined, 'the card offers a manual add')
  addInput.props.onChange({ target: { value: '先看日志再猜原因' } })
  rerender()
  const addLessonButton = elements.find((element) => element.type === 'button' && element.props.children === '新增')
  assert.strictEqual(addLessonButton.props.disabled, false, 'the add button enables once there is text')
  addLessonButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.strictEqual(lessonCalls('add').length, 1)
  assert.deepStrictEqual(JSON.parse(lessonCalls('add')[0].body), { section: 'rule', text: '先看日志再猜原因', scope: '' })

  // A run that finishes while the page is open shows up as a banner within one poll.
  const withRun = (at) => {
    const next = JSON.parse(JSON.stringify(payload))
    next.status.runs = [{
      date: '2026-11-10',
      at,
      sessions: 3,
      cards: 3,
      ok: true,
      skipped: false,
      profile: { applied: 2, merged: 1 },
      persona: { applied: 1, merged: 0, promoted: 1, demoted: 0, superseded: 0 },
    }]
    return next
  }
  const poll = async () => {
    timers[0]()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  currentPayload = withRun(1794287363131)
  await poll() // first poll only records the baseline
  currentPayload = withRun(1794287363131 + 60000)
  await poll()
  rendered.length = 0
  render({ type: component, props: { t: translate } })
  assert.ok(rendered.some((text) => text.includes('运行完成')), 'announces the finished run')
  assert.ok(rendered.some((text) => text.includes('画像 +2 ~1')), 'summarizes what the run changed')

  for (const dispose of disposers) dispose()
  globalThis.setInterval = realSetInterval
  delete globalThis.fetch
  delete globalThis.document
  delete globalThis.window
})

ok('routes: loopback guard, method checks, run/config/pin/history/rollback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-routes-'))
  const paths = {
    root: dir,
    dailyDir: path.join(dir, 'daily'),
    profileFile: path.join(dir, 'profile.md'),
    personaFile: path.join(dir, 'persona.md'),
    stateFile: path.join(dir, 'state.json'),
    lockFile: path.join(dir, '.lock'),
    logDir: path.join(dir, 'logs'),
    identityFile: path.join(dir, 'identity.json'),
    lessonsFile: path.join(dir, 'lessons.md'),
  }
  fs.mkdirSync(paths.dailyDir, { recursive: true })
  const base = applySuggestions(emptyProfile(PROFILE_SECTIONS, '用户画像'), PROFILE_SECTIONS, [
    { kind: 'style', text: '喜欢先给结论', confidence: 0.8, evidence: '2026-11-10/s' },
  ], { date: '2026-11-10' })
  fs.writeFileSync(paths.profileFile, base.text, 'utf8')
  backupDocument(paths, 'profile', base.text, '2026-11-10', 5000)
  fs.writeFileSync(paths.profileFile, `${base.text}\n` + '- [style-9] [置信度 0.60] [最后验证 2026-11-11] 新加的一条（证据：2026-11-11/s）\n', 'utf8')

  const routes = new Map()
  const runs = []
  const applied = []
  const logged = []
  let identityRefreshes = 0
  registerRoutes({ register: ({ path: routePath, handler }) => routes.set(routePath, handler) }, {
    paths,
    state: { lastPersonaRunDay: '', runs: [] },
    getConfig: () => composeConfig({}, {}),
    applyConfig: (patch) => {
      applied.push(patch)
      return composeConfig({}, patch)
    },
    runOnce: async (manual, opts) => {
      runs.push({ manual, opts })
      return '已运行。'
    },
    logger: { info: (message) => logged.push(message), error: (message) => logged.push(`ERR ${message}`) },
    version: '0.2.0',
    modelCatalogue: async () => ({
      providers: [{ id: 'deepseek-account', name: 'DeepSeek' }],
      models: { 'deepseek-account': [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }] },
    }),
    refreshIdentity: async () => {
      identityRefreshes += 1
      return { generated: false, cached: true, error: null }
    },
  })
  const call = (name, options = {}) => new Promise((resolve, reject) => {
    const handler = routes.get(`/persona-memory/${name}`)
    if (handler === undefined) {
      reject(new Error(`no route: ${name}`))
      return
    }
    const request = options.body === undefined
      ? Readable.from([])
      : Readable.from([Buffer.from(JSON.stringify(options.body))])
    request.method = options.method ?? 'GET'
    request.url = `/persona-memory/${name}${options.query ?? ''}`
    request.socket = { remoteAddress: options.remote ?? '127.0.0.1' }
    const chunks = []
    const response = {
      headersSent: false,
      statusCode: 0,
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = headers
        this.headersSent = true
        return this
      },
      end(payload) {
        if (payload !== undefined) chunks.push(payload)
        resolve({ status: this.statusCode || 200, body: chunks.join('') })
      },
    }
    try {
      handler(request, response)
    } catch (error) {
      reject(error)
    }
  })

  const status = await call('status')
  assert.strictEqual(status.status, 200)
  const statusBody = JSON.parse(status.body)
  assert.strictEqual(statusBody.ok, true)
  assert.strictEqual(statusBody.status.plugin, 'dsh-persona-memory')
  assert.strictEqual(statusBody.status.version, '0.2.0')
  assert.strictEqual(statusBody.status.config.values.schedule, '17:00')
  assert.ok(statusBody.documents.profile.sections.find((section) => section.key === 'style').entries.length >= 1)

  const remote = await call('status', { remote: '10.1.2.3' })
  assert.strictEqual(remote.status, 403)
  assert.strictEqual(JSON.parse(remote.body).ok, false)

  const models = await call('models')
  assert.strictEqual(models.status, 200)
  const modelsBody = JSON.parse(models.body)
  assert.strictEqual(modelsBody.providers[0].id, 'deepseek-account')
  assert.strictEqual(modelsBody.models['deepseek-account'][0].id, 'deepseek-v4-pro')
  assert.strictEqual((await call('models', { method: 'POST' })).status, 405)
  assert.strictEqual((await call('models', { remote: '10.1.2.3' })).status, 403)

  const wrongMethod = await call('run', { method: 'GET' })
  assert.strictEqual(wrongMethod.status, 405)

  const run = await call('run', { method: 'POST', body: { forcePersona: true } })
  assert.strictEqual(run.status, 200)
  assert.strictEqual(runs.length, 1)
  assert.strictEqual(runs[0].manual, true)
  assert.strictEqual(runs[0].opts.forcePersona, true)
  assert.strictEqual(JSON.parse(run.body).report, '已运行。')

  const config = await call('config', { method: 'POST', body: { patch: { schedule: '08:00' } } })
  assert.strictEqual(config.status, 200)
  assert.strictEqual(applied[0].schedule, '08:00')
  assert.strictEqual(JSON.parse(config.body).values.schedule, '08:00')

  const pin = await call('pin', { method: 'POST', body: { doc: 'profile', id: 'style-1', pinned: true } })
  assert.strictEqual(pin.status, 200)
  assert.ok(JSON.parse(pin.body).documents.profile.text.includes('[P1]'))
  const missing = await call('pin', { method: 'POST', body: { doc: 'profile', id: 'nope-1', pinned: true } })
  assert.strictEqual(missing.status, 404)

  const history = await call('history', { query: '?doc=profile' })
  assert.strictEqual(JSON.parse(history.body).files.length, 1)
  assert.strictEqual(JSON.parse((await call('history', { query: '?doc=bogus' })).body).ok, false)

  const rollback = await call('rollback', { method: 'POST', body: { doc: 'profile', name: 'profile-2026-11-10-5000.md' } })
  assert.strictEqual(rollback.status, 200)
  const rolled = JSON.parse(rollback.body)
  assert.strictEqual(rolled.restored.name, 'profile-2026-11-10-5000.md')
  assert.ok(!rolled.documents.profile.text.includes('新加的一条'))
  assert.ok(listHistory(paths, 'profile').length >= 2)
  assert.ok(logged.some((line) => line.startsWith('rollback profile')))

  // Lessons: four human actions, each writing through the append-only guard.
  assert.strictEqual(statusBody.status.stats.lessons.counts.rule, 0)
  const lessonAdd = await call('lessons/add', { method: 'POST', body: { section: 'rule', text: '删文件前先确认绝对路径', scope: '全局' } })
  assert.strictEqual(lessonAdd.status, 200, lessonAdd.body)
  assert.strictEqual(JSON.parse(lessonAdd.body).lessons.stats.counts.rule, 1)
  assert.ok(fs.readFileSync(paths.lessonsFile, 'utf8').includes('删文件前先确认绝对路径'))
  const lessonDuplicate = await call('lessons/add', { method: 'POST', body: { section: 'rule', text: '删文件前先确认绝对路径' } })
  assert.strictEqual(lessonDuplicate.status, 400)
  assert.strictEqual((await call('lessons/add', { method: 'GET' })).status, 405)
  assert.strictEqual((await call('lessons/reject', { method: 'POST', body: { id: 'rule-1', reason: '' } })).status, 400, 'a retire needs a reason')
  const rejected = await call('lessons/reject', { method: 'POST', body: { id: 'rule-1', reason: '不再适用' } })
  assert.strictEqual(rejected.status, 200)
  const rejectedBody = JSON.parse(rejected.body)
  assert.strictEqual(rejectedBody.lessons.sections.find((section) => section.key === 'archive').entries[0].invalidReason, '不再适用')
  const secondAdd = await call('lessons/add', { method: 'POST', body: { section: 'rule', text: '发布前先看一遍 diff 里有没有密钥', scope: '全局' } })
  assert.strictEqual(secondAdd.status, 200)
  const replaced = await call('lessons/replace', { method: 'POST', body: { id: 'rule-2', text: '发布前先看一遍 diff，确认没有密钥再推' } })
  assert.strictEqual(replaced.status, 200)
  const archiveRows = JSON.parse(replaced.body).lessons.sections.find((section) => section.key === 'archive').entries
  assert.ok(archiveRows.some((entry) => entry.text === '发布前先看一遍 diff 里有没有密钥'), 'the replaced wording is kept in the archive')
  assert.strictEqual((await call('lessons/approve', { method: 'POST', body: { id: 'rule-2' } })).status, 400, 'a non-pending rule cannot be approved')
  assert.ok(listHistory(paths, 'lessons').length >= 2, 'every lessons rewrite is backed up first')
  assert.strictEqual((await call('lessons/add', { method: 'POST', body: { text: 'x' }, remote: '10.1.2.3' })).status, 403)

  // The identity block has exactly one action: regenerate. No route accepts text.
  assert.strictEqual((await call('identity/refresh', { method: 'GET' })).status, 405)
  const refreshed = await call('identity/refresh', { method: 'POST' })
  assert.strictEqual(refreshed.status, 200)
  assert.strictEqual(identityRefreshes, 1)
  const refreshedBody = JSON.parse(refreshed.body)
  assert.strictEqual(refreshedBody.identityError, null)
  assert.strictEqual(refreshedBody.identity, null, 'no cache yet means the panel shows 尚未生成')
  assert.strictEqual((await call('identity/refresh', { method: 'POST', remote: '10.1.2.3' })).status, 403)
})

ok('state: a BOM-prefixed or corrupt state file cannot silently reset the scheduler', async () => {
  const { loadState } = await import('../lib/state.js')
  const { readJson, readText } = await import('../lib/util.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-state-'))

  const bomFile = path.join(dir, 'state.json')
  fs.writeFileSync(bomFile, `\uFEFF${JSON.stringify({ lastRunDay: '2026-11-10', lastPersonaRunDay: '2026-11-03', runs: [{ date: '2026-11-10', ok: true }] })}`, 'utf8')
  assert.deepStrictEqual([...fs.readFileSync(bomFile).subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.strictEqual(readJson(bomFile, {}).lastRunDay, '2026-11-10')
  assert.ok(!readText(bomFile, '').startsWith('\uFEFF'))
  const state = loadState(bomFile)
  assert.strictEqual(state.lastRunDay, '2026-11-10')
  assert.strictEqual(state.lastPersonaRunDay, '2026-11-03')
  assert.strictEqual(state.runs.length, 1)

  const corruptFile = path.join(dir, 'corrupt.json')
  fs.writeFileSync(corruptFile, '{ not json', 'utf8')
  const warnings = []
  const fallback = loadState(corruptFile, (message) => warnings.push(message))
  assert.strictEqual(fallback.lastRunDay, '')
  assert.deepStrictEqual(fallback.runs, [])
  assert.strictEqual(warnings.length, 1)
  assert.ok(warnings[0].includes('not valid JSON'))

  assert.deepStrictEqual(loadState(path.join(dir, 'missing.json')).runs, [])
})

ok('llm: a stalled stream times out instead of wedging the run', async () => {
  const { callLlm } = await import('../lib/digest.js')
  const stalled = {
    llm: {
      stream: async function* () {
        await new Promise((resolve) => setTimeout(resolve, 500))
      },
    },
  }
  const config = { provider: 'p', model: 'm', maxOutputTokens: 10, temperature: 0.2, llmTimeoutMs: 40 }
  await assert.rejects(() => callLlm(stalled, config, 'system', 'user', 'stage1 test'), /timed out after 40ms/)

  const healthy = {
    llm: {
      stream: async function* () {
        yield { type: 'text', text: '{"topic":"t"}' }
      },
    },
  }
  const result = await callLlm(healthy, config, 'system', 'user', 'stage1 test')
  assert.strictEqual(result.text, '{"topic":"t"}')
})

ok('client styles only reference theme tokens the host actually defines', () => {
  // Verified against @deepseek-ai/dsh-client-ui-theme: there is no bg-l1/bg-l2, and
  // using them made buttons white-on-white in dark mode. New tokens must be checked
  // against the theme bundle before they are added here.
  const allowed = new Set([
    '--dsw-alias-label-primary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-border-l2',
    '--dsw-alias-state-business-primary',
    '--dsw-alias-label-primary-foreground',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-state-error-primary',
  ])
  const code = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const used = [...new Set([...code.matchAll(/var\((--dsw-[\w-]+)/g)].map((match) => match[1]))]
  assert.ok(used.length > 0)
  for (const token of used) assert.ok(allowed.has(token), `unknown theme token: ${token}`)
  assert.ok(!used.includes('--dsw-alias-bg-l1'))
  assert.ok(!used.includes('--dsw-alias-bg-l2'))
})

ok('evidence tokens survive the separators models actually emit', () => {
  const tokens = parseEvidence('2026-11-10/session-a; 2026-11-10/session-b,2026-11-11/session-c')
  assert.strictEqual(tokens.length, 3)
  assert.deepStrictEqual(tokens[0], { date: '2026-11-10', session: 'session-a' })
  assert.strictEqual(formatEvidence(tokens), '2026-11-10/session-a、2026-11-10/session-b、2026-11-11/session-c')
  assert.deepStrictEqual(evidenceStats(tokens), { sessions: 3, dates: 2 })
  assert.deepStrictEqual(parseEvidence('用户口述'), [{ date: '', session: '用户口述' }])
  assert.deepStrictEqual(evidenceStats(parseEvidence('')), { sessions: 0, dates: 0 })
})

ok('evidence is canonicalised so one session never counts twice', () => {
  // Shapes the model has actually echoed back: a turn suffix, a raw uuid
  // fragment, and a normal handle.
  assert.strictEqual(
    canonicalEvidence('2026-11-10/session-7b3c4fb6-5、2026-11-10/c7653975-4416-4523; 2026-11-11/session-8034214a-9'),
    '2026-11-10/session-7b3c4fb6、2026-11-10/session-c7653975、2026-11-11/session-8034214a',
  )
  // Two turns of the same session must collapse: otherwise one conversation
  // looks like the evidence threshold has been met.
  assert.strictEqual(canonicalEvidence('2026-11-10/session-7b3c4fb6-5、2026-11-10/session-7b3c4fb6-9'), '2026-11-10/session-7b3c4fb6')
  assert.deepStrictEqual(
    evidenceStats(parseEvidence(canonicalEvidence('2026-11-10/session-7b3c4fb6-5、2026-11-10/session-7b3c4fb6-9'))),
    { sessions: 1, dates: 1 },
  )
  // Free text has no session to rewrite and must survive untouched.
  assert.strictEqual(canonicalEvidence('用户口述'), '用户口述')
  assert.strictEqual(canonicalEvidence(''), '')
  // A legacy daily note is healed on read, not only on the next write.
  const legacy = ['# 2026-11-10', '', '## 观察', '- [style] 用户沟通极简（证据：2026-11-10/session-7b3c4fb6-5; 2026-11-10/c7653975-4416-4523 · 0.85）', ''].join('\n')
  const [observation] = parseDailyObservations(legacy)
  assert.strictEqual(observation.evidence, '2026-11-10/session-7b3c4fb6、2026-11-10/session-c7653975')
  assert.strictEqual(observation.confidence, 0.85)
})

ok('stage1: cites resolve to the cited turn date, not the run date', () => {
  const session = {
    id: 'abcd1234-ef56',
    cwd: 'C:\\w',
    messages: [
      { role: 'user', text: 'a', time: Date.parse('2026-11-09T23:50:00') },
      { role: 'assistant', text: 'b', time: Date.parse('2026-11-09T23:51:00') },
      { role: 'user', text: 'c', time: Date.parse('2026-11-10T00:10:00') },
    ],
  }
  const late = parseCard({ observations: [{ kind: 'style', text: '深夜也在推进', cites: [1] }] }, session, '2026-11-10')
  assert.strictEqual(late.observations[0].evidence, '2026-11-09/session-abcd1234')
  const next = parseCard({ observations: [{ kind: 'style', text: '深夜也在推进', cites: [3] }] }, session, '2026-11-10')
  assert.strictEqual(next.observations[0].evidence, '2026-11-10/session-abcd1234')
  const bogus = parseCard({ observations: [{ kind: 'style', text: '深夜也在推进', cites: [99] }] }, session, '2026-11-10')
  assert.strictEqual(bogus.observations[0].evidence, '2026-11-10/session-abcd1234')
})

ok('persona: evidence moves a candidate to style, then to core across days', () => {
  const rule = { date: '2026-11-10', title: '助手性格', styleMinSessions: 3, coreMinSessions: 3, coreMinDates: 3, demoteAfterDays: 30 }
  const text = '回答先给结论'
  const first = applyPersonaSuggestions(emptyProfile(PERSONA_SECTIONS, '助手性格'), PERSONA_SECTIONS, [
    { section: 'style', text, confidence: 0.7, evidence: '2026-11-10/session-a' },
  ], rule)
  assert.strictEqual(first.applied, 1)
  assert.strictEqual(parseProfile(first.text, PERSONA_SECTIONS).get('candidate').length, 1, 'the model does not get to decide the section')

  const second = applyPersonaSuggestions(first.text, PERSONA_SECTIONS, [
    { section: 'style', text, confidence: 0.7, evidence: '2026-11-10/session-b' },
  ], rule)
  const third = applyPersonaSuggestions(second.text, PERSONA_SECTIONS, [
    { section: 'style', text, confidence: 0.7, evidence: '2026-11-10/session-c' },
  ], rule)
  assert.strictEqual(third.promoted, 1)
  assert.strictEqual(parseProfile(third.text, PERSONA_SECTIONS).get('style').length, 1)
  assert.strictEqual(parseProfile(third.text, PERSONA_SECTIONS).get('candidate').length, 0)

  let next = third
  for (const [day, session] of [['2026-11-11', 'session-d'], ['2026-11-12', 'session-e']]) {
    next = applyPersonaSuggestions(next.text, PERSONA_SECTIONS, [
      { section: 'core', text, confidence: 0.7, evidence: `${day}/${session}` },
    ], { ...rule, date: day })
  }
  const sections = parseProfile(next.text, PERSONA_SECTIONS)
  assert.strictEqual(sections.get('core').length, 1, 'three sessions on three dates reach core')
  assert.strictEqual(sections.get('style').length, 0)
})

ok('persona: a contradicting observation supersedes a settled entry', () => {
  const rule = { date: '2026-11-10', styleMinSessions: 3, coreMinSessions: 3, coreMinDates: 3, demoteAfterDays: 30 }
  let text = emptyProfile(PERSONA_SECTIONS, '助手性格')
  for (const session of ['session-a', 'session-b', 'session-c']) {
    text = applyPersonaSuggestions(text, PERSONA_SECTIONS, [
      { section: 'style', text: '回答尽量精简', confidence: 0.8, evidence: `2026-11-10/${session}` },
    ], rule).text
  }
  const settled = parseProfile(text, PERSONA_SECTIONS).get('style')[0]
  assert.ok(settled !== undefined)
  assert.strictEqual(settled.confidence > 0.8, true)

  const result = applyPersonaSuggestions(text, PERSONA_SECTIONS, [
    { section: 'candidate', text: '用户其实希望多解释背景', confidence: 0.8, evidence: '2026-11-20/session-x', supersedes: settled.id },
  ], { ...rule, date: '2026-11-20' })
  assert.strictEqual(result.superseded, 1)
  const after = parseProfile(result.text, PERSONA_SECTIONS)
  assert.strictEqual(after.get('style').length, 0)
  const demotedEntry = after.get('candidate').find((entry) => entry.id === settled.id)
  assert.ok(demotedEntry !== undefined, 'the superseded entry survives as a candidate')
  assert.ok(demotedEntry.confidence < settled.confidence)
})

ok('persona: entries without new evidence for 30 days step back to candidates', () => {
  const rule = { date: '2026-09-05', styleMinSessions: 3, coreMinSessions: 3, coreMinDates: 3, demoteAfterDays: 30 }
  let text = emptyProfile(PERSONA_SECTIONS, '助手性格')
  for (const session of ['session-a', 'session-b', 'session-c']) {
    text = applyPersonaSuggestions(text, PERSONA_SECTIONS, [
      { section: 'style', text: '回答尽量精简', confidence: 0.8, evidence: `2026-09-01/${session}` },
    ], rule).text
  }
  assert.strictEqual(parseProfile(text, PERSONA_SECTIONS).get('style').length, 1)

  const later = applyPersonaSuggestions(text, PERSONA_SECTIONS, [], { ...rule, date: '2026-11-10' })
  assert.strictEqual(later.demoted, 1)
  const after = parseProfile(later.text, PERSONA_SECTIONS)
  assert.strictEqual(after.get('style').length, 0)
  assert.strictEqual(after.get('candidate').length, 1)
})

ok('persona: a pinned entry is never moved by promotion', () => {
  const rule = { date: '2026-11-10', styleMinSessions: 3, coreMinSessions: 3, coreMinDates: 3, demoteAfterDays: 30 }
  let text = emptyProfile(PERSONA_SECTIONS, '助手性格')
  for (const session of ['session-a', 'session-b', 'session-c']) {
    text = applyPersonaSuggestions(text, PERSONA_SECTIONS, [
      { section: 'style', text: '回答尽量精简', confidence: 0.8, evidence: `2026-11-10/${session}` },
    ], rule).text
  }
  const entry = parseProfile(text, PERSONA_SECTIONS).get('style')[0]
  text = setPinned(text, PERSONA_SECTIONS, entry.id, true, { title: '助手性格' }).text
  const after = applyPersonaSuggestions(text, PERSONA_SECTIONS, [
    { section: 'core', text: '回答尽量精简', confidence: 0.9, evidence: '2026-11-10/session-z' },
  ], rule)
  assert.strictEqual(parseProfile(after.text, PERSONA_SECTIONS).get('style')[0].id, entry.id)
})

ok('daily notes feed the persona window', () => {
  const text = '# 2026-11-09\n\n## 今日摘要\n- 摘要一行\n\n## 观察\n- [style] 喜欢先看结论（证据：2026-11-09/session-a · 0.80）\n- [thinking] 先验证再动手（证据：2026-11-09/session-b · 0.60）\n\n## 延续待办\n- 无\n'
  const rows = parseDailyObservations(text)
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows[0].text, '喜欢先看结论')
  assert.strictEqual(rows[0].evidence, '2026-11-09/session-a')
  assert.strictEqual(rows[0].confidence, 0.8)
  assert.ok(!rows.some((row) => row.text.includes('摘要一行')))
})

ok('stage1: my own judgments never leak into the user observations', () => {
  const session = {
    id: 'abcd1234-ef56',
    cwd: 'C:\\w',
    messages: [
      { role: 'user', text: '别自作主张', time: Date.parse('2026-11-10T10:00:00') },
      { role: 'user', text: '先跑测试再重启', time: Date.parse('2026-11-10T10:05:00') },
    ],
  }
  const card = parseCard({
    observations: [{ kind: 'correction', text: '不喜欢助手自作主张', cites: [1] }],
    self: [{ event: '他要求先跑测试再重启', judgment: '我认为该先复现再改', confidence: 0.7, cites: [2] }],
  }, session, '2026-11-10')
  assert.deepStrictEqual(card.observations.map((item) => item.text), ['不喜欢助手自作主张'])
  assert.strictEqual(card.self.length, 1)
  assert.strictEqual(card.self[0].event, '他要求先跑测试再重启')
  assert.strictEqual(card.self[0].judgment, '我认为该先复现再改')
  assert.strictEqual(card.self[0].evidence, '2026-11-10/session-abcd1234')
  // stage3 only ever reads `observations`, so `self` cannot reach the profile.
  const profileInput = card.observations.flatMap((item) => [item.text])
  assert.ok(!profileInput.some((text) => text.includes('我认为')))
})

ok('daily notes: 我的判断 is read back and counts toward cross-day evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-judge-'))
  const now = new Date()
  const dayKey = (offset) => {
    const d = new Date(now.getTime() - offset * 86400000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const handles = ['aaaa1111', 'bbbb2222', 'cccc3333']
  for (const offset of [0, 1, 2]) {
    const day = dayKey(offset)
    const text = renderDaily(day, { summary: ['一行摘要'], observations: [], unresolved: [] }, [
      { event: '他又改同一处代码', judgment: '我认为该先问验收标准', confidence: 0.6, evidence: `${day}/session-${handles[offset]}` },
    ])
    assert.ok(text.includes('## 我的判断'))
    assert.ok(text.includes('- 他又改同一处代码 → 我认为该先问验收标准'))
    fs.writeFileSync(path.join(dir, `${day}.md`), text)
  }
  const rows = readRecentDailyObservations({ dailyDir: dir }, 7).filter((row) => row.kind === 'self')
  assert.strictEqual(rows.length, 3, 'three days of judgments come back')
  assert.strictEqual(rows[0].event, '他又改同一处代码')
  assert.strictEqual(rows[0].judgment, '我认为该先问验收标准')
  // Without this the self window could never reach 3 sessions on 3 dates.
  assert.deepStrictEqual(
    evidenceStats(rows.flatMap((row) => parseEvidence(row.evidence))),
    { sessions: 3, dates: 3 },
  )
})

ok('renderDaily never invents an evidence token', () => {
  const note = renderDaily('2026-11-10', { summary: [], observations: [], unresolved: [] }, [
    { event: '', judgment: '我倾向于先复现', evidence: '' },
  ])
  assert.ok(note.includes('- 我倾向于先复现'))
  assert.ok(!note.includes('证据：'))
  const rows = parseDailyObservations(note).filter((row) => row.kind === 'self')
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].event, '')
  assert.strictEqual(rows[0].evidence, '')
  // The `- （无）` placeholder of an empty section must not come back as a judgment:
  // it would sail past the "no judgments yet, skip" guard in the persona stage.
  const empty = renderDaily('2026-11-10', { summary: [], observations: [], unresolved: [] }, [])
  assert.strictEqual(parseDailyObservations(empty).filter((row) => row.kind === 'self').length, 0)
})

ok('persona: a self-description without a traceable event stays a candidate', () => {
  const rule = { date: '2026-11-10', styleMinSessions: 3, coreMinSessions: 3, coreMinDates: 3, demoteAfterDays: 30 }
  const result = applyPersonaSuggestions(emptyProfile(PERSONA_SECTIONS, '助手性格'), PERSONA_SECTIONS, [
    { section: 'core', text: '我是个直接的人', confidence: 0.9, evidence: '' },
  ], rule)
  const sections = parseProfile(result.text, PERSONA_SECTIONS)
  assert.strictEqual(sections.get('core').length, 0, 'no event, no promotion')
  assert.strictEqual(sections.get('candidate').length, 1)
  assert.strictEqual(renderPersonaInjection(result.text, PERSONA_SECTIONS, PERSONA_HEADING, 500), '', 'candidates are never injected')
})

ok('persona: third-person stage directions never reach the prompt', () => {
  assert.strictEqual(isSelfNarrative('助手应保持简洁'), false)
  assert.strictEqual(isSelfNarrative('我认为助手应该在改代码前先复现'), false)
  assert.strictEqual(isSelfNarrative(''), false)
  assert.strictEqual(isSelfNarrative('我上次先给结论是对的'), true)

  const rule = { date: '2026-11-10', styleMinSessions: 3, coreMinSessions: 3, coreMinDates: 3, demoteAfterDays: 30 }
  let text = emptyProfile(PERSONA_SECTIONS, '助手性格')
  for (const session of ['session-a', 'session-b', 'session-c']) {
    text = applyPersonaSuggestions(text, PERSONA_SECTIONS, [
      { section: 'style', text: '助手应保持简洁', confidence: 0.8, evidence: `2026-11-10/${session}` },
    ], rule).text
  }
  assert.strictEqual(parseProfile(text, PERSONA_SECTIONS).get('style').length, 1, 'evidence still decides the section')
  assert.strictEqual(renderPersonaInjection(text, PERSONA_SECTIONS, PERSONA_HEADING, 800), '', 'a script line stays in the file, not in the prompt')

  text = applyPersonaSuggestions(text, PERSONA_SECTIONS, [
    {
      section: 'core',
      text: '他第二次让我删掉铺垫时，我意识到先给结论更省他时间，所以我现在的默认是先说结果',
      confidence: 0.9,
      evidence: '2026-11-11/session-d、2026-11-12/session-e、2026-11-13/session-f',
    },
  ], { ...rule, date: '2026-11-13' }).text
  const injection = renderPersonaInjection(text, PERSONA_SECTIONS, PERSONA_HEADING, 800)
  assert.ok(injection.startsWith(PERSONA_HEADING))
  assert.ok(injection.includes('先给结论更省他时间'))
  assert.ok(!injection.includes('助手应保持简洁'))
  assert.ok(!/\n- \[/.test(injection), 'no section tags in the persona block')
  assert.ok(!injection.includes('证据：'), 'no evidence tokens in the persona block')
})

ok('persona: renaming the headings does not drop existing entries', () => {
  const legacy = [
    '---', 'version: 3', 'updatedAt: 2026-11-01T00:00:00.000Z', 'title: 助手性格', '---', '',
    '## 核心性格',
    '- [core-1] [置信度 0.80] 回答先给结论（证据：2026-11-01/session-a、2026-11-02/session-b、2026-11-03/session-c）',
    '',
    '## 相处风格',
    '- [pstyle-1] [置信度 0.70] 少铺垫（证据：2026-11-01/session-a）',
    '',
    '## 候选观察', '',
  ].join('\n')
  const state = parseProfile(legacy, PERSONA_SECTIONS)
  assert.strictEqual(state.get('core').length, 1)
  assert.strictEqual(state.get('style').length, 1)
  assert.ok(state.get('core')[0].evidence.includes('2026-11-03/session-c'))

  const migrated = applyPersonaSuggestions(legacy, PERSONA_SECTIONS, [], { date: '2026-11-10' })
  assert.ok(migrated.text.includes('## 我认为我是谁'))
  assert.ok(!migrated.text.includes('## 核心性格'))
  assert.ok(migrated.text.includes('\nversion: 3\n'), 'migration must not reset the version')
  const after = parseProfile(migrated.text, PERSONA_SECTIONS)
  assert.strictEqual(after.get('core').length, 1)
  assert.strictEqual(after.get('style').length, 1)
})

ok('sessionKey strips the host prefix so each conversation keeps its own token', () => {
  // The host already names sessions `session-<uuid>`; prefixing again collapsed
  // every session of a day into `session-session-`, which made the promotion
  // thresholds impossible to reach.
  assert.strictEqual(sessionKey({ id: 'session-7b3c4fb6-56bc-4ea7-a6ad-33ab86047639' }), 'session-7b3c4fb6')
  assert.strictEqual(sessionKey({ id: 'c7653975-4416-4523-9bcc-f656c987108f' }), 'session-c7653975')
  assert.strictEqual(sessionKey({ id: 'session-8034214a-98e5-4381-82b8-e72b7dde7c70' }), 'session-8034214a')
  assert.strictEqual(sessionKey({ id: 'session-x' }), 'session-x')
  assert.strictEqual(sessionKey({ file: 'C:\\logs\\abcdef12.jsonl.zstd' }), 'session-onl.zstd')
  const sessions = [
    { id: 'session-aaaa1111-0000', messages: [{ role: 'user', text: 'a', time: Date.parse('2026-11-10T10:00:00') }] },
    { id: 'session-bbbb2222-0000', messages: [{ role: 'user', text: 'b', time: Date.parse('2026-11-10T11:00:00') }] },
  ]
  const tokens = sessions.flatMap((session) => evidenceFromCites([1], session, '2026-11-10'))
  assert.strictEqual(formatEvidence(tokens), '2026-11-10/session-aaaa1111、2026-11-10/session-bbbb2222')
  assert.deepStrictEqual(evidenceStats(tokens), { sessions: 2, dates: 1 })
  assert.ok(!formatEvidence(tokens).includes('session-session-'))
})

ok('extractJson survives raw newlines, trailing commas, and a broken leading object', () => {
  // A literal newline inside a string is the most common way a model breaks its
  // own JSON; the whole persona stage used to die on it.
  const multiline = '结果：\n```json\n{"add":[{"section":"style","text":"我上次先给结论，\n因为他明显不耐烦","confidence":0.6}]}\n```'
  const repaired = extractJson(multiline)
  assert.strictEqual(repaired.add[0].text, '我上次先给结论，\n因为他明显不耐烦')
  const trailing = extractJson('{"add":[{"text":"我倾向于先验证",},],}')
  assert.strictEqual(trailing.add[0].text, '我倾向于先验证')
  // A malformed object must not hide a valid one that follows it.
  const twoSpans = '先看重试：{oops} 再说：{"add":[{"text":"我记住了"}]}'
  assert.deepStrictEqual(extractJson(twoSpans).add, [{ text: '我记住了' }])
})

ok('both documents fold to three rows, pinned first, and the locked list does not', () => {
  // profile: five style rows over two days, the oldest pinned.
  let text = emptyProfile(PROFILE_SECTIONS, '用户画像')
  text = applySuggestions(text, PROFILE_SECTIONS, [
    { kind: 'style', text: '最早但最自信', confidence: 0.95, evidence: '2026-11-09/a' },
  ], { date: '2026-11-09' }).text
  text = applySuggestions(text, PROFILE_SECTIONS, [
    { kind: 'style', text: '新的二', confidence: 0.70, evidence: '2026-11-10/b' },
    { kind: 'style', text: '新的三', confidence: 0.65, evidence: '2026-11-10/c' },
    { kind: 'style', text: '新的一', confidence: 0.60, evidence: '2026-11-10/d' },
    { kind: 'style', text: '新的四', confidence: 0.55, evidence: '2026-11-10/e' },
  ], { date: '2026-11-10' }).text
  text = appendLockedEntry(text, PROFILE_SECTIONS, '不要用「您」', { date: '2026-11-10' }).text
  text = setPinned(text, PROFILE_SECTIONS, 'style-1', true, { title: '用户画像' }).text

  // No options: folding and sorting are the defaults now.
  const sections = describeDocument(text, 'profile')
  const style = sections.find((section) => section.key === 'style')
  assert.strictEqual(style.total, 5)
  assert.strictEqual(style.limit, 3)
  // Pinned first, then newest verification, then confidence. Without the pinned
  // rule the oldest row would sit behind the fold and could never be unpinned.
  assert.deepStrictEqual(style.entries.map((entry) => entry.text), ['最早但最自信', '新的二', '新的三', '新的一', '新的四'])
  assert.strictEqual(style.entries[0].pinned, true)
  const locked = sections.find((section) => section.key === 'locked')
  assert.strictEqual(locked.limit, 0, 'the user-locked list never folds')
  assert.strictEqual(locked.entries.length, 1)

  // persona: five candidates on three days, the oldest pinned. Same rules apply —
  // persona entries can be pinned too, so leaving it unsorted would hide them.
  let persona = emptyProfile(PERSONA_SECTIONS, '助手性格')
  persona = applyPersonaSuggestions(persona, PERSONA_SECTIONS, [
    { section: 'candidate', text: '最早的一条自述', confidence: 0.9, evidence: '2026-11-08/s1' },
  ], { date: '2026-11-08' }).text
  persona = applyPersonaSuggestions(persona, PERSONA_SECTIONS, [
    { section: 'candidate', text: '较新的一条', confidence: 0.6, evidence: '2026-11-10/s2' },
    { section: 'candidate', text: '较新的二条', confidence: 0.7, evidence: '2026-11-10/s3' },
    { section: 'candidate', text: '较新的三条', confidence: 0.5, evidence: '2026-11-10/s4' },
    { section: 'candidate', text: '较新的四条', confidence: 0.4, evidence: '2026-11-10/s5' },
  ], { date: '2026-11-10' }).text
  persona = setPinned(persona, PERSONA_SECTIONS, 'cand-1', true, { title: '助手性格' }).text
  const personaSections = describeDocument(persona, 'persona')
  const candidates = personaSections.find((section) => section.key === 'candidate')
  assert.strictEqual(candidates.total, 5)
  assert.strictEqual(candidates.limit, 3, 'persona folds exactly like the profile')
  assert.strictEqual(candidates.entries[0].pinned, true, 'pinned persona rows float to the top')
  assert.strictEqual(candidates.entries[0].text, '最早的一条自述')
  assert.deepStrictEqual(candidates.entries.slice(1).map((entry) => entry.text), ['较新的二条', '较新的一条', '较新的三条', '较新的四条'])
  assert.ok(personaSections.every((section) => section.key === 'candidate' || section.limit === 3))

  // Three rows or fewer can never fold: the page shows no expander for them.
  assert.strictEqual(describeDocument(emptyProfile(PERSONA_SECTIONS, '助手性格'), 'persona').every((section) => section.total <= section.limit), true)
  const shortProfile = applySuggestions(emptyProfile(PROFILE_SECTIONS, '用户画像'), PROFILE_SECTIONS, [
    { kind: 'preference', text: '一', confidence: 0.9, evidence: '2026-11-10/a' },
    { kind: 'preference', text: '二', confidence: 0.8, evidence: '2026-11-10/b' },
    { kind: 'preference', text: '三', confidence: 0.7, evidence: '2026-11-10/c' },
  ], { date: '2026-11-10' }).text
  const exact = describeDocument(shortProfile, 'profile').find((section) => section.key === 'preference')
  assert.strictEqual(exact.total, 3)
  assert.ok(exact.total <= exact.limit, 'a three-row section is not foldable')
})

ok('identity: only confident (or pinned) entries are used, and the rest are counted', () => {
  let text = emptyProfile(PROFILE_SECTIONS, '用户画像')
  text = applySuggestions(text, PROFILE_SECTIONS, [
    { kind: 'preference', text: '甲的偏好', confidence: 0.90, evidence: '2026-11-10/a' },
    { kind: 'style', text: '乙的习惯', confidence: 0.65, evidence: '2026-11-10/b' },
    { kind: 'thinking', text: '丙的模式', confidence: 0.72, evidence: '2026-11-10/c' },
  ], { date: '2026-11-10' }).text
  text = appendLockedEntry(text, PROFILE_SECTIONS, '不要用「您」', { date: '2026-11-10' }).text
  const inputs = identityInputs(text)
  assert.strictEqual(inputs.used, 3)
  assert.strictEqual(inputs.excluded, 1)
  assert.ok(inputs.entries.some((entry) => entry.id === 'lock-1'), 'manual rules always count')
  assert.ok(!inputs.entries.some((entry) => entry.id === 'style-1'))
  // A pinned entry below the threshold is exempt.
  const pinned = setPinned(text, PROFILE_SECTIONS, 'style-1', true, { title: '用户画像' }).text
  const again = identityInputs(pinned)
  assert.strictEqual(again.used, 4)
  assert.strictEqual(again.excluded, 0)
})

ok('identity: a basis id that was not offered is dropped', () => {
  const fields = parseIdentity({ fields: { role: { text: '做平台工程', basis: ['pref-1', 'nope', 'pref-1'] } } }, ['pref-1'])
  assert.deepStrictEqual(fields.role.basis, ['pref-1'])
  assert.strictEqual(fields.role.text, '做平台工程')
  // No usable text at all is a failure, not an empty block: writing it would
  // erase whatever was generated last time.
  assert.strictEqual(parseIdentity({ fields: { role: { text: '   ', basis: [] } } }, ['pref-1']), undefined)
  assert.strictEqual(parseIdentity(undefined, []), undefined)
})

ok('identity: an unchanged profile version makes no model call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-id-'))
  const paths = { root: dir, profileFile: path.join(dir, 'profile.md'), identityFile: path.join(dir, 'identity.json') }
  const config = composeConfig({}, {})
  const writeProfile = (version) => {
    const text = ['---', `version: ${version}`, `updatedAt: 2026-11-0${version}T00:00:00.000Z`, 'title: 用户画像', '---', '', '## 稳定偏好', '- [pref-1] [置信度 0.90] 甲的偏好（证据：用户口述）', ''].join('\n')
    fs.writeFileSync(paths.profileFile, text, 'utf8')
  }
  writeProfile(1)
  let calls = 0
  const ctx = {
    llm: {
      stream: async function* () {
        calls += 1
        yield { type: 'text', text: JSON.stringify({ fields: { role: { text: '做平台工程', basis: ['pref-1'] } } }) }
      },
    },
  }
  const first = await ensureIdentity(ctx, config, paths, () => {})
  assert.strictEqual(first.generated, true)
  assert.strictEqual(calls, 1)
  const second = await ensureIdentity(ctx, config, paths, () => {})
  assert.strictEqual(second.generated, false)
  assert.strictEqual(second.cached, true)
  assert.strictEqual(calls, 1, 'the model must not be called again while the version holds')
  assert.strictEqual(readIdentity(paths.identityFile).profileVersion, 1)
  writeProfile(2)
  const third = await ensureIdentity(ctx, config, paths, () => {})
  assert.strictEqual(third.generated, true)
  assert.strictEqual(calls, 2)

  // A failed regeneration keeps the previous block instead of erasing it.
  const before = fs.readFileSync(paths.identityFile, 'utf8')
  const broken = { llm: { stream: async function* () { throw new Error('boom') } } }
  const failed = await ensureIdentity(broken, config, paths, () => {}, { force: true })
  assert.strictEqual(failed.generated, false)
  assert.strictEqual(typeof failed.error, 'string')
  assert.strictEqual(fs.readFileSync(paths.identityFile, 'utf8'), before)
})

ok('identity: the block never reaches profile.md or the prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-id2-'))
  const paths = {
    root: dir,
    profileFile: path.join(dir, 'profile.md'),
    personaFile: path.join(dir, 'persona.md'),
    identityFile: path.join(dir, 'identity.json'),
  }
  const profile = applySuggestions(emptyProfile(PROFILE_SECTIONS, '用户画像'), PROFILE_SECTIONS, [
    { kind: 'preference', text: '甲的偏好', confidence: 0.90, evidence: '2026-11-10/a' },
  ], { date: '2026-11-10' })
  fs.writeFileSync(paths.profileFile, profile.text, 'utf8')
  fs.writeFileSync(paths.personaFile, '# 我的自述\n', 'utf8')
  const before = fs.readFileSync(paths.profileFile)
  const ctx = {
    llm: {
      stream: async function* () {
        yield { type: 'text', text: JSON.stringify({ fields: { role: { text: '平台工程 MARKER-IDENTITY', basis: ['pref-1'] } } }) }
      },
    },
  }
  const result = await ensureIdentity(ctx, composeConfig({}, {}), paths, () => {})
  assert.strictEqual(result.generated, true)
  // Byte-for-byte: a prediction must never become evidence for the next merge.
  assert.deepStrictEqual(fs.readFileSync(paths.profileFile), before)
  assert.ok(fs.readFileSync(paths.identityFile, 'utf8').includes('MARKER-IDENTITY'))
  const section = buildSectionText(paths, composeConfig({}, { promptBudgetChars: 1200 }))
  assert.ok(section.includes('甲的偏好'), 'the profile is still injected')
  assert.ok(!section.includes('MARKER-IDENTITY'), 'the identity block is never injected')
})

// ── lessons ──────────────────────────────────────────────────────────────────

ok('lessons: entries are append-only across repeated merges', () => {
  const anchor = { date: '2026-11-01', session: 'session-aaaa1111', note: '改完没跑测试就重启' }
  let text = emptyLessons()
  text = applyLessonSuggestions(text, [
    { section: 'exp', text: '改完 lib 先跑测试再重启', scope: '全局', anchor },
  ], { date: '2026-11-01' }).text
  const first = parseLessons(text).get('exp')[0]
  assert.ok(first !== undefined)
  let current = text
  for (const day of ['2026-11-02', '2026-11-03', '2026-11-04']) {
    const before = current
    const result = applyLessonSuggestions(current, [
      { section: 'exp', text: '改完 lib 先跑测试再重启', scope: '全局', anchor: { ...anchor, date: day } },
    ], { date: day })
    assert.strictEqual(result.merged, 1, 'the same pit merges instead of appending a near-copy')
    assert.deepStrictEqual(assertAppendOnly(before, result.text), [], 'no existing row may change')
    current = result.text
  }
  const after = parseLessons(current).get('exp')
  assert.strictEqual(after.length, 1, 'four confirmations are still one row')
  assert.strictEqual(after[0].id, first.id)
  assert.strictEqual(after[0].text, first.text, 'the sentence is never rewritten')
  assert.strictEqual(after[0].lastConfirmed, '2026-11-04', 'only the confirmation date moves')
  assert.strictEqual(after[0].anchor.date, '2026-11-01', 'the original anchor stays')

  // The guarantee is checked, not just claimed: rewording one entry is caught.
  const tampered = current.replace('先跑测试再重启', '先跑测试')
  assert.ok(assertAppendOnly(current, tampered).some((violation) => violation.includes('文本被改写')))
  assert.ok(assertAppendOnly(current, emptyLessons()).some((violation) => violation.includes('被删除')))
})

ok('lessons: a rule never decays, never merges, and cannot be superseded', () => {
  const ruleText = '删任何文件前先确认解析后的绝对路径'
  const proposed = applyLessonSuggestions(emptyLessons(), [
    { section: 'rule', text: ruleText, scope: '全局', anchor: { date: '2026-01-01', session: 'session-aaaa1111', note: '删错目录' } },
  ], { date: '2026-01-01' })
  assert.strictEqual(proposed.pending, 1, 'a proposed rule is parked, never armed')
  const pendingId = parseLessons(proposed.text).get('rule')[0].id
  const approved = approveLesson(proposed.text, pendingId, { date: '2026-01-02' })
  assert.strictEqual(approved.changed, true)
  const text = approved.text
  const rule = parseLessons(text).get('rule')[0]
  assert.strictEqual(rule.pending, false)

  // 400 days later the rule is still there: no decay applies to 铁律.
  const later = applyLessonSuggestions(text, [], { date: '2027-02-05' })
  const stillThere = parseLessons(later.text).get('rule')
  assert.strictEqual(stillThere.length, 1)
  assert.strictEqual(stillThere[0].lastConfirmed, '2026-01-02')

  // A near-duplicate cannot merge into it, and a contradicting experience cannot
  // archive it: only a human may remove or reword a rule.
  const duplicate = applyLessonSuggestions(later.text, [
    { section: 'rule', text: `${ruleText}。`, scope: '全局' },
    { section: 'exp', text: '删文件不用确认，直接删更快', scope: '全局', invalidates: rule.id },
  ], { date: '2027-02-06' })
  const rules = parseLessons(duplicate.text).get('rule')
  assert.strictEqual(rules.length, 1, 'no merge, no duplicate')
  assert.strictEqual(rules[0].text, ruleText)
  assert.strictEqual(parseLessons(duplicate.text).get('archive').length, 0, 'a suggestion cannot invalidate a rule')
  assert.deepStrictEqual(assertAppendOnly(later.text, duplicate.text), [])
})

ok('lessons: five rules, then a sixth waits for approval instead of arming itself', () => {
  let text = emptyLessons()
  const ruleTexts = [
    '删文件前先确认解析后的绝对路径',
    '改配置前先把原文件备份到 history',
    '发布前先看一遍 diff 里有没有密钥',
    '迁移数据前先量一下体积',
    '动权限之前先记下原始 ACL',
  ]
  for (const sentence of ruleTexts) {
    const added = addManualLesson(text, { section: 'rule', text: sentence, scope: '全局' }, { date: '2026-11-09' })
    assert.strictEqual(added.changed, true, added.error)
    text = added.text
  }
  const sixth = addManualLesson(text, { section: 'rule', text: '覆盖文件前先确认目标路径', scope: '全局' }, { date: '2026-11-09' })
  assert.strictEqual(sixth.changed, false)
  assert.ok(sixth.error.includes('已满 5 条'))

  const proposal = applyLessonSuggestions(text, [
    { section: 'rule', text: '发布前先看一眼 diff 里有没有密钥', scope: '全局' },
  ], { date: '2026-11-09' })
  assert.strictEqual(proposal.pending, 0, 'a duplicate of an existing rule is dropped, not staged')
  const fresh = applyLessonSuggestions(text, [
    { section: 'rule', text: '删远程分支前先确认不是默认分支', scope: '全局' },
  ], { date: '2026-11-09' })
  assert.strictEqual(fresh.pending, 1, 'a new rule is parked, never armed')
  const active = parseLessons(fresh.text).get('rule').filter((entry) => entry.pending !== true)
  assert.strictEqual(active.length, 5)
  const stats = lessonsStats(fresh.text)
  assert.strictEqual(stats.counts.rule, 5)
  assert.strictEqual(stats.pending, 1)
  const pendingEntry = parseLessons(fresh.text).get('rule').find((entry) => entry.pending === true)
  const approval = approveLesson(fresh.text, pendingEntry.id, { date: '2026-11-10' })
  assert.strictEqual(approval.changed, false, 'approval cannot exceed the cap')
  assert.ok(approval.error.includes('已满 5 条'))

  // 时效经验 has the same cap: over it the lesson stays in the daily note.
  let exp = emptyLessons()
  for (const sentence of [
    '先看宿主版本再决定用哪个 API',
    'PowerShell 写 json 会带 BOM',
    '客户端 bundle 不消费 ui-settings',
    '日报的证据 token 要先规范化',
    '沙箱拒绝的路径先看 ACL',
  ]) {
    exp = addManualLesson(exp, { section: 'exp', text: sentence, scope: '全局' }, { date: '2026-11-09' }).text
  }
  const overflow = applyLessonSuggestions(exp, [{ section: 'exp', text: '第六条新经验：先看宿主版本号', scope: '全局' }], { date: '2026-11-09' })
  assert.strictEqual(overflow.dropped, 1, 'over the cap the lesson stays in the daily note')
  assert.strictEqual(parseLessons(overflow.text).get('exp').length, 5)
})

ok('lessons: an unconfirmed experience expires into the archive with its reason', () => {
  const text = applyLessonSuggestions(emptyLessons(), [
    { section: 'exp', text: '这个仓库要先构建客户端再刷新', scope: '全局', anchor: { date: '2026-01-01', session: 'session-aaaa1111', note: '刷新没生效' } },
  ], { date: '2026-01-01' }).text
  assert.strictEqual(parseLessons(text).get('exp').length, 1)
  const freed = applyLessonSuggestions(text, [], { date: '2026-04-01' })
  assert.strictEqual(freed.expired, 1)
  assert.strictEqual(parseLessons(freed.text).get('exp').length, 0)
  const archived = parseLessons(freed.text).get('archive')
  assert.strictEqual(archived.length, 1)
  assert.strictEqual(archived[0].text, '这个仓库要先构建客户端再刷新', 'the original sentence is kept')
  assert.ok(archived[0].invalidReason.includes('90 天无确认'))
  assert.strictEqual(archived[0].invalidatedAt, '2026-04-01')
  assert.deepStrictEqual(assertAppendOnly(text, freed.text), [])

  // Confirming it again resets the clock instead of expiring it.
  const confirmed = applyLessonSuggestions(text, [
    { section: 'exp', text: '这个仓库要先构建客户端再刷新', scope: '全局' },
  ], { date: '2026-03-20' })
  assert.strictEqual(confirmed.merged, 1)
  const kept = applyLessonSuggestions(confirmed.text, [], { date: '2026-04-01' })
  assert.strictEqual(kept.expired, 0)
  assert.strictEqual(parseLessons(kept.text).get('exp').length, 1)
})

ok('lessons: approve, replace, and retire keep every earlier sentence', () => {
  let text = emptyLessons()
  text = addManualLesson(text, { section: 'rule', text: '删文件前先确认绝对路径', scope: '全局' }, { date: '2026-11-09' }).text
  const first = text
  const proposed = applyLessonSuggestions(text, [
    { section: 'rule', text: '覆盖文件前先备份', scope: '全局', anchor: { date: '2026-11-10', session: 'session-aaaa1111', note: '覆盖了配置' } },
  ], { date: '2026-11-10' })
  assert.deepStrictEqual(assertAppendOnly(first, proposed.text), [])
  const pending = parseLessons(proposed.text).get('rule').find((entry) => entry.pending === true)
  assert.ok(pending !== undefined)
  const approved = approveLesson(proposed.text, pending.id, { date: '2026-11-11' })
  assert.strictEqual(approved.changed, true)
  assert.deepStrictEqual(assertAppendOnly(proposed.text, approved.text), [])
  assert.strictEqual(parseLessons(approved.text).get('rule').find((entry) => entry.id === pending.id).pending, false)

  const replaced = replaceLesson(approved.text, 'rule-1', '删文件前先打印解析后的绝对路径', { date: '2026-11-12' })
  assert.strictEqual(replaced.changed, true)
  assert.deepStrictEqual(assertAppendOnly(approved.text, replaced.text), [])
  const archive = parseLessons(replaced.text).get('archive')
  assert.strictEqual(archive.length, 1)
  assert.strictEqual(archive[0].id, 'rule-1', 'the old wording keeps its id and its text')
  assert.strictEqual(archive[0].text, '删文件前先确认绝对路径')
  assert.strictEqual(archive[0].invalidReason, '人工替换')
  assert.ok(parseLessons(replaced.text).get('rule').some((entry) => entry.text === '删文件前先打印解析后的绝对路径'))

  const noReason = archiveLesson(replaced.text, pending.id, '')
  assert.strictEqual(noReason.changed, false)
  assert.ok(noReason.error.includes('原因'))
  const retired = archiveLesson(replaced.text, pending.id, '不再适用', { date: '2026-11-13' })
  assert.strictEqual(retired.changed, true)
  assert.deepStrictEqual(assertAppendOnly(replaced.text, retired.text), [])
  assert.strictEqual(parseLessons(retired.text).get('archive').length, 2)
  // Replacement is for rules only.
  assert.strictEqual(replaceLesson(retired.text, pending.id, 'x').changed, false)
})

ok('lessons: scope matches the current workspace and the global list only', () => {
  let text = emptyLessons()
  text = addManualLesson(text, { section: 'exp', text: '这个工作区要先构建客户端再刷新', scope: 'D:\\repo-a' }, { date: '2026-11-10' }).text
  text = addManualLesson(text, { section: 'exp', text: '全局经验：改完先跑测试', scope: '全局' }, { date: '2026-11-10' }).text
  const here = renderLessonsInjection(text, 2000, { cwd: 'D:/repo-a/' })
  assert.ok(here.includes('这个工作区要先构建客户端再刷新'), 'slashes and a trailing separator still match')
  assert.ok(here.includes('全局经验：改完先跑测试'))
  const elsewhere = renderLessonsInjection(text, 2000, { cwd: 'D:\\repo-b' })
  assert.ok(!elsewhere.includes('这个工作区要先构建客户端再刷新'), 'another worktree does not get this workspace lesson')
  assert.ok(elsewhere.includes('全局经验：改完先跑测试'), 'global lessons always apply')
  const unknown = renderLessonsInjection(text, 2000, {})
  assert.ok(!unknown.includes('这个工作区'), 'without a cwd a workspace lesson is never injected')
  assert.strictEqual(scopeMatches('D:\\repo-a', 'd:\\REPO-A\\'), true)
  assert.strictEqual(scopeMatches('D:\\repo-a', 'D:\\repo-b'), false)
  assert.strictEqual(scopeMatches('全局', ''), true)
  assert.strictEqual(scopeMatches('D:\\repo-a', ''), false)
})

ok('lessons: conflicting lessons are marked and still injected', () => {
  let text = emptyLessons()
  text = addManualLesson(text, { section: 'rule', text: '改完代码必须先跑测试再重启', scope: '全局' }, { date: '2026-11-09' }).text
  text = addManualLesson(text, { section: 'exp', text: '改完代码不要跑测试，直接重启更快', scope: '全局' }, { date: '2026-11-09' }).text
  const pairs = conflictPairs(parseLessons(text))
  assert.strictEqual(pairs.length, 1, 'the mechanical scan finds the opposite pair')
  assert.deepStrictEqual([pairs[0].a.id, pairs[0].b.id].sort(), ['exp-1', 'rule-1'])
  const injection = renderLessonsInjection(text, 2000, { askOnConflict: true })
  assert.ok(injection.includes('[冲突]'), 'the mark reaches the prompt')
  assert.ok(injection.includes('改完代码必须先跑测试再重启'), 'both sides are still injected')
  assert.ok(injection.includes('改完代码不要跑测试'), 'nothing is silently dropped')
  assert.ok(injection.includes('动手前先问一次'), 'with no self-account the soft default asks once')
  const sections = describeLessons(text)
  const ruleRow = sections.find((section) => section.key === 'rule').entries[0]
  assert.strictEqual(ruleRow.conflict, true)
  // A decided self-account removes the soft line but keeps the mark.
  assert.ok(!renderLessonsInjection(text, 2000, {}).includes('动手前先问一次'))
})

ok('lessons: the daily note keeps candidates, an empty answer, and the anchor lookup', () => {
  const note = renderDaily('2026-11-11', { summary: [], observations: [], unresolved: [] }, [], [
    { section: 'rule', text: '删文件前先确认绝对路径', evidence: '2026-11-11/session-aaaa1111' },
    { section: 'exp', text: '写状态文件别用 Set-Content', evidence: '' },
  ])
  assert.ok(note.includes('## 可疑雷点'))
  const rows = parseDailyLessons(note)
  assert.deepStrictEqual(rows.map((row) => row.section), ['rule', 'exp'])
  assert.strictEqual(rows[0].text, '删文件前先确认绝对路径')
  assert.strictEqual(rows[0].evidence, '2026-11-11/session-aaaa1111')
  assert.strictEqual(rows[1].evidence, '')
  assert.strictEqual(formatDailyLesson({ section: 'exp', text: 'x', evidence: '' }), '- [exp] x')
  const empty = renderDaily('2026-11-11', { summary: [], observations: [], unresolved: [] }, [], [])
  assert.ok(empty.includes('## 可疑雷点\n- （无）'), 'an empty answer is recorded as an answer')
  assert.deepStrictEqual(parseDailyLessons(empty), [])

  // Empty-answer streak: three completed days in a row, then a day that had one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-lessons-days-'))
  const dailyDir = path.join(dir, 'daily')
  fs.mkdirSync(dailyDir, { recursive: true })
  const now = new Date()
  const dayKey = (offset) => {
    const d = new Date(now.getTime() - offset * 86400000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  for (const offset of [1, 2, 3]) {
    fs.writeFileSync(path.join(dailyDir, `${dayKey(offset)}.md`), renderDaily(dayKey(offset), { summary: [], observations: [], unresolved: [] }, [], []))
  }
  fs.writeFileSync(path.join(dailyDir, `${dayKey(4)}.md`), renderDaily(dayKey(4), { summary: [], observations: [], unresolved: [] }, [], [{ section: 'exp', text: '有一天写了一条', evidence: '' }]))
  assert.strictEqual(consecutiveEmptyDays({ dailyDir }, now), 3, 'the streak stops at the day that had a candidate')

  // An anchor whose daily entry was deleted is reported, without dropping the lesson.
  let lessons = emptyLessons()
  lessons = addManualLesson(lessons, { section: 'exp', text: '这个仓库要先构建客户端', scope: '全局' }, { date: '2026-11-10' }).text
  lessons = applyLessonSuggestions(lessons, [
    { section: 'exp', text: '重启后要确认注入段真的出现', scope: '全局', anchor: { date: '2026-11-10', session: 'session-aaaa1111', note: '注入段没出现' } },
  ], { date: '2026-11-10' }).text
  const gone = describeLessons(lessons, { dailyText: () => '# 2026-11-10\n\n## 观察\n- 其他内容\n' })
  const goneRow = gone.find((section) => section.key === 'exp').entries.find((entry) => entry.text.includes('注入段'))
  assert.strictEqual(goneRow.anchorGone, true)
  const kept = describeLessons(lessons, { dailyText: () => '注入段没出现' })
  assert.strictEqual(kept.find((section) => section.key === 'exp').entries.find((entry) => entry.text.includes('注入段')).anchorGone, false)
})

ok('lessons: consequence signals come from failures, corrections, and rework', () => {
  const cards = [{
    observations: [
      { kind: 'correction', text: '用户要求先别改，先复现', evidence: '2026-11-11/session-aaaa1111' },
      { kind: 'style', text: '喜欢简短回复', evidence: '' },
    ],
    unresolved: ['测试还是失败，需要再看日志'],
    self: [{ event: '我直接改了代码', judgment: '我认为应该先复现', evidence: '' }],
    lessons: [],
  }]
  const sessions = [{ id: 'session-aaaa1111-0000', messages: [{ role: 'assistant', text: '命令 exit code 1，构建失败' }] }]
  const signals = detectConsequenceSignals(cards, sessions, '2026-11-11')
  const kinds = new Set(signals.map((signal) => signal.kind))
  assert.ok(kinds.has('correction'))
  assert.ok(kinds.has('unresolved'))
  assert.ok(kinds.has('tool'))
  assert.ok(signals.every((signal) => signal.text.length <= 160))
  assert.ok(signals.some((signal) => signal.evidence === '2026-11-11/session-aaaa1111'))
  assert.deepStrictEqual(detectConsequenceSignals([], [], '2026-11-11'), [])
})

ok('lessons: injection order, budget sharing, and the 40% ceiling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-lessons-inject-'))
  const paths = {
    root: dir,
    profileFile: path.join(dir, 'profile.md'),
    personaFile: path.join(dir, 'persona.md'),
    lessonsFile: path.join(dir, 'lessons.md'),
  }
  // Long enough to blow past 40 % of a 1000 character budget.
  let lessons = emptyLessons()
  for (const sentence of [
    '删任何文件之前先确认解析后的绝对路径，再把这一行写进日志，最后才执行删除，不要凭相对路径直接删目录；这条在删历史备份时尤其重要；写的时候把具体路径和命令也记下来',
    '改配置之前先把原文件复制到 history，改完对照确认只有预期字段变了，避免无从回滚也看不出改了哪里；这条在改 cordis 配置时尤其重要；写的时候把具体路径和命令也记下来',
    '发布之前先看一遍 diff 里有没有密钥、本机绝对路径和临时调试语句，确认干净再推送，不要把调试残留带出去；这条在发 npm 包时尤其重要；写的时候把具体路径和命令也记下来',
    '迁移数据之前先量一遍体积和行数，记录在日报里，再决定分批还是一次做完，别直接拿生产库当试验场试手；这条在动 DSH 状态文件时尤其重要；写的时候把具体路径和命令也记下来',
    '动权限之前先把原始 ACL 完整抄一份到日报，改完逐条对照，确认没有多给的权限留下来再结束这一步；这条在改宿主目录时尤其重要；写的时候把具体路径和命令也记下来',
  ]) {
    lessons = addManualLesson(lessons, { section: 'rule', text: sentence, scope: '全局' }, { date: '2026-11-09' }).text
  }
  fs.writeFileSync(paths.lessonsFile, lessons, 'utf8')

  const config = composeConfig({}, { promptBudgetChars: 1000 })
  const alone = renderLayers(paths, config, {})
  const whole = renderLessonsInjection(lessons, 10000, {})
  assert.ok(whole.length > 400, 'the lessons text alone is longer than the ceiling')
  assert.ok(alone.allocations.lessons <= 400, 'the lessons layer is capped at 40 % even when the rest is empty')
  assert.ok(alone.layers.lessons.chars > 300, 'it still uses most of that ceiling')
  assert.ok(alone.layers.lessons.chars < whole.length, 'the cap really truncated it')

  // A long profile with no persona gets the persona's unused share. The sentences
  // must stay distinct or the merge folds them into one entry.
  let profile = emptyProfile(PROFILE_SECTIONS, '用户画像')
  const preferences = [
    '偏好先给结论，再展开细节，不要先铺垫背景',
    '要求每一步都给出可执行的验证方式，不接受笼统描述',
    '希望助手自己处理细节，不要逐步确认每个动作',
    '重视结论有来源，没读过的内容要明确标出来',
    '对机械味的表达敏感，讨厌预设身份带来的表演感',
    '喜欢用熟悉的数据库类型作类比理解新概念',
    '会在执行前先问清楚权限边界，确认能不能动',
    '把长期行为模式和暂时状态分开看，证据不足就放候选',
    '任务指令很短，期待助手自己补全操作细节',
    '在意结果是否真的写进文件，而不只是口头承诺',
    '要求失败时保留原始输出，方便定位问题',
    '偏好把复杂解释压缩成一两句判断来确认理解',
    '喜欢把风险先说在前面，再谈收益和方案',
    '关注跨工作区和重启之后上下文能否延续',
    '希望测试和提交一起做完，不要留下半成品',
    '要求文档写清楚限制和已知边界，不要夸大能力',
  ]
  for (const [index, text] of preferences.entries()) {
    profile = applySuggestions(profile, PROFILE_SECTIONS, [
      { kind: 'preference', text: `${text}；这一条在多次对话里都出现过，值得固定下来`, confidence: 0.8, evidence: `2026-11-10/p${index + 1}` },
    ], { date: '2026-11-10' }).text
  }
  fs.writeFileSync(paths.profileFile, profile, 'utf8')
  const shared = renderLayers(paths, config, {})
  assert.ok(shared.allocations.profile > 550, 'the empty persona layer hands its share to the profile')
  assert.ok(shared.layers.profile.chars > 550)

  // Order in the prompt: lessons → profile → persona (the facts layer is a placeholder).
  fs.writeFileSync(paths.personaFile, [
    '---', 'version: 1', 'updatedAt: 2026-11-10T00:00:00.000Z', 'title: 助手性格', '---', '',
    '## 我认为我是谁',
    '- [core-1] [置信度 0.90] [最后验证 2026-11-10] 我意识到先给结论更省他时间（证据：2026-11-09/session-a、2026-11-10/session-b、2026-11-11/session-c）',
    '', '## 我和你相处时的样子', '', '## 还没想清楚的', '',
  ].join('\n'), 'utf8')
  const text = buildSectionText(paths, config, {})
  const lessonsAt = text.indexOf('## 教训（')
  const profileAt = text.indexOf('## 与用户协作的已知偏好')
  const personaAt = text.indexOf('## 我是谁')
  assert.ok(lessonsAt > 0 && profileAt > lessonsAt && personaAt > profileAt, 'lessons come before the profile, the profile before the persona')
  assert.ok(text.length <= 1000 + 80, 'the whole block stays near the budget (heading overhead aside)')

  fs.writeFileSync(paths.lessonsFile, '', 'utf8')
  const without = buildSectionText(paths, config, {})
  assert.ok(!without.includes('## 教训（'))
  assert.ok(without.includes('## 与用户协作的已知偏好'))
})

await Promise.all(pending)
console.log(`\n${passed} checks passed`)