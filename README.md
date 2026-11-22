# dsh-ask-every

[English section below ↓](#english)

> **先弹窗问清楚 → 再列方案让你选 → 最后点一下放行才执行**——每一步都由引擎强制，不靠模型自觉。

面向 [DeepSeek Harness（DSH)](https://github.com/deepseek-ai/deepseek-harness) 的常驻插件：把你每一条任务类消息变成一次受控的确认流程，**弹窗没点确认，后台任务就不执行**。

## 这是什么

dsh-ask-every 安装后做两件事：

1. **注入一条常驻协议**到系统提示词，要求代理处理任务类消息时走固定的覆盖流程：任务分解 → 结构化澄清（任务类型模板必问项）→ 方案卡 → 需求回放 → 执行闸门弹窗。
2. **注册一个引擎级工具 guard**（v2.0 起默认开启），在闸门放行前直接拒绝白名单以外的所有工具调用——写文件、跑命令、派子代理都调不动。

两层配合：协议负责"问什么、方案怎么列、闸门怎么呈现"；guard 负责"没点放行就不放行"。前者靠模型理解力，后者靠机制，模型想绕也绕不过去。v2.1 起，协议层从"问几个问题"升级为"保证覆盖"：任务分解防漏项、任务类型模板保证必问面、需求回放让偏差在执行前暴露。

## 解决什么问题

**痛点一：需求没问清就开干。**
你说"帮我优化一下这个脚本"，模型可能直接闷头改出一个你不想要的东西。本插件强迫代理先把你的真实意图问清楚——先拆子任务确认范围，再按任务类型模板逐项问清（代码类必问验收标准、边界、现有代码可改动范围），答完还允许一轮追问，最后把 2–4 个五字段方案卡列给你选。你的粗略回答会被当方向性信号折进方案，不会被逐点追问。

**痛点二：需求理解有偏差。**
问得再多也可能有漏。执行前会把"我说的事实 / 模型的推断 / 未确认项及默认处理"回放成清单，让你一次确认或逐条纠偏——偏差在这道关卡暴露，而不是在执行完后返工。

**痛点三：弹窗没确认，后台就跑了。**
只靠提示词要求模型"先问后做"是脆弱的：长任务、强指令上下文里模型仍可能直接动手。v2.0 的引擎级门控把这个约束变成机制——上锁的会话里，`pwsh`、`write`、子代理派发这类调用会被引擎直接拒绝并返回"请先弹窗"的失败结果，直到你在闸门上点「满足，开始执行」。

**适合谁：**

- 表达需求偏大方向、细节让代理补全的人——你只管描述，插件逼着代理先弄懂你；
- 被"方案跑偏、返工"坑过的人——任务分解、模板必问、需求回放三层防线把偏差压到执行前；
- 经历过"AI 擅自跑了一堆后台操作"的人——重要操作前必须过你这一关；
- 想要可审计确认流程的人——每次放行都是一次显式点击，拒绝原因都会作为工具结果记录在会话里。

## 设计思路

**五阶段覆盖的编排逻辑。** 一次确认流程分五段收敛，每段只解决一件事：

| 阶段 | 收敛什么 | 形式 |
|---|---|---|
| 0 任务分解 | 范围：子任务清单 | 首弹窗第一问确认"要做的有这几件" |
| 1 结构化澄清 | 决策点：任务类型模板的必问项 + 补充维度 | 弹窗 1–10 问，允许一轮追问 |
| 2 方案卡 | 方案：2–4 个五字段方向 | 聊天区完整卡片 + 弹窗选方向 |
| 2.5 需求回放 | 理解一致性：事实/推断/未确认 | 并入闸门弹窗逐条确认 |
| 3 执行闸门 | 放行：一次显式确认 | 弹窗最后一问固定为 `execute_gate` |

闸门问题固定 id、固定位置、固定选项，是整个流程的锚点：跳过不算数、超时不算数、修改变体都收口回同一个问题。**覆盖不靠问题数量，靠机制**：分解防漏项、模板保证必问面、回放让偏差在执行前暴露。

**为什么要两层。** 提示词层擅长编排——什么时候问、问什么、怎么把你的粗略答案折进方案，这些交给模型判断比写死逻辑好。但提示词层不擅长强制——模型对"不许执行"的理解是概率性的。所以凡是"必须不发生"的事，交给引擎层的 `ctx.tools.guard()`：它同步执行、与监听器顺序无关、只认闸门答案里的点击，模型无论怎么被上下文带偏都绕不开一次真实点击。参照实现是 DSH 官方的 plan-mode（同样的 projection + guard 机制），API 均为官方公开接口。

**Fail-closed 的取舍。** 门控状态从会话事件流实时派生：每条真实用户消息重新上锁，闸门点击放行，内部注入的上下文不会误触发。这意味着：跳过/超时的弹窗保持上锁；重启后保持上锁；你在聊天框里打字说"开始执行"也不开锁——协议会把文本确认转换成最后一次闸门点击。保守方向的误伤（多弹一次、多点一次）远小于放行方向的误伤（后台跑了不该跑的），所以宁可锁死。子代理会话在机制层豁免（按 session origin 判断），不依赖模型记得豁免。

## 工作流程（覆盖流程 → 执行闸门）

```text
你的消息
   │
   ├─ 阶段0 任务分解 ────── 拆子任务清单，首问确认“要做的有这几件”
   ├─ 阶段1 结构化澄清 ──── 任务类型模板 → 必问项 → 允许一轮追问（1–10 问）
   ├─ 阶段2 方案卡 ──────── 每方向含 目标/步骤/产出物/关键假设/风险
   ├─ 阶段2.5 需求回放 ──── 事实/推断/未确认，执行前逐条确认
   └─ 阶段3 执行闸门 ────── execute_gate 最后一问，点击放行
```

1. **任务分解**：收到任务类消息，先把你的话拆成编号子任务清单（“我理解你要做的事情是：1… 2…”），作为第一个弹窗的第一问让你确认全对/有遗漏/有偏差——防止一句话里的多件事被漏做。
2. **结构化澄清**：识别任务类型（代码/文档/调研/数据/运营），加载对应模板的**必问项**（每类 4–6 项），弹窗逐项问清；答完若暴露新决策点，追加一轮 2–4 问的追问。问题数上限 10，允许小任务少问。
3. **方案卡**：每个方向用五字段卡片呈现：目标 / 关键步骤 / 产出物 / **关键假设** / 风险与回退。你选方向时看到的不再是一句话，而是完整方案。
4. **需求回放**：执行前把“我说的事实 / 模型的推断 / 未确认项及默认处理”列成清单，并入闸门弹窗让你一次确认或逐条纠偏——这是对“带着假设往前走”的兜底。
5. **执行闸门**：每次弹窗的最后一问固定为 id `execute_gate` 的闸门问题：
   > 这些方向是否满足你的需求？是否开始执行任务？
   > - 满足，开始执行
   > - 需要修改（自定义输入说明改哪里）
   > - 还有遗漏，我要补充需求（自由输入）

   选「需要修改」就修订后重弹；只有明确选「满足，开始执行」任务才启动。跳过/超时不作数：协议优先级高于宿主工具说明中"不再重问"的字面规则，会简化后重发一次；连续两次跳过视为用户离开，停下等待明确放行。

**三档模式**：`mode: lite` 回到旧行为（5 维度泛问 1–6 问，无分解无回放）；`standard`（默认）为上述完整流程；`deep` 追问两轮 + 回放独立成窗。

**不打扰设计**：闲聊、确认续行、元问题不触发；子代理 / 团队任务 / 定时任务 / goal 自动续跑不受协议约束。随时一句"别问了/你定吧"跳过当前任务——硬门控下会转成一个单问弹窗的点击放行。

## 引擎级硬门控（v2.0，默认开启）

- 会话默认上锁。**每条真实用户消息都重新上锁**；`ask_user_question` 闸门问题（id `execute_gate`）上用户点了「满足，开始执行」才开锁。
- 上锁期间引擎直接**拒绝**白名单以外的所有工具调用，并把拒绝原因（"先弹清单等用户点放行"）作为失败结果返回给模型——模型无法绕过，监听器顺序也无法把拒绝改回放行。
- 白名单默认只有 `ask_user_question`、`read`、`glob`、`grep`、`web_search`、`web_fetch`、`todo_write`（`preGateTools` 可配）。
- 自由输入文字（如直接打"开始执行"）**不开锁**：协议要求代理把文本确认转换成最后一次闸门弹窗的点击。
- 跳过/超时的弹窗保持上锁（fail-closed）；插件重载或应用重启后同样保持上锁，直到用户再次点击放行。
- 子代理会话（origin `subagent`）与无代理上下文的调用豁免；代理无弹窗通道时按调用方已确认的范围继续工作。
- 需要临时放宽？`hardGate: false` 一键退回纯提示词模式。

**注意**：定时任务与 goal 自动续跑的会话同样会被上锁——它们的执行也会弹出闸门等你点击。这正是"后台任务不点确认不跑"的含义；无人值守场景请关闭 `hardGate` 或用 `exemptOrigins` 放行。

## 安装

```sh
dsh plugin --profile <你的 profile> add <本仓库路径或 git URL>
```

或在 DSH 的 GUI：**Plugins → Add plugin**，粘贴本仓库目录。安装后新会话生效；要求 DSH ≥ 0.2.0（`package.json` 已声明 `engines.dsh`，不兼容版本会在安装期报错）。

## 配置（`cordis.patch.yml` 的 `ask-every` 行）

配置不合法（未知字段、错误类型）会在激活时直接报错，而不是静默忽略。

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `standard` | 流程档位：`lite`（旧行为）/ `standard`（完整覆盖流程）/ `deep`（两轮追问 + 独立回放） |
| `minQuestions` / `maxQuestions` | `1` / `10` | 单次弹窗提问数量范围（上限 12） |
| `decomposeFirst` | `true` | 首问是否先做任务分解确认 |
| `taskTemplates` | 内置五类 | 任务类型模板库（`code`/`doc`/`research`/`data`/`ops`），可整体替换 |
| `clarifyRounds` | `1` | 首轮答完后的追问轮数上限（0–3） |
| `playback` | `gate` | 需求回放位置：`gate`（并入闸门弹窗）/ `separate`（独立弹窗）/ `off` |
| `reaskOnSkip` | `true` | 弹窗被跳过/超时视为未放行，简化后重发；`false` 则声明假设后继续 |
| `dimensions` | plan-first 五类 | 补充扫描维度（模板未覆盖时使用），数组，可增删改写 |
| `extraRules` | `''` | 追加到协议末尾的自定义规则文本 |
| `gateQuestionId` | `execute_gate` | 闸门问题的固定 id，协议据此渲染，引擎据此识别放行 |
| `gateQuestion` | 中文默认句 | 闸门问题全文（英文会话可改写为英文） |
| `gateGoOption` | `满足，开始执行` | 闸门"放行"选项文本 |
| `gateReviseOption` | `需要修改（…）` | 闸门"修改"选项文本 |
| `gateAddOption` | `还有遗漏，…` | 闸门"补充"选项文本 |
| `hardGate` | `true` | 引擎级执行门控开关；`false` 退回纯提示词模式 |
| `preGateTools` | 只读白名单 | 门控未放行时仍允许调用的工具名列表（`ask_user_question` 永远保留） |
| `exemptOrigins` | `['subagent']` | 豁免门控的会话 origin 列表 |
| `gateGoMarkers` | 英文兜底标记 | 除 `gateGoOption` 外额外认可的放行选项关键词（适配其他语言的选项文案） |

## 已知边界

- 提示词层负责流程编排（澄清问什么、方案列什么、闸门怎么呈现），引擎层只负责"没点放行就不放行"；两者都已明确分工。
- 门控状态是会话事件流的实时派生缓存：重启后 fail-closed 重新上锁，代理会再弹一次闸门请用户点击。
- `ask_user_question` 弹窗在无人值守通道（定时任务、goal 续跑的会话）不可用时，任务会停在门控拒绝上——这是刻意的保守行为，需无人值守请关 `hardGate`。
- 与会话中已有的 plan-first 类技能意图一致（先问后做），叠加不冲突。

## 卸载

Plugins 面板禁用/移除 `ask-every` 行，或删除插件目录即可，无系统级残留。

## 开发

```sh
npm test   # node --test tests/
```

`resolveConfig` / `buildProtocol` / `isGateGoAnswer` 均为纯函数并已导出；测试覆盖协议渲染、配置校验与门控生命周期（上锁、放行、重锁、豁免、白名单）。

## 致谢

流程设计参考了 [dsh-ask-first](https://www.npmjs.com/package/dsh-ask-first)、[spec-kit `/clarify`](https://github.com/github/spec-kit) 与 [pi-ask](https://github.com/Jopqior/pi-ask)；引擎层参照 DSH 官方 [plan-mode](https://github.com/deepseek-ai/deepseek-harness) 的 projection + guard 机制。

## License

[MIT](LICENSE)

---

# English

> **Decompose → clarify → plan cards → playback → one confirming click** — enforced by the engine, not by the model's good behavior.

A persistent plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) that turns every task-like message into a controlled confirmation flow: **if the popup is not confirmed by a click, background work does not run.**

## What this is

After installation it does two things:

1. **Injects a standing protocol** into the system prompt: every task-like message goes through a fixed coverage flow — task decomposition → structured clarification (task-type templates) → plan cards → requirement playback → execute-gate popup.
2. **Registers an engine-level tool guard** (on by default since v2.0) that denies every tool call outside a small allowlist until the gate passes — no writes, no shell, no subagent dispatch.

The two layers split the work: the protocol decides *what to ask, how to frame options, and how to present the gate* (model judgment); the guard makes *no-go actually mean no-go* (mechanism, order-independent, unbypassable). Since v2.1 the protocol is coverage-first: decomposition catches missing subtasks, task-type templates guarantee the required decisions get asked, and playback exposes misreadings before execution.

## Problems it solves

**Vague requests getting answered instead of understood.** Say "optimize this script" and a model may charge ahead and deliver the wrong thing. This plugin forces the agent to clarify first — confirm the subtask list, ask the task-type template's required items (for code: acceptance criteria, editable scope, boundaries), allow one follow-up round, then present 2–4 five-field plan cards. Rough answers are folded in as directional signals, not re-interrogated point by point.

**Requirements getting misread.** No set of questions catches everything. Before execution the agent replays "what you stated / what it inferred / what is still open and how it will default" for you to confirm or correct — misreadings surface at this checkpoint instead of after rework.

**Backend work running without your confirmation.** Prompt-only "ask first" instructions are fragile: strong context can wash them away. The v2.0 guard turns the constraint into mechanism — in a locked session, calls like `pwsh`, `write`, or subagent dispatch are denied by the engine with a "present the checklist first" failure until you click 「满足，开始执行」.

**Who it is for:** people who describe needs roughly and want the agent made to understand first; people burned by plans that drifted and forced rework; people burned by "the AI went off and did things"; anyone who wants an auditable confirmation step — every release is an explicit click, every denial is recorded as a tool result.

## Design

**Five stages, one decision each.** Stage 0 converges scope (confirm the subtask list). Stage 1 converges decision points (task-type template items, 1–10 questions, one optional follow-up round). Stage 2 converges the plan (2–4 five-field plan cards). Stage 2.5 converges understanding (facts / inferences / open items replay). Stage 3 converges permission (the LAST popup question is always the fixed id `execute_gate`). The gate question has a fixed id, position, and options — skips and timeouts never count, every revision path funnels back to the same question. **Coverage does not come from question count**: decomposition prevents missing subtasks, templates guarantee the required decisions, playback exposes drift before execution.

**Why two layers.** Prompt-layer is good at orchestration — when to ask, what to ask, how to fold rough answers in. It is bad at enforcement — its "don't execute" is probabilistic. Anything that *must not happen* is delegated to the engine's `ctx.tools.guard()`: synchronous, order-independent, unlocked only by a real click in the gate answer. The reference implementation is DSH's official plan-mode (same projection + guard machinery), all through public plugin APIs.

**Fail-closed by choice.** State derives from live session events: every real user message re-locks; only a gate click opens. Skipped/timed-out popups stay closed; restarts stay closed; typed "go ahead" does not open the gate — the protocol converts it into one final gate click. A false lock costs one extra popup; a false release could cost much more. Subagent sessions are exempted mechanically by session origin, not by model memory.

## Workflow (coverage flow → execute gate)

**Stage 0 — Task decomposition.** Split the message into a numbered subtask list and confirm it as the first popup question (all correct / missing items / misread) — so several jobs inside one sentence are not silently dropped.

**Stage 1 — Structured clarification.** Identify the task type (code / doc / research / data / ops), ask the template's required items, up to 10 questions, then at most one follow-up round of 2–4 questions if the answers exposed new decision points.

**Stage 2 — Plan cards.** 2–4 directions, each with five fields: goal / key steps / deliverable / key assumption / risk and fallback. Full cards in chat, short-form options in the popup.

**Stage 2.5 — Requirement playback.** Replay facts (≤8), inferences marked [推断] (≤5), and open items with defaults (≤3) for one confirmation or per-line correction.

**Stage 3 — Execute gate.** The LAST question, id `execute_gate`: *"这些方向是否满足你的需求？是否开始执行任务？"* with options 满足，开始执行 / 需要修改 / 还有遗漏. Only an explicit go starts the work; a skipped or timed-out popup is not permission (the protocol outranks the host tool's "do not re-ask" wording and re-presents once, more simply). "Don't ask, just do it" is honored via a minimal one-question gate click.

**Three modes:** `lite` restores the old behavior (five generic dimensions, 1–6 questions, no decomposition or playback); `standard` (default) is the full flow above; `deep` runs two follow-up rounds and splits playback into its own popup.

**Quiet by default:** small talk, confirmations, and meta questions never trigger; subagents, team workers, scheduled tasks, and goal continuations are exempt.

## Engine-level hard gate (v2.0, on by default)

- Sessions lock by default; every real user message re-locks; selecting the go option on the `execute_gate` question unlocks.
- While locked, the engine denies every tool call outside the allowlist and returns the reason to the model. Guards are synchronous and order-independent — listeners cannot turn a denial back into permission.
- Default allowlist: `ask_user_question`, `read`, `glob`, `grep`, `web_search`, `web_fetch`, `todo_write` (`preGateTools`).
- Typed confirmations do not unlock; skips/timeouts/restarts keep the session closed (fail-closed).
- Subagent sessions (origin `subagent`) and agentless calls are exempt; `hardGate: false` falls back to prompt-only mode.
- Scheduled and goal sessions also gate on a click — that is what "no background work without confirmation" means. Disable `hardGate` for unattended use.

## Install

```sh
dsh plugin --profile <profile> add <repo path or git URL>
```

Or paste the repo directory under **Plugins → Add plugin**. Requires DSH ≥ 0.2.0 (declared in `engines.dsh`).

## Configuration

Same schema as the Chinese table above, all keys live in the `ask-every` row of `cordis.patch.yml`: mode presets (`mode`, `decomposeFirst`, `taskTemplates`, `clarifyRounds`, `playback`), question range (`minQuestions`/`maxQuestions`), `reaskOnSkip`, `dimensions`, `extraRules`, gate text (`gateQuestionId`/`gateQuestion`/`gateGoOption`/`gateReviseOption`/`gateAddOption`), and gate behavior (`hardGate`, `preGateTools`, `exemptOrigins`, `gateGoMarkers`). Invalid config fails at activation instead of being ignored.

## Known limits

- The prompt layer orchestrates (what to ask, how to present); the engine layer only enforces the gate.
- Gate state is a live derivation of the session event log: after a restart the session re-locks fail-closed and the agent re-presents the gate once.
- Template coverage is probabilistic: a wrongly identified task type can still ask the wrong questions; playback is the backstop, and it is itself bounded (facts ≤8, inferences ≤5, open items ≤3).
- Unattended scheduled/goal sessions stall on the gate by design — disable `hardGate` for unattended flows.

## Development

```sh
npm test   # node --test tests/
```

`resolveConfig`, `buildProtocol`, and `isGateGoAnswer` are exported pure functions; tests cover protocol rendering, config validation, and the gate lifecycle (lock, unlock, re-lock, exemptions, allowlist).

## Credits

Flow design references [dsh-ask-first](https://www.npmjs.com/package/dsh-ask-first), [spec-kit `/clarify`](https://github.com/github/spec-kit), and [pi-ask](https://github.com/Jopqior/pi-ask); the engine layer follows DSH's official plan-mode projection + guard pattern.

Licensed under [MIT](LICENSE).
