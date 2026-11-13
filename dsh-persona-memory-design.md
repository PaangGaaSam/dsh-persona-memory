# dsh-persona-memory 设计文档（v0.1 草案）

> 目标：每天定时跨工作区、跨会话总结当天内容 → 沉淀到同一份记忆 → 提炼用户的沟通习惯与思维模式 → 每轮对话自动注入，让回复更贴合用户。
>
> 状态：草案，待确认关键决策后开工。目标宿主：DeepSeek Harness 0.2.1-rc.5（桌面端，Node 24.21）。

---

## 1. 需求映射

| 需求 | 设计落点 |
|---|---|
| 每天定时 | 插件内置每日调度器（默认 23:30，可配），宿主在线才触发，支持启动补跑 |
| 跨工作区、跨会话 | 直接读 `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，天然覆盖所有工作区 |
| 总结当天内容 | 两段式 LLM 管线：会话抽取卡 → 当日摘要 |
| 统一记忆 | `$DSH_HOME/persona-memory/` 下单一 `profile.md` + `daily/` 日志，跨工作区共享 |
| 提炼语言习惯/思维模式 | 画像更新阶段：从当日观察 → 候选条目 → 合并进 profile 的固定分区 |
| 自动贴合沟通 | `ctx.systemPrompt.section()` 每轮注入 profile 摘要（字符预算、pinned 优先） |

**非目标（v0.1 不做）**：语义向量检索、多用户/多租户、Web 设置面板、主动消息推送、修改过去会话。

---

## 2. 设计原则

1. **本地优先**：所有记忆是 `~/.dsh/persona-memory/` 下的纯文本，可读、可改、可删、可 git。
2. **证据链**：画像里每一条观察都必须带出处（日期 + 会话 id + 置信度），不允许"无源之水"。
3. **增量画像**：每天只做"建议 + 合并"，不整篇重写；旧版本全部归档。
4. **预算可控**：注入段有硬预算（默认 1200 字符），超限截断而非撑爆上下文。
5. **失败不崩**：解析失败跳过、LLM 失败保留抽取卡、写盘失败先备份。
6. **可审计**：每次运行写一份 run 日志（读了多少会话、token 估算、写入哪些条目）。

---

## 3. 架构总览

```
┌────────────────────────────────────────────────────────────────┐
│ 定时器(每日 23:30) / persona_digest 工具 / 启动补跑              │
└───────────────────────────┬────────────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ 采集器 collector                                                │
│  · 扫描 ~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd
│  · 逐帧 zstd 解码（多帧文件，Node 24 zlib.zstdDecompressSync 逐帧可用）
│  · 按 [窗口开始, now] 过滤、排除自身摘要会话、排除空会话
│  · 抽取 user/message、assistant/message 文本（丢弃工具结果与 reasoning）
└───────────────────────────┬────────────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ 抽取 stage-1（每会话一张卡）                                     │
│  { sessionId, workspace, 主题, 用户核心诉求, 纠正/偏好观察, 未完成 }
└───────────────────────────┬────────────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ 合并 stage-2（当日）→ daily/YYYY-MM-DD.md                        │
│  { 今日摘要, 观察列表[], 待办延续[] }                             │
└───────────────────────────┬────────────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ 画像 stage-3（LLM 输出 JSON 建议 → 确定性合并进 profile.md）      │
│  · 分区：稳定偏好 / 沟通习惯 / 思维模式 / 雷区 / 手动锁定          │
│  · 去重、置信度、证据、pinned、历史版本                            │
└───────────┬────────────────────────────────────────┬───────────┘
            ▼                                        ▼
   ctx.systemPrompt.section          persona_profile / persona_pin
   （每轮注入 1200 字符预算）          / persona_rollback 工具
```

---

## 4. 数据源与采集

### 4.1 实测格式（2026-11-10 验证）

- 目录：`C:\Users\72970\.dsh\sessions\<workspace 转义名>\<session-id>\session.v4.jsonl.zstd`
  - workspace 目录名即工作区路径的转义（如 `--C-Users-72970-Documents-deepseek-harness-default-workspace--`）。
- 文件：**多个 zstd 帧首尾相接**（实测 119 帧 / 2.8MB 解压内容），Node 的 `zlib.zstdDecompressSync` 对每个帧单独解压即可；不能一次性解压整个文件（只解第一帧）。
- 记录（JSONL，每行一条）：`{ type, seq, time, data, ... }`
  - `session`：id、createdAt、cwd、agentPreset
  - `user/message`：`data.content[].text`；`data.source.kind`（`user` 为真人输入）
  - `assistant/message`：`data.message.content[]`（`text` / `reasoning`）
  - `system/message`、`turn/start|end`、`tool/call|result`、`session/title` 等
- `time` 为毫秒时间戳；`seq` 单调递增。

### 4.2 采集规则

| 规则 | 说明 |
|---|---|
| 时间窗口 | 默认 `[昨天 00:00, 今天 23:30)`，按 `time` 过滤；可配 |
| 排除自身 | 摘要任务自己的会话（按 session id 黑名单 + 会话标题前缀排除），防止递归自我总结 |
| 跳过注入消息 | `user/message` 中 `Current runtime context.` 开头、压缩摘要、提醒注入等非用户原话；用 `source.kind` + 前缀启发式过滤 |
| 最小会话 | 真人 `user/message` < 1 条的会话跳过（只有系统注入的会话无信息量） |
| 截断 | 单会话纳入 LLM 的字符数上限（默认 6000），超长按"首 2 条 + 末 N 条"采样，保留原始用户诉求与最新纠正 |
| 丢弃内容 | 工具结果全文、reasoning、附件二进制 |

### 4.3 隐私红线（采集层）

- 不采集 `assistant/message` 里的 reasoning（只取正文）。
- 命中黑名单模式的内容（`.env`、`api_key`、`sk-`、`BEGIN PRIVATE KEY`、身份证/手机号等）在写入 LLM 输入前替换为 `[REDACTED]`。
- 采集只在内存进行，除画像结论外不落盘原文。

---

## 5. 摘要与画像管线

### 5.1 stage-1 会话抽取卡（LLM 调用 1 次/会话，或合并为 1 次批量调用）

输入：该会话裁剪后的对话文本（带说话人标记）。
输出 JSON：

```json
{
  "sessionId": "session-…",
  "workspace": "C:\\…",
  "topic": "一句话主题",
  "userNeeds": ["用户的核心诉求/目标（≤3 条）"],
  "observations": [
    { "kind": "preference|style|thinking|correction|friction",
      "text": "观察到的事实，一句话",
      "confidence": 0.0 }
  ],
  "unresolved": ["未完成/待跟进（≤3 条）"]
}
```

`kind` 含义：
- `preference`：稳定偏好（工具、流程、格式、技术选型）
- `style`：语言/沟通风格（长短句、语气、结论先行、喜欢表格、讨厌客套……）
- `thinking`：思维模式（先验证再动手、爱先问边界、喜欢类比、坚持最小改动……）
- `correction`：用户纠正/否定的做法（雷区候选）
- `friction`：明显卡点（反复澄清、反复不满）

### 5.2 stage-2 当日合并（LLM 调用 1 次）

输入：全部抽取卡（JSON 数组，超长分批）。
输出 `daily/YYYY-MM-DD.md`：

```markdown
# 2026-11-10

## 今日摘要
- …

## 观察
- [style] 习惯先要结论后要细节（证据：session-… · 0.8）
- [correction] 不接受在没确认前大改文件（证据：session-… · 0.9）

## 延续待办
- …
```

### 5.3 stage-3 画像更新（LLM 调用 1 次）

输入：当日观察 + 现有 `profile.md`（含 pinned 与手动锁定区）。
输出 **JSON 建议**（不是直接改文件）：

```json
{
  "add":    [ { "section": "style", "text": "…", "evidence": "2026-11-10/session-…", "confidence": 0.8 } ],
  "merge":  [ { "id": "style-3", "addEvidence": "2026-11-10/session-…", "confidence": 0.9 } ],
  "demote": [ { "id": "style-7", "reason": "连续 30 天无新证据" } ],
  "remove": [ { "id": "thinking-2", "reason": "与用户明确纠正冲突" } ]
}
```

插件做**确定性合并**（去重、置信度加权、冲突检测、证据追加），再写 `profile.md`。合并规则见 §7。

### 5.4 LLM 调用参数

| 项 | 值 |
|---|---|
| 模型 | 沿用宿主默认（`deepseek-account` → `deepseek-flash`），可在配置覆盖 |
| 温度 | 0.2（抽取/画像偏稳定） |
| 输入预算 | 单次 ≤ 60k 字符（超长分批） |
| 输出预算 | ≤ 4k token |
| 重试 | 2 次指数退避；连续失败 → 当日只落抽取卡，次日补做 |
| 失败降级 | LLM 不可用时当天写"仅采集"日志，不写画像 |

---

## 6. 画像文件格式（profile.md）

```markdown
---
version: 12
updatedAt: 2026-11-10T23:30:00+08:00
budgetChars: 1200
---

<!-- user-locked: 本区由用户手动维护，自动流程只读，不修改 -->
## 手动锁定
- [P] 回复尽量用中文，不要用「您」。
<!-- /user-locked -->

## 稳定偏好
- [pref-1][P1][置信度 0.9][最后验证 2026-11-09] 喜欢最小改动，先给方案再动手（证据：10-08 session-a、11-09 session-b）

## 沟通习惯
- [style-3][P1][置信度 0.8][最后验证 2026-11-10] 习惯先给结论，再展开细节（证据：11-10 session-c）

## 思维模式
- [think-2][置信度 0.6][最后验证 2026-10-21] 倾向先要可运行的最小版本（证据：10-21 session-d）

## 雷区
- [avoid-1][P1][置信度 0.95][最后验证 2026-11-10] 不要在没确认前批量改文件（证据：11-10 session-e）
```

条目字段：`id`、优先级 `P0/P1`（P0=锁定，不自动删）、置信度、最后验证时间、证据列表（最多保留 5 条，滚动）。
预算：注入时按 `budgetChars` 截断——先 P0，再 P1，然后按最后验证时间倒序。

### 6.1 性格层（v0.2，见 §20）

画像回答"用户是谁、怎么沟通更顺"；性格层回答"和这个人相处时，我是谁"。它是第二个文件 `persona.md`，同样带证据、版本与 pin，合并频率更低（默认每周），并多一道"≥3 条独立证据"的晋升门槛。

---

## 7. 合并与防漂移

1. **同分区去重**：文本归一化（去标点/空白）后相似度 > 0.85 视为同一条 → 追加证据、置信度取 `1-(1-a)(1-b)`。
2. **冲突检测**：新条目与同分区旧条目文本近似但语义相反（LLM 判定，低成本）→ 标记 `conflict`，旧条目降置信度，人工可见。
3. **置信度衰减**：30 天无新证据且非 P0 → 每次衰减 0.05；< 0.3 移入 `archive` 分区（不再注入）。
4. **P0 保护**：用户 pin 的条目永不被自动删除；只能通过 `persona_unpin` 或手改文件解除。
5. **用户区分保护**：`<!-- user-locked -->` 区逐字节保留（参考 dsh-plugin-memory / pi-mentis 的做法）。
6. **每次写盘**：先写 `history/profile-YYYY-MM-DD-HHMM.md.bak`，再原子替换；失败回滚。
7. **审计**：`logs/run-YYYY-MM-DD.jsonl` 记录本次输入会话数、LLM 调用、增删改条目 diff。

---

## 8. 注入

- `ctx.systemPrompt.section({ id: 'persona-memory', order: 40, text })`（order 参考：身份 -100 / persona 0 / 本项目 40）。
- 每轮渲染：`## 与用户协作的已知偏好` + 截断后的 profile 条目。
- 递归保护：注入文本带固定标记，采集器识别该标记并剔除，防止"画像→上下文→画像"回环。
- 注入内容变化才触发重新渲染（缓存友好）。

---

## 9. 调度

- 默认每日 **23:30（Asia/Shanghai，跟随系统时区）**；配置可改时间或 cron。
- 触发条件：宿主进程在线（插件常驻即可）；`state.json.lastRunDay < today` 时在启动后 60 秒内补跑。
- 幂等：一天最多一次自动运行（按 `lastRunDay` + 运行锁文件）；手动 `/digest` 强制重跑但不重复写当天条目（覆盖式重生成 daily，画像按增量合并）。
- 并发锁：`state.json` 写锁 + 运行中标记，超时 10 分钟自动释放。
- 补跑上限：启动时最多补 3 天（避免久未开机的 LLM 集中消耗）。

---

## 10. 存储布局

```
$DSH_HOME/persona-memory/
├── profile.md                     # 画像（唯一事实源）
├── daily/2026-11-10.md            # 每日摘要
├── history/                       # 每次写盘前的备份
├── archive/                       # 衰减/删除的条目归档
├── state.json                     # lastRunDay、运行状态、版本
├── run/                           # 抽取卡与 LLM 原始输出（可关）
└── logs/run-2026-11-10.jsonl      # 运行审计
```

---

## 11. 工具与命令（面向模型）

| 名称 | 作用 |
|---|---|
| `persona_digest` | 立即运行一次摘要+画像更新（参数：days=1，force） |
| `persona_profile` | 读取当前画像（可指定分区） |
| `persona_pin` / `persona_unpin` | 置顶/取消置顶某条目，自动流程不再动它 |
| `persona_rollback` | 回滚到指定历史版本（参数：version 或日期） |
| `persona_note` | 用户口述一条偏好/雷区，立即写入（用户区分） |

斜杠命令 `/digest`、`/profile`：若宿主支持命令注册则提供；否则只保留工具（v0.1 先工具）。

---

## 12. 隐私与安全

- 所有数据在本地 `~/.dsh/persona-memory/`，不上传；卸载插件不删数据（文档提供清理命令）。
- 会话内容会发给 LLM（与正常对话同一链路，不额外引入第三方）。
- 采集前做敏感模式替换（见 §4.3）；画像只写"结论"，不写原文、不写密钥。
- 可配置 `excludeWorkspaces`（某些工作区不参与总结）与 `excludeKeywords`。
- 运行日志不含对话原文，只含计数与文件路径。

---

## 13. 失败与降级

| 失败 | 处理 |
|---|---|
| zstd 帧解析失败 | 跳过该会话并记录；不中断整体 |
| LLM 调用失败 | 重试 2 次；仍失败则保留抽取卡，次日合并时纳入 |
| 写盘失败 | 先备份旧文件；失败则丢弃本次（原文件不动） |
| 画像合并冲突 | 标记 conflict，保留双方，置信度低者优先降级 |
| 数据目录被删 | 自动重建空画像（注入段为空，不报错） |

---

## 14. 配置示例

```yaml
- id: persona-memory
  name: dsh-persona-memory
  config:
    schedule: "17:00"          # 每日运行时间（HH:mm，本地时区），可在设置页改
    catchUpDays: 3             # 启动补跑最多几天
    windowHours: 24            # 采集窗口
    promptBudgetChars: 1200    # 画像注入预算（profile + persona 合计）
    sessionCharLimit: 6000     # 单会话纳入 LLM 的字符上限
    model: "deepseek-v4-pro"   # 摘要/画像用模型；null=宿主默认；可在设置页改
    temperature: 0.2
    autoApply: true            # true=每天自动合并进 profile（有历史可回滚）
    excludeWorkspaces: []      # 排除的工作区（默认空 = 全部总结）
    excludeKeywords: [".env", "BEGIN PRIVATE KEY", "sk-"]
    keepRaw: false             # 是否保留抽取卡原文
    # —— 性格层（见 §20）——
    personaEnabled: true       # 是否维护助手性格
    personaUpdateEveryDays: 7  # 性格层合并频率（天）
    personaMinEvidence: 3      # 性格条目至少需要的独立证据数
    notifyOnRun: false         # 运行完成/失败时是否通知（见 §21）
```

---

## 15. 插件包结构（实现时）

```
dsh-persona-memory/
├── package.json          # name/version/type=module, exports, dsh.bundle.patch, dsh.client(v0.2)
├── cordis.patch.yml      # 挂载行：id/persona-memory + config 默认值
├── lib/
│   ├── index.js          # apply(ctx, config)：注册工具、prompt section、定时器
│   ├── collector.js      # 会话扫描 + 多帧 zstd 解码 + 过滤
│   ├── digest.js         # stage-1/2/3 与 LLM 调用
│   ├── profile.js        # profile.md 解析/序列化/合并/预算（用户画像）
│   ├── persona.js        # persona.md 生成与合并（助手性格，v0.2）
│   ├── inject.js         # prompt section 渲染（profile + persona）
│   └── state.js          # 调度状态、锁、审计日志
├── client/               # 设置页客户端插件（v0.2，见 §19）
│   └── client.js         # 与 dshmarket / dsh-at-file 同机制，挂进插件设置区
└── README.md
```

安装（与 dshmarket 同路径）：

```
dsh plugin --profile desktop add file:<工作区>/dsh-persona-memory
```

> 不需要「创造模式」：这是标准插件包 + profile 安装 + 宿主热加载。创造模式只在"会话内即时写插件并热挂载"时才需要，本任务用不上。

---

## 16. 里程碑与验收

| 版本 | 内容 | 验收 |
|---|---|---|
| v0.1 | 采集 + 抽取 + 当日摘要 + 画像合并 + 注入 + 定时/补跑（17:00） | 17:00 自动生成 `daily/2026-11-10.md`；`persona_profile` 可读；新会话系统提示出现注入段 |
| v0.2 | 设置页（客户端插件）+ 性格层 + 冲突/衰减/回滚 + pin | 设置页可改时间/模型/排除项；性格条目按周合并；能 pin 与回滚 |
| v0.3 | 可选语义检索、运行通知、周报 | 摘要召回更准；周报可用；可开通知 |

验收标准（v0.1）：
1. 同一台机器上多个工作区、多个会话的内容出现在当天 daily 里；
2. 画像条目全部带证据；
3. 注入段不超过预算且不含密钥；
4. 插件卸载/停用后注入消失，数据保留。

---

## 17. 已拍板的决策（2026-11-10）

1. **运行时间**：默认 **17:00**，设置页可改（也支持填 cron）。
2. **画像自动应用**：`autoApply: true`，每天自动合并进 profile；每次写盘前留历史版本，可回滚。
3. **范围**：默认总结**所有工作区**；设置页提供"排除工作区"列表（`excludeWorkspaces`）。
4. **模型**：默认 **`deepseek-v4-pro`**，设置页可改为任意宿主模型或"跟随宿主默认"；模型 id 不在宿主目录时自动回退到宿主默认并在日志里提示。
5. **通知**：用途见 §21；`notifyOnRun: false`（默认关），设置页可开。

仍待你确认：
- 通知要不要默认开（我建议默认关，靠设置页/日志自查）。
- 性格层（§20）的"定格速度"：默认每周合并一次、每条至少 3 条独立证据，是否要更快/更慢。

---

## 18. 兼容性与风险

- 目标宿主 0.2.1-rc.5：依赖 `ctx.tools.register`、`ctx.systemPrompt.section`、`ctx.llm`、timer；均在宿主 API 内，v0.1 实现时逐项验证（若 `ctx.llm` 调用面与预期不同，降级为"只落抽取卡"，v0.2 再接）。
- 会话日志格式为内部格式（v4 + 多帧 zstd），宿主升级可能变动 → 解析器做版本探测 + 失败降级。
- 跨工作区读取需要插件进程有 `~/.dsh` 读权限（宿主进程默认有）。
- 画像质量依赖提示词与你的校准；首周建议人工检查 daily/profile。
- 定时依赖宿主进程存活：桌面端关闭期间不跑，下次启动补跑（最多 3 天）。

---

## 19. 设置页面（v0.2）

**结论：可以，做法与 dsh-market / dsh-at-file 一致**——插件自带一个 Web 客户端包（`dsh.client`，platform=web），注册进宿主的「插件」设置区；宿主 0.2.1-rc.5 已有这套客户端插件机制（dsh-at-file、dsh-genui 都走它）。

页面结构（单页多卡片）：

| 卡片 | 内容 |
|---|---|
| 运行状态 | 上次运行时间、结果（成功/失败/跳过）、读了多少会话、token 粗估；按钮「立即运行」「查看日志」 |
| 计划 | 每日运行时间（默认 **17:00**）、时区、补跑天数、「启用定时」开关 |
| 模型 | 模型选择：`deepseek-v4-pro`（默认）/ 跟随宿主默认 / 自定义 id；温度 |
| 范围 | 工作区排除列表（默认空=全部）、关键词黑名单、单会话字符上限 |
| 画像 | `profile.md` 只读预览 + 分区表格；条目 pin/unpin；历史版本列表与「回滚」「看 diff」 |
| 性格 | `persona.md` 预览；合并频率、最小证据数；「重置为出厂性格」 |
| 通知 | 运行完成 / 失败通知开关（默认关） |

数据通道：客户端 → 插件自己的 HTTP 路由（仅回环地址、同源 POST、写操作二次确认），参考 dsh-market 的接口安全做法。

降级路径：若宿主客户端设置槽位不可用（版本变动），退化为「插件自带独立 HTTP 页面 + 侧栏入口」，或纯配置文件 + 工具。这不会阻塞 v0.1（v0.1 无 UI）。

---

## 20. 性格层（v0.2）

### 20.1 定位

- **用户画像**（§6）：用户是谁、偏好什么、讨厌什么 → 影响"怎么讲"。
- **性格层**（本文）：和这个用户相处时，我是什么样的人 → 影响"我是谁、多主动、多直接、多幽默、称呼与边界"。

两者分文件、分频率、分注入段，互不覆盖。

### 20.2 演化机制

| 项 | 规则 |
|---|---|
| 输入 | 该周的 `daily/*.md` 观察（行为模式，不是单日情绪）；`## 我的判断` 每条带 kind（mistake/stance/revise），只有 mistake 能长出行为条目 —— 每场最多 1 条，日报排序把它排在 12 条上限之前，persona 阶段优先看它 |
| 频率 | 默认每 7 天合并一次（`personaUpdateEveryDays`） |
| 晋升门槛 | 候选性格需 ≥3 条独立证据（不同日期、不同会话）才进入正式区；单日事件只进"候选" |
| 目录 | `persona.md`：`## 核心性格`（慢变，30 天证据存续）/ `## 相处风格`（较快变）/ `## 固定行为规则`（用户 pin）/ `## 候选观察` |
| 方向约束 | 只向"更贴合用户"演化；**反谄媚约束**：不因单次夸奖改变核心性格，不为了讨好放弃诚实与边界 |
| 重申 | 每轮先对照现有条目：同一现象再次出现时用 `entry_id: "<id>"` 点名那一条、text 逐字照抄、evidence 只填新证据；合并按 id 直接命中，不再看相似度（相似度只用于「没点名」的场合）。没点名且措辞又变了，就会新开候选 —— 这正是 0.3.5 之前所有候选攒不到 3 会话的根因 |
| 防漂移 | 30 天无新证据的核心条目 → 降级到候选（不删除）；与用户明确纠正冲突 → 标记 conflict |
| 一键重置 | 设置页「重置为出厂性格」保留画像、只重置 persona.md |

### 20.3 persona.md 结构

```markdown
---
version: 5
updatedAt: 2026-11-16T17:00:00+08:00
---

## 核心性格
- [core-1][P1] 直接、不绕弯，先给结论再展开（证据：11-10 s-a、11-12 s-b、11-14 s-c）

## 相处风格
- [style-1] 讲方案时主动用表格对比（证据：11-13 s-d、11-15 s-e）

## 固定行为规则
- [P0] 不主动用「您」，除非用户先说（用户 pin）

## 候选观察
- [cand-1] 调侃式幽默用得更顺手了（证据：11-16 s-f，待观察）
```

### 20.4 注入

- 与画像共用一段注入（合并渲染），顺序：身份 → 性格 → 用户偏好 → 项目规则。
- 总预算 1200 字符，其中性格最多占 40%（约 480 字符），P0 条目优先。
- 若用户已装 `@deepseek-ai/dsh-persona`，性格段排在其后，不覆盖其人格设定；设置页提示两者关系。

### 20.5 与角色扮演的区别

性格层只改变"表达方式与主动性"，不引入虚构角色、不改变事实与工具行为；不做 persona 扮演。

---

## 21. 通知的用途（回答"通知有啥用"）

| 用途 | 说明 |
|---|---|
| 透明度 | 17:00 的总结跑没跑、成功没有——否则你只能去翻日志 |
| 可回溯 | 通知可带「今日摘要已更新」，点开就是当天 `daily/` 或设置页 |
| 异常告警 | LLM 失败、会话解析失败、画像冲突需要你拍板时，至少让你知道 |
| 节奏可控 | 只在"运行完成/失败"时发，不打扰日常对话；默认关，开了才有 |

实现：宿主通知能力（桌面端系统通知/界面 toast），v0.2 上线，开关在设置页「通知」卡。

---

## 22. v0.1 实现记录（2026-11-10）

**已落地**（包：`dsh-persona-memory` 0.1.0，工作区 `dsh-persona-memory/`）：

| 模块 | 文件 | 状态 |
|---|---|---|
| 多帧 zstd 会话解码 + 过滤 | `lib/collector.js` | ✅ 实测 10 个真实会话可解码 |
| 画像解析/合并/去重/预算/pin/锁定区 | `lib/profile.js` | ✅ 单测覆盖 |
| 三段式 LLM 管线 + 日报 | `lib/digest.js` | ✅ mock 端到端通过；真实模型已跑通 stage1/2 |
| 注入段渲染 | `lib/inject.js` | ✅ 已注册 `persona-memory` prompt section |
| 调度/状态/锁/审计 | `lib/state.js` | ✅ 每日 17:00、启动补跑、单进程锁 |
| 工具：digest/profile/status/pin/note | `lib/index.js` | ✅ 已注册进宿主（工具目录已出现） |
| HTTP：`/persona-memory/status`、`/run` | `lib/index.js` | ✅ 已可用（仅回环） |

**验证**：`node test/run.mjs` 12 项全过（画像合并/去重/pin/预算、真实会话采集、JSON 解析容错、系统事实过滤、mock 端到端写盘）。

**首次真实运行结果（2026-11-10 13:04）**：2 个会话 → 2 张卡 → 日报写入、画像 8 条、性格 4 条，注入段在下一轮对话立即生效。日报质量可用；画像暴露出"把技术事实写成用户特质"的问题（如 DSH 加载器缓存、token 上限被归入雷区）。

**已做的校准**：
- stage1/stage3 提示词收紧：观察只描述用户本人，禁止记录助手/系统/插件/模型的技术事实与任务进度；`correction` 定义为"用户明确纠正助手的做法"。
- 新增确定性过滤 `isSystemFactObservation`：同时命中系统词汇与系统主语（助手/系统/模型/插件/DSH/宿主）的观察直接丢弃。
- 性格提示词限定为"沟通姿态"（语气/详略/主动性/幽默/称呼/边界），不写任务建议。
- 脏画像与性格文件已清空（日报保留），待新提示词生效后重跑。

**已知限制**：
- 宿主不热重载软链接包里的源码 → 改代码后需重启一次桌面端（软链接用于开发，正式包无此问题）。
- 市场热开关（`/dsh-market/toggle`）只能热挂载"纯 insert"补丁行；bundle patch 带 `config:` 块时只能重启生效；且热挂载会复用模块 import 缓存，源码更新仍要重启。因此插件包的 bundle patch 改为纯 insert，可调项放进 `lib/index.js` 的 DEFAULTS（用户可在自己的 profile 补丁行里覆盖）。
- 真实模型（deepseek-v4-pro）会把 JSON 写进 reasoning 块或写在 reasoning 之后 → 已修：只取 `text` 块、reasoning 兜底解析、`maxOutputTokens` 提到 8000、`temperature` 0.2。
- 性格层为每周合并（`personaUpdateEveryDays`）；`core/style` 需 ≥3 个不同会话证据，证据不足只进 `candidate`。
- 设置页/性格可视化面板 → v0.2。

---

## 23. v0.2 实现记录（2026-11-10）

**范围**：设置页（客户端插件）+ 可落盘的配置覆盖 + 历史回滚 + pin/取消 pin + 强制性格合并。运行通知、冲突检测、置信度衰减仍未做。

### 23.1 宿主半侧

| 模块 | 文件 | 内容 |
|---|---|---|
| 配置 | `lib/config.js` | `DEFAULTS`、`EDITABLE_KEYS`、`resolveConfig`（校验 + `scheduleMinutes`）、`composeConfig`（补丁行 + 覆盖项）、`loadOverrides`/`saveOverrides`、`publicConfig` |
| 历史 | `lib/history.js` | `backupDocument`、`listHistory`（新→旧）、`restoreHistory`（回滚前先备份当前版本，回滚本身可逆；文件名正则校验，拒绝路径穿越） |
| 路由 | `lib/http.js` | `registerRoutes` + `readJsonBody`（128KB 上限）+ `describeDocument`/`documentsPayload`；全部仅回环，方法不符回 405 |
| 入口 | `lib/index.js` | 可变更 `config`（`applyConfig` 写盘后即时生效）、注入段/定时器读最新配置、新增 `persona_rollback` 工具、版本号读 `package.json` |
| 状态 | `lib/state.js` | `statusOf` 接受版本号参数 |

路由一览（前缀 `/persona-memory/`）：`status`(GET)、`config`(GET/POST)、`run`(POST，`forcePersona`)、`documents`(GET)、`pin`(POST)、`history`(GET `?doc=`)、`rollback`(POST)。

配置优先级：`DEFAULTS` → 补丁行 `config:` → `persona-memory/config.json`。设置页只写 `EDITABLE_KEYS`，删文件即回落到补丁行。

### 23.2 客户端半侧（设置页）

- `package.json`：`version 0.2.0`、`exports["./client"]`、`dsh.client = { platform: 'web', inject: [dsh-client-ui-slots, dsh-client-locale] }`（与 dsh-at-file 同形：只声明模块依赖，不声明它并不使用的配置底座）。
- `lib/client.js`：手写的 `window.__ModuleLoader__.load({ id: 'dsh-persona-memory', factory })` CJS 工厂（宿主不给第三方包做打包，必须预构建），只 `require('react')` 与 `require('react/jsx-runtime')`（平台模块表内）。
- 注册：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'persona-memory', order: 60, label: () => t('nav'), locale: NS }, MemorySection))`；`ctx.locale.register(NS, { zh, en })` 自带中英字典；样式以 `<style data-plugin-css>` 注入，颜色全部走 `--dsw-alias-*` 变量。
- 页面：运行状态（上次运行/结果/上次性格合并/计划）→ 计划与模型（时间、模型、提供方、温度、窗口、预算、单会话上限、会话数、性格间隔与证据数、三个开关、排除工作区）→ 画像条目（置信度/最后验证/证据 + 置顶/取消）→ 性格条目 → 历史版本（两段确认后回滚）→ 最近日报。
- 数据通道：同源 `fetch` 调插件自己的回环路由；所有写操作只走 POST JSON。

### 23.3 验证

- `node test/run.mjs` 20 项：原 12 项 + 配置合并/持久化/非法值拒绝、历史列表与可逆回滚、文档投影与面板负载、`readJsonBody`、路由级（403/405/run/config/pin/404/history/rollback）、客户端 bundle（注册形状 + 字典 + 加载后渲染出分区/条目/日报）、BOM/损坏 state 容错、置顶不重置版本号。
- `node --check` 全部 `lib/*.js` 通过。
- **已实测（重启后）**：`GET /persona-memory/status` 返回 200 且 `version` 为 `0.2.0`；`config`/`documents`/`history` 路由可用；设置页在「设置 → 记忆与画像」正常出现（说明宿主的 `settings.section` 对第三方客户端插件开放，降级方案不需要）。

### 23.4 重启验证时发现的两个 v0.1 遗留缺陷

1. **`state.json` 的 BOM 让调度状态静默清零**：文件被 PowerShell 写过，开头 `EF BB BF`，`JSON.parse` 抛错 → `loadState` 回落默认值。表现是"上次运行"永远空白、`runs` 为空、`lastPersonaRunDay` 永远为空（性格合并永远判定到期）。修法：`readText` 统一去 BOM；`loadState` 增加 `onCorrupt` 回调，解析失败写 warn 日志而不是静默。
2. **置顶/写入手动锁定区会把 `version` 冲回 0**：`setPinned` 与 `appendLockedEntry` 序列化时硬编码 `version: 0`。修法：新增 `readMeta` 从原 frontmatter 继承 `version` 与 `title`，`applySuggestions` 也改用它。

### 23.5 首次真机使用暴露的问题（2026-11-10 下午）

用户反馈两条：「一堆空白按钮，点了最上面那个不知道在跑什么」「配置能改但没在页面里体现」。排查结论：

1. **按钮/输入框在深色主题下是白字白底**：`lib/client.js` 的样式用了 `var(--dsw-alias-bg-l1, #fff)` 和 `bg-l2`，而宿主的主题里**根本没有这两个变量**（真实的是 `bg-base`、`bg-layer-1..3`）。兜底值 `#fff` 生效，文字用 `label-primary`（深色主题下近白）→ 视觉上按钮空白。修法：按钮改透明底 + `inherit` 字色，输入框用 `bg-layer-2`，主按钮用 `state-business-primary` + `label-primary-foreground`，卡片只用 `border-l2`；测试新增"样式只能引用已核实主题变量"的白名单断言。
2. **配置没写盘**不是代码问题：`config.json` 不存在、日志也没有 `config updated`，说明保存请求从未发出——按钮标签看不见导致点错按钮（那一次点到的是「强制合并性格」，日志里是 `forcePersona=true` 的完整 digest）。
3. **模型调用没有超时**：一次性格合并的 persona 调用耗时约 2 分钟；若 stream 挂住，`inFlight` 与 `state.running` 会永远为真，此后所有定时任务停摆。修法：`callLlm` 用 `Promise.race` 加超时（`llmTimeoutMs`，默认 180s），超时按该 stage 失败处理；启动时复位 `state.running`。
4. **性格晋升门槛只有提示词约束**：设计要求 `core/style` 需足够证据，但 `applySuggestions` 不做计数，写进哪个区完全由模型决定。实测那条 `pstyle-1` 带了 3 个不同会话、但**全部同一天**——按"相处风格可不跨天"的口径它其实合格，真正缺的是"代码裁决 + 跨天累积"（见 §23.6）。

同一次强制运行的结果（可作回归基线）：3 个会话 → 3 张卡；画像 v1→v2（+5，稳定偏好 3 / 沟通习惯 4 / 思维模式 2）；性格 v1→v2（+4，相处风格 1 / 候选观察 7）；`history` 累积 2 份备份。

### 23.6 性格定型机制（2026-11-10 晚，按用户口径实现）

用户定调：**性格靠长期对话定型，且能被后来的对话风格慢慢修改；第一次投入生产不该定型**。据此把门槛从"天数优先"改为"证据累积优先"。

| 区 | 晋升条件 | 配置 |
|---|---|---|
| 候选观察 | 一切新观察的默认落点 | — |
| 相处风格 | ≥3 个不同**会话**（同一天多个会话可以） | `personaMinEvidence`（默认 3） |
| 核心性格 | 同上的会话数 **且** ≥3 个不同**日期** | `personaMinEvidence` + `personaCoreMinDates`（默认 3） |

实现要点：

- **证据结构化**：`parseEvidence/formatEvidence/evidenceStats`（`lib/profile.js`）。兼容 `、` `;` `,` 等分隔符——模型之前用分号分隔，旧代码按顿号切分导致三段证据被当一条。
- **时间戳落到轮次**：stage1 把每条消息渲染成 `[#n YYYY-MM-DD HH:mm] 角色: 文本`，模型只返回 `cites:[n]`；`evidenceFromCites` 用被引消息的 `time` 反推日期，再拼 `session-<id8>`。跨零点的会话不再被记成"跑批那天"。
- **落盘裁决**：新增 `applyPersonaSuggestions`（`lib/profile.js`）。模型给的 `section` 只是提示，最终分区由证据计数决定；跨 core/style/candidate 三区做相似度匹配（≥0.85），命中即合并证据并按计数重新分区，因此**候选可以晋升，正式条目也可以降级**——之前两者都做不到。
- **冲突**：模型可给 `supersedes:"<id>"`，旧条目置信度 −0.3 并退回候选（不删除）；`pinned`/用户锁定条目豁免。
- **衰减**：`personaDemoteAfterDays`（默认 30）天无新证据 → 退回候选。比较基准是本次运行日期，便于测试与补跑。
- **回溯窗口**：`personaStage` 现在真的读最近 `personaUpdateEveryDays` 天 `daily/*.md` 的观察（`parseDailyObservations`），与当日卡片合并去重（上限 40 条）。此前提示词写"近一周"，实际只喂当日。

验证：`node test/run.mjs` 29 项。新增 6 项覆盖证据解析容错、`cites` 日期解析（含跨零点与非法编号）、候选→风格→核心的晋升链、`supersedes` 推翻、30 天降级、pinned 不迁移、日报观察解析。真实 `persona.md` 上验证：`pstyle-1` 被识别为 3 会话 / 1 日期，按新口径留在相处风格。

### 24. 运行通知（方案 A 实现，2026-11-10）

**前置结论**：宿主没有通知服务——翻遍 `app.asar` 没有任何 toast/notification 包，`dshmarket` 里的 "toast" 只是它设置卡的状态文案。因此"推送"只能在页面内做。

**实现**：

- 运行记录携带结果：`recordRun` 的 entry 增加 `skipped` / `profile` / `persona`（含 promoted/demoted/superseded），`/persona-memory/status` 的 `runs[]` 直接可渲染，不用解析日志。
- 客户端每 30s 轮询一次 `/status`；首次轮询只记录基线（避免把历史运行当新事件），之后 `runs[0].at` 变大就出横幅：时间、会话/卡片数、画像与性格增量、升降级计数。失败与"无会话跳过"各有文案。
- 横幅常开；`notifyOnRun`（默认 false）勾选后额外尝试 `new Notification(...)`，「测试系统通知」按钮走 `Notification.requestPermission()` 并回报结果（granted / denied / 不支持），用来实测桌面壳。
- 手动点「立即运行」时先更新基线再提示，避免轮询重复播报同一事件。
- 页面关闭即无推送——这是方案 A 的边界，写进文档。

**静态证据**：`lib/main.js` 里默认 session 的 `setPermissionRequestHandler` 对非 `media` 权限直接 `callback(true)`，所以渲染进程的 `Notification` 很可能被放行；另一条 `callback(false)` 的处理器属于 `dsh-policy-auth-*` 分区。最终以「测试系统通知」的运行时结果为准。

**实测（2026-11-10 晚）**：

- 系统通知能弹（桌面端放行）。
- **延迟定位**：测试按钮显示页面内从点击到 `new Notification(...)` 返回只用 **1ms**，因此剩余延迟 100% 在 Windows Toast 管线（Electron Web Notification → 系统通知中心渲染），插件侧无从优化。页面在后台时另有浏览器定时器节流，轮询间隔因此从 30s 收到 15s。
- **卡片叠加 bug**：勾选「运行通知」后「计划与模型」卡片会出现 2~3 份，刷新即恢复；服务端数据干净（`config.json` 只有 `notifyOnRun`）。定位为勾选走的是"清空 draft → 整块表单塌成 0 → 重建"的路径，而其它开关只改本地 draft。修法两条：勾选改为 `keepDraft: true`（不再清空表单），卡片内所有数组子节点补稳定 `key`（含根节点 7 张卡片）。用户确认修复。
- **闪烁**：上述修复后卡片不再叠加，但点击瞬间仍会闪——因为 `save()` 会先 `setNotice(null)` + `setBusy('save')`（按钮变灰），而复选框勾选值来自服务端数据，要等 `reload()` 才更新。改为**乐观更新**（新增 `notifyChoice` 状态立即翻转，请求返回后清除）+ **静默保存**（`quiet: true`：不置 busy、不清横幅）。至此点击无闪烁。
- **提示文案**：测量阶段曾在"系统通知可用"后附带 `(1ms)` 以确认延迟归属；定位完成后已在 `0.2.1` 去掉，只显示结果本身。

验证：`node test/run.mjs` 30 项。新增用例——捕获轮询定时器，第一次轮询建立基线，第二次喂入新运行记录后重渲染，断言横幅出现且包含 `画像 +2 ~1`；以及"点通知开关后立即勾上"的乐观更新断言（测试用的迷你 React 改为按 deps 触发 effect，从而能渲染出表单字段）。
### 25. 事实层（v0.3.5 实现，2026-11-12）—— 按需检索，绝不进提示词

**为什么另起一层**：画像/自述回答「你是谁 / 我是谁」，教训回答「该怎么做」，事实回答「是什么」（装在哪、版本、路径、定过什么）。前两层必须常驻注入，因此只能少而硬；事实则相反——**a wrong fact is worse than a missing one**，但它的体量天然会涨，所以不注入，改成工具按需检索。这样事实库长到几百条，每轮提示词的字符数也不变。

**结构（`lib/facts.js`，`$DSH_HOME/persona-memory/facts.md`）**：

```md
## 事实
- [fact-1] [作用域 本机] [确认 2026-11-12] DSH 装在 D:\deepseekharness（锚点：2026-11-12/session-xxxx · 插件是进程内加载）
  [验证] Test-Path "D:\deepseekharness\DeepSeekHarness.exe"
  [回注] 重启宿主
## 已作废
- [fact-2] [作用域 全局] [作废 2026-11-13] [原因 机器换了一台] [确认 2026-11-01] 旧机器端口是 65100（锚点：人工新增）
```

- `[验证]` / `[回注]` 是**续行**（两个空格缩进），不是同一行的标签：命令里带方括号、管道、引号都不会破坏解析。解析器只在行首认 `- [fact-n]`，续行按所属条目挂回去。
- 作用域三档：`全局` / `本机` / 工作区路径。检索 = 全局 + 本机 + 当前 cwd，其余计入 `skipped`。
- 只追加、只作废：`assertFactsAppendOnly` 逐条比对 id / 原句 / 作用域 / 验证命令；作废必须给原因，原句与 `[验证]` 一起搬进「已作废」，id 不变。
- 180 天没再确认 → 检索结果和面板标 `[可能过期]`，不删除、不隐藏。
- 没命中返回「没有找到…不要据此推测」；一个事实都没命中时不编。

**写入口只有人**：设置页「事实」卡片 → `POST /persona-memory/facts/{add,archive,confirm}`。**故意不注册 `facts_add` / `facts_archive` 工具**——模型能调用的只有 `facts_search`，所以「事实不改写事实」是代码约束而不是文档约定。写入前后都走 `backupDocument(..., 'facts', ...)`，`history` 路由与回滚同样支持 `facts`。

**面板**：与教训卡片同构——条目（id / 作用域 / 确认日 / 锚点 / 验证命令 / `可能过期`）、新增（内容 + 作用域 + 验证命令 + 可选回注）、作废（原因必填）、确认（刷新确认日）。失败提示挂在卡片内，不弹窗。卡片标题下第一行就写「不常驻提示」，否则列表变长看起来像每轮都在烧 token。

**没有做（刻意）**：语义检索（宿主无 embedding 接口，见 §17）、日更自动提取事实（把判断当事实的代价高于漏记）、`[回注]` 的实际注入（v1 只存）。检索结果会作为工具结果进入对话，因而下一次日更会读到；`isSystemFactObservation` 仍把系统类事实挡在画像之外。

**验证**：`node test/run.mjs` 79 项。新增：解析/续行、作废保留原句与验证命令、确认只动日期、作用域过滤与 `skipped`、180 天边界（正好 180 天即过期）、空命中措辞、换行折叠、手改缺 `[确认]` 标签仍能确认、append-only 篡改检测；路由：方法/回环/空内容/缺原因/未知 id/写入前备份/回滚恢复；面板：计数、条目、`可能过期`、验证命令、新增/确认/作废三个 POST body 与"原因未填不能确认"。