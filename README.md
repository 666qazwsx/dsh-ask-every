# dsh-ask-every

[ English section below ↓ ](#english)

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的常驻提示词层插件：**每一条任务类消息，都先弹窗澄清你的真实需求，再给出计划方向清单让你选择确认，最后才执行。**

适合"我经常表达需求不太清楚"的人——你只管大致描述，插件逼着代理先弄懂你、再动手。

## 工作流程（三阶段闸门）

```text
你的消息 ──▶ 阶段一 澄清 ──▶ 阶段二 计划方向清单 ──▶ 阶段三 执行闸门 ──▶ 执行
              弹窗追问 3-6 问      部分
```

1. **澄清**：代理先安静推断你的意图，重述理解，然后通过 `ask_user_question` 弹窗提出 3–6 个针对真实决策点的问题（每个选项带权衡说明、推荐项置顶）。你的粗略回答会被当作方向性信号折进方案。
2. **计划方向清单（弹窗选择）**：基于回答起草 2–4 个不同的计划方向，编号展示（目标 / 步骤梗概 / 权衡），再弹窗让你选方向。
3. **执行闸门**：每次清单弹窗的最后一问固定为：
   > 这份计划方向清单是否满足你的需求？是否开始执行任务？
   > - 满足，开始执行
   > - 需要修改（自定义输入说明改哪里）
   > - 还有遗漏，我要补充需求

   选「需要修改」就修订后重弹；只有明确选「满足，开始执行」任务才启动。

**不打扰设计**：闲聊、确认续行、元问题不触发；子代理 / 团队任务 / 定时任务 / goal 自动续跑豁免；随时一句"别问了/你定吧"跳过当前任务。

## 安装

```sh
dsh plugin --profile <你的 profile> add <本仓库路径或 git URL>
```

或在 DSH 的 GUI：**Plugins → Add plugin**，粘贴本仓库目录。安装后新会话生效。

## 配置（`cordis.patch.yml` 的 `ask-every` 行）

| 字段 | 默认 | 说明 |
|---|---|---|
| `minQuestions` / `maxQuestions` | `3` / `6` | 阶段一提问数量范围 |
| `reaskOnSkip` | `true` | 弹窗被跳过/超时视为未放行，简化后重发；`false` 则声明假设后继续 |
| `dimensions` | plan-first 五类 | 阶段一追问维度清单，数组，可增删改写成任意语言 |
| `extraRules` | `''` | 追加到协议末尾的自定义规则文本 |

## 已知边界

- **提示词层约束**：本协议注入系统提示词并依赖模型遵循，不是引擎级硬闸；极端情况下模型仍可能直接作答。
- 与会话中已有的 plan-first 类技能意图一致（先问后做），叠加不冲突。

## 卸载

Plugins 面板禁用/移除 `ask-every` 行，或删除插件目录即可，无系统级残留。

## 致谢

流程设计参考了 [dsh-ask-first](https://www.npmjs.com/package/dsh-ask-first)、[spec-kit `/clarify`](https://github.com/github/spec-kit) 与 [pi-ask](https://github.com/Jopqior/pi-ask)。

## License

[MIT](LICENSE)

---

# English

A persistent prompt-layer plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): **every task-like message first triggers a clarification popup about your real need, then a plan-direction checklist you select from, and only then execution.**

Built for people whose first description of a need is often vague — describe it roughly; the agent must understand you properly before touching anything.

**Protocol:** Stage 1 — silhouette analysis, restatement, 3–6 targeted popup questions (recommended options first, tradeoff descriptions). Stage 2 — 2–4 numbered plan directions presented and selected via popup. Stage 3 — a fixed final gate on every checklist popup: *"Does this plan satisfy your need? May I start?"* — with 满足，开始执行 / 需要修改 / 还有遗漏 options. Work starts only after an explicit go.

Small talk, confirmations, meta questions, subagents, scheduled tasks, and goal continuations are exempt; a single "don't ask, just do it" skips the protocol for that task.

**Install:** `dsh plugin --profile <profile> add <repo path or git URL>` — or paste the directory under **Plugins → Add plugin**.

**Known limit:** prompt-layer enforcement — it relies on model compliance with the injected system-prompt section, not an engine-level hard gate.

Licensed under [MIT](LICENSE).
