# dsh-ask-every

[ English section below ↓ ](#english)

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的常驻提示词层插件：**每一条任务类消息，都先弹窗澄清你的真实需求，再给出计划方向清单让你选择确认，最后才执行。**

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

**不打扰设计**：闲聊、确认续行、元问题不触发；子代理 / 团队任务 / 定时任务 / goal 自动续跑豁免；随时一句"别问了/你定吧"跳过当前任务。

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
| `gateQuestionId` | `execute_gate` | 闸门问题的固定 id，协议据此渲染 |
| `gateQuestion` | 中文默认句 | 闸门问题全文（英文会话可改写为英文） |
| `gateGoOption` | `满足，开始执行` | 闸门"放行"选项文本 |
| `gateReviseOption` | `需要修改（…）` | 闸门"修改"选项文本 |
| `gateAddOption` | `还有遗漏，…` | 闸门"补充"选项文本 |

## 已知边界

- **提示词层约束**：本协议注入系统提示词并依赖模型遵循，不是引擎级硬闸；极端情况下模型仍可能直接作答。闸门协议条款、只读分析白名单条款与跳过重发优先级条款已尽量收紧这一边界。
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

A persistent prompt-layer plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): **every task-like message first triggers a clarification popup about your real need, then a plan-direction checklist you select from, and only then execution.**

Built for people whose first description of a need is often vague — describe it roughly; the agent must understand you properly before touching anything.

**Protocol:** Stage 1 — silent intent analysis, restatement, 1–6 targeted popup questions (recommended options first, tradeoff descriptions); analysis before the gate is read-only. Stage 2 — 2–4 numbered plan directions presented and selected via popup. Stage 3 — a fixed gate as the LAST popup question (id `execute_gate`): *"Does this plan satisfy your need? May I start?"* — with 满足，开始执行 / 需要修改 / 还有遗漏 options. Work starts only after an explicit go; a skipped or timed-out popup is not permission (the protocol explicitly outranks the host tool's "do not re-ask" wording and re-presents once, more simply).

Small talk, confirmations, meta questions, subagents, scheduled tasks, and goal continuations are exempt; a single "don't ask, just do it" skips the protocol for that task.

**Install:** `dsh plugin --profile <profile> add <repo path or git URL>` — or paste the directory under **Plugins → Add plugin**.

**Known limit:** prompt-layer enforcement — it relies on model compliance with the injected system-prompt section, not an engine-level hard gate.

Licensed under [MIT](LICENSE).
