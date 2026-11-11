# dsh-persona-memory — 项目状态（交接用）

> 更新时间：**2026-11-11 12:35**。当前版本：**0.2.8**（46 项测试全过，**待重启生效**）。
> compact 后先读 **§0 → §1 → §20（身份块 + 分区折叠）→ §19 → §18 → §17 → §16（交接速览）**。§2–§11 是 0.2.1 时的基线（数字会旧，结论仍有效），§12–§20 是之后发生的事。

---

## 0. 一句话

DeepSeek Harness 插件：每天 17:00 跨工作区汇总会话 → 写日报 → 增量维护**用户画像**（profile.md）与**我的自述**（persona.md，第一人称、从对话里长出来、按证据累积）→ 每轮对话注入 → 自带设置页可看可调。已发布到 GitHub，收录 PR 在审。

## 1. 当前状态

- 包：`D:\dsh-persona-memory`；profile `desktop` 以 `link:` 安装（`dsh.profile.bundles` 含 `dsh-persona-memory`）。
- 版本 **0.2.8**（0.2.1 → … → 0.2.8，跨 11-10 / 11-11）。**改完代码必须重启桌面端**，然后 `GET /persona-memory/status` 看 `status.version` 是否已变。
- 测试：`node test/run.mjs` → **46 项全过**；`node --check lib/*.js` 全过。
- 0.2.5 已实测：6 个会话 → 18 条 self notes，日报的 `## 我的判断` 正常落盘；但**自述合并失败**（`persona: no JSON object`），已在 0.2.6 修（见 §18）。
- **0.2.6 已实测通过**（18:16–18:26 那轮）：6 会话 → `persona: +5 ~0 ↑0 ↓0 x0 (v3)`，第一次解析就成功、没走重试；日报证据变成 `2026-11-10/session-7b3c4fb6` 等**5 个不同会话**；`persona.md` 出现 5 条第一人称自述。
- **注入段仍然为空**（`我认为我是谁 0 / 我和你相处时的样子 0 / 还没想清楚的 5`）：每条自述只被 1–2 个会话支持、日期只有 1 天，达不到「3 会话 / 再 +3 日期」的门槛。这是设计，不是 bug —— 要等后续几天的对话把同一条自述重复出来。
- 旧台本条目已按用户要求清理：`pstyle-1` + `cand-1…cand-7` 共 8 条从 `persona.md` 删除，`persona.md` v3 → v4（5 条保留），清理前版本已备份为 `history/persona-2026-11-10-1794306528849.md`（3684 B），可在设置页回滚。
- 设置页已在「设置 → 记忆与画像」出现；配色/通知/置顶/回滚已人工验证。**待确认**：下拉框在 0.2.3 修完后是否还渲染异常（见 §16）。
- 系统通知实测可弹；用户已打开 `notifyOnRun`。

## 2. 数据现状（2026-11-10 收尾）

| 项 | 值 |
|---|---|
| `profile.md` | v2，共 9 条：稳定偏好 3 / 沟通习惯 4 / 思维模式 2 / 雷区 0 / 手动锁定 0 |
| `persona.md` | v2，共 8 条：核心性格 0 / 相处风格 1（pstyle-1，3 会话同一天）/ 候选观察 7 |
| `daily/` | 仅 `2026-11-10.md`（2381 B） |
| `history/` | 2 份（profile-2026-11-10-1794293559615、persona-2026-11-10-1794293661112） |
| `state.json` | runs 6 条全 ok；`lastRunDay=2026-11-10`；`lastPersonaRunDay=2026-11-10` |
| `config.json` | `{"notifyOnRun": true}` |
| `logs/run-2026-11-10.jsonl` | 19 KB，含每次 stage 日志 |

注意：`lastPersonaRunDay` 已是今天，所以接下来 7 天内定时任务不会再合并性格；要再看机制效果，用设置页「强制合并性格」或 `persona_digest(force_persona=true)`。

## 3. 代码地图

| 文件 | 职责 | 关键点 |
|---|---|---|
| `lib/index.js` | 插件入口 | `apply()` 注册 6 个工具、注入段、HTTP 路由、60s 定时器 + 45s 启动补跑；`config` 是 `let`，设置页改完即时生效；`runOnce()` 负责锁/状态/记录 |
| `lib/config.js` | 配置 | `DEFAULTS`、`EDITABLE_KEYS`、`resolveConfig`（校验 + scheduleMinutes）、`composeConfig`（DEFAULTS → 补丁行 → config.json）、`loadOverrides`/`saveOverrides`、`publicConfig` |
| `lib/digest.js` | 三段 LLM 管线 | stage1 每会话一卡（`cites` 引用消息号）、stage2 日报、stage3 画像建议、`personaStage`（读近 N 天日报 + 当日卡片）；`callLlm` 带超时；`parseDailyObservations` |
| `lib/profile.js` | 文档解析/合并 | `parseProfile`/`serialize`/`readMeta`；证据 `parseEvidence`/`formatEvidence`/`evidenceStats`；`applySuggestions`（画像）；`applyPersonaSuggestions`（性格升降级 + supersedes + 衰减） |
| `lib/history.js` | 备份与回滚 | `backupDocument`、`listHistory`、`restoreHistory`（回滚前先备份当前，可逆；文件名正则校验防穿越） |
| `lib/http.js` | 回环路由 | `registerRoutes`（7 条）、`readJsonBody`（128KB 上限）、`describeDocument`/`documentsPayload`；全部仅回环，方法不符 405 |
| `lib/state.js` | 调度状态 | `loadState`（去 BOM、解析失败回调）、`saveState`、`recordRun`（含 profile/persona 摘要）、`statusOf`、锁（10 分钟陈旧）、`createLogger`（jsonl 审计） |
| `lib/inject.js` | 注入段 | 预算 1200 字符按 70/30 切分；带 `<!-- persona-memory:do-not-digest -->` 标记防回环 |
| `lib/collector.js` | 采集 | 扫 `$DSH_HOME/sessions/<ws>/<session>/session.v4.jsonl.zstd`；多帧 zstd 按魔数切帧；过滤注入消息与自身标记 |
| `lib/util.js` | 工具 | `readText`（去 BOM）、`writeTextAtomic`、`readJson`、`parseTimeOfDay`、`similarity`（二元组重合）、`todayKey` |
| `lib/client.js` | 设置页（浏览器半侧） | `window.__ModuleLoader__.load` CJS 工厂；注册 `settings.section`（id `persona-memory`，order 60）；轮询 15s 出运行横幅；乐观开关 + 静默保存；样式只用真实主题变量 |

## 4. 关键约定（后续讨论会反复用到）

- **证据 token**：`YYYY-MM-DD/session-<id 前 8 位>`，如 `2026-11-10/session-7b3c4fb6`。多条用 `、` 连接；解析容错 `;`、`,`。日期取自**被引消息的 time**，不是跑批日期。
- **分区与晋升**（`applyPersonaSuggestions`）：一切新观察先落 `候选观察`；`≥personaMinEvidence`（默认 3）个**不同会话** → 相处风格；再叠加 `≥personaCoreMinDates`（默认 3）个**不同日期** → 核心性格。模型给的 `section` 只是提示，落盘由证据裁决。
- **合并/迁移**：跨 core/style/candidate 三区算相似度，≥0.85 视为同一条；命中即合并证据并按计数重新分区（所以能升也能降）。
- **冲突**：模型可给 `supersedes:"<id>"` → 旧条目置信度 −0.3 并退回候选（不删除）；`pinned`/手动锁定豁免。
- **衰减**：`personaDemoteAfterDays`（默认 30）天无新证据 → 退回候选；比较基准是**本次运行日期**。
- **配置优先级**：`DEFAULTS` → 补丁行 `config:` → `persona-memory/config.json`（设置页写的）。删掉 config.json 即回落到补丁行。
- **注入**：prompt section `persona-memory`，order 20，预算 1200（画像 70% / 性格 30%）。
- **路由**（前缀 `/persona-memory/`）：`status`(GET)、`config`(GET/POST)、`run`(POST `{forcePersona}`)、`documents`(GET)、`pin`(POST)、`history`(GET `?doc=`)、`rollback`(POST)。
- **工具**：`persona_digest`、`persona_profile`、`persona_status`、`persona_pin`、`persona_rollback`、`persona_note`。

## 5. 本次会话做了什么

1. **v0.2 设置页落地**：客户端 bundle 注册进宿主设置；7 条回环路由；`config.json` 覆盖；历史回滚；`persona_rollback` 工具；设置页含状态/配置/画像/性格/历史/日报六张卡。
2. **重启验证时挖出并修掉 v0.1 遗留问题**：`state.json` 的 BOM 让调度状态静默清零；置顶会把 frontmatter `version` 冲回 0；模型调用没有超时；启动时不复位 `state.running`。
3. **深色主题白屏**：样式引了不存在的主题变量（`--dsw-alias-bg-l1`/`bg-l2`），兜底 `#fff` → 白字白底。改为真实变量 + 白名单测试。
4. **性格定型机制**（按用户口径重设计）：证据结构化、轮次级时间戳（`cites`）、证据累积晋升、`supersedes` 推翻、30 天衰减、性格阶段回溯近 N 天日报。
5. **运行通知**：运行记录带结果 → 设置页每 15s 轮询出横幅；`notifyOnRun` 另发系统通知；「测试系统通知」按钮。
6. **卡片叠加 bug**：勾选通知会让 draft 清空、表单塌成 0 再重建 → 改为 `keepDraft` + 补稳定 key。
7. **闪烁**：`setNotice(null)`+`setBusy`+复选框等服务端值 → 改乐观更新 + 静默保存。
8. **收尾**：去掉测试通知里的毫秒后缀，版本升到 0.2.1。

## 6. 已修复的坑（现象 → 根因 → 修法）

| 现象 | 根因 | 修法 |
|---|---|---|
| "上次运行"永远空白、`runs` 空、性格永远"到期" | `state.json` 被 PowerShell 写入 BOM，`JSON.parse` 抛错后静默回落默认值 | `readText` 去 BOM；`loadState` 让调用方拿到 corrupt 回调并写 warn |
| 置顶后版本号变 0 | `setPinned`/`appendLockedEntry` 序列化硬编码 `version: 0` | 新增 `readMeta` 从原 frontmatter 继承 `version`/`title` |
| 一次性格合并后所有定时任务停摆 | LLM stream 无超时，`inFlight`/`state.running` 永久为真 | `callLlm` 用 `Promise.race` + `llmTimeoutMs`（180s）；启动复位 `state.running` |
| 设置页按钮"空白"、输入框看不见字 | 引用不存在的主题变量，落到 `#fff` 兜底 | 改用真实变量（`bg-layer-2` / `border-l2` / `state-business-primary`）；测试加白名单 |
| 勾选通知后「计划与模型」卡片叠加，刷新恢复 | 勾选走 `setDraft(null)` 把表单塌成 0 再重建（其它开关只改本地 draft） | 勾选改 `keepDraft: true`；卡片子节点补稳定 key |
| 勾选通知瞬间闪烁 | `setNotice(null)` + `setBusy('save')` + 复选框等服务端回包 | 乐观更新（`notifyChoice`）+ 静默保存（`quiet: true`） |
| 模型把技术事实写成用户特质 | 提示词过松 | 提示词收紧 + `isSystemFactObservation` 过滤 |
| 证据分隔符不一致导致去重失效 | 旧代码只按 `、` 切分，模型用 `;` | `parseEvidence` 容错多种分隔符 |

## 7. 用户拍板的口径（后续别改错）

- **性格靠长期对话定型，第一次投入生产不该定型**；已定性的性格要能被后来的对话风格慢慢修改。
- 相处风格：**≥3 个不同会话**（同一天多个会话可以）；核心性格：**≥3 个不同会话 + ≥3 个不同日期**。
- **周报等积累 3-5 天日报再做**，现在只有一天，做出来是空壳。
- 系统通知的延迟（Windows Toast）**接受**；插件侧只有 1ms，不优化。
- **画像不加晋升门槛**（偏好类不需要跨天累积）。
- 语义冲突依赖模型主动给 `supersedes`；模型不给时矛盾观察会并存，这是当前取舍。

## 8. 边界与限制

- 宿主**不热重载**软链接包源码：改 `lib/*.js`（含 `client.js`）都要**重启桌面端**才生效。
- 页面关闭时**没有任何通知**（宿主没有通知服务可挂；要"关页也通知"需宿主在主进程导出 Notification 桥）。
- 客户端 bundle 必须预构建：手写 `window.__ModuleLoader__.load`，只能 require `react`、`react/jsx-runtime`。
- `daily/` 只有当天文件；单会话字符上限 6000，超长截断。
- 后台页面定时器会被浏览器节流（轮询可能远超 15s）。
- 不要用 PowerShell `Set-Content`/`Out-File` 改 `persona-memory/` 下的 JSON（会加 BOM）；用编辑器或插件自己的接口。

## 9. 下一步（按优先级）

1. 下次重启后确认设置页状态卡显示 `v0.2.1`、测试通知文案无毫秒。
2. 观察 3-5 天：候选能否真的跨天累积到相处风格/核心性格（这是本次机制的唯一未验证部分）。
3. 周报：数据管道已就绪（`daily/*.md`），做一个 `weekly/YYYY-Www.md` + 设置页「本周」卡片；**不要注入每轮上下文**。
4. "关页也通知"：需要 DSH 在 `lib/main.js` 暴露主进程 Notification 桥，属宿主侧需求。
5. v0.3 方向：语义检索召回、周报。

## 10. 验证手册

- 测试：`node test/run.mjs`（应 30 项全过）。
- 状态：`GET http://127.0.0.1:<GUI 端口>/persona-memory/status`（仅回环）→ 看 `status.version`、`runs[]`、`stats`。
- 手动跑：设置页「立即运行」/「强制合并性格」，或工具 `persona_digest(force_persona=true)`。
- 日志：`C:\Users\72970\.dsh\persona-memory\logs\run-YYYY-MM-DD.jsonl`（`persona: +a ~m ↑p ↓d x s` 这一行记录了性格变动）。
- 改完代码：重启桌面端 → 确认 `status.version`。

## 11. 协作约定（本次会话形成）

- 用户偏好极简指令、短确认；回复先给动作与结论，少铺垫。
- 用户会直接照做，所以要主动把不确定与风险讲清楚，不因对方不问而省略。
- 每次改完代码明确说"需不需要重启"，并给出重启后的验证步骤。
- 数据类操作前先看真实状态（`/status`、文件、日志），不凭印象下结论。

## 12. 发布状态（2026-11-10 16:30）

- **GitHub**：<https://github.com/PaangGaaSam/dsh-persona-memory>（public，分支 `main`，首个 commit `982026c`，20 文件）。
  - 已加 topic `dsh-plugin`；About 描述已设；`LICENSE` = MIT；`.gitattributes` 强制 LF。
  - `git remote` 走 SSH：`git@github.com:PaangGaaSam/dsh-persona-memory.git`。
- **打包校验**：`npm pack --dry-run` → 15 files / 39.8 kB，含 `lib/client.js` 与 `cordis.patch.yml`，装下来即可运行、**无需构建步骤**。
- **依赖口径**：peer 从 6 个虚的裁到 3 个——`cordis`、`dsh-tools`（静态 import，必需）、`dsh-llm`（`try/catch` 动态 import 带兜底，标 optional）。范围用 `^0.2.1-rc.1`，否则 `*` 不匹配预发布宿主。
- **dsh-market 收录**：条目 `data/plugins/PaangGaaSam__dsh-persona-memory.yml`，`category: memory`。仓库年龄门槛 1 天 —— 建于 2026-11-10 16:08（UTC+8），故 **2026-11-11 16:08 之后** gate 才会转绿。

### 本机环境坑（复发时照这个绕）

- `~/.ssh/config` 第 8/23 行的 `HostKeyAlgorithms +ssh-rsa,ssh-dss`：新版 OpenSSH 已移除 ssh-dss，遇到不认识的算法会**终止解析整个 config**，portable-git 自带的 ssh 因此全部不可用。绕法：`GIT_SSH_COMMAND='C:/Windows/System32/OpenSSH/ssh.exe -o StrictHostKeyChecking=accept-new'`。根治：两处删掉 `,ssh-dss`。
- workspace-write 沙箱下，任何需要 schannel 证书库或子进程管道的命令都跑不通（`git push`、`ssh`、`curl`、凭据助手 → `SEC_E_NO_CREDENTIALS` / `couldn't create signal pipe, Win32 error 5`）。这类命令要一次性提权到 danger-full-access。
- GitHub 凭据现状：`~/.git-credentials` 里存的是**已失效的旧密码**；GCM 因系统 socks5 代理报 `ServicePointManager 不支持 socks5` 而完全不可用；`~/.ssh` 现已有 `id_ed25519`（2026-11-10 生成并登记到 GitHub）。**push 走 SSH，不要走 HTTPS。**
- `~/.dsh/llm-deepseek` 只有 `files-v3.json`；宿主 `app.asar` **没有** `ctx.llm.embed` / embedding 服务（只有 `ctx.llm.stream`）—— 这是 v0.3 若要上向量必须先解决的问题。

## 13. v0.2.2（2026-11-10 傍晚）——「设置页有标签没控件」修复 + 模型下拉

**根因（最容易重犯的一条）**：`jsx(Field, props, child)` —— React 自动运行时的**第三个参数是 key，不是 children**。所有配置字段都这么写，于是控件被当成 key 丢掉，卡片上只剩标签文本。用户看到「value 看不见」，实际是控件根本没进 DOM；不是配色问题。

- 修法：全部 `jsx(C, props, child)` → `h(C, props, [child])`（`h` 就是把 children 塞进 props 的 `jsxs` 包装）。
- 防线：测试里的假 `jsx`/`jsxs` 现在对「第三个参数是对象/数组」直接抛错；并断言数字输入框 ≥8 个、provider/model 是 `<select>`、选项含已保存的模型、`{days}` 占位符已替换。
- 顺带修：`.pm-input` 不再 `color:inherit` + 白底，改**透明底 + `label-primary` 文字**，杜绝第二类隐形（沿用 0.2.1 那次 `bg-l1` 的教训）。
- 新增 `GET /persona-memory/models`：`ctx.llm.listProviders()` + `listModels()`；提供方/模型变下拉框，目录为空时退回输入框，已保存值永远在选项里。
- 补齐两个此前只有 JSON 能改的键：`personaCoreMinDates`、`personaDemoteAfterDays`。现在 `EDITABLE_KEYS` 全部有对应控件。
- 版本 **0.2.2**；30 项测试全过；**必须重启桌面端**，`status.version` 才会从 0.2.1 变 0.2.2。

验证：重启 → 设置 → 记忆与画像 → 「计划与模型」卡片应有 12 个输入框（其中 2 个是下拉）+ 4 个开关 + 排除工作区文本框；状态卡的三个值应当可见。

## 14. v0.2.3 —— 下拉框跟随配色、字段校验、逐项说明

- **下拉框**：`.pm-select` 设 `color-scheme: inherit`（跟随宿主在 `<html>` 上解析出的 light/dark/system），并显式给 `option` 上 token 配色 + `bg-layer-1` 实底 + `padding-right:26px` 给原生箭头留位。宿主 `dsh-client-ui-theme` 的呈现器本来就会写 `html{color-scheme}`（见 `app.asar` 493527 行），所以 `inherit` 等于「跟应用主题一致」，主题设成 system 时就是跟随系统。**若仍不对，下一步换成自绘下拉**（不依赖原生 popup）。
- **校验**：`validateDraft()` 按字段校验，规则集中在 `FIELDS` 表；错误显示在控件下方、`data-invalid` 变红边、**保存按钮禁用**，`submit()` 里再兜一次（防回车提交）。范围：schedule `^([01]\d|2[0-3]):[0-5]\d$`（与服务端 `parseTimeOfDay` 一致）、temperature 0–2 小数、windowHours 1–168、budget 0–20000、sessionLimit 200–100000、maxSessions 1–100、personaEvery 1–90、evidence 1–20、coreDates 1–20、demote 1–365。
- **说明文字**：每个字段一行 `hint*`，讲清作用与建议值；温度那条明确写了「0–2、摘要建议 0.1–0.3、作用在三段调用（会话卡片/日报/性格合并）」，并在无效时与错误共存展示。
- 12 个字段改为 `FIELDS` 表驱动渲染，新增键只需加一行。
- 版本 **0.2.3**；30 项测试全过（新增：hint 渲染、越界报错、保存被禁用、改正后恢复）；**必须重启桌面端**。

## 15. v0.2.4 —— 证据 token 规范化 +「延续待办」的真实作用

### 修了什么

旧日报里出现 `session-7b3c4fb6-5`（带轮次后缀）和 `c7653975-4416-4523`（裸 uuid 片段）。同一个会话被写成不同 token，`evidenceStats` 会把一场对话算成两个会话 —— **直接绕过晋升门槛**（候选 → 相处风格只需 3 个不同会话）。

- 新增 `canonicalEvidence()`（`lib/profile.js`）：把 `session-<8hex>` 各种写法归一化、去重、`、` 连接；自由文本（`用户口述`）原样保留。
- **两端都做**：`renderDaily` 写盘前规范化（模型回吐什么都不能污染文件）、`parseDailyObservations` 读回来再规范化（旧日报就地修正，不用重写文件）。
- `EVIDENCE_SPLIT` 增加 `·`，容忍模型用中点分隔证据。
- 31 项测试全过，新增「一轮对话不能算两个会话」「旧日报读出来即规范」两组断言。

### 一个尚未处理的发现：`## 延续待办` 是只写不读的死数据

`unresolved` 的完整链路：stage1 卡片 `unresolved`（截 3 条）→ stage2 合并（截 8 条）→ `renderDaily` 写进 `## 延续待办`。**之后没有任何代码读它**：

- `parseDailyObservations` 只认 `## 观察` 段；
- `inject.js` 只拼 `profile.md` + `persona.md`；
- 性格/画像两个 stage 都只吃 `observations`。

所以它目前唯一的消费者是「人眼看设置页」。可选的三种走向见 2026-11-10 与用户的对话：删掉 / 次日喂回 stage2 / 注入上下文；**待用户决定**。

## 16. 交接速览（compact 后先读这一节）

### 今天（2026-11-10）一条时间线

| 版本 | 事 | 状态 |
|---|---|---|
| 0.2.1 | 设置页空白按钮/输入框（用了不存在的 `--dsw-alias-bg-l1`）、通知开关卡片重复与闪烁、状态文案去毫秒 | 已验证 |
| 0.2.2 | 设置页**有标签没控件**：`jsx(Field, props, child)` 把控件当成了 key（React 自动运行时第三个参数是 key）。修法全部改 `h()`；新增 `GET /persona-memory/models` 模型下拉；补 `personaCoreMinDates`/`personaDemoteAfterDays` | 已验证 |
| 0.2.3 | 下拉框 `color-scheme: inherit` + `option` 显式配色；`validateDraft()` 按字段校验（越界红字 + 禁用保存 + submit 兜底）；每个字段加 `hint*` 说明 | **待用户确认下拉框渲染** |
| 0.2.4 | `canonicalEvidence()`：证据 token 两端规范化，避免同一会话被算成两个（会绕过 3 会话晋升门槛） | 待重启 |
| 0.2.5 | 性格层改口径：台本 → 第一人称自述（stage1 新增 `self`、日报新增 `## 我的判断`、注入只放自述、分区标题改名 + aliases） | 待重启 + 待强制合并一次 |

### 发布进度

- 仓库：<https://github.com/PaangGaaSam/dsh-persona-memory>（commit `98e17ef`，中英双 README，底部有求 star / 求反馈段）
- 收录 PR：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13895>（`add-persona-memory` 分支，1 file +6）
- **当前 CI 状态**：`check` ✅ success；`Submission gate` ❌ 唯一原因「repository is 0.0 days old (needs 1)」。官方原文说会自动重跑、不要重新提交。**2026-11-11 16:08（北京）之后**应自行转绿。若没转绿，在 `PaangGaaSam/awesome-dsh-plugin` 的 `add-persona-memory` 分支推一个空提交即可重新触发。
- 用户收到的「Submission gate 全部 job 失败」通知就是这个，已解释过，无需处理。

### 三个未决事项（都有推荐，等用户拍板）

1. **「延续待办」是死数据**（见 §15）：推荐**先不动**，等做周报时一起处理；不建议注入系统提示（与插件「不收任务进度」的设计原则冲突）。
2. **周报**：暂缓，等 `daily/*.md` 攒够 3–5 天。计划 `weekly/YYYY-Www.md` + 设置页「本周」卡片，**不注入**每轮上下文。
3. **向量库 / 知识库**：结论已定 —— 宿主 `app.asar` **没有** `ctx.llm.embed`（只有 `ctx.llm.stream`），上向量必须自备 embedding；建议 v0.3 先做**词法检索**（BM25/字符 bigram），不做向量；**知识库是独立插件**，不与性格绑定，只共用 `date/session-<id8>` 证据 token 作坐标系。

### 操作约束（会重复踩的）

- **改任何 `lib/*.js` 都要重启桌面端**，`status.version` 才会变。
- `git push` 必须在 danger-full-access 下、且指定系统 ssh：`GIT_SSH_COMMAND='C:/Windows/System32/OpenSSH/ssh.exe -o StrictHostKeyChecking=accept-new'`。见 §12 环境坑。
- 不要用 PowerShell `Set-Content`/`Out-File` 写 `~/.dsh/persona-memory/` 下的 JSON（会加 BOM，历史上把调度状态清空过）。
- 沙箱 workspace-write 下跑不了 schannel/子进程相关的命令（curl、ssh、git push、凭据助手），这几类要一次性提权。
- 测试里的假 `jsx` 会对「第三个参数是对象」直接抛错 —— 这是防 0.2.2 那个 bug 复发的护栏，别把它删了。

### 验证 0.2.4 的步骤

1. 重启桌面端 → 设置 → 记忆与画像 → 状态卡应显示 `v0.2.4`。
2. 「计划与模型」应有 12 个输入框（2 个下拉）+ 4 个开关 + 1 个多行文本框，每个字段下面有一行灰字说明。
3. 把温度填成 `9` → 应该红框 + 「范围 0–2」+ 保存按钮变灰。
4. 看「最新日报」那段：`观察` 里的证据应是 `2026-11-10/session-xxxx` 形式（旧文件读取时已规范化）。

## 17. v0.2.5 —— 性格层从「第三人称台本」改成「第一人称自述」

### 为什么改

原来 `persona.md` 的记录方式本质是**给演员的台本**：「助手应保持简洁」「助手在这份信任下仍保持边界」。它是被一个预设的角色规范驱动的，一旦写入就机械执行，而且用户没法定义「我是谁」——那段文字的来源是模型对用户的观察，不是助手自己的判断。

新的口径：**身份从对话里长出来，是助手自己认为「我是谁」**，每条带具体来历（哪件事 → 我当时怎么想 → 所以现在倾向怎么做），并且能被后来的对话推翻。判断标准只有一条：注入进提示词的那段文字如果读起来像台本，就是没做到。

### 五处改动（互相咬合，缺一条就漏）

| # | 位置 | 改了什么 |
|---|---|---|
| 1 | `lib/digest.js` `STAGE1_SYSTEM` | 从「排除一切关于助手的内容」改成「排除技术结论，保留我自己的判断」；新增独立字段 `self: [{event, judgment, confidence, cites}]` |
| 2 | `lib/digest.js` `parseCard` | `self` 单独解析成 `card.self`，**绝不混进 `card.observations`**（后者是 stage3 画像的输入，混进去会污染用户画像）；`judgment` 为空的行丢弃 |
| 3 | `lib/digest.js` `PERSONA_SYSTEM` | 整段重写：第一人称自述三段式、禁第三人称规范句、禁语气/幽默度/称呼这类可表演形容词、必须有可追溯事件、鼓励 `supersedes`、旧台本不要沿用措辞 |
| 4 | `lib/digest.js` `renderDaily` + `personaStage` | 日报新增 `## 我的判断` 区（**卡片原文直写，不经 stage2**，防模型把第一人称改回台本）；`parseDailyObservations` 读回该区（`kind:'self'`，拆出 event/judgment）；`personaStage` 只拿 self 当材料、把用户观察降级为「现场背景」；**没有 self 就整段跳过**（否则模型会在真空里编造身份） |
| 5 | `lib/profile.js` + `lib/inject.js` | 新增 `renderPersonaInjection()`：标题 `## 我是谁（这些是从对话里长出来的，不是设定）`、行格式 `- <自述原文>`、无 `[分区]` 标签、无证据 token、**候选区永不注入**；`isSelfNarrative()` 是代码闸门（无「我」或仍带 `助手应…` 的条目留在文件里、永不进提示词）；分区标题改名 + `aliases` 兼容读数 |

分区标题：`核心性格 → 我认为我是谁`、`相处风格 → 我和你相处时的样子`、`候选观察 → 还没想清楚的`。`parseProfile` 先精确匹配新名、再匹配 `aliases` 里的旧名，`serialize` 只写新名 —— 所以旧文档读得出来、下次写盘自动迁移，`version` 不重置。`用户固定规则` 区保留原样但**不再注入**（`appendLockedEntry` 只挂画像，persona 的这个区实际是空的）。

### 已知的行为变化（不是 bug）

1. **性格层会先静默一段时间。** 现有 `persona.md` 的 8 条**全是台本**（`pstyle-1` 写着「助手保持直接、简洁的回应」），所以升级后注入段变空 —— 实测 `node test/inspect-injection.mjs` 输出 `(empty — nothing qualifies yet)`。这不是坏了：旧台本停止驱动行为，等新的 `## 我的判断 → 自述` 攒够 3 会话 / 3 日期才重新出现。设置页性格卡片已加一行说明。
2. **首次强制合并大概率只出少量条目。** 历史日报里没有 `## 我的判断` 区，所以跨天证据从今天才开始累积；`personaStage` 在没有 self 时的日志是 `persona: no self judgments recorded yet, skipped`（不更新 `lastPersonaRunDay`，下次还会重试）。
3. **`lastPersonaRunDay` 已是 11-10**，定时任务 7 天内不会再合并性格；要验证必须用设置页「强制合并性格」或 `persona_digest(force_persona=true)`。

### 测试

37 项全过（新增 6）：`self` 不进画像建议 / `## 我的判断` 能被 `parseDailyObservations` 读回且 3 天 = 3 会话 3 日期 / 无证据时不编造证据 token / 无事件的自述留候选且不注入 / 第三人称台本永不进提示词 / 标题改名不丢条目且不重置 version。`test/inspect-injection.mjs` 是手动工具：`node test/inspect-injection.mjs [persona.md] [budget]`，直接打印注入段并自检四类违禁内容。

### 验证步骤（0.2.5）

1. 重启桌面端 → 状态卡应显示 `v0.2.5`。
2. 设置 → 记忆与画像 → 性格卡片应出现两行灰字说明，「核心性格」分区标题变成「我认为我是谁」（**点一次「强制合并性格」写盘后才会变**，之前靠 aliases 照常读出）。
3. 点「强制合并性格」→ 日志应出现 `stage1 ... N self notes`；`persona.md` 里新条目必须是第一人称且带事件，`## 还没想清楚的` 里可能出现拿不出证据的描述。
4. `node test/inspect-injection.mjs` → 注入段不应出现「助手应 / 助手保持」，也不应出现 `[分区]` 标签或 `证据：`。
5. 同日再跑一次：`daily/2026-11-10.md` 里应已有 `## 我的判断` 区，跨天证据能接着累积。

## 18. v0.2.6 —— 0.2.5 首次实跑暴露的两个真 bug

0.2.5 重启后用户点了「强制合并性格」，整轮 12 分钟跑完。结果一半好一半坏，暴露两个必须修的 bug。

### 好消息（说明 0.2.5 的主链路是通的）

- 6 个会话 → 6 张卡，**18 条 self notes**（`stage1 ... 2 observations, 3 self notes` 每场都有）。
- `daily/2026-11-10.md` 的 `## 我的判断` 区正常落盘，是真正的「事件 → 我的判断」第一人称文本，例如"用户要求安装 dsh-market，我先探索桌面端环境，发现沙箱阻止写入 profile 后升级权限重试安装。→ 我判断这次安装需要突破沙箱写限制……"。
- 画像 v2 → v3（+12）。`persona.md` 未改动（合并失败），注入段仍为空（预期）。

### bug 1：证据 token 全变成 `session-session-`（严重，跨天证据根本不可能累积）

`sessionKey()` 原本是 `session-${id.slice(0,8)}`。但**宿主给的 `session.id` 本身就以 `session-` 开头**（`session-7b3c4fb6-56bc-4ea7-ac4f-…`），于是得到 `session-` + `session-` = `session-session-` —— 一天里所有会话共用同一个 token，`evidenceStats` 永远只算 1 个会话。

这个 bug 一直在，只是被掩盖了：观察的证据通常走「模型把证据回吐」这条路（模型从提示里的会话号自己写 token），而我这次让 self 直接走 `cites` → `sessionKey()`，才把它暴露出来。旧的单元测试用的是裸 uuid（`abcd1234-ef56`），从来没覆盖过真实格式。

修法：先剥掉已有的 `session-`/`session_` 前缀，再取前 8 位十六进制；非十六进制的退化为前 8 个字符。旧的坏 token 信息已丢失（uuid 被截掉了），只能靠下一次运行重写今日日报自愈。

### bug 2：自述合并 `persona: no JSON object`

`parsePersonaJSON` 失败后整个 stage 抛错，文件不动、`personaResult` 为 null —— 从报告里看只像"没新条目"，根本看不出是失败。而且没有重试，白白浪费了一整轮 12 分钟的 digest。

0.2.6 的处置：
- `extractJson()` 重写：先整体 `JSON.parse`，再扫描候选 `{`/`[`；**某个跨度解析失败不再 `break`**（原来会因此丢掉后面完整的 JSON），并新增 `repairJson()` 兜底：转义字符串里的裸换行/制表符、去掉尾逗号。这是「模型把长中文写进字符串时最常见的两种破法」。
- `PERSONA_SYSTEM` 输出收紧：**最多 5 条、每条不超过 80 字**，并禁止在 JSON 字符串里换行、禁止未转义引号。
- `personaStage` 失败重试一次（`persona#1` / `persona#2`），两次都失败才抛错。
- 失败时把**原始输出**写进日志（`persona raw (attempt N): …`），下次不用猜。
- `runDigest` 把错误存进 `personaResult.error`，`formatReport` 显示「自述：合并失败（原因），文件未改动，原始输出已写进日志」。沉默的 null 才是最坏的情况。

### 测试

39 项全过（新增 2）：`sessionKey` 对真实 `session-<uuid>` 不再产出 `session-session-`、两个不同会话得到两个不同 token；`extractJson` 能修复字符串里的裸换行、尾逗号，并在前面有坏对象时仍找到后面的好 JSON。

### 验证步骤（0.2.6）

1. 重启桌面端 → 状态卡应显示 `v0.2.6`。
2. 设置 → 记忆与画像 → 再点一次「强制合并性格」。
3. 跑完看三处：日志有 `persona: +N ~M …`（不是 `persona failed`）；`daily/2026-11-10.md` 的 `## 我的判断` 证据应变成 `2026-11-10/session-xxxxxxxx`（不再是 `session-session-`）；`persona.md` 出现第一人称条目。
4. `node test/inspect-injection.mjs` → 应看到「## 我是谁（…）」段，且自检三项都是 none。

### 0.2.6 实测结果（已通过）

18:16 重启 → 18:16–18:26 跑完（10 分钟，6 会话）：

```
stage1 … 4 observations, 4 self notes   （6 场各 1–4 条）
stage2: 6 summary lines
stage3: 8 suggestions → profile: +8 ~0 (v4)
persona: +5 ~0 ↑0 ↓0 x0 (v3)          ← 第一次就解析成功，没走重试
```

- 证据已修好：日报 `## 我的判断` 里的 token 是 `2026-11-10/session-7b3c4fb6`、`session-c7653975`、`session-251aa32e`、`session-8034214a`、`session-92537183`、`session-d3196a7c` —— **5 个不同会话**，其中一条自述挂了 3 个会话。
- 5 条新自述全在「还没想清楚的」：每条 1–2 个会话 + 1 个日期，不够 3 会话。**这是门槛在正常工作**，不是漏晋升。
- 注入段仍为空，符合预期（候选不注入；旧台本已被 `isSelfNarrative` 挡掉）。
- 之后按用户要求清掉了 8 条旧台本（`pstyle-1` + `cand-1…7`），`persona.md` → v4（仅剩 5 条自述），备份 `history/persona-2026-11-10-1794306528849.md`。

**下一步（等时间，不是等代码）**：明后天定时任务继续攒；同一条自述在 ≥3 个不同会话复现 → 晋「我和你相处时的样子」，跨到 3 个不同日期 → 晋「我认为我是谁」。届时注入段才会第一次非空。

## 19. v0.2.7 —— 设置页与文档对齐「自述」口径

用户问「设置页需不需要改 / README 更新了吗」。答案：设置页需要，README 只差几处按钮名。

### 设置页改了什么

| 项 | 之前 | 现在 |
|---|---|---|
| **死区** | 性格卡片里有「用户固定规则」区，从没有任何写入路径（`appendLockedEntry` 只挂画像）、也不注入、永远显示 `（空）` | 从 `PERSONA_SECTIONS` 删除（只剩 core/style/candidate）。旧文档里的该标题被忽略，不删文件；用户自己的规则属于画像的「手动锁定 / 雷区」 |
| **注入现状** | 卡片只显示每个区几条，看不出文件里 5 条、提示词里 0 条 | 性格卡片顶部新增「当前注入：N 条（约 C 字符）」；为 0 时显示「当前注入为空 —— 还没有自述满足 ≥{s} 个不同会话；『还没想清楚的』不参与注入」；预算 0 或关闭维护时显示「注入已关闭」。数据来自 `GET /status` 新增的 `documents.persona.injected`（由 `personaInjection()` 用**同一个** `renderPersonaInjection` 算出，不会和真实注入漂移） |
| **术语** | 同一张卡片里「我认为我是谁 · 0 条」和「晋升『核心性格』…」两套名字并存 | 5 处文案统一：`personaCoreDates` 标签、`hintPersonaEvidence/Core/Demote`、`personaRule`、`hintTemperature`；卡片标题「助手性格 → 我的自述」，按钮「强制合并性格 → 强制合并自述」 |

新增测试 2 项（共 41）：`documentsPayload` 的 `injected` 在「候选不注入 / 预算 0」两种情况下分别是 `{enabled:true,count:0}` 与 `{enabled:false}`、晋升到 style 后计数变 1；`PERSONA_SECTIONS` 不再有 locked、旧标题被忽略且 `appendLockedEntry` 对 persona 返回未改动。

### README 改了什么

之前那句「README 有更新吗」的答案是：**0.2.5 时已更新**（第一人称、`## 我的判断`、新分区名、候选永不注入、证据规范化），这次补的是 **0.2.6/0.2.7 之后才对得上的部分**：

- 设置页段落：说明「我的自述」卡片会显示当前注入条数、为空时给出原因；按钮名改成「强制合并自述」；日期门槛的说法改成「『我认为我是谁』的日期门槛」。
- 明确写入 `persona.md` **没有用户锁定区**（身份不由用户定义，用户规则走画像），旧 `## 用户固定规则` 会被忽略。
- 运行通知段落：自述合并失败时横幅给原因（文件不动、原文进日志），不再看起来像「没有新条目」。
- 工具表：`persona_digest` / `persona_profile` 的说明改成自述。

中英两份同步。**README 里没有写版本号**，所以 0.2.6/0.2.7 的补丁级修复（`sessionKey`、`extractJson`）不进 README —— 那些是内部实现，用户可见的只有「证据 token 正确」和「失败会说话」。

### 验证步骤（0.2.7）

1. 重启 → 状态卡 `v0.2.7`。
2. 设置 → 记忆与画像 → 性格卡片标题应为「我的自述」，**没有**「用户固定规则」区，顶部三行灰字分别是：证据累积（新术语）、当前注入为空、注入规则。
3. 「计划与模型」里那条日期门槛应显示「『我认为我是谁』最少日期数」。
4. 跑一次「立即运行」或等明晚定时任务；注入数会在某条自述拿到 3 个会话后从 0 变正数。

## 20. v0.2.8 —— 画像分区折叠 + 身份块（画像的派生视图）

用户提了两件事：设置页画像每区只显示 3 条（可展开），以及一个「身份块」。第二件被明确要求**不要做成新功能** —— 它是读 `profile.md` 生成的一段描述，不开采集、不开合并链、不做自己的证据计数。这一点决定了整个实现形态。

### 一、画像分区折叠（只动 profile 文档）

- `describeDocument(text, doc, { limit, sort })`：`limit` 交给面板决定哪些区可折；`sort` 按**置顶 → 最后验证时间（新在前）→ 置信度**排序。`documentsPayload` 对 profile 传 `{ limit: 3, sort: true }`，persona 不传 —— persona 的显示完全没动。
- **置顶优先是硬要求**：否则被折叠的条目永远看不到、也就永远置顶不了。`limit` 只给非 `userLocked` 区，所以「手动锁定」全区展开。
- 面板：每区前 3 条 + 底部「展开全部（N）」/「收起」；总数 ≤3 时不出现那一行。展开状态存在一个 `{ 'doc:section': true }` 的对象里，30 秒轮询刷新不会把用户展开的区收回去。
- 排序在服务端，面板只做截断 —— 只有一份排序实现，和测试断言用的是同一份。

### 二、身份块

新增 `lib/identity.js` + `paths.identityFile` → `~/.dsh/persona-memory/identity.json`：

```json
{"profileVersion":4,"profileUpdatedAt":"…","generatedAt":"…","used":24,"excluded":5,
 "fields":{"role":{"text":"…","basis":["pref-1"]}, …五个字段}}
```

- **输入过滤**：只喂 `pinned || confidence ≥ 0.7` 的条目（`pinned` 含手动锁定，无条件计入），被滤掉的计入 `excluded`，面板显示「另有 N 条低于阈值未计入」。真实画像实测 v4 → used 24 / excluded 5。
- **版本没变不调 LLM**：`identityIsStale(cache, version)` 比 `profile.md` frontmatter 的 `version`。日更里绝大多数天画像不变，这条是硬要求，测试用 mock 计数断言「第二次调用次数仍是 1」。
- **永不写回画像、永不注入**：`generateIdentity` 只读 `profile.md`，写的是 `identity.json`；`lib/inject.js` 一行没动。测试对比 `profile.md` 的**字节**在生成前后完全一致，并断言 `buildSectionText()` 里不含身份块文本。
- **只提供重新生成**：`POST /persona-memory/identity/refresh` → `ensureIdentity(..., { force: true })`，没有写 text 的接口；GET 返回 405。失败保留上一次缓存（测试断言文件字节不变）。
- 提示词要求**足量外推**（从「在意权限边界 + 要求来源 + 先讲清再动手」直接落到「大概率在做运维或平台工程这类会被事故追责的活」），主行只写判断句、依据只进 `basis`；禁止第三人称评价和敏感属性（健康/宗教/政治/性取向/经济/婚恋）。
- `basis` 里不在本次候选 id 范围内的会被丢掉（模型编 id 不会污染面板）。

### 顺手做的重构

`callLlm` 移到 `lib/llm.js`，`digest.js` 保留 `export { callLlm }`（测试和老调用点都不用改）。原因：`identity.js` 需要它，而 `digest.js` 反过来要 import `identity.js`，不拆就是循环依赖。

`extractJson` 仍在 `digest.js`，`identity.js` 直接从那 import —— 这是一条**单向**引用（digest → identity → digest 才成环；identity → digest 只是借用函数），Node 的 ESM 能处理，但改动时要留意别让 identity 在模块顶层调用 digest 的东西。

### 测试（46 项，新增 5）

1. 分区预览：`total/limit`、置顶排最前、其余按验证时间再按置信度、手动锁定区 `limit: 0`、persona 一律 `limit: 0`。
2. 身份块输入：`used/excluded` 计数、锁定区计入、低于阈值被滤、置顶后豁免。
3. `parseIdentity`：未知 basis id 被丢、全空视为失败（不覆盖旧缓存）。
4. `ensureIdentity`：版本未变时**不调模型**（计数不变）、版本变了才重算、失败保留旧缓存。
5. 身份块不写回画像（字节比较）且不进注入；面板折叠/展开/收起、依据折叠、无缓存显示「尚未生成」；路由 405/403/200。

### 验证步骤（0.2.8）

1. 重启 → 状态卡 `v0.2.8`。
2. 设置 → 记忆与画像 → 「用户画像」卡片：稳定偏好（10 条）只显示 3 条 + 「展开全部（10）」，沟通习惯、思维模式同理；雷区只有 3 条，**没有**展开按钮；「手动锁定」不折。
3. 「身份块」卡片：现在是「尚未生成」；点「重新生成」→ 五个字段出结果、「依据（N）」点开能看到引用的原文、「另有 5 条低于阈值未计入」。
4. 跑完一次日更后 `identity.json` 出现，`profile.md` 的字节不变；第二次运行日志里没有新的 `identity: generated`（版本没变会走缓存）。
