# dsh-persona-memory

**English** · [简体中文](README.zh-CN.md)

Daily cross-workspace session digest that grows a **user profile** and a **companion personality**, then injects both into every prompt — with a settings page to inspect and steer it.

## Install

```sh
dsh plugin add github:PaangGaaSam/dsh-persona-memory
```

Then restart the desktop app. No build step, no native dependencies, and no API key of its own — the digest runs on the host's configured model.

Open **设置 → 插件 → 记忆与画像 / Settings → Plugins → Memory & persona** to change the schedule, model, budget or scope, and to run the first digest immediately (`立即运行`, or `强制合并性格` to exercise the persona merge). Data lives in `$DSH_HOME/persona-memory/` and is never uploaded anywhere.

Requirements: DSH desktop with the `web` client platform (the settings page is a `dsh.client` bundle) and Node `^22.19.0 || >=24.0.0`.

## What it does

1. **Every day at 17:00** (configurable) it reads all session logs under `$DSH_HOME/sessions` (every workspace, every session in the window), including multi-frame zstd logs.
2. **Stage 1** — one card per session: topic, user needs, observations (preference / style / thinking / correction / friction), unresolved items.
3. **Stage 2** — merges the cards into `persona-memory/daily/YYYY-MM-DD.md`.
4. **Stage 3** — turns observations into profile suggestions, then merges them into `profile.md` (near-duplicate detection, evidence chains, pinned entries protected).
5. **Weekly** — consolidates observations into `persona.md` (core / style / candidates) with the same evidence rules.
6. **Every prompt** — a `persona-memory` system-prompt section renders pinned + recent entries under a character budget (default 1200 chars, 70/30 profile/persona).

## How the personality settles

The companion personality forms over time, not on first use. Every observation lands in **候选观察** first; the plugin then moves entries by **evidence**, never by what the model claims:

| Section | Promoted when |
|---|---|
| 候选观察 | default landing place for anything observed |
| 相处风格 (style) | `personaMinEvidence` distinct sessions (default 3) — a single day may qualify |
| 核心性格 (core) | the same session count **and** `personaCoreMinDates` distinct dates (default 3) |

Two rules keep it honest:

- **Supersede** — when a new observation contradicts a settled entry the model names it (`supersedes: "<id>"`); that entry's confidence drops by 0.3 and it returns to candidates instead of coexisting with its opposite.
- **Decay** — an entry without new evidence for `personaDemoteAfterDays` (default 30) steps back to candidates. Nothing is deleted; pinned and user-locked entries never move.

Evidence is `date/session` tokens (`2026-11-10/session-7b3c4fb6`), and the date comes from the **cited turn** (`[#n]` in the stage-1 prompt) rather than the run, so a session that spans midnight is dated correctly. The persona stage also reads the last `personaUpdateEveryDays` daily notes, so evidence can cross days.

Evidence is **canonicalised on the way in and on the way out**: whatever the model echoes back — a turn-qualified handle (`session-7b3c4fb6-5`) or a raw uuid fragment (`c7653975-4416-4523`) — is rewritten to `session-<8 hex>` and deduplicated. Otherwise two turns of one conversation would look like two sessions and clear the promotion threshold by itself. Legacy daily notes are healed when read, so an older note cannot poison the count.

## Settings page

The plugin ships a browser half (`dsh.client`) that registers a **记忆与画像 / Memory & persona** section in the host settings. It shows the run status, lets you edit the schedule, model, budget and scope, run the digest (optionally forcing a persona merge), pin or unpin individual entries, restore a pre-write backup, and read the latest daily note.

Every knob in the config block below is editable there — including the core-personality date threshold and the demote window — so the patch row is never the only way in. Each field carries a one-line explanation of what it changes and the page validates what it can (time format, numeric ranges) before the request leaves: an invalid value shows a message under the control and disables **保存**. **Provider and model are dropdowns** fed by the host's own model catalogue (`ctx.llm.listProviders()` / `listModels()`, served over `GET /persona-memory/models`); the controls use `color-scheme: inherit`, so the closed box and the native popup follow whatever light/dark scheme the host resolved. When an adapter cannot enumerate its models the fields fall back to free-text inputs, and the value that is already saved is always kept as an option, so opening the page can never silently change it.

Settings made there are stored in `persona-memory/config.json` as overrides and win over the patch-row config; delete that file to fall back to the row. The page talks to the plugin's own loopback routes, so no host settings plumbing is involved.

### Run notifications

While the page is open it polls `/persona-memory/status` every 30 s. When a new run appears, a banner reports it: time, sessions, cards, profile/persona deltas, and how many personality entries were promoted/demoted/superseded. The banner is always on; ticking **运行通知** additionally asks for a desktop system notification, and **测试系统通知** probes whether the shell grants it. Nothing is pushed while the page is closed — there is no host notification service to hook into.

The run record itself carries the outcome (`profile`, `persona`, `skipped`, `error`) so the banner needs no log parsing.

## Tools

| Tool | Purpose |
|---|---|
| `persona_digest` | Run the digest now (`force_persona: true` forces the weekly persona merge) |
| `persona_profile` | Read the profile and personality markdown |
| `persona_status` | Schedule, last run, file sizes |
| `persona_pin` / `persona_unpin` | Pin an entry by id (`[pref-1]` …) |
| `persona_rollback` | List or restore pre-write backups |
| `persona_note` | Append a user-dictated rule to the locked section |

## Data layout

```
$DSH_HOME/persona-memory/
├── profile.md            # user profile (single source of truth)
├── persona.md            # companion personality
├── config.json           # settings-page overrides (optional)
├── daily/YYYY-MM-DD.md   # daily digests
├── history/              # backup before every rewrite: profile-<date>-<ms>.md
├── state.json            # scheduler state
└── logs/run-YYYY-MM-DD.jsonl
```

## Config (bundle patch row)

```yaml
- insert:
    - id: persona-memory
      name: 'dsh-persona-memory'
      config:
        schedule: '17:00'
        windowHours: 24
        maxSessionsPerRun: 20
        provider: 'deepseek-account'
        model: 'deepseek-v4-pro'
        temperature: 0.2
        autoApply: true
        personaEnabled: true
        personaUpdateEveryDays: 7
        promptBudgetChars: 1200
        excludeWorkspaces: []
```

## HTTP (loopback only)

| Route | Purpose |
|---|---|
| `GET /persona-memory/status` | Scheduler status, config, documents, history |
| `GET /persona-memory/config` | Editable config values and defaults |
| `POST /persona-memory/config` | `{ patch }` — validate, persist, apply |
| `POST /persona-memory/run` | `{ forcePersona }` — run the digest now |
| `GET /persona-memory/documents` | Both documents as sections of entries, plus the latest daily note |
| `GET /persona-memory/models` | Provider and model catalogue for the dropdowns |
| `POST /persona-memory/pin` | `{ doc, id, pinned }` |
| `GET /persona-memory/history` | `?doc=profile` or `?doc=persona` — pre-write backups |
| `POST /persona-memory/rollback` | `{ doc, name }` — restore one backup |

Every non-loopback request is rejected with 403; wrong methods get 405.

## Limits

- Requires the host process to be running at the scheduled time; missed days are caught up once on the next start.
- Model output must be JSON; parsing tolerates prose/fences but a bad generation only degrades that stage (the other stages still write).
- Source changes to a `link:`-installed package need a host restart (the loader does not hot-reload linked sources, and the client bundle is served from `lib/client.js` as built).

## If this is useful to you

⭐ **[A star](https://github.com/PaangGaaSam/dsh-persona-memory/stargazers)** is the only upkeep signal this project gets — no telemetry, no usage reporting, nothing phoning home. It is also what tells other people the plugin is worth trying.

- **It did something odd, or you disagree with how the personality settles?** Open an [issue](https://github.com/PaangGaaSam/dsh-persona-memory/issues) and say what you expected. Behaviour questions are the most useful ones — the evidence thresholds are guesses until someone outside this machine runs them for a month.
- **You installed it and then stopped using it?** That is a genuinely valuable report too. Tell us why; "the daily note was noise" is a design decision worth revisiting.
- **Want to show what it grew into?** A trimmed `profile.md` / `persona.md` makes a great issue. Remove anything personal first — those files are a record of your own conversations.

Pull requests are welcome, and so are plain opinions. If you file one, keep the rule this project runs on: describe what the code actually does.
