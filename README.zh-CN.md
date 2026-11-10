# dsh-persona-memory

[English](README.md) · **简体中文**

每天跨工作区汇总会话，生长出**用户画像**和**陪伴性格**，并把两者注入每一轮对话 —— 自带设置页，可看、可调。

## 安装

```sh
dsh plugin add github:PaangGaaSam/dsh-persona-memory
```

装完重启桌面端。没有构建步骤，没有原生依赖，也不自带 API key —— 摘要跑在宿主已配置的模型上。

打开 **设置 → 插件 → 记忆与画像**，可改调度时间、模型、预算与范围，也能立刻跑第一次摘要（「立即运行」；「强制合并性格」用来演练性格合并）。数据保存在 `$DSH_HOME/persona-memory/`，不会上传到任何地方。

要求：DSH 桌面端 + `web` 客户端平台（设置页是一个 `dsh.client` 包），Node `^22.19.0 || >=24.0.0`。

## 它做什么

1. **每天 17:00**（可配置）读取 `$DSH_HOME/sessions` 下的所有会话日志（所有工作区、窗口期内的所有会话），包括多帧 zstd 日志。
2. **第一段** —— 每个会话一张卡片：主题、用户诉求、观察（偏好 / 风格 / 思维 / 纠正 / 摩擦）、未解决事项。
3. **第二段** —— 把卡片合并成 `persona-memory/daily/YYYY-MM-DD.md`。
4. **第三段** —— 把观察转成画像建议，再合并进 `profile.md`（近似去重、证据链、置顶条目受保护）。
5. **每周** —— 用同一套证据规则，把观察收敛进 `persona.md`（核心性格 / 相处风格 / 候选观察）。
6. **每轮对话** —— 一个 `persona-memory` 系统提示段，在字符预算内渲染置顶条目加近期条目（默认 1200 字符，画像 / 性格 70/30）。

## 性格如何定型

陪伴性格是长期形成的，不是第一次用就定型。每条观察先落进**候选观察**，之后由**证据**推动晋级，而不是由模型的自我声明：

| 分区 | 晋级条件 |
|---|---|
| 候选观察 | 任何观察的默认落点 |
| 相处风格 (style) | `personaMinEvidence` 个不同会话（默认 3）—— 同一天内凑够也算 |
| 核心性格 (core) | 同样的会话数，**并且**满足 `personaCoreMinDates` 个不同日期（默认 3） |

两条规则保证它不跑偏：

- **推翻（supersede）** —— 新观察与已定型条目冲突时，由模型点名它（`supersedes: "<id>"`）；那条的置信度降 0.3 并退回候选观察，而不是与相反结论并存。
- **衰减（decay）** —— 超过 `personaDemoteAfterDays`（默认 30）天没有新证据的条目退回候选观察。不删除任何东西；置顶和用户锁定的条目永不移动。

证据是 `日期/会话` 形式的 token（`2026-11-10/session-7b3c4fb6`），日期取自**被引用的那一轮**（第一段提示里的 `[#n]`）而不是运行日期，所以跨午夜的会话也能正确归日。性格那一段还会读最近 `personaUpdateEveryDays` 天的日报，因此证据可以跨天累积。

## 设置页

插件带一个浏览器半身（`dsh.client`），在宿主设置里注册「**记忆与画像**」分区。它显示运行状态，可改调度、模型、预算与范围，可手动跑摘要（可强制合并性格），可逐条置顶 / 取消置顶，可回滚到写入前的备份，也能读最新一篇日报。

下面配置块里的每一个开关都能在页面上改 —— 包括核心性格的日期门槛和降级天数 —— 补丁行不再是非用不可的唯一入口。每个字段都带一行说明，讲清它改的是什么；能校验的都会在发请求前校验（时间格式、数值范围）：填错时控件下方直接显示原因，并禁用「保存」。**提供方和模型是下拉框**，选项来自宿主自己的模型目录（`ctx.llm.listProviders()` / `listModels()`，经 `GET /persona-memory/models` 送出）；控件用 `color-scheme: inherit`，所以闭合框和原生弹出列表都跟随宿主解析出的深/浅色方案。某个适配器列不出模型时，这两个字段退回手填输入框；已经保存的值永远保留在选项里，所以打开页面绝不会悄悄改掉它。

在这里做的设置会以覆盖项存进 `persona-memory/config.json`，优先级高于补丁行配置；删掉该文件即回落到补丁行。设置页直接调插件自己的回环路由，不经过宿主的设置管道。

### 运行通知

页面开着时每 30 秒轮询一次 `/persona-memory/status`。出现新的一次运行就在页面顶部弹一条横幅：时间、会话数、卡片数、画像 / 性格增量，以及性格条目晋升 / 降级 / 推翻了几条。横幅总是有；勾上**运行通知**会额外申请桌面系统通知，**测试系统通知**用来探测当前 shell 是否放行。页面关闭时不推送任何东西 —— 宿主没有通知服务可挂。

运行记录本身携带结果（`profile`、`persona`、`skipped`、`error`），所以横幅不需要解析日志。

## 工具

| 工具 | 用途 |
|---|---|
| `persona_digest` | 立刻跑一次摘要（`force_persona: true` 强制合并性格） |
| `persona_profile` | 读取画像与性格的 markdown |
| `persona_status` | 调度、上次运行、文件大小 |
| `persona_pin` / `persona_unpin` | 按 id 置顶 / 取消置顶（`[pref-1]` …） |
| `persona_rollback` | 列出或恢复写入前备份 |
| `persona_note` | 把一条用户口述的规则追加到锁定区 |

## 数据布局

```
$DSH_HOME/persona-memory/
├── profile.md            # 用户画像（唯一事实来源）
├── persona.md            # 陪伴性格
├── config.json           # 设置页覆盖项（可选）
├── daily/YYYY-MM-DD.md   # 每日摘要
├── history/              # 每次改写前的备份：profile-<日期>-<毫秒>.md
├── state.json            # 调度状态
└── logs/run-YYYY-MM-DD.jsonl
```

## 配置（捆绑补丁行）

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

## HTTP（仅回环）

| 路由 | 用途 |
|---|---|
| `GET /persona-memory/status` | 调度状态、配置、两份文档、备份 |
| `GET /persona-memory/config` | 可改配置项与默认值 |
| `POST /persona-memory/config` | `{ patch }` —— 校验、持久化、生效 |
| `POST /persona-memory/run` | `{ forcePersona }` —— 立刻跑摘要 |
| `GET /persona-memory/documents` | 两份文档按分区返回条目，附最新日报 |
| `GET /persona-memory/models` | 下拉框用的提供方与模型目录 |
| `POST /persona-memory/pin` | `{ doc, id, pinned }` |
| `GET /persona-memory/history` | `?doc=profile` 或 `?doc=persona` —— 写入前备份 |
| `POST /persona-memory/rollback` | `{ doc, name }` —— 恢复某份备份 |

非回环请求一律 403；方法不对返回 405。

## 限制

- 定时时刻需要宿主进程在跑；错过的那天会在下次启动时补跑一次。
- 模型输出必须是 JSON；解析容忍散文和代码围栏，但某一段生成失败只降级那一段（其余段照常写入）。
- 以 `link:` 安装的包，改源码后需要重启宿主（加载器不热重载软链接源码，客户端 bundle 是从构建好的 `lib/client.js` 直接发出的）。
