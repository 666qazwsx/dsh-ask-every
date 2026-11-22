# Changelog

## 版本命名风格

Release 标题统一为 `v{版本} · {短语}`，短语取英文、两三词、名词短语优先，围绕插件核心价值「把模糊的问题和任务问清楚」立意，不使用内部机制术语（如"硬门控"）。

| 版本 | 标题 | 立意 |
|---|---|---|
| v2.0.0 | `v2.0.0 · Clarity First` | 先求清楚，再动手 |

后续版本沿用同一调性，例如 `v2.1 · Ask Sharper`、`v2.2 · Clearer Scope`。Git tag 使用 `v{版本}-{主题}` 形式，本次为 `v2.0.0-clarify`。

## 2.1.0 — 2026-11-22

**新增：覆盖流程（解决"问得太少导致方案偏差"）。** 协议从"问几个问题"升级为五阶段覆盖：

- **任务分解**：首弹窗第一问确认子任务清单，防止漏做。
- **结构化澄清**：五类任务模板（`code`/`doc`/`research`/`data`/`ops`）带必问项，单次上限 6 → 10；允许一轮追问（`clarifyRounds`）。
- **方案卡**：方向从一句话升级为五字段（目标/步骤/产出物/关键假设/风险回退）。
- **需求回放**：执行前回放"事实/推断/未确认"，并入闸门弹窗或独立成窗（`playback`）。
- **三档模式**：`lite`（旧行为）/ `standard`（默认）/ `deep`（两轮追问+独立回放）。

配置新增 `mode`、`decomposeFirst`、`taskTemplates`、`clarifyRounds`、`playback`；`maxQuestions` 默认 10、上限 12。引擎层 guard 行为不变。测试 26 项全部通过。

## 2.0.0 — 2026-11-22

**新增：引擎级硬门控（默认开启）。** 字面实现"弹窗没点确认，后台任务不跑"：

- 注册 `ctx.tools.guard()`：会话默认上锁，每条真实用户消息重新上锁；`ask_user_question` 闸门问题（id `execute_gate`）点选放行选项才开锁。
- 上锁期间拒绝白名单外全部工具调用，拒绝原因引导模型重新弹清单。guard 同步、顺序无关、fail-closed——跳过/超时/重启均保持上锁。
- 白名单默认 `ask_user_question`、`read`、`glob`、`grep`、`web_search`、`web_fetch`、`todo_write`。
- 自由输入文字不开锁：协议要求把文本确认转换为最后一次闸门点击。
- 子代理会话与无代理调用豁免；`hardGate: false` 退回纯提示词模式。

协议文本同步强化：澄清阶段只读白名单条款、闸门 id `execute_gate` 约定、跳过重发优先于宿主工具说明的条款、"别问了/你定吧"转单问弹窗点击放行。

**其他改进**

- 配置激活时经 `resolveConfig` 严格校验：未知字段、错误类型直接报错；范围自动钳制。
- `minQuestions` 默认 3 → 1（与"决策点不足时可少问"条款一致）。
- 闸门问题与三个选项文本全部可配置（`gateQuestionId` / `gateQuestion` / `gateGoOption` / `gateReviseOption` / `gateAddOption`）。
- 声明 `engines.dsh: >=0.2.0` 版本要求；不兼容的 DSH 版本会在安装期报错。
- 单元测试：`resolveConfig` / `buildProtocol` / `isGateGoAnswer` / 门控生命周期（上锁、放行、重锁、豁免、白名单），`npm test` 运行。

## 1.1.0

三阶段澄清协议插件首个发布版：澄清弹窗 → 计划方向清单弹窗 → 执行闸门。提示词层实现。

## 1.0.0

初始版本。
