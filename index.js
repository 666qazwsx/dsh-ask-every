/**
 * dsh-ask-every — a standing system-prompt protocol that makes the primary
 * conversation agent clarify the user's real need through an ask_user_question
 * popup before executing any task, backed (since 2.0) by an engine-level
 * execution gate and (since 2.1) by a structured coverage flow.
 *
 * Two layers cooperate:
 *
 * - The prompt layer contributes one ordered system-prompt section describing
 *   the coverage flow: task decomposition → structured clarification (task-type
 *   templates) → plan cards → requirement playback → execute gate.
 * - The gate layer registers a `ctx.tools.guard()` that DENIES every tool call
 *   outside the configured allowlist until the user has selected the go option
 *   on the fixed `execute_gate` question of an `ask_user_question` popup. The
 *   gate state is derived from live events (`session/event`, `tools/result`):
 *   each real user message re-locks the session; a gate answer re-opens it.
 *   Subagent sessions (origin `subagent`) and agentless calls are exempt.
 *
 * The gate is fail-closed: after a restart the session stays locked until the
 * agent re-presents the gate popup and the user clicks go again.
 *
 * @module dsh-ask-every
 */

/** The services this plugin needs: prompt registry, tool guard, session events. */
export const inject = ['systemPrompt', 'tools', 'sessions']

/** Default clarification dimensions scanned in lite mode (plan-first five). */
export const DEFAULT_DIMENSIONS = [
  'goal & scope — what exactly to make or do, and how far it must go',
  'audience & scenario — who will use the result, in what environment',
  'deliverable form — document / code / prototype / plan-only, and format requirements',
  'hard constraints — platform, tech stack, deadline, privacy, local-only musts',
  'edges & failure handling — what is explicitly out of scope, what to do when blocked',
]

/**
 * Default task-type templates: the required coverage items per task type.
 * These turn "ask a few questions" into "cover the decisions this task type
 * always has".
 */
export const DEFAULT_TASK_TEMPLATES = {
  code: {
    label: '代码开发',
    fields: [
      '语言、框架与版本',
      '现有代码库位置与可改动范围',
      '验收标准（测试/构建/行为）',
      '运行环境与部署方式',
      '边界与兼容性要求',
      '是否允许改动现有行为',
    ],
  },
  doc: {
    label: '文档写作',
    fields: [
      '受众与使用场景',
      '篇幅与结构',
      '语气风格',
      '引用与事实来源',
      '交付格式',
      '已有素材',
    ],
  },
  research: {
    label: '调研分析',
    fields: [
      '问题边界（含/不含）',
      '信息源与时效要求',
      '分析深度',
      '输出形式',
      '可信度与引用标准',
    ],
  },
  data: {
    label: '数据/表格',
    fields: [
      '数据源与获取方式',
      '口径与字段定义',
      '时间与范围粒度',
      '输出粒度',
      '校验方式',
      '敏感数据处理',
    ],
  },
  ops: {
    label: '运营/方案',
    fields: [
      '目标指标',
      '预算与资源',
      '时间线',
      '目标受众',
      '硬约束',
      '成功判定标准',
    ],
  },
}

/**
 * Mode presets. Explicit per-field config overrides the preset value.
 * - lite: previous behavior — five generic dimensions, no decomposition/playback.
 * - standard: coverage flow with templates, one follow-up round, playback in the gate.
 * - deep: two follow-up rounds and a separate playback popup.
 */
export const MODE_PRESETS = {
  lite: { decomposeFirst: false, clarifyRounds: 0, playback: 'off', useTemplates: false, maxQuestions: 6 },
  standard: { decomposeFirst: true, clarifyRounds: 1, playback: 'gate', useTemplates: true, maxQuestions: 10 },
  deep: { decomposeFirst: true, clarifyRounds: 2, playback: 'separate', useTemplates: true, maxQuestions: 10 },
}

/** The fixed id of the plan-checklist gate question. */
export const DEFAULT_GATE_QUESTION_ID = 'execute_gate'

/** Tools that stay callable while the execution gate is closed. */
export const DEFAULT_PRE_GATE_TOOLS = [
  'ask_user_question',
  'read',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'todo_write',
]

/** Session origins exempt from the execution gate. */
export const DEFAULT_EXEMPT_ORIGINS = ['subagent']

/** Extra go-option label markers for non-Chinese sessions. */
export const DEFAULT_GATE_GO_MARKERS = ['start execut', 'start the task']

/**
 * Resolve and validate the `ask-every` row config. Wrong shape, wrong types,
 * or unknown keys fail at plugin load rather than being silently ignored.
 *
 * @param {Record<string, unknown>} config - Raw plugin config.
 * @returns A detached, validated config object.
 */
export function resolveConfig(config = {}) {
  const c = { ...config }
  const known = [
    'minQuestions', 'maxQuestions', 'reaskOnSkip', 'dimensions', 'extraRules',
    'gateQuestionId', 'gateQuestion', 'gateGoOption', 'gateReviseOption', 'gateAddOption',
    'hardGate', 'preGateTools', 'exemptOrigins', 'gateGoMarkers',
    'mode', 'decomposeFirst', 'taskTemplates', 'clarifyRounds', 'playback',
  ]
  const unknown = Object.keys(c).filter(key => !known.includes(key))
  if (unknown.length > 0) {
    throw new Error(`ask-every config has unknown key(s) ${unknown.join(', ')}`)
  }
  c.mode = enumOr(c.mode, 'standard', ['lite', 'standard', 'deep'], 'mode')
  const preset = MODE_PRESETS[c.mode]
  c.maxQuestions = c.maxQuestions === undefined ? preset.maxQuestions : c.maxQuestions
  c.minQuestions = clampInt(c.minQuestions, 1, 1, 12, 'minQuestions')
  c.maxQuestions = clampInt(c.maxQuestions, preset.maxQuestions, c.minQuestions, 12, 'maxQuestions')
  c.reaskOnSkip = boolOr(c.reaskOnSkip, true, 'reaskOnSkip')
  // extraRules may legitimately be empty (the default) — only its type is checked.
  if (c.extraRules === undefined) c.extraRules = ''
  else if (typeof c.extraRules !== 'string') {
    throw new Error(`ask-every config extraRules must be a string, got ${JSON.stringify(c.extraRules)}`)
  }
  c.dimensions = stringArrayOr(c.dimensions, DEFAULT_DIMENSIONS, 'dimensions', true)
  c.gateQuestionId = stringOr(c.gateQuestionId, DEFAULT_GATE_QUESTION_ID, 'gateQuestionId')
  c.gateQuestion = stringOr(c.gateQuestion, '这些方向是否满足你的需求？是否开始执行任务？', 'gateQuestion')
  c.gateGoOption = stringOr(c.gateGoOption, '满足，开始执行', 'gateGoOption')
  c.gateReviseOption = stringOr(c.gateReviseOption, '需要修改（在自定义输入里说明改哪里）', 'gateReviseOption')
  c.gateAddOption = stringOr(c.gateAddOption, '还有遗漏，我要补充需求（自由输入）', 'gateAddOption')
  c.hardGate = boolOr(c.hardGate, true, 'hardGate')
  c.preGateTools = stringArrayOr(c.preGateTools, DEFAULT_PRE_GATE_TOOLS, 'preGateTools', true)
  if (!c.preGateTools.includes('ask_user_question')) {
    // The gate must always be passable: keep the popup tool callable.
    c.preGateTools = ['ask_user_question', ...c.preGateTools]
  }
  c.exemptOrigins = stringArrayOr(c.exemptOrigins, DEFAULT_EXEMPT_ORIGINS, 'exemptOrigins', false)
  c.gateGoMarkers = stringArrayOr(c.gateGoMarkers, DEFAULT_GATE_GO_MARKERS, 'gateGoMarkers', false)
  c.decomposeFirst = boolOr(c.decomposeFirst, preset.decomposeFirst, 'decomposeFirst')
  c.clarifyRounds = clampInt(c.clarifyRounds, preset.clarifyRounds, 0, 3, 'clarifyRounds')
  c.playback = enumOr(c.playback, preset.playback, ['gate', 'separate', 'off'], 'playback')
  c.taskTemplates = taskTemplatesOr(c.taskTemplates, DEFAULT_TASK_TEMPLATES)
  // Internal flag, not user-facing: lite mode keeps the legacy dimension list.
  c.useTemplates = preset.useTemplates
  return c
}

function clampInt(value, fallback, min, max, name) {
  if (value === undefined) value = fallback
  if (!Number.isInteger(value)) {
    throw new Error(`ask-every config ${name} must be an integer, got ${JSON.stringify(value)}`)
  }
  return Math.min(max, Math.max(min, value))
}

function boolOr(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new Error(`ask-every config ${name} must be a boolean, got ${JSON.stringify(value)}`)
  }
  return value
}

function enumOr(value, fallback, allowed, name) {
  if (value === undefined) return fallback
  if (!allowed.includes(value)) {
    throw new Error(`ask-every config ${name} must be one of ${allowed.join(' / ')}, got ${JSON.stringify(value)}`)
  }
  return value
}

function stringOr(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`ask-every config ${name} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

function stringArrayOr(value, fallback, name, nonEmpty) {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`ask-every config ${name} must be an array of non-empty strings`)
  }
  if (nonEmpty && value.length === 0) {
    throw new Error(`ask-every config ${name} must not be empty`)
  }
  return value
}

function taskTemplatesOr(value, fallback) {
  if (value === undefined) return fallback
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ask-every config taskTemplates must be an object keyed by task type')
  }
  const out = {}
  for (const [type, template] of Object.entries(value)) {
    if (template === null || typeof template !== 'object') {
      throw new Error(`ask-every config taskTemplates.${type} must be an object with label and fields`)
    }
    const label = template.label
    if (typeof label !== 'string' || label.trim() === '') {
      throw new Error(`ask-every config taskTemplates.${type}.label must be a non-empty string`)
    }
    const fields = template.fields
    if (!Array.isArray(fields) || fields.length === 0 || fields.some(f => typeof f !== 'string' || f.trim() === '')) {
      throw new Error(`ask-every config taskTemplates.${type}.fields must be a non-empty array of non-empty strings`)
    }
    out[type] = { label, fields: [...fields] }
  }
  if (Object.keys(out).length === 0) {
    throw new Error('ask-every config taskTemplates must not be empty')
  }
  return out
}

/**
 * Register the prompt section and, when the hard gate is enabled, the
 * engine-level tool guard.
 *
 * @param ctx - the harness context.
 * @param config - the `ask-every` row config from cordis.patch.yml.
 */
export function apply(ctx, config = {}) {
  if (typeof ctx?.systemPrompt?.section !== 'function') return
  const c = resolveConfig(config)
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'ask-every-protocol',
    // Order 10400 places this standing order after DSH's own deployment
    // sections (0–10000 range used by shipped bundles) and keeps it above
    // ad-hoc user notes. Keep it stable: users pin workflows to this slot.
    order: 10400,
    text: buildProtocol(c),
    interpolate: false,
  }), 'ask-every.section()')
  if (c.hardGate) {
    if (typeof ctx?.tools?.guard !== 'function' || typeof ctx?.on !== 'function') return
    installExecutionGate(ctx, c)
  }
}

/**
 * Does this ask_user_question result carry an explicit gate "go"?
 * Only a clicked option label counts — a free-form custom answer can never
 * open the gate by itself (fail-closed).
 *
 * @param {object} result - Frozen tool result of the ask_user_question call.
 * @param {object} c - Resolved config.
 * @returns {boolean}
 */
export function isGateGoAnswer(result, c) {
  const value = result && typeof result === 'object' ? result.value : undefined
  const answers = value && typeof value === 'object' && Array.isArray(value.answers) ? value.answers : []
  const markers = [c.gateGoOption, ...c.gateGoMarkers]
    .map(m => String(m).toLowerCase())
    .filter(m => m.length > 0)
  for (const answer of answers) {
    if (!answer || answer.id !== c.gateQuestionId) continue
    const selected = Array.isArray(answer.selected) ? answer.selected : []
    const clicked = selected.some((label) => {
      if (typeof label !== 'string') return false
      const lowered = label.toLowerCase()
      return markers.some(m => lowered.includes(m))
    })
    if (clicked) return true
  }
  return false
}

/**
 * Install the engine-level execution gate: a fail-closed tool guard whose
 * per-session open/closed state is derived from live session and tool events.
 *
 * @param ctx - the harness context.
 * @param c - Resolved config.
 */
function installExecutionGate(ctx, c) {
  /** Session → true when the execute gate has been passed. */
  const openSessions = new WeakMap()

  function gateDenial(execName) {
    return `Execution gate not passed (ask-every): this session denies "${execName}" until the user `
      + `confirms the plan checklist. Present (or re-present) the plan cards via `
      + `ask_user_question whose LAST question has id "${c.gateQuestionId}" and offers the go option `
      + `"${c.gateGoOption}"; the gate opens only when the user selects it. While the gate is closed `
      + `you may only call: ${c.preGateTools.join(', ')}. This denial is policy, not a tool failure — `
      + `do not retry the same call before the user clicks go.`
  }

  ctx.effect(() => {
    const disposers = [
      // A real user message re-locks the session. Injected contexts carry
      // other source kinds (model/tool/system-prompt/…) and never re-lock.
      ctx.on('session/event', (session, event) => {
        if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
          openSessions.set(session, false)
        }
      }),
      // The user clicked go on the gate question: open the session.
      ctx.on('tools/result', (exec, result) => {
        const agent = exec?.agent
        if (!agent || exec.name !== 'ask_user_question') return
        if (exec.name === 'ask_user_question' && kind(result) !== 'failure' && isGateGoAnswer(result, c)) {
          openSessions.set(agent.session, true)
        }
      }),
      // Fail-closed guard: evaluate last, deny regardless of listener order.
      ctx.tools.guard((exec) => {
        const agent = exec?.agent
        if (!agent) return undefined
        const origin = agent.session?.header?.origin
        if (origin !== undefined && c.exemptOrigins.includes(origin)) return undefined
        if (openSessions.get(agent.session) === true) return undefined
        if (c.preGateTools.includes(exec.name)) return undefined
        return gateDenial(exec.name)
      }),
    ]
    return () => { for (const disposer of disposers) disposer?.() }
  }, 'ask-every.gate()')
}

function kind(result) {
  if (result === null || typeof result !== 'object') return 'unknown'
  return result.isError === true ? 'failure' : 'success'
}

/** Render the task-type template table for the protocol text. */
function renderTemplates(templates) {
  return Object.entries(templates)
    .map(([type, template]) => {
      const fields = template.fields.map((f, i) => `     ${i + 1}. ${f}`).join('\n')
      return `- \`${type}\` ${template.label}:\n${fields}`
    })
    .join('\n')
}

/** Render the coverage-flow stages (Stage 0/1/2/2.5) from the resolved config. */
function buildCoverageFlow(c) {
  const decomposeStage = c.decomposeFirst ? `
### Stage 0 — Task decomposition

Before anything else, split the user's message into a numbered list of concrete subtasks (verb-first, each independently verifiable). The FIRST question of your first popup is a decomposition check:

- Question: "我理解你要做的事情是：1. … 2. … 这些理解对吗？" with options "全对，按这个范围来"(Recommended) / "有遗漏，我补充" / "有理解偏差，我纠正".
- If the user corrects it, restate the corrected list once, then continue. Do not loop the decomposition popup.
- A single-subtask message still passes this question once; the "全对" option makes it one click.
` : ''

  const clarifyStage = c.useTemplates ? `
### Stage 1 — Structured clarification

1. **Identify the task type(s)** from the template library below (multi-select when a task spans types).
2. **Ask the template's required items** as popup questions — one decision point per question, recommended options first. The template items are required coverage: do not silently skip one; if an item is genuinely irrelevant, say so inside the question text.
3. Ask between ${c.minQuestions} and ${c.maxQuestions} questions per popup. If fewer real decision points remain, asking fewer is allowed down to ${c.minQuestions}.
4. **Follow-up round.** After the answers, check for NEW decision points the answers exposed. If any, run up to ${c.clarifyRounds} follow-up round(s) of 2-4 targeted questions. If none, proceed without one.
5. User answers may be rough: treat them as directional signals and fold them in.

Task-type templates (required coverage):

${renderTemplates(c.taskTemplates)}

Supplementary scan list (use only when it adds a dimension the templates missed):

${c.dimensions.map((d, i) => `${i + 1}. ${d}`).join('\n')}
` : `
### Stage 1 — Understand and clarify

1. **Think first, silently.** Reconstruct what the user actually wants; infer intent generously from the message, the conversation, and the workspace.
2. **Restate.** Open with one or two sentences, in the user's language, restating what you believe the user wants.
3. **Ask.** Call ask_user_question with between ${c.minQuestions} and ${c.maxQuestions} questions resolving the decision points you identified. One decision point per question; 2-5 concrete options each with a tradeoff; recommended option first; user's language.
   - The user's answers may be rough: treat them as directional signals (fewer real decision points → ask fewer, down to ${c.minQuestions}).

Clarification dimensions (scan these; cover the ones that materially affect this task):

${c.dimensions.map((d, i) => `${i + 1}. ${d}`).join('\n')}
`

  const playbackBlock = c.playback === 'off' ? '' : c.playback === 'separate'
    ? `
### Stage 2.5 — Requirement playback (separate popup)

Before the gate, replay your understanding as its own popup:

- 事实: what the user actually stated (≤8 bullets).
- 推断: your inferences, each marked [推断] (≤5 bullets).
- 未确认: open items and the default you will take (≤3 bullets).

Question: "执行前请确认我的理解" with options "全部正确，开始执行"(Recommended) / "有需要纠正的（自定义输入逐条改）". If corrected, replay once more, then continue to the gate.
` : `
### Stage 2.5 — Requirement playback (inside the gate popup)

Before the gate question, add one playback question to the same popup:

- 事实: what the user actually stated (≤8 bullets).
- 推断: your inferences, each marked [推断] (≤5 bullets).
- 未确认: open items and the default you will take (≤3 bullets).

Question: "执行前请确认我的理解" with options "全部正确"(Recommended) / "有需要纠正的（自定义输入逐条改）". If corrected, replay once more, then ask the gate.
`

  const planCardStage = `
### Stage 2 — Plan cards

Draft 2-4 directions, each as a card with all five fields:

- **目标**: one sentence.
- **关键步骤**: 3-5 steps.
- **产出物**: the concrete deliverable (files, outputs).
- **关键假设**: the premise the direction rests on — and what changes if it is false.
- **风险与回退**: main risk plus how to back out.

Present the full cards in chat; the popup's direction options use the short form "name — one-line tradeoff", recommended first.

**Popup the checklist.** Call ask_user_question with the direction choice first (single-select, recommended first, custom allowed) and the fixed gate LAST: id \`${c.gateQuestionId}\`, question "${c.gateQuestion}", options "${c.gateGoOption}"(Recommended) / "${c.gateReviseOption}" / "${c.gateAddOption}". Render the gate in the user's language when their language is not Chinese, keeping the go option recognizable as the start-now choice.
`

  return `${decomposeStage}${clarifyStage}${planCardStage}${playbackBlock}`
}

/** Render the standing protocol from the resolved config. */
export function buildProtocol(c) {
  const extra = String(c.extraRules || '').trim()
  const flowTitle = c.useTemplates
    ? 'Flow: Decompose → Structured clarify → Plan cards → Playback → Execute gate'
    : 'Flow: Clarify → Plan-direction checklist → Execute gate'
  const stageNames = c.useTemplates
    ? 'all stages below, in order, on every applicable message.'
    : 'all three stages, in order, on every applicable message.'
  const hardGateSection = c.hardGate ? `
## Engine-level execution gate (hard gate)

A harness-level guard enforces the execute gate mechanically, not just by instruction:

- Until the user selects "${c.gateGoOption}" on the gate question (id \`${c.gateQuestionId}\`), every tool call outside this allowlist is denied by the engine: ${c.preGateTools.join(', ')}.
- A denial arrives as a failed tool result whose reason tells you to present the plan cards. It is policy, not a tool error: never retry the denied call before the user clicks go.
- The session re-locks on each new user message, so a fresh task needs a fresh gate click.
- A typed confirmation such as "go ahead" or "开始执行" does not open the gate by itself. When the user confirms in text, present the plan popup one final time and let them convert it into the click; the engine opens only on that click.
- If ask_user_question is unavailable (for example a subagent session), you are exempt: proceed within the caller's already-confirmed scope.
` : ''
  return `# Need-clarification protocol (ask-every) — user-configured standing order

This protocol was installed by the user (YG) as a plugin. It governs the conversation agent that talks to the user. Subagents, team task workers, scheduled-task messages, goal continuations, and other automated inputs are exempt from it and must not trigger popups. Where this protocol and the host \`ask_user_question\` tool documentation disagree on resurfacing a skipped or timed-out gate popup, this protocol wins: a skipped gate does not count as permission.

## When it applies

Every new user message that requests work — building, changing, analyzing, writing, planning, debugging, or answering a substantive question with real choices in it.

Do NOT trigger for: a reply or selection answering your earlier questions; a confirmation or continuation ("go ahead", "continue", "do it"); an explicit skip/off instruction; greetings or small talk; questions about how you work; messages delivered automatically (scheduled tasks, agent messages, goal rounds).

## Ground rules

- **Analysis stays read-only.** While forming questions you may consult the conversation and workspace with read-only operations only. Do not start any mutating or side-effecting operation — no writes, no shell commands, no subagent dispatch, no scheduled or background job — until the execute gate below has passed.
- **Coverage beats brevity.** The goal of every stage is coverage: nothing about the real need should stay an unstated assumption.

## ${flowTitle}

Follow ${stageNames}
${buildCoverageFlow(c)}
### Execute gate

1. **No execution before an explicit go.** The task starts only when the user selects "${c.gateGoOption}" on the gate question, or clearly confirms in text after the plan was presented. You may not begin the actual work before that.${c.playback !== 'off' ? ' The playback question comes before the gate question in the same popup (or as its own popup in separate mode); a corrected playback must be replayed once before the gate.' : ''} ${c.reaskOnSkip ? 'A skipped or timed-out popup is NOT an answer and does not count as a go: re-present the popup, more simply. A second consecutive skip means the user is away: stop and state that you will wait for their explicit go.' : 'A skipped or timed-out popup counts as "use your professional judgment": state assumptions and proceed.'}${c.hardGate ? ' With the hard gate enabled, a typed confirmation additionally needs its gate click: re-present the popup so the user can convert their text into the selecting click, and only then begin.' : ''}
2. **Modification loop.** If the user selects the revise option or supplies corrections: fold the feedback into the cards, present the revised list, and popup again with the same fixed gate as its LAST question. If the user selects the add option, return to the clarification stage with sharper questions covering only the new gaps. After 3 modification rounds, consolidate the remaining open points into at most 3 focused questions.
3. **After the go.** Output a compact confirmed-plan summary — chosen direction, the decisions taken, the assumptions you kept for anything the user did not answer — then immediately execute, using only the choices the user confirmed. Do not open popups again unless a new materially ambiguous decision point appears mid-task; handle minor choices yourself and note them.
${hardGateSection}
## Off-ramps

If the user says, in any language, "don't ask / you decide / skip the popups / direct forward", comply immediately for the current task${c.hardGate ? ' by presenting a minimal one-question gate popup ("跳过本次询问，直接按你的判断执行？") whose go click opens the gate; state your working assumptions alongside it' : ' and state your working assumptions instead of asking'}. If the user asks to disable this behavior permanently, tell them the row is \`ask-every\` (package \`dsh-ask-every\`) and it can be disabled or removed in the Plugins panel (or set \`hardGate: false\` for a prompt-only mode), then proceed with that task without asking. Never argue for the protocol's own use.${extra ? `\n\n## Extra rules (user-configured)\n\n${extra}` : ''}`
}
