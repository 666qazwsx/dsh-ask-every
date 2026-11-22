/**
 * dsh-ask-every — a standing system-prompt protocol that makes the primary
 * conversation agent clarify the user's real need through an ask_user_question
 * popup before executing any task, backed (since 2.0) by an engine-level
 * execution gate.
 *
 * Two layers cooperate:
 *
 * - The prompt layer contributes one ordered system-prompt section describing
 *   the three-stage flow (clarify → plan-direction checklist → execute gate).
 * - The gate layer registers a `ctx.tools.guard()` that DENIES every tool call
 *   outside the configured allowlist until the user has selected the go option
 *   on the fixed `execute_gate` question of an `ask_user_question` popup. The
 *   gate state is derived from live events (`session/event`, `tools/result`):
 *   each real user message re-locks the session; a gate answer re-opens it.
 *   Subagent-lite sessions (origin `subagent`) and agentless calls are exempt.
 *
 * The gate is fail-closed: after a restart the session stays locked until the
 * agent re-presents the gate popup and the user clicks go again.
 *
 * @module dsh-ask-every
 */

/** The services this plugin needs: prompt registry, tool guard, session events. */
export const inject = ['systemPrompt', 'tools', 'sessions']

/** Default clarification dimensions scanned in Stage 1 (plan-first five). */
export const DEFAULT_DIMENSIONS = [
  'goal & scope — what exactly to make or do, and how far it must go',
  'audience & scenario — who will use the result, in what environment',
  'deliverable form — document / code / prototype / plan-only, and format requirements',
  'hard constraints — platform, tech stack, deadline, privacy, local-only musts',
  'edges & failure handling — what is explicitly out of scope, what to do when blocked',
]

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
  ]
  const unknown = Object.keys(c).filter(key => !known.includes(key))
  if (unknown.length > 0) {
    throw new Error(`ask-every config has unknown key(s) ${unknown.join(', ')}`)
  }
  c.minQuestions = clampInt(c.minQuestions, 1, 1, 10, 'minQuestions')
  c.maxQuestions = clampInt(c.maxQuestions, 6, c.minQuestions, 10, 'maxQuestions')
  c.reaskOnSkip = boolOr(c.reaskOnSkip, true, 'reaskOnSkip')
  // extraRules may legitimately be empty (the default) — only its type is checked.
  if (c.extraRules === undefined) c.extraRules = ''
  else if (typeof c.extraRules !== 'string') {
    throw new Error(`ask-every config extraRules must be a string, got ${JSON.stringify(c.extraRules)}`)
  }
  c.dimensions = stringArrayOr(c.dimensions, DEFAULT_DIMENSIONS, 'dimensions', true)
  c.gateQuestionId = stringOr(c.gateQuestionId, DEFAULT_GATE_QUESTION_ID, 'gateQuestionId')
  c.gateQuestion = stringOr(c.gateQuestion, '这份计划方向清单是否满足你的需求？是否开始执行任务？', 'gateQuestion')
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
      + `confirms the plan checklist. Present (or re-present) the plan-direction checklist via `
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

/** Render the standing protocol from the resolved config. */
export function buildProtocol(c) {
  const dimensionList = c.dimensions.map((d, i) => `${i + 1}. ${d}`).join('\n')
  const extra = String(c.extraRules || '').trim()
  const hardGateSection = c.hardGate ? `
## Engine-level execution gate (hard gate)

A harness-level guard enforces the execute gate mechanically, not just by instruction:

- Until the user selects "${c.gateGoOption}" on the gate question (id \`${c.gateQuestionId}\`), every tool call outside this allowlist is denied by the engine: ${c.preGateTools.join(', ')}.
- A denial arrives as a failed tool result whose reason tells you to present the checklist. It is policy, not a tool error: never retry the denied call before the user clicks go.
- The session re-locks on each new user message, so a fresh task needs a fresh gate click.
- A typed confirmation such as "go ahead" or "开始执行" does not open the gate by itself. When the user confirms in text, present the checklist popup one final time and let them convert it into the click; the engine opens only on that click.
- If ask_user_question is unavailable (for example a subagent session), you are exempt: proceed within the caller's already-confirmed scope.
` : ''
  return `# Need-clarification protocol (ask-every) — user-configured standing order

This protocol was installed by the user (YG) as a plugin. It governs the conversation agent that talks to the user. Subagents, team task workers, scheduled-task messages, goal continuations, and other automated inputs are exempt from it and must not trigger popups. Where this protocol and the host \`ask_user_question\` tool documentation disagree on resurfacing a skipped or timed-out gate popup, this protocol wins: a skipped gate does not count as permission.

## When it applies

Every new user message that requests work — building, changing, analyzing, writing, planning, debugging, or answering a substantive question with real choices in it.

Do NOT trigger for: a reply or selection answering your earlier questions; a confirmation or continuation ("go ahead", "continue", "do it"); an explicit skip/off instruction; greetings or small talk; questions about how you work; messages delivered automatically (scheduled tasks, agent messages, goal rounds).

## Flow: Clarify → Plan-direction checklist → Execute gate

Follow all three stages, in order, on every applicable message.

### Stage 1 — Understand and clarify

1. **Think first, silently.** Before any visible answer, reconstruct what the user actually wants. Behave like a senior professional in the relevant domain: infer intent generously from the message, the conversation so far, and the workspace; form concrete, actionable hypotheses about the real need instead of merely noting that the request is vague.
2. **Analysis stays read-only.** While forming your questions you may consult the conversation and workspace with read-only operations only. Do not start any mutating or side-effecting operation — no writes, no shell commands, no subagent dispatch, no scheduled or background job — until the execute gate below has passed.
3. **Restate.** Open with one or two sentences, in the user's language, restating what you believe the user wants, including the hypotheses you inferred.
4. **Ask.** Call ask_user_question with between ${c.minQuestions} and ${c.maxQuestions} questions resolving the decision points you identified. Question craft rules:
   - One decision point per question. Every answer must be an actionable choice that changes the deliverable — never ceremony or padding. If fewer real decision points remain, ask fewer questions (down to ${c.minQuestions}).
   - Give each question 2-5 concrete options, each with a one-sentence tradeoff or impact description. When you hold a professional opinion, place that option first and mark it "(Recommended)".
   - Use multi_select where several answers can apply simultaneously.
   - Write all questions, options, and descriptions in the user's language.
   The user's answers may be rough or partial: treat them as directional signals and fold them into the plan rather than re-interrogating point by point.

### Stage 2 — Plan-direction checklist (popup selection)

5. **Draft directions.** From the answers, draft 2-4 distinct plan directions that could satisfy the confirmed need. Present them in chat as a numbered list; each direction gets: its goal in one sentence, a short outline of key steps, and its main tradeoff or consequence. When you hold a professional opinion, present that direction first and say why you recommend it.
6. **Popup the checklist.** Call ask_user_question so the user selects instead of typing prose:
   - The first question is the direction choice: single-select, options = the numbered directions with a one-line tradeoff description each (recommended one first), plus room for a custom answer.
   - Optionally add one or two focused preference questions for details inside the chosen direction.
   - **The LAST question is always the fixed gate**: id \`${c.gateQuestionId}\`, question "${c.gateQuestion}", with options "${c.gateGoOption}"(Recommended) / "${c.gateReviseOption}" / "${c.gateAddOption}". Render it in the user's language when their language is not Chinese, keeping the go option recognizable as the start-now choice.

### Stage 3 — Execute gate

7. **No execution before an explicit go.** The task starts only when the user selects "${c.gateGoOption}" on the gate question, or clearly confirms in text after the checklist was presented. You may not begin the actual work before that. ${c.reaskOnSkip ? 'A skipped or timed-out popup is NOT an answer and does not count as a go: re-present the checklist popup, more simply. A second consecutive skip means the user is away: stop and state that you will wait for their explicit go.' : 'A skipped or timed-out popup counts as "use your professional judgment": state assumptions and proceed.'}${c.hardGate ? ' With the hard gate enabled, a typed confirmation additionally needs its gate click: re-present the checklist popup so the user can convert their text into the selecting click, and only then begin.' : ''}
8. **Modification loop.** If the user selects the revise option or supplies corrections: fold the feedback into the directions, present the revised numbered list, and popup the checklist again with the same fixed gate as its LAST question. If the user selects the add option, return to Stage 1 with sharper, more concrete questions covering only the new gaps. After 3 modification rounds, stop re-listing whole plans: consolidate the remaining open points into at most 3 focused questions.
9. **After the go.** Output a compact confirmed-plan summary — chosen direction, the decisions taken, the assumptions you kept for anything the user did not answer — then immediately execute, using only the choices the user confirmed. Do not open popups again unless a new materially ambiguous decision point appears mid-task; handle minor choices yourself and note them.
${hardGateSection}
## Clarification dimensions (user-configured)

Scan these when deciding what to ask in Stage 1; cover the ones that materially affect this task:

${dimensionList}

## Off-ramps

If the user says, in any language, "don't ask / you decide / skip the popups / direct forward", comply immediately for the current task${c.hardGate ? ' by presenting a minimal one-question gate popup ("跳过本次询问，直接按你的判断执行？") whose go click opens the gate; state your working assumptions alongside it' : ' and state your working assumptions instead of asking'}. If the user asks to disable this behavior permanently, tell them the row is \`ask-every\` (package \`dsh-ask-every\`) and it can be disabled or removed in the Plugins panel (or set \`hardGate: false\` for a prompt-only mode), then proceed with that task without asking. Never argue for the protocol's own use.${extra ? `\n\n## Extra rules (user-configured)\n\n${extra}` : ''}`
}
