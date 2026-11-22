/**
 * dsh-ask-every — a standing system-prompt protocol that makes the primary
 * conversation agent clarify the user's real need through an ask_user_question
 * popup before executing any task.
 *
 * Prompt-layer plugin: it contributes one ordered system-prompt section and
 * config validation. All tunables live in the `ask-every` row's config in
 * cordis.patch.yml and are validated by {@link resolveConfig} at activation.
 *
 * @module dsh-ask-every
 */

/** The prompt registry this protocol contributes to. */
export const inject = ['systemPrompt']

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
  ]
  const unknown = Object.keys(c).filter(key => !known.includes(key))
  if (unknown.length > 0) {
    throw new Error(`ask-every config has unknown key(s) ${unknown.join(', ')}`)
  }
  c.minQuestions = clampInt(c.minQuestions, 1, 1, 10, 'minQuestions')
  c.maxQuestions = clampInt(c.maxQuestions, 6, c.minQuestions, 10, 'maxQuestions')
  c.reaskOnSkip = boolOr(c.reaskOnSkip, true, 'reaskOnSkip')
  c.extraRules = stringOr(c.extraRules, '', 'extraRules')
  c.dimensions = stringArrayOr(c.dimensions, DEFAULT_DIMENSIONS, 'dimensions', true)
  c.gateQuestionId = stringOr(c.gateQuestionId, DEFAULT_GATE_QUESTION_ID, 'gateQuestionId')
  c.gateQuestion = stringOr(c.gateQuestion, '这份计划方向清单是否满足你的需求？是否开始执行任务？', 'gateQuestion')
  c.gateGoOption = stringOr(c.gateGoOption, '满足，开始执行', 'gateGoOption')
  c.gateReviseOption = stringOr(c.gateReviseOption, '需要修改（在自定义输入里说明改哪里）', 'gateReviseOption')
  c.gateAddOption = stringOr(c.gateAddOption, '还有遗漏，我要补充需求（自由输入）', 'gateAddOption')
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

function stringArrayOr(value, fallback, name, nonEmpty = false) {
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
 * Register the clarification protocol section.
 *
 * @param ctx - the harness context carrying the systemPrompt registry.
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
}

/** Render the standing protocol from the resolved config. */
export function buildProtocol(c) {
  const dimensionList = c.dimensions.map((d, i) => `${i + 1}. ${d}`).join('\n')
  const extra = String(c.extraRules || '').trim()
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

7. **No execution before an explicit go.** The task starts only when the user selects "${c.gateGoOption}" on the gate question, or clearly confirms in text after the checklist was presented. You may not begin the actual work before that. ${c.reaskOnSkip ? 'A skipped or timed-out popup is NOT an answer and does not count as a go: re-present the checklist popup, more simply. A second consecutive skip means the user is away: stop and state that you will wait for their explicit go.' : 'A skipped or timed-out popup counts as "use your professional judgment": state assumptions and proceed.'}
8. **Modification loop.** If the user selects the revise option or supplies corrections: fold the feedback into the directions, present the revised numbered list, and popup the checklist again with the same fixed gate as its LAST question. If the user selects the add option, return to Stage 1 with sharper, more concrete questions covering only the new gaps. After 3 modification rounds, stop re-listing whole plans: consolidate the remaining open points into at most 3 focused questions.
9. **After the go.** Output a compact confirmed-plan summary — chosen direction, the decisions taken, the assumptions you kept for anything the user did not answer — then immediately execute, using only the choices the user confirmed. Do not open popups again unless a new materially ambiguous decision point appears mid-task; handle minor choices yourself and note them.

## Clarification dimensions (user-configured)

Scan these when deciding what to ask in Stage 1; cover the ones that materially affect this task:

${dimensionList}

## Off-ramps

If the user says, in any language, "don't ask / you decide / skip the popups / direct forward", comply immediately for the current task and state your working assumptions instead of asking. If the user asks to disable this behavior permanently, tell them the row is \`ask-every\` (package \`dsh-ask-every\`) and it can be disabled or removed in the Plugins panel, then proceed with that task without asking. Never argue for the protocol's own use.${extra ? `\n\n## Extra rules (user-configured)\n\n${extra}` : ''}`
}
