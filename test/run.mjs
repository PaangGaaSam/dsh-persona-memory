import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { collectSessions, decodeSessionLog, parseSessionLog } from '../lib/collector.js'
import { composeConfig, EDITABLE_KEYS, loadOverrides, publicConfig, saveOverrides } from '../lib/config.js'
import { backupDocument, listHistory, restoreHistory } from '../lib/history.js'
import { describeDocument, documentsPayload, readJsonBody, registerRoutes } from '../lib/http.js'
import {
  appendLockedEntry,
  applyPersonaSuggestions,
  applySuggestions,
  emptyProfile,
  evidenceStats,
  formatEvidence,
  parseEvidence,
  parseProfile,
  PERSONA_SECTIONS,
  PROFILE_SECTIONS,
  renderForInjection,
  setPinned,
} from '../lib/profile.js'
import { extractJson, parseCard, parseDaily, parseDailyObservations, parsePersonaSuggestions, parseSuggestions, runDigest } from '../lib/digest.js'
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
    { section: 'core', text: '直接、不绕弯', confidence: 0.6, evidence: '2026-11-05/session-e' },
  ], { date: '2026-11-05' })
  assert.ok(merged.text.includes('## 核心性格'))
  assert.ok(merged.text.includes('直接、不绕弯'))
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
          out = JSON.stringify({ topic: '测试主题', userNeeds: ['要一个插件'], observations: [{ kind: 'style', text: '喜欢先给结论再展开细节', confidence: 0.8 }], unresolved: ['重启后验证'] })
        } else if (system.includes('日记作者')) {
          out = JSON.stringify({ summary: ['完成了 v0.1 骨架'], unresolved: ['重启后验证'], observations: [{ kind: 'style', text: '喜欢直接看到结果', confidence: 0.7 }] })
        } else if (system.includes('用户画像编辑')) {
          out = JSON.stringify({ add: [{ kind: 'style', text: '喜欢先给结论再展开细节', confidence: 0.8, evidence: '2026-11-10/s' }] })
        } else {
          out = JSON.stringify({ add: [{ section: 'core', text: '直接、不绕弯', confidence: 0.6, evidence: '2026-11-10/s' }] })
        }
        yield { type: 'text', text: out }
      },
    },
  }
  await ok('mock digest writes daily, profile, and persona files', async () => {
    const report = await runDigest(ctx, config, paths, state, () => {})
    assert.ok(report.skipped === false)
    assert.ok(fs.existsSync(report.daily))
    assert.ok(fs.readFileSync(report.daily, 'utf8').includes('完成了 v0.1 骨架'))
    assert.ok(fs.readFileSync(paths.profileFile, 'utf8').includes('喜欢先给结论再展开细节'))
    assert.ok(fs.readFileSync(paths.personaFile, 'utf8').includes('直接、不绕弯'))
    const now = new Date()
    const localDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    assert.strictEqual(state.lastPersonaRunDay, localDay)
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
    jsx: (type, props) => ({ type, props: props ?? {} }),
    jsxs: (type, props) => ({ type, props: props ?? {} }),
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
        sections: describeDocument(applySuggestions(emptyProfile(PROFILE_SECTIONS, '用户画像'), PROFILE_SECTIONS, [
          { kind: 'style', text: '喜欢先给结论', confidence: 0.8, evidence: '2026-11-10/s' },
        ], { date: '2026-11-10' }).text, 'profile'),
        stats: { counts: {}, pinned: 0 },
      },
      persona: { text: '', sections: describeDocument(emptyProfile(PERSONA_SECTIONS, '助手性格'), 'persona'), stats: { counts: {}, pinned: 0 } },
    },
    personaIsDue: false,
    daily: { date: '2026-11-10', text: '# 今天\n- 完成 v0.2' },
  }
  const fetchCalls = []
  let currentPayload = payload
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
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
    '--dsw-alias-label-tertiary',
    '--dsw-alias-border-l2',
    '--dsw-alias-state-business-primary',
    '--dsw-alias-label-primary-foreground',
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

await Promise.all(pending)
console.log(`\n${passed} checks passed`)