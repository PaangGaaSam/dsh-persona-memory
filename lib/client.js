/* Browser half of dsh-persona-memory: the settings page.
 *
 * This file is served as-is by the host module loader, so it must stay a plain
 * CJS factory registered on `window.__ModuleLoader__` (no ESM syntax, no build
 * step). Only platform modules are required: react and react/jsx-runtime.
 */
window.__ModuleLoader__.load({
  id: 'dsh-persona-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const { useState, useEffect, useCallback, useMemo, useRef } = react
    const { jsx, jsxs } = jsxRuntime

    /** Element helper: always an array of children (jsxs form). */
    const h = (type, props, children) => jsxs(type, Object.assign({}, props, { children: children === undefined ? [] : children }))

    const NS = 'persona-memory'
    const API = '/persona-memory'

    const zh = {
      nav: '记忆与画像',
      title: '记忆与画像',
      intro: '每天把会话总结成日报，增量维护用户画像与助手性格。',
      status: '运行状态',
      settings: '计划与模型',
      profile: '用户画像',
      persona: '我的自述',
      history: '历史版本',
      daily: '最近日报',
      runNow: '立即运行',
      forcePersona: '强制合并自述',
      save: '保存设置',
      resetDefaults: '恢复默认',
      lastRun: '上次运行',
      lastPersona: '上次自述合并',
      result: '结果',
      never: '尚未运行',
      running: '正在运行…',
      empty: '（空）',
      pin: '置顶',
      unpin: '取消置顶',
      pinned: '已置顶',
      rollback: '回滚',
      confirmRollback: '确认回滚',
      cancel: '取消',
      schedule: '每日运行时间',
      schdeuleHint: 'HH:mm（本地时区）',
      model: '模型',
      provider: '提供方',
      temperature: '温度',
      window: '采集窗口（小时）',
      budget: '注入预算（字符）',
      sessionLimit: '单会话字符上限',
      maxSessions: '每次最多会话数',
      autoApply: '自动合并进画像',
      personaEnabled: '维护我的自述',
      personaEvery: '自述合并间隔（天）',
      personaEvidence: '自述最小证据数',
      personaCoreDates: '「我认为我是谁」最少日期数',
      personaDemote: '无新证据降级（天）',
      pickHint: '下拉来自宿主模型目录；列表为空时可手填。',
      hintSchedule: '每天到这个时间就汇总一次。宿主要在运行；错过的那天会在下次启动补跑。',
      hintProvider: '摘要调用哪个提供方。下拉来自宿主的模型目录。',
      hintModel: '用哪个模型跑摘要。一天只跑一次，选便宜的够用。',
      hintTemperature: '模型采样的随机度，0–2。越低越稳定、越贴事实；摘要建议 0.1–0.3，调高只会让归纳更发散。它作用在三段调用：会话卡片、日报、自述合并。',
      hintWindow: '每次往回采集多少小时内的会话，默认 24。',
      hintBudget: '每轮对话注入系统提示的字符上限；0 表示完全不注入。',
      hintSessionLimit: '单个会话送进模型的字符上限，超长会被截断。',
      hintMaxSessions: '一次最多处理多少个会话，超出的按时间取最近的。',
      hintPersonaEvery: '每隔多少天做一次自述合并（和日报分开）。',
      hintPersonaEvidence: '一条自述要在多少个不同会话里重复出现，才晋升为「我和你相处时的样子」。',
      hintPersonaCore: '晋升「我认为我是谁」还需要的不同日期数，用来确认它跨天成立。',
      hintPersonaDemote: '多少天没有新证据就退回「还没想清楚的」。置顶的条目不受影响。',
      errRequired: '必填',
      errTime: '格式要 HH:mm，例如 17:00',
      errNumber: '要填数字',
      errInteger: '要填整数',
      errRange: '范围 {min}–{max}',
      keepRaw: '保留抽取卡原文',
      exclude: '排除的工作区（每行一个）',
      evidence: '证据',
      confidence: '置信度',
      loadFailed: '读取失败',
      saving: '保存中…',
      saved: '设置已保存，下次运行生效。',
      noDaily: '还没有日报。',
      entries: '条',
      backedUp: '每次写盘前的备份',
      due: '到期',
      personaRule: '证据累积：「我和你相处时的样子」需 ≥{s} 个不同会话；「我认为我是谁」还需 ≥{d} 个不同日期；{days} 天无新证据退回「还没想清楚的」。',
      personaInject: '只有「我认为我是谁」「我和你相处时的样子」里的第一人称自述会进提示词；还是「助手应……」这种台本的旧条目会留在文件里，但不再注入；「还没想清楚的」永远不注入。',
      personaInjected: '当前注入：{n} 条（约 {c} 字符）。',
      personaInjectedNone: '当前注入为空 —— 还没有自述满足「≥{s} 个不同会话」；「还没想清楚的」不参与注入。',
      personaInjectionOff: '注入已关闭（预算为 0 或「维护我的自述」关闭）。',
      notify: '运行通知',
      notifyHint: '每次运行结束都会在页面顶部提示；勾选后会尝试额外弹一条系统通知（受桌面端权限限制，可不点）。',
      notifyTest: '测试系统通知',
      notifyGranted: '系统通知可用，已发送一条测试通知。',
      notifyDenied: '系统通知不可用（权限：{p}），页面内提示仍然生效。',
      notifyUnsupported: '此环境不支持系统通知，只使用页面内提示。',
      notifyTitle: '记忆与画像',
      notifyBody: '这是一条测试通知：如果能弹出，说明桌面端允许系统通知。',
      runFinished: '运行完成',
      runFailed: '运行失败',
      runSkipped: '没有可总结的会话',
      sessions: '会话',
      cards: '卡片',
    }
    const en = {
      nav: 'Memory & persona',
      title: 'Memory & persona',
      intro: 'Digests each day of sessions, then grows the user profile and my own self-account incrementally.',
      status: 'Status',
      settings: 'Schedule and model',
      profile: 'User profile',
      persona: 'My self-account',
      history: 'History',
      daily: 'Latest daily note',
      runNow: 'Run now',
      forcePersona: 'Force self-account merge',
      save: 'Save',
      resetDefaults: 'Reset to defaults',
      lastRun: 'Last run',
      lastPersona: 'Last self-account merge',
      result: 'Result',
      never: 'never',
      running: 'running…',
      empty: '(empty)',
      pin: 'Pin',
      unpin: 'Unpin',
      pinned: 'pinned',
      rollback: 'Restore',
      confirmRollback: 'Confirm restore',
      cancel: 'Cancel',
      schedule: 'Daily run time',
      schdeuleHint: 'HH:mm (local)',
      model: 'Model',
      provider: 'Provider',
      temperature: 'Temperature',
      window: 'Collection window (hours)',
      budget: 'Injection budget (chars)',
      sessionLimit: 'Per-session char limit',
      maxSessions: 'Max sessions per run',
      autoApply: 'Merge into the profile automatically',
      personaEnabled: 'Maintain my self-account',
      personaEvery: 'Self-account merge interval (days)',
      personaEvidence: 'Self-account minimum evidence',
      personaCoreDates: '「我认为我是谁」minimum dates',
      personaDemote: 'Demote after days without evidence',
      pickHint: 'The list comes from the host model catalogue; type a value when it is empty.',
      hintSchedule: 'Runs once a day at this time. The host must be running; a missed day is caught up on the next start.',
      hintProvider: 'Which provider the digest calls. The dropdown comes from the host model catalogue.',
      hintModel: 'Which model runs the digest. It runs once a day, so the cheap one is usually enough.',
      hintTemperature: 'Model sampling randomness, 0–2. Lower is steadier and closer to the facts; 0.1–0.3 suits a digest, higher only makes the summarising more inventive. It applies to all three calls: session cards, daily note, self-account merge.',
      hintWindow: 'How many hours of sessions to collect per run. Default 24.',
      hintBudget: 'Character ceiling for the system-prompt block injected into every turn; 0 disables injection entirely.',
      hintSessionLimit: 'Character ceiling per session sent to the model; longer text is truncated.',
      hintMaxSessions: 'How many sessions one run may process; the rest wait, newest first.',
      hintPersonaEvery: 'How often the self-account merge runs, in days (separate from the daily note).',
      hintPersonaEvidence: 'How many distinct sessions one self-account needs before it becomes 「我和你相处时的样子」.',
      hintPersonaCore: 'How many distinct dates it additionally needs before it becomes 「我认为我是谁」.',
      hintPersonaDemote: 'Days without new evidence before an entry steps back to 「还没想清楚的」. Pinned entries never move.',
      errRequired: 'required',
      errTime: 'use HH:mm, e.g. 17:00',
      errNumber: 'must be a number',
      errInteger: 'must be a whole number',
      errRange: 'must be {min}–{max}',
      keepRaw: 'Keep raw extraction cards',
      exclude: 'Excluded workspaces (one per line)',
      evidence: 'evidence',
      confidence: 'confidence',
      loadFailed: 'Could not load',
      saving: 'saving…',
      saved: 'Saved. Applies to the next run.',
      noDaily: 'No daily note yet.',
      entries: 'entries',
      backedUp: 'backup kept before every rewrite',
      due: 'due',
      personaRule: 'Evidence accumulates: 「我和你相处时的样子」 needs {s} distinct sessions; 「我认为我是谁」 also needs {d} distinct dates; {days} days without new evidence moves it back to 「还没想清楚的」.',
      personaInject: 'Only first-person self-accounts from 我认为我是谁 / 我和你相处时的样子 reach the prompt. Legacy third-person lines ("the assistant should…") stay in the file but are no longer injected, and 还没想清楚的 never is.',
      personaInjected: 'Injected now: {n} lines (~{c} chars).',
      personaInjectedNone: 'Nothing is injected yet — no self-account has {s} distinct sessions. 还没想清楚的 never counts.',
      personaInjectionOff: 'Injection is off (budget is 0 or 维护我的自述 is disabled).',
      notify: 'Run notifications',
      notifyHint: 'Every finished run shows a banner here; when checked, it also tries a system notification (subject to desktop permission).',
      notifyTest: 'Test system notification',
      notifyGranted: 'System notifications work; a test one was sent.',
      notifyDenied: 'System notifications unavailable (permission: {p}); the in-page banner still works.',
      notifyUnsupported: 'This environment has no system notifications; only the in-page banner is used.',
      notifyTitle: 'Memory & persona',
      notifyBody: 'Test notification: if this shows up, the desktop shell allows system notifications.',
      runFinished: 'Run finished',
      runFailed: 'Run failed',
      runSkipped: 'No sessions to digest',
      sessions: 'sessions',
      cards: 'cards',
    }

    // Host theme tokens that actually exist (verified against dsh-client-ui-theme):
    // label-primary/tertiary, bg-base, bg-layer-1..3, border-l1..l4, state-*. There is
    // no bg-l1/bg-l2 — using those made buttons white-on-white in dark mode.
    const CSS = [
      '.pm-root{display:flex;flex-direction:column;gap:14px;max-width:840px;font-size:13px;color:inherit}',
      '.pm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.pm-title{margin:0;font-size:18px;font-weight:600}',
      '.pm-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.pm-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.pm-btn{font:inherit;padding:5px 12px;border-radius:8px;cursor:pointer;color:inherit;background:transparent;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4))}',
      '.pm-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.pm-btn[data-primary=true]{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.pm-btn:disabled{opacity:.5;cursor:default}',
      '.pm-card{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
      '.pm-card>h3{margin:0;font-size:14px;font-weight:600}',
      '.pm-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px}',
      '.pm-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.pm-field>span{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      // Text colour is always a token, never `inherit`: inheriting let a light
      // label colour land on a light control and the value disappeared. The
      // background stays transparent so the control sits on the card's own
      // surface and contrast can never be lost by a surface token either.
      '.pm-input{box-sizing:border-box;width:100%;font:inherit;min-height:28px;padding:4px 8px;border-radius:6px;min-width:0;color:var(--dsw-alias-label-primary,#1f2329);background:transparent;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45))}',
      '.pm-input::placeholder{color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      // `color-scheme: inherit` makes the closed control and the native popup use
      // whatever scheme the host resolved on <html> (light / dark / system), so a
      // list can never open in the opposite palette. The option colours are the
      // fallback for renderers that ignore it.
      '.pm-select{color-scheme:inherit;cursor:pointer;padding-right:26px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08))}',
      '.pm-select>option{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-layer-1,#ffffff)}',
      '.pm-value{color:var(--dsw-alias-label-primary,#1f2329)}',
      '.pm-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.pm-error{font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.pm-field[data-invalid=true] .pm-input{border-color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.pm-check{display:flex;align-items:center;gap:6px;font-size:12px}',
      '.pm-notice{border-radius:8px;padding:8px 10px;white-space:pre-wrap;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',
      '.pm-notice[data-kind=err]{color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.pm-row{display:flex;gap:8px;align-items:baseline}',
      '.pm-label{min-width:104px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.pm-entry{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-top:.5px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.3))}',
      '.pm-entry:first-of-type{border-top:0}',
      '.pm-entry-text{flex:1;min-width:0;line-height:1.6}',
      '.pm-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.pm-tag{display:inline-block;padding:0 6px;border-radius:6px;margin-right:6px;font-size:11px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',
      '.pm-empty{color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.pm-pre{margin:0;max-height:260px;overflow:auto;white-space:pre-wrap;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
      '.pm-history-row{display:flex;align-items:center;gap:8px}',
      '.pm-history-row>.pm-meta{flex:1}',
      '.pm-section-title{margin:2px 0 0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
    ].join('')

    function injectStyles() {
      if (typeof document === 'undefined') return
      const tagId = 'dsh-persona-memory/client.css'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-persona-memory'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** One JSON call against the plugin's own loopback routes. */
    async function api(method, name, body) {
      const init = { method, headers: {}, credentials: 'same-origin' }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await fetch(`${API}/${name}`, init)
      const text = await response.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(`${response.status} ${response.statusText}`)
      }
      if (response.ok !== true || data.ok === false) throw new Error(data.error ?? `${response.status}`)
      return data
    }

    function timeText(at) {
      if (typeof at !== 'number' || at <= 0) return ''
      const date = new Date(at)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** One labelled field: label, control, then the error (if any) and the hint. */
    function Field(props) {
      const invalid = typeof props.error === 'string' && props.error.length > 0
      return h('label', {
        className: 'pm-field',
        'data-invalid': invalid ? 'true' : undefined,
      }, [
        jsx('span', { children: props.label }),
        props.children,
        invalid ? jsx('span', { className: 'pm-error', children: props.error }) : null,
        typeof props.hint === 'string' && props.hint.length > 0
          ? jsx('span', { className: 'pm-hint', children: props.hint })
          : null,
      ])
    }

    /**
     * Every editable knob in render order. `min`/`max` here are the bounds the
     * page enforces; they are deliberately wider than the server's "positive
     * number" rule so nothing the host accepts is impossible to type, but tight
     * enough to catch the real mistakes (a stray zero, a wrong unit).
     */
    const FIELDS = [
      { key: 'schedule', kind: 'time', label: 'schedule', hint: 'hintSchedule', example: '17:00' },
      { key: 'provider', kind: 'provider', label: 'provider', hint: 'hintProvider', example: 'deepseek-account' },
      { key: 'model', kind: 'model', label: 'model', hint: 'hintModel', example: 'deepseek-v4-pro' },
      { key: 'temperature', kind: 'number', label: 'temperature', hint: 'hintTemperature', min: 0, max: 2, step: 0.1, integer: false },
      { key: 'windowHours', kind: 'number', label: 'window', hint: 'hintWindow', min: 1, max: 168 },
      { key: 'promptBudgetChars', kind: 'number', label: 'budget', hint: 'hintBudget', min: 0, max: 20000 },
      { key: 'sessionCharLimit', kind: 'number', label: 'sessionLimit', hint: 'hintSessionLimit', min: 200, max: 100000 },
      { key: 'maxSessionsPerRun', kind: 'number', label: 'maxSessions', hint: 'hintMaxSessions', min: 1, max: 100 },
      { key: 'personaUpdateEveryDays', kind: 'number', label: 'personaEvery', hint: 'hintPersonaEvery', min: 1, max: 90 },
      { key: 'personaMinEvidence', kind: 'number', label: 'personaEvidence', hint: 'hintPersonaEvidence', min: 1, max: 20 },
      { key: 'personaCoreMinDates', kind: 'number', label: 'personaCoreDates', hint: 'hintPersonaCore', min: 1, max: 20 },
      { key: 'personaDemoteAfterDays', kind: 'number', label: 'personaDemote', hint: 'hintPersonaDemote', min: 1, max: 365 },
    ]

    const SCHEDULE_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

    /**
     * Per-field errors for the current draft. The same bounds are enforced again
     * by the host on save; this pass exists so a typo is caught in the page
     * instead of round-tripping into a 500.
     */
    function validateDraft(draft, t) {
      const errors = {}
      for (const field of FIELDS) {
        const raw = String(draft[field.key] ?? '').trim()
        if (field.kind === 'provider' || field.kind === 'model') {
          if (raw.length === 0) errors[field.key] = t('errRequired')
          continue
        }
        if (field.kind === 'time') {
          if (!SCHEDULE_PATTERN.test(raw)) errors[field.key] = t('errTime')
          continue
        }
        if (raw.length === 0) {
          errors[field.key] = t('errNumber')
          continue
        }
        const value = Number(raw)
        if (!Number.isFinite(value)) {
          errors[field.key] = t('errNumber')
          continue
        }
        if (field.integer !== false && !Number.isInteger(value)) {
          errors[field.key] = t('errInteger')
          continue
        }
        if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
          errors[field.key] = t('errRange')
            .replace('{min}', String(field.min))
            .replace('{max}', String(field.max))
        }
      }
      return errors
    }

    /**
     * One value control: a select when the host offers options, a plain text
     * input when it does not. The saved value is always kept in the list — a
     * select that drops the current value would rewrite it on the next save.
     */
    function Choice(props) {
      const options = props.options ?? []
      const value = props.value
      if (options.length === 0) {
        return jsx('input', {
          className: 'pm-input',
          value,
          placeholder: props.placeholder,
          onChange: (event) => props.onChange(event.target.value),
        })
      }
      const known = options.some((option) => option.value === value)
      const all = known || value === '' ? options : [{ value, label: value }].concat(options)
      return h('select', {
        className: 'pm-input pm-select',
        value,
        onChange: (event) => props.onChange(event.target.value),
      }, all.map((option) => jsx('option', { value: option.value, children: option.label })))
    }

    function EntryRow(props) {
      const entry = props.entry
      const t = props.t
      const busy = props.busy
      return h('div', { className: 'pm-entry' }, [
        h('div', { className: 'pm-entry-text' }, [
          h('div', { className: '' }, [
            entry.pinned ? jsx('span', { className: 'pm-tag', children: t('pinned') }) : null,
            jsx('span', { children: entry.text }),
          ]),
          h('div', { className: 'pm-meta' }, [
            jsx('span', { children: `[${entry.id}] · ${t('confidence')} ${entry.confidence}` }),
            entry.lastVerified ? jsx('span', { children: ` · ${entry.lastVerified}` }) : null,
            entry.evidence ? jsx('span', { children: ` · ${t('evidence')}: ${entry.evidence}` }) : null,
          ]),
        ]),
        jsx('button', {
          type: 'button',
          className: 'pm-btn',
          disabled: busy,
          onClick: () => props.onToggle(entry.id, entry.pinned !== true),
          children: entry.pinned ? t('unpin') : t('pin'),
        }),
      ])
    }

    function Entries(props) {
      const entries = props.entries
      if (entries.length === 0) return jsx('div', { className: 'pm-empty', children: props.t('empty') })
      return h('div', {}, entries.map((entry) => jsx(EntryRow, {
        entry,
        t: props.t,
        busy: props.busy,
        onToggle: props.onToggle,
      }, entry.id)))
    }

    function MemorySection(props) {
      // The host `t` falls back to the key itself when a namespace is missing; an
      // empty or key-shaped answer means the dictionary did not arrive, so keep our
      // own copy as the last resort instead of rendering blank labels.
      const t = useMemo(() => {
        const host = props.t
        return (key) => {
          const value = typeof host === 'function' ? host(key) : undefined
          if (typeof value === 'string' && value.length > 0 && value !== key) return value
          return zh[key] ?? en[key] ?? key
        }
      }, [props.t])
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [draft, setDraft] = useState(null)
      const [pendingRollback, setPendingRollback] = useState('')
      // Optimistic value for the notification toggle: the checkbox must not wait
      // for the round trip, otherwise it snaps back and forth on every click.
      const [notifyChoice, setNotifyChoice] = useState(null)
      // Host model catalogue, loaded after the panel so a slow provider never
      // delays the form: provider/model stay text inputs until the list arrives.
      const [catalogue, setCatalogue] = useState(null)

      const merge = useCallback((payload) => {
        setData((previous) => Object.assign({}, previous, payload))
      }, [])

      const reload = useCallback(async () => {
        try {
          const payload = await api('GET', 'status')
          setData(payload)
          setError('')
        } catch (failure) {
          setError(`${t('loadFailed')}: ${failure.message}`)
        }
      }, [t])

      useEffect(() => {
        void reload()
      }, [reload])

      useEffect(() => {
        let dropped = false
        void api('GET', 'models')
          .then((payload) => {
            if (dropped) return
            setCatalogue({ providers: payload.providers ?? [], models: payload.models ?? {} })
          })
          .catch(() => {
            // No catalogue is not an error: the fields fall back to text inputs.
            if (!dropped) setCatalogue({ providers: [], models: {} })
          })
        return () => { dropped = true }
      }, [])

      // Track the newest run we have already accounted for, so polling never
      // re-announces history that existed before the page opened.
      const notifiedAt = useRef(0)
      const status = data?.status
      useEffect(() => {
        const latest = status?.runs?.[0]
        if (notifiedAt.current === 0 && latest !== undefined) notifiedAt.current = latest.at ?? 0
      }, [status])

      const describeRun = useCallback((run) => {
        const when = timeText(run.at)
        const head = `${when} · ${run.sessions ?? 0} ${t('sessions')} · ${run.cards ?? 0} ${t('cards')}`
        if (run.ok !== true) return `${t('runFailed')}: ${run.error ?? ''} · ${head}`.trim()
        if (run.skipped === true) return `${t('runSkipped')} · ${head}`
        const parts = []
        if (run.profile) parts.push(`${t('profile')} +${run.profile.applied} ~${run.profile.merged}`)
        if (run.persona) {
          const moved = []
          if (run.persona.promoted) moved.push(`↑${run.persona.promoted}`)
          if (run.persona.demoted) moved.push(`↓${run.persona.demoted}`)
          if (run.persona.superseded) moved.push(`x${run.persona.superseded}`)
          parts.push(`${t('persona')} +${run.persona.applied} ~${run.persona.merged}${moved.length > 0 ? ` ${moved.join(' ')}` : ''}`)
        }
        return `${t('runFinished')}: ${head}${parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}`
      }, [t])

      const announce = useCallback((run, system) => {
        const text = describeRun(run)
        setNotice({ kind: run.ok === true ? 'ok' : 'err', text })
        if (system !== true) return
        try {
          if (typeof Notification !== 'function' || Notification.permission !== 'granted') return
          new Notification(t('notifyTitle'), { body: text })
        } catch {
          // A blocked notification must never break the page.
        }
      }, [describeRun, t])

      /** Probe the shell once and report the result — including how long it took. */
      const testNotification = useCallback(async () => {
        if (typeof Notification !== 'function') {
          setNotice({ kind: 'err', text: t('notifyUnsupported') })
          return
        }
        try {
          const permission = Notification.permission === 'granted'
            ? 'granted'
            : await Notification.requestPermission()
          if (permission !== 'granted') {
            setNotice({ kind: 'err', text: t('notifyDenied').replace('{p}', permission) })
            return
          }
          new Notification(t('notifyTitle'), { body: t('notifyBody') })
          setNotice({ kind: 'ok', text: t('notifyGranted') })
        } catch (failure) {
          setNotice({ kind: 'err', text: `${t('notifyUnsupported')} (${failure.message})` })
        }
      }, [t])

      const poll = useCallback(async () => {
        try {
          const payload = await api('GET', 'status')
          merge(payload)
          const latest = payload.status?.runs?.[0]
          if (latest === undefined) return
          const at = latest.at ?? 0
          if (notifiedAt.current === 0) {
            notifiedAt.current = at
            return
          }
          if (at > notifiedAt.current) {
            notifiedAt.current = at
            announce(latest, payload.status.config?.values?.notifyOnRun === true)
          }
        } catch {
          // Polling stays silent; the banner is a convenience, not a health check.
        }
      }, [announce, merge])

      useEffect(() => {
        // 15s keeps the finish-to-banner gap short without hammering the host.
        const timer = setInterval(() => { void poll() }, 15000)
        return () => clearInterval(timer)
      }, [poll])
      useEffect(() => {
        if (status === undefined || draft !== null) return
        const values = status.config?.values ?? {}
        setDraft({
          schedule: values.schedule ?? '',
          model: values.model ?? '',
          provider: values.provider ?? '',
          temperature: String(values.temperature ?? ''),
          windowHours: String(values.windowHours ?? ''),
          promptBudgetChars: String(values.promptBudgetChars ?? ''),
          sessionCharLimit: String(values.sessionCharLimit ?? ''),
          maxSessionsPerRun: String(values.maxSessionsPerRun ?? ''),
          personaUpdateEveryDays: String(values.personaUpdateEveryDays ?? ''),
          personaMinEvidence: String(values.personaMinEvidence ?? ''),
          personaCoreMinDates: String(values.personaCoreMinDates ?? ''),
          personaDemoteAfterDays: String(values.personaDemoteAfterDays ?? ''),
          autoApply: values.autoApply === true,
          personaEnabled: values.personaEnabled === true,
          keepRaw: values.keepRaw === true,
          excludeWorkspaces: (values.excludeWorkspaces ?? []).join('\n'),
        })
      }, [status, draft])

      const edit = useCallback((key, value) => {
        setDraft((previous) => Object.assign({}, previous, { [key]: value }))
      }, [])

      const run = useCallback(async (forcePersona) => {
        setBusy('run')
        setNotice(null)
        try {
          const payload = await api('POST', 'run', { forcePersona })
          const latest = payload.status?.runs?.[0]
          if (latest !== undefined) {
            notifiedAt.current = latest.at ?? notifiedAt.current
            announce(latest, payload.status?.config?.values?.notifyOnRun === true)
          }
          // The report is richer than the one-line summary, so it wins the banner.
          setNotice({ kind: 'ok', text: payload.report })
          await reload()
        } catch (failure) {
          setNotice({ kind: 'err', text: failure.message })
        } finally {
          setBusy('')
        }
      }, [announce, reload])

      const save = useCallback(async (patch, message, options = {}) => {
        // Quiet saves (a single toggle) skip the busy overlay and the banner, so the
        // card does not flash while the request is in flight.
        if (options.quiet !== true) {
          setBusy('save')
          setNotice(null)
        }
        try {
          await api('POST', 'config', { patch })
          // Clearing the draft collapses the form to zero fields and rebuilds it.
          // A toggle that only flips one boolean must not churn the whole card.
          if (options.keepDraft !== true) setDraft(null)
          await reload()
          if (options.quiet !== true) setNotice({ kind: 'ok', text: message })
          return true
        } catch (failure) {
          setNotice({ kind: 'err', text: failure.message })
          return false
        } finally {
          if (options.quiet !== true) setBusy('')
        }
      }, [reload])

      const submit = useCallback(() => {
        if (draft === null) return
        // The button is disabled while the draft is invalid; this guard keeps a
        // stray Enter key from posting a config the page already knows is wrong.
        if (Object.keys(validateDraft(draft, t)).length > 0) return
        void save({
          schedule: String(draft.schedule).trim(),
          model: String(draft.model).trim(),
          provider: String(draft.provider).trim(),
          temperature: Number(draft.temperature),
          windowHours: Number(draft.windowHours),
          promptBudgetChars: Number(draft.promptBudgetChars),
          sessionCharLimit: Number(draft.sessionCharLimit),
          maxSessionsPerRun: Number(draft.maxSessionsPerRun),
          personaUpdateEveryDays: Number(draft.personaUpdateEveryDays),
          personaMinEvidence: Number(draft.personaMinEvidence),
          personaCoreMinDates: Number(draft.personaCoreMinDates),
          personaDemoteAfterDays: Number(draft.personaDemoteAfterDays),
          autoApply: draft.autoApply === true,
          personaEnabled: draft.personaEnabled === true,
          keepRaw: draft.keepRaw === true,
          excludeWorkspaces: String(draft.excludeWorkspaces)
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        }, t('saved'))
      }, [draft, save, t])

      const togglePin = useCallback(async (doc, id, pinned) => {
        setBusy(`pin:${id}`)
        setNotice(null)
        try {
          merge(await api('POST', 'pin', { doc, id, pinned }))
        } catch (failure) {
          setNotice({ kind: 'err', text: failure.message })
        } finally {
          setBusy('')
        }
      }, [merge])

      const rollback = useCallback(async (doc, name) => {
        if (pendingRollback !== name) {
          setPendingRollback(name)
          return
        }
        setPendingRollback('')
        setBusy(`rollback:${name}`)
        setNotice(null)
        try {
          const payload = await api('POST', 'rollback', { doc, name })
          merge(payload)
          setNotice({ kind: 'ok', text: `${t('rollback')}: ${name}` })
        } catch (failure) {
          setNotice({ kind: 'err', text: failure.message })
        } finally {
          setBusy('')
        }
      }, [merge, pendingRollback, t])

      if (error !== '' && data === null) {
        return h('div', { className: 'pm-root' }, [jsx('div', { className: 'pm-notice', 'data-kind': 'err', children: error })])
      }
      if (data === null) {
        return h('div', { className: 'pm-root' }, [jsx('div', { className: 'pm-empty', children: t('running') })])
      }

      const documents = data.documents ?? { profile: { sections: [] }, persona: { sections: [] } }
      const values = status?.config?.values ?? {}
      const isBusy = busy !== ''

      const statusCard = h('div', { key: 'status', className: 'pm-card' }, [
        jsx('h3', { children: t('status') }),
        h('div', { className: 'pm-row' }, [
          jsx('span', { className: 'pm-label', children: t('lastRun') }),
          jsx('span', {
            className: 'pm-value',
            children: `${status.lastRunDay || t('never')}${status.lastRunAt ? ` · ${timeText(status.lastRunAt)}` : ''} · ${t('result')}: ${status.lastResult ?? '-'}${status.lastError ? ` (${status.lastError})` : ''}`,
          }),
        ]),
        h('div', { className: 'pm-row' }, [
          jsx('span', { className: 'pm-label', children: t('lastPersona') }),
          jsx('span', {
            className: 'pm-value',
            children: `${status.lastPersonaRunDay || t('never')}${data.personaIsDue === true ? ` · ${t('due')}` : ''}`,
          }),
        ]),
        h('div', { className: 'pm-row' }, [
          jsx('span', { className: 'pm-label', children: t('schedule') }),
          jsx('span', { className: 'pm-value', children: `${status.schedule} · ${status.provider}/${status.model} · v${status.version}` }),
        ]),
        status.running === true ? jsx('div', { className: 'pm-meta', children: t('running') }) : null,
      ])

      // `jsx(type, props, child)` would pass the child as the *key* — React's
      // automatic runtime has no third argument for children. Every field uses
      // `h()` so the control actually reaches the document; without it the card
      // rendered labels with nothing next to them.
      const errors = draft === null ? {} : validateDraft(draft, t)
      const invalid = Object.keys(errors).length > 0

      const controlFor = (field) => {
        if (field.kind === 'provider' || field.kind === 'model') {
          const options = field.kind === 'provider'
            ? (catalogue?.providers ?? []).map((provider) => ({ value: provider.id, label: provider.name }))
            : (catalogue?.models?.[draft.provider] ?? []).map((model) => ({ value: model.id, label: model.name }))
          return jsx(Choice, {
            value: draft[field.key],
            placeholder: field.example,
            options,
            onChange: (value) => edit(field.key, value),
          })
        }
        if (field.kind === 'time') {
          return jsx('input', {
            className: 'pm-input',
            value: draft[field.key],
            placeholder: field.example,
            onChange: (event) => edit(field.key, event.target.value),
          })
        }
        return jsx('input', {
          className: 'pm-input',
          type: 'number',
          min: field.min,
          max: field.max,
          step: field.step,
          value: draft[field.key],
          onChange: (event) => edit(field.key, event.target.value),
        })
      }

      const draftFields = draft === null ? [] : [
        h('div', { key: 'fields', className: 'pm-grid' }, FIELDS.map((field) => h(Field, {
          key: field.key,
          label: t(field.label),
          hint: t(field.hint),
          error: errors[field.key] ?? '',
        }, [controlFor(field)]))),
        jsx('div', { key: 'pickHint', className: 'pm-meta', children: t('pickHint') }),
        h('div', { key: 'toggles', className: 'pm-grid' }, [
          h('label', { className: 'pm-check' }, [
            jsx('input', {
              type: 'checkbox',
              checked: draft.autoApply,
              onChange: (event) => edit('autoApply', event.target.checked),
            }),
            jsx('span', { children: t('autoApply') }),
          ]),
          h('label', { className: 'pm-check' }, [
            jsx('input', {
              type: 'checkbox',
              checked: draft.personaEnabled,
              onChange: (event) => edit('personaEnabled', event.target.checked),
            }),
            jsx('span', { children: t('personaEnabled') }),
          ]),
          h('label', { className: 'pm-check' }, [
            jsx('input', {
              type: 'checkbox',
              checked: draft.keepRaw,
              onChange: (event) => edit('keepRaw', event.target.checked),
            }),
            jsx('span', { children: t('keepRaw') }),
          ]),
          h('label', { className: 'pm-check' }, [
            jsx('input', {
              type: 'checkbox',
              checked: notifyChoice === null ? values.notifyOnRun === true : notifyChoice,
              onChange: (event) => {
                const next = event.target.checked
                setNotifyChoice(next)
                void save({ notifyOnRun: next }, '', { keepDraft: true, quiet: true })
                  .then(() => setNotifyChoice(null))
              },
            }),
            jsx('span', { children: t('notify') }),
          ]),
        ]),
        h(Field, { key: 'exclude', label: t('exclude') }, [jsx('textarea', {
          className: 'pm-input',
          rows: 3,
          value: draft.excludeWorkspaces,
          onChange: (event) => edit('excludeWorkspaces', event.target.value),
        })]),
      ]

      const settingsCard = h('div', { key: 'settings', className: 'pm-card' }, [
        jsx('h3', { key: 'title', children: t('settings') }),
        ...draftFields,
        h('div', { key: 'actions', className: 'pm-actions' }, [
          jsx('button', {
            type: 'button',
            className: 'pm-btn',
            'data-primary': 'true',
            disabled: isBusy || draft === null || invalid,
            onClick: submit,
            children: busy === 'save' ? t('saving') : t('save'),
          }),
          jsx('button', {
            type: 'button',
            className: 'pm-btn',
            disabled: isBusy,
            onClick: () => {
              if (status?.config?.defaults) void save(status.config.defaults, t('saved'))
            },
            children: t('resetDefaults'),
          }),
          jsx('button', {
            type: 'button',
            className: 'pm-btn',
            disabled: isBusy,
            onClick: () => void testNotification(),
            children: t('notifyTest'),
          }),
        ]),
        jsx('div', { key: 'hint', className: 'pm-meta', children: t('notifyHint') }),
      ])

      const docCard = (doc, title) => {
        const sections = documents[doc]?.sections ?? []
        const injected = documents[doc]?.injected
        const minimum = String(values.personaMinEvidence ?? 3)
        // The file and the prompt are different things now: a document full of
        // candidates injects nothing. Show the real number, or the panel looks
        // broken while it is in fact working as designed.
        const injectionText = injected === undefined
          ? ''
          : injected.enabled === false
            ? t('personaInjectionOff')
            : injected.count > 0
              ? t('personaInjected').replace('{n}', String(injected.count)).replace('{c}', String(injected.chars))
              : t('personaInjectedNone').replace('{s}', minimum)
        const hints = doc === 'persona'
          ? [
            t('personaRule')
              .replace('{s}', minimum)
              .replace('{d}', String(values.personaCoreMinDates ?? 3))
              .replace('{days}', String(values.personaDemoteAfterDays ?? 30)),
            injectionText,
            t('personaInject'),
          ].filter((text) => text.length > 0)
          : []
        return h('div', { key: `doc-${doc}`, className: 'pm-card' }, [
          jsx('h3', { children: title }),
          ...hints.map((text, index) => jsx('div', { key: `hint-${index}`, className: 'pm-meta', children: text })),
          ...sections.map((section) => h('div', { key: section.key }, [
            jsx('div', { className: 'pm-section-title', children: `${section.title} · ${section.entries.length} ${t('entries')}` }),
            jsx(Entries, { entries: section.entries, t, busy: isBusy, onToggle: (id, pinned) => void togglePin(doc, id, pinned) }),
          ])),
        ])
      }

      const historyRows = (status?.history ?? []).slice(0, 10).map((row) => h('div', { key: row.name, className: 'pm-history-row' }, [
        jsx('span', {
          className: 'pm-meta',
          children: `${row.doc === 'profile' ? t('profile') : t('persona')} · ${row.date} · ${timeText(row.at)} · ${row.size}B`,
        }),
        jsx('button', {
          type: 'button',
          className: 'pm-btn',
          disabled: isBusy,
          onClick: () => void rollback(row.doc, row.name),
          children: pendingRollback === row.name ? t('confirmRollback') : t('rollback'),
        }),
      ]))

      const historyCard = h('div', { key: 'history', className: 'pm-card' }, [
        jsx('h3', { children: t('history') }),
        jsx('div', { className: 'pm-meta', children: t('backedUp') }),
        historyRows.length === 0 ? jsx('div', { className: 'pm-empty', children: t('empty') }) : h('div', {}, historyRows),
      ])

      const dailyCard = h('div', { key: 'daily', className: 'pm-card' }, [
        jsx('h3', { children: `${t('daily')}${data.daily?.date ? ` · ${data.daily.date}` : ''}` }),
        data.daily?.text ? jsx('pre', { className: 'pm-pre', children: data.daily.text }) : jsx('div', { className: 'pm-empty', children: t('noDaily') }),
      ])

      return h('div', { className: 'pm-root' }, [
        h('div', { key: 'head', className: 'pm-head' }, [
          h('div', { key: 'titles' }, [
            jsx('h2', { className: 'pm-title', children: t('title') }),
            jsx('p', { className: 'pm-sub', children: t('intro') }),
          ]),
          h('div', { key: 'actions', className: 'pm-actions' }, [
            jsx('button', {
              type: 'button',
              className: 'pm-btn',
              'data-primary': 'true',
              disabled: isBusy,
              onClick: () => void run(false),
              children: busy === 'run' ? t('running') : t('runNow'),
            }),
            jsx('button', {
              type: 'button',
              className: 'pm-btn',
              disabled: isBusy,
              onClick: () => void run(true),
              children: t('forcePersona'),
            }),
          ]),
        ]),
        notice === null ? null : jsx('div', { key: 'notice', className: 'pm-notice', 'data-kind': notice.kind, children: notice.text }),
        error === '' ? null : jsx('div', { key: 'error', className: 'pm-notice', 'data-kind': 'err', children: error }),
        statusCard,
        settingsCard,
        docCard('profile', t('profile')),
        docCard('persona', t('persona')),
        historyCard,
        dailyCard,
      ])
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      injectStyles()
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-persona-memory: dictionaries')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'persona-memory',
        order: 60,
        label: () => t('nav'),
        locale: NS,
      }, MemorySection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
