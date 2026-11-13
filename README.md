# dsh-persona-memory

**English** · [简体中文](README.zh-CN.md)

Stop the assistant in DSH from starting over every time. Once a day it digests the conversations locally and writes down what it learned about you — and where it went wrong itself — and slowly grows **a personality of its own**; then it reads that back before the next turn. Everything is a local file; nothing is uploaded.

## The 30-second version

1. Once a day (17:00 by default, configurable) it reads the session logs of every workspace and writes one daily note.
2. From that note it grows three files: a **profile** (what it knows about you), a **self-account** (what it says about itself — its personality grows from here) and **lessons** (the step to change next time).
3. Before every turn it puts lessons + profile + self-account into one small system-prompt block (1200 characters by default), so the assistant already "remembers" you without being told again.

There is one more layer, **facts**: verifiable details such as install paths, versions and how things are laid out. Facts never sit in the prompt — the assistant looks them up when it needs them, so the store can keep growing while the prompt stays the same size.

## What you see after installing

Open **Settings → Plugins → Memory & persona**. Four cards:

| Card | What it is, in one line |
|---|---|
| **Profile** | Facts about you, in four sections (stable preferences / communication habits / thinking patterns / red lines); three rows per section by default, expandable |
| **Self-account** | What the assistant says about itself in the first person — its **personality** — split into "who I think I am / how I am with you / not figured out yet"; the card states **how many rows actually reach the prompt** |
| **Lessons** | Hard rules (irreversible red lines a human must approve) + timely lessons (expire) + retired rows (kept for reading) |
| **Facts** | Verifiable details, never in the prompt; each row carries an anchor and one verify command |

The top of the page shows run status, schedule, model, a "run now" button and rollback to an earlier version.

## Glossary

These words appear throughout the docs and the UI. They are internal names; here is what they mean:

| Term | Plain meaning | File |
|---|---|---|
| profile (画像) | What it remembers about you: preferences, habits, thinking patterns, red lines | `profile.md` |
| self-account (自述) | What the assistant says about itself — **also its personality**; first person, every row traceable to a conversation | `persona.md` |
| lessons (教训) | Pits it fell into and the specific step to change next time | `lessons.md` |
| hard rules (铁律) | The hardest slice of lessons: breaking one is irreversible, and only a human may approve one | a section of `lessons.md` |
| facts (事实) | Verifiable details; looked up on demand, never injected | `facts.md` |
| identity block (身份块) | A derived summary of the profile; read-only, never written back, never in the prompt | `identity.json` |
| injection (注入) | The act of putting the layers above into the system prompt before a turn | — |

## Install

```sh
dsh plugin add github:PaangGaaSam/dsh-persona-memory
```

Then restart the desktop app. No build step, no native dependencies, and no API key of its own — the digest runs on the host's configured model.

Open **Settings → Plugins → Memory & persona** to change the schedule, model, budget or scope, and to run the first digest immediately ("Run now"; "Force self-account merge" exercises the weekly merge). Data lives in `$DSH_HOME/persona-memory/` and is never uploaded anywhere.

Requirements: DSH desktop with the `web` client platform (the settings page is a `dsh.client` bundle) and Node `^22.19.0 || >=24.0.0`.

## How it works (details)

This section is for people who want to read or change the code, or judge whether the implementation is trustworthy. If you only want to use it, the 30-second version above is enough.

1. **Once a day** (17:00 by default, configurable) it reads every session log under `$DSH_HOME/sessions` — every workspace, every session inside the window — including multi-frame zstd logs.
2. **Stage 1** — one card per session: topic, user needs, observations (preference / style / thinking / correction / friction), **the assistant's own judgments**, suspect failure points (the step to change next time), unresolved items.
3. **Stage 2** — merges the cards into `persona-memory/daily/YYYY-MM-DD.md`. The assistant's judgments are copied verbatim into `## 我的判断` (the section keeps that name — the rows *are* its judgments) instead of being rephrased by the model. Suspect lessons go to `## 可疑雷点`, and **an empty answer is recorded as 「（无）」**.
4. **Stage 3** — turns observations into profile suggestions, then merges them into `profile.md` (near-duplicate detection, evidence chains, pinned entries protected).
5. **Weekly** — takes only those judgments as material, writes them in the first person, and consolidates them into `persona.md` (who I think I am / how I am with you / not figured out yet) with the same evidence rules.
6. **End of the daily run** — the day's suspects plus the existing lessons text go to the model once; the code then decides caps, near-duplicate merges, 90-day expiry and which rules wait for approval. Written to `lessons.md`.
7. **Every turn** — one `persona-memory` system-prompt section, in the order `lessons → profile → self-account` (facts are not part of it, see below). Default 1200 characters, baseline profile 55 / lessons 25 / self-account 20; a layer that needs less hands its share to a truncated one, and **lessons stop at 40 % (hard ceiling)** because they are in every turn.

## How the personality (self-account) grows

The personality is not a character sheet — it is a self-description the assistant forms in conversation. The file is `persona.md`, its rows are called the self-account, and both names mean the same thing: who it thinks it is, and how it behaves with you.

**What it does and does not touch.** It shapes how the assistant talks, when it stops, and when it asks before acting. It does **not** rewrite facts (the facts layer is read-only for the model), **not** the profile (rows about you are maintained by the daily digest and by hand), and **not** lessons (the code decides which pits to record and when a hard rule takes effect). A growing personality therefore changes how the remembered material is used, never the material itself.

**Do not expect results on day one.** A row needs 3 distinct sessions **and** 3 distinct dates before it reaches the prompt, so for the first days the panel will say "nothing is injected yet" — that is the threshold working, not a failure.

Every row must point back to something that happened in a specific session, and to what the assistant concluded from it. So stage 1 records **`self`: the assistant's own judgments** in a separate array — `observations` feed the profile, `self` feeds the personality, and the two never mix.

**First person, and not a script.** The prompt asks every row to walk through "what happened → what I thought at the time → what I lean towards doing now". Third-person stage directions ("the assistant should…", "keep a helpful tone") are rejected, as are performable adjectives such as tone, humour level or forms of address. A code gate runs before injection too: a row without "我" or still carrying a third-person stage direction stays in the file but never reaches the prompt. An older `persona.md` full of scripts therefore stays **silent** after an upgrade (its rows are no longer injected) until new rows collect enough evidence — that is expected behaviour, not a breakage.

New rows land in **not figured out yet**, and **evidence** moves them up — not the model's self-declaration:

| Section | Promotion condition |
|---|---|
| not figured out yet (candidate) | default home of any self-account row; **never injected** |
| how I am with you (style) | `personaMinEvidence` distinct sessions (default 3) — several in one day still counts |
| who I think I am (core) | the same session count **and** `personaCoreMinDates` distinct dates (default 3) |

Each judgment carries a kind: `mistake` (something went wrong this session, or it was corrected and changed its approach), `stance` (a judgment about a concrete matter — the default), `revise` (it used to think X, now it thinks Y). Only `mistake` can grow a reusable behaviour row, so the daily note sorts those ahead of its 12-row cap and the self-account stage reads them first — however accurate a "how to see this" judgment is, it can never repeat into a behaviour.

Three rules keep it honest:

- **Reaffirm** — before writing anything, the model must compare against the existing rows. When the same phenomenon shows up again, it names that row with `entry_id: "<id>"`, copies its text verbatim and supplies only today's evidence. The code merges by id (similarity is no longer consulted), so rephrasing can never open a new row. Without this rule every rewrite looked like a new phenomenon and the evidence stayed at one or two sessions, so the threshold was never reachable.
- **Supersede** — when a new self-account statement contradicts an established row, the model names it (`supersedes: "<id>"`); that row drops 0.3 confidence and steps back to candidates instead of coexisting with its opposite. Overturning yourself is encouraged: say why the old way did not hold.
- **Decay** — a row with no new evidence for `personaDemoteAfterDays` (default 30) steps back to candidates. Nothing is ever deleted; pinned rows never move.

`persona.md` has **no user-locked section**: identity is not something the user defines. Rules the user dictates belong to the profile's locked section and red lines, are injected separately, and never mix into the self-account. A leftover `## 用户固定规则` heading in an older document is ignored — not deleted, just no longer read or written.

Evidence is a `date/session` token (`2026-11-10/session-7b3c4fb6`), and the date comes from **the cited turn** (the `[#n]` markers in the stage-1 prompt), not from the run date, so a conversation that crosses midnight still lands on the right day. The self-account stage also reads the **`## 我的判断`** section of the last `personaUpdateEveryDays` daily notes, which is how evidence accumulates across days; renaming that section makes cross-day evidence permanently zero and the core section permanently empty.

Evidence is **canonicalised on the way in and on the way out**: whatever the model echoes back — a turn-qualified handle (`session-7b3c4fb6-5`) or a raw uuid fragment (`c7653975-4416-4523`) — is rewritten to `session-<8 hex>` and deduplicated. Otherwise two turns of one conversation would look like two sessions and clear the promotion threshold by itself. Legacy daily notes are healed when read, so an older note cannot poison the count.

## How lessons accumulate

Lessons answer a different question: **what went wrong last time, and which step to change next time**. That is the operational layer, so it never enters the profile, the self-account or the identity block — those answer "who you are / who I am", lessons answer "what to do". They are injected every turn, so they must stay few and hard.

| Section | Cap | Decay | Merge | Overturned by | Who adds/removes |
|---|---|---|---|---|---|
| hard rules (铁律) | 10 | never | never | never by the system | only a human; **a human must approve it** |
| timely lessons (时效经验) | 25 | no confirmation for 90 days → retired | same pit → merged (0.85) | can be disproved | the system may retire, a human may too |
| retired (已作废) | unlimited | — | — | — | appended only, kept for reading |

**Append-only and invalidate-only, never rewrite.** The system never rewrites the sentence of an existing entry: new rows are appended, a row that stops holding moves to retired with its original text and a reason. Every write compares each pre-existing entry (id, sentence, scope, anchor) before and after — if any of them changed, the write is refused. That is an assertion in the code, not a convention in the docs. A human **replace** is the only rewrite path: it must be clicked on the settings page, the old wording still goes to retired, and the new one is appended.

Lessons arrive through three entries:

1. **The daily question** — the note carries `## 可疑雷点`, and the answer may be 「（无）」. An empty answer is still an answer; the panel shows the streak of empty days.
2. **Consequence retrospection** — when a consequence signal shows up (tool failure / on-the-spot correction / rework / unresolved failure), the same run re-reads the last three daily notes to name the corrective step.
3. **The user fallback** — saying 「记一下」 simply becomes a candidate and lands in the daily note. No new tool.

**The model proposes, the code decides.** The model writes the step and a section suggestion; the code decides caps, merging, expiry, and that **every new rule waits for approval** before it takes effect. The section follows the failure condition: depends on the task (scale, reversibility, destructiveness) → hard rule; depends on the environment (version, path, API shape) → timely lesson. A rule also has to pass one self-check: **would breaking it cause an irreversible consequence?** Rework alone is not enough.

**Conflict detection belongs to the system; handling belongs to the self-account.** Two entries in the same scope that say the same thing in opposite directions (one 「必须」, one 「不要」) are marked `[冲突]` by a mechanical scan; the panel shows it and the injected line carries the mark — but the code neither resolves nor deletes either side. Handling is left to the self-account, and while that is still empty the default is **ask once before acting** (the soft line in the block), which disappears as the self-account grows.

Scope v1 has two tiers only: **the current workspace (cwd)** and **global**. A lesson for another worktree never reaches this workspace's prompt. Each lesson also carries an anchor (date / session / the daily sentence); if that daily entry is deleted the lesson is kept and the panel shows the anchor as 「（原条目已删除）」.

## The facts layer (looked up on demand, never injected)

Lessons answer "what to do"; facts answer "what is": where it is installed, which version runs, how a path is laid out, what was decided back then. The two layers are deliberately opposite — lessons are injected every turn and must stay few and hard; facts **never enter the prompt** and are retrieved by keyword only when the model calls `facts_search`. A facts store can therefore keep growing while the per-turn prompt stays the same size.

- `$DSH_HOME/persona-memory/facts.md`: **append-only and invalidate-only**. Every write compares each existing row's id / sentence / scope / verify command before and after; if any of them changed, the write is refused. Retiring requires a reason, and the sentence plus its `[验证]` command move to retired together.
- One row looks like `- [fact-1] [作用域 本机] [确认 2026-11-12] DSH lives in D:\deepseekharness（锚点：…）`, optionally followed by two continuation lines: `  [验证] Test-Path …` (one command that can re-prove the claim) and `  [回注] …` (stored, unused in v1). Because they are indented separate lines, a command containing brackets cannot break the parser.
- Three scopes: **global / local machine / workspace path**. Retrieval carries global + local + the current workspace; facts that belong to another worktree are reported as "N more belong to another workspace", never mixed in.
- Expiry: a row not re-confirmed for **180 days** is marked `[可能过期]`, but it is **neither deleted nor hidden**; one click on the panel's "confirm" refreshes the date.
- v1 is **human-written only**: the settings page card, or `POST /persona-memory/facts/add`. There is no `facts_add` / `facts_archive` tool — the model can only call `facts_search`, so "facts never rewrite facts" is enforced by the code rather than by convention.
- On a miss the tool answers "nothing found … do not speculate", so an empty result cannot turn into an invented fact.

## Settings page

The plugin ships a browser half (`dsh.client`) that registers a **Memory & persona** section inside the host settings. It shows run status, lets you change schedule / model / budget / scope, run a digest by hand (optionally forcing the self-account merge), pin or unpin single rows, roll back to a pre-write backup, and read the latest daily note.

The self-account card states **how many rows are actually injected** (and whether the injected block is empty). File and prompt are two different things: a full candidate section still injects nothing, so when it says "nothing is injected yet" the card also explains how much evidence is still missing — no need to read code or logs.

Both the profile and self-account cards list **3 rows per section** by default (pinned first), with an "expand all (N)" row at the end; the user-locked section never folds. Order is pinned → last verified → confidence, so a hidden row can be pinned once expanded, and nothing becomes unreachable. Folding affects the panel only and **has nothing to do with how many rows are injected**.

**Lessons** is its own card (not nested inside the profile): hard rules / timely lessons / retired, each row with scope, anchor and last confirmation date, plus `[冲突]` and "pending" marks. It supports adding by hand (choose rule or experience), retiring (a reason is required), replacing (rules only, two clicks), and "approve" appears only for pending rules. The card also shows the **streak of empty suspect answers**, the **number of pending rules** and **how many rows are injected** — the same numbers the prompt sees. It displays them; it never decides anything for you.

The **facts** card mirrors the lessons card: its first line says "not injected", then counts (live / retired), rows (id, scope, confirmation date, anchor, verify command, `possible stale`), an add form (text + scope + verify command + optional prompt cue), and "confirm" / "retire (reason required)" per row. Failures are shown inside the card, never in a dialog.

Every switch in the config block can be changed on the page — including the "who I think I am" date threshold and the demote window — so the patch row is never the only way in. Each field carries a one-line explanation of what it changes, and the page validates what it can (time format, numeric ranges) before the request leaves: an invalid value shows a message under the control and disables **Save**. **A successful save leaves the value that was just written on disk in the form** — the page refills from the config it reads back, so the field never snaps back to the old value. Times accept full-width input (`23：00`, `２３：００`): it is folded to `23:00` as you type, while `23:0` / `23` / `23:00:00` still fail. **Provider and model are dropdowns** fed by the host's own model catalogue (`ctx.llm.listProviders()` / `listModels()`, served over `GET /persona-memory/models`); the controls use `color-scheme: inherit`, so the closed box and the native popup follow whatever light/dark scheme the host resolved. When an adapter cannot enumerate its models the fields fall back to free-text inputs, and the value already saved is always kept as an option, so opening the page can never silently change it.

Settings made here are stored as overrides in `persona-memory/config.json`, which wins over the patch row; deleting that file restores the patch row exactly. The page talks to the plugin's own loopback routes, not through the host's settings pipeline.

### The identity block (a derived view of the profile)

The identity block is not a second memory: it reads `profile.md` and has the model summarise five fields — **role / domain / stack / workflow / impression**. Each is one sentence; the reasoning lives only in `basis` (the ids it cites), never in the sentence itself. Extrapolation is allowed and expected: from "cares about permission boundaries + demands sources + explains before acting" it may conclude "probably does platform or ops work that gets blamed when things break" rather than listing the inputs. It must not infer health, religion, politics, sexual orientation, financial status or relationships.

Three hard constraints:

- **Only entries at confidence ≥ 0.7 are used**; pinned and user-locked rows always count. Filtered rows are reported as "N more below the threshold".
- **Unchanged version, no call**: the cache in `identity.json` records `profileVersion`, so a day without a profile change costs no model call.
- **Never written back, never injected**: it cannot become an entry (a prediction would otherwise become evidence for the next merge, a self-reinforcing loop), and `lib/inject.js` does not know it exists. The panel offers exactly one action, "regenerate"; there is no way to edit its text. A failed regeneration keeps the previous cache instead of erasing it.

### Run notifications

While the page is open it polls `/persona-memory/status` every 30 seconds. A new run raises a banner with time, session count, card count, profile / self-account deltas and how many rows were promoted / demoted / superseded. A failed self-account merge names the reason in the banner (file untouched, raw answer in the log) instead of looking like "nothing new to add". The banner always appears; ticking **run notifications** additionally asks for a desktop notification, and **test notification** probes whether the current shell allows one. Nothing is pushed while the page is closed — the host has no notification service to attach to.

The run record itself carries the outcome (`profile`, `persona`, `lessons` including `truncated` and `suggestions`, `skipped`, `error`), so the banner never parses logs.

### When the model's answer is cut off

Models occasionally stop mid-sentence (stream cut, near-timeout) and leave the JSON unclosed. That is **no longer reported as success**:

- Entries that arrived complete are still kept — the entry itself is valid JSON, only the outer `{"add":[` is missing, and a half-finished answer must not discard good rows.
- The log gets a `warn`: `lessons truncated: 1437 chars in 140032ms, kept 1 suggestion(s)`. Length and duration sit on the same line, so the next time it is obvious whether the model wrote badly or the stream was cut (default timeout 180 s).
- The run summary and the page banner both say "this answer was truncated, kept N" instead of looking like "nothing to write today".
- `{"add":[]}` is still a valid answer (nothing to write today) and raises nothing.

## Tools

| Tool | Purpose |
|---|---|
| `persona_digest` | Run the digest now (`force_persona: true` also merges the self-account) |
| `persona_profile` | Read the profile and self-account markdown |
| `persona_status` | Schedule, last run, file sizes |
| `persona_pin` | Pin or unpin one row by id (`pinned: false` unpins; ids look like `[pref-1]`) |
| `persona_rollback` | List or restore pre-write backups |
| `persona_note` | Append one user-dictated rule to the locked section |
| `facts_search` | Retrieve facts by keyword (global + this machine + the current workspace) with anchors and verify commands; **nothing else reads facts, and facts never enter the prompt** |

## Data layout

```
$DSH_HOME/persona-memory/
├── profile.md            # profile (about the user; single source of truth)
├── persona.md            # self-account (first person; old headings are read and rewritten)
├── lessons.md            # lessons (rules / experiences / retired; append-only, invalidate-only)
├── facts.md              # facts (global / local / workspace; looked up, never injected; append-only)
├── identity.json         # identity block cache (derived view; never written back)
├── config.json           # settings-page overrides (optional)
├── daily/YYYY-MM-DD.md   # daily note: summary / observations / judgments / suspects / open threads
├── history/              # pre-write backups: profile-<date>-<ms>.md (same for persona / lessons / facts)
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
| `GET /persona-memory/status` | Scheduler status, config, the four documents, history |
| `GET /persona-memory/config` | Editable config values and defaults |
| `POST /persona-memory/config` | `{ patch }` — validate, persist, apply |
| `POST /persona-memory/run` | `{ forcePersona }` — run the digest now |
| `GET /persona-memory/documents` | The four documents as sections of entries, plus the latest daily note |
| `GET /persona-memory/models` | Provider and model catalogue for the dropdowns |
| `POST /persona-memory/pin` | `{ doc, id, pinned }` |
| `GET /persona-memory/history` | `?doc=profile`, `persona`, `lessons` or `facts` — pre-write backups |
| `POST /persona-memory/rollback` | `{ doc, name }` — restore one backup |
| `POST /persona-memory/identity/refresh` | Regenerate the identity block from the current profile (**the only write action**, and there is no route that accepts its text) |
| `POST /persona-memory/lessons/add` | `{ text, section, scope }` — add a lesson by hand |
| `POST /persona-memory/lessons/approve` | `{ id }` — approve a proposed rule (refused once ten are in force) |
| `POST /persona-memory/lessons/reject` | `{ id, reason }` — retire it; **a reason is required**, the original text moves to retired |
| `POST /persona-memory/lessons/replace` | `{ id, text }` — rules only; the old wording is archived, the new one appended |
| `POST /persona-memory/facts/add` | `{ text, scope, verify?, prompt?, note? }` — add one fact by hand (**no tool does this**) |
| `POST /persona-memory/facts/archive` | `{ id, reason }` — retire; **reason required**, the sentence and its `[验证]` command are kept in retired |
| `POST /persona-memory/facts/confirm` | `{ id }` — refresh the confirmation date (only 180 unconfirmed days mark a row stale) |

Every non-loopback request is rejected with 403; wrong methods get 405.

## Limits

- Requires the host process to be running at the scheduled time. A slot that passes while nothing is watching is **not** replayed: the next start re-arms the next future slot and the missed one leaves a single warning line in `logs/run-<day>.jsonl`. A run that starts on time and then fails is not retried either — the failure stays in the log and in `lastError`.
- The pool caps (10 rules / 25 experiences) bound what lives in `lessons.md`, not what reaches the prompt: the lessons layer is still cut to its share of the character budget, and the settings page reports how many rows that left out. A bigger pool keeps a lesson out of the daily note instead of dropping it.
- Model output must be JSON; parsing tolerates prose/fences but a bad generation only degrades that stage (the other stages still write).
- **Scope v1 only trusts a cwd the host hands over**: it is not confirmed that the host rebuilds the prompt every turn, so `buildSectionText` takes `cwd` from the context when present and otherwise the host process cwd. Global lessons therefore always inject; a workspace lesson injects only when the host process runs in that workspace. Keyword and file-type matching are deliberately not implemented — a missed lesson beats a wrongly applied one.
- Conflict detection is a mechanical scan (same scope + opposite polarity + text similarity ≥ 0.4), not semantic understanding: it catches clear opposites and can miss indirect phrasing. A false mark deletes nothing.
- Fact retrieval is keyword matching (substring + terms), not semantic search: rephrasing can miss. It fails loudly instead of guessing — a miss says nothing is recorded. The retrieved text does enter that conversation as a tool result, so the next digest reads it (stage 1 already forbids writing technical conclusions into `self`, and `isSystemFactObservation` keeps system facts out of the profile).
- Self-account promotion still depends on the model obeying the reaffirm rule: the code recognises an `entry_id`, it cannot judge whether two statements are really the same phenomenon. If rows never promote despite enough evidence, suspect the prompt before lowering the threshold.
- Source changes to a `link:`-installed package need a host restart (the loader does not hot-reload linked sources, and the client bundle is served from `lib/client.js` as built).

## If this is useful to you

⭐ **[A star](https://github.com/PaangGaaSam/dsh-persona-memory/stargazers)** is the only upkeep signal this project gets — no telemetry, no usage reporting, nothing phoning home. It is also what tells other people the plugin is worth trying.

- **It did something odd, or you disagree with how the self-account settles?** Open an [issue](https://github.com/PaangGaaSam/dsh-persona-memory/issues) and say what you expected. Behaviour questions are the most useful ones — the evidence thresholds are guesses until someone outside this machine runs them for a month.
- **You installed it and then stopped using it?** That is a genuinely valuable report too. Tell us why; "the daily note was noise" is a design decision worth revisiting.
- **Want to show what it grew into?** A trimmed `profile.md` / `persona.md` makes a great issue. Remove anything personal first — those files are a record of your own conversations.

Pull requests are welcome, and so are plain opinions. If you file one, keep the rule this project runs on: describe what the code actually does.
