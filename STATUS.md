# dsh-persona-memory — 项目状态（交接用）

> 更新时间：2026-11-10 晚。当前版本：**0.2.1**（宿主已加载并实测）。
> compact 后请先读这一份；代码、数据、决策、坑、遗留都在这里。

---

## 0. 一句话

DeepSeek Harness 插件：每天 17:00 跨工作区汇总会话 → 写日报 → 增量维护**用户画像**（profile.md）与**助手性格**（persona.md，按证据累积定型）→ 每轮对话注入 → 自带设置页可看可调。

## 1. 当前状态

- 包：`D:\dsh-persona-memory`；profile `desktop` 以 `link:` 安装（`dsh.profile.bundles` 含 `dsh-persona-memory`）。
- 版本 **0.2.1**；重启后 `GET /persona-memory/status` 的 `status.version` 实测为 `0.2.1`。
- 测试：`node test/run.mjs` → **30 项全过**；`node --check lib/*.js` 全过。
- 设置页已在「设置 → 记忆与画像」实测出现并可操作（配色、通知、置顶、回滚都已人工验证）。
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
