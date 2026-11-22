# dsh-ask-every

[ English section below ↓ ](#english)

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的常驻插件：**每一条任务类消息，都先弹窗澄清你的真实需求，再给出计划方向清单让你选择确认，最后才执行**——并自 v2.0 起由引擎级工具 guard 强制执行，弹窗没点放行，任务就调不动写入类工具。

适合"我经常表达需求不太清楚"的人——你只管大致描述，插件逼着代理先弄懂你、再动手。

## 工作流程（三阶段闸门）

```text
你的消息 ──▶ 阶段一 澄清 ──────▶ 阶段二 计划方向清单 ─▶ 阶段三 执行闸门 ──▶ 执行
             静默推断+重述         编号方向 2-4 个          弹窗最后一问固定为
             弹窗追问 1-6 问       弹窗选择方向与细节       execute_gate 闸门
```

1. **澄清**：代理先安静推断你的意图，重述理解，然后通过 `ask_user_question` 弹窗提出 1–6 个针对真实决策点的问题（每个选项带权衡说明、推荐项置顶）。澄清阶段只允许只读分析——写入、shell、派发子代理等一律等闸门通过。你的粗略回答会被当作方向性信号折进方案。
2. **计划方向清单（弹窗选择）**：基于回答起草 2–4 个不同的计划方向，编号展示（目标 / 步骤梗概 / 权衡），再弹窗让你选方向。
3. **执行闸门**：每次清单弹窗的最后一问固定为 id `execute_gate` 的闸门问题：
   > 这份计划方向清单是否满足你的需求？是否开始执行任务？
   > - 满足，开始执行
   > - 需要修改（自定义输入说明改哪里）
   > - 还有遗漏，我要补充需求（自由输入）

   选「需要修改」就修订后重弹；只有明确选「满足，开始执行」任务才启动。跳过/超时不作数：协议优先级高于宿主工具说明中"不再重问"的字面规则，会简化后重发一次；连续两次跳过视为用户离开，停下等待明确放行。

**不打扰设计**：闲聊、确认续行、元问题不触发；子代理 / 团队任务 / 定时任务 / goal 自动续跑豁免；随时一句"别问了/你定吧"跳过当前任务（硬门控开启时，代理会用一个单问弹窗把这句话转换成一次点击放行）。

## 引擎级硬门控（v2.0，默认开启）

提示词约束不再是唯一防线。本插件注册了一个引擎层工具 guard（`ctx.tools.guard()`），字面实现"**弹窗没点确认，后台任务就不跑**"：

- 会话默认上锁。**每条真实用户消息都重新上锁**；`ask_user_question` 闸门问题（id `execute_gate`）上用户点了"满足，开始执行"才开锁。
- 上锁期间引擎直接**拒绝**白名单以外的所有工具调用，并把拒绝原因（"先弹清单等用户点放行"）作为失败结果返回给模型——模型无法绕过，监听器顺序也无法把拒绝改回放行。
- 白名单默认只有 `ask_user_question`、`read`、`glob`、`grep`、`web_search`、`web_fetch`、`todo_write`（`preGateTools` 可配）。
- 自由输入文字（如直接打"开始执行"）**不开锁**：协议要求代理把文本确认转换成最后一次闸门弹窗的点击。
- 跳过/超时的弹窗保持上锁（fail-closed）；插件重载或应用重启后同样保持上锁，直到用户再次点击放行。
- 子代理会话（origin `subagent`）与无代理上下文的调用豁免；代理无弹窗通道时按调用方已确认的范围继续工作。
- 需要临时放宽？`hardGate: false` 一键退回纯提示词模式。

**注意**：定时任务与 goal 自动续跑的会话同样会被上锁——它们的执行也会弹出闸门等你点击。这正是"后台任务不点确认不跑"的含义；无人值守场景请把 `hardGate` 关掉或用 `exemptOrigins` 放行。


## 安装

```sh
dsh plugin --profile <你的 profile> add <本仓库路径或 git URL>
```

或在 DSH 的 GUI：**Plugins → Add plugin**，粘贴本仓库目录。安装后新会话生效。

## 配置（`cordis.patch.yml` 的 `ask-every` 行）

配置不合法（未知字段、错误类型）会在激活时直接报错，而不是静默忽略。

| 字段 | 默认 | 说明 |
|---|---|---|
| `minQuestions` / `maxQuestions` | `1` / `6` | 阶段一提问数量范围 |
| `reaskOnSkip` | `true` | 弹窗被跳过/超时视为未放行，简化后重发；`false` 则声明假设后继续 |
| `dimensions` | plan-first 五类 | 阶段一追问维度清单，数组，可增删改写成任意语言 |
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

- **v1.x 提示词层的历史边界已被引擎级门控补上**：guard 顺序无关、同步、fail-closed，模型无法绕过。提示词层仍负责流程编排（澄清问什么、方案列什么、闸门怎么呈现）。
- 门控状态来自会话事件流的实时派生：重启后 fail-closed 重新上锁，代理会再弹一次闸门请用户点击。
- `ask_user_question` 弹窗在无人值守通道（定时任务、goal 续跑的会话）不可用时，任务会停在门控拒绝上——这是刻意的保守行为，需无人值守请关 `hardGate`。
- 与会话中已有的 plan-first 类技能意图一致（先问后做），叠加不冲突。

## 卸载

Plugins 面板禁用/移除 `ask-every` 行，或删除插件目录即可，无系统级残留。

## 开发

```sh
npm test   # node --test tests/
```

`resolveConfig` 与 `buildProtocol` 均为纯函数并已导出，可直接加快照/回归测试。

## 致谢

流程设计参考了 [dsh-ask-first](https://www.npmjs.com/package/dsh-ask-first)、[spec-kit `/clarify`](https://github.com/github/spec-kit) 与 [pi-ask](https://github.com/Jopqior/pi-ask)。

## License

[MIT](LICENSE)

---

# English

A persistent plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): **every task-like message first triggers a clarification popup about your real need, then a plan-direction checklist you select from, and only then execution** — enforced since v2.0 by an engine-level tool guard, not just prompt text.

Built for people whose first description of a need is often vague — describe it roughly; the agent must understand you properly before touching anything.

**Protocol:** Stage 1 — silent intent analysis, restatement, 1–6 targeted popup questions (recommended options first, tradeoff descriptions); analysis before the gate is read-only. Stage 2 — 2–4 numbered plan directions presented and selected via popup. Stage 3 — a fixed gate as the LAST popup question (id `execute_gate`): *"Does this plan satisfy your need? May I start?"* — with 满足，开始执行 / 需要修改 / 还有遗漏 options. Work starts only after an explicit go; a skipped or timed-out popup is not permission (the protocol explicitly outranks the host tool's "do not re-ask" wording and re-presents once, more simply).

**Hard gate (default on):** a `ctx.tools.guard()` denies every tool call outside a small read-only allowlist until the user clicks the go option on the `execute_gate` question. Each new user message re-locks the session; typed confirmations must be converted into the gate click; restart keeps sessions locked (fail-closed); subagent sessions and agentless calls are exempt; `hardGate: false` falls back to prompt-only mode. Unattended scheduled/goal sessions also gate on a click — set `hardGate: false` to let them run unattended.

Small talk, confirmations, meta questions, subagents, scheduled tasks, and goal continuations are exempt from the popup protocol; a single "don't ask, just do it" is converted into one minimal gate click.

**Install:** `dsh plugin --profile <profile> add <repo path or git URL>` — or paste the directory under **Plugins → Add plugin**.

Licensed under [MIT](LICENSE).
