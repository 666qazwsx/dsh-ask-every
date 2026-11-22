import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  buildProtocol,
  isGateGoAnswer,
  resolveConfig,
  DEFAULT_DIMENSIONS,
  DEFAULT_GATE_QUESTION_ID,
  DEFAULT_PRE_GATE_TOOLS,
  DEFAULT_TASK_TEMPLATES,
  MODE_PRESETS,
} from '../index.js'

test('resolveConfig fills standard-mode defaults', () => {
  const c = resolveConfig({})
  assert.equal(c.mode, 'standard')
  assert.equal(c.minQuestions, 1)
  assert.equal(c.maxQuestions, 10)
  assert.equal(c.reaskOnSkip, true)
  assert.equal(c.extraRules, '')
  assert.deepEqual(c.dimensions, DEFAULT_DIMENSIONS)
  assert.equal(c.gateQuestionId, DEFAULT_GATE_QUESTION_ID)
  assert.equal(c.hardGate, true)
  assert.deepEqual(c.preGateTools, DEFAULT_PRE_GATE_TOOLS)
  assert.deepEqual(c.exemptOrigins, ['subagent'])
  assert.ok(c.gateGoMarkers.length > 0)
  assert.equal(c.decomposeFirst, true)
  assert.equal(c.clarifyRounds, 1)
  assert.equal(c.playback, 'gate')
  assert.deepEqual(c.taskTemplates, DEFAULT_TASK_TEMPLATES)
  assert.equal(c.useTemplates, true)
})

test('mode presets expand: lite keeps legacy behavior', () => {
  const c = resolveConfig({ mode: 'lite' })
  assert.equal(c.decomposeFirst, false)
  assert.equal(c.clarifyRounds, 0)
  assert.equal(c.playback, 'off')
  assert.equal(c.maxQuestions, 6)
  assert.equal(c.useTemplates, false)
})

test('mode presets expand: deep adds rounds and separate playback', () => {
  const c = resolveConfig({ mode: 'deep' })
  assert.equal(c.clarifyRounds, 2)
  assert.equal(c.playback, 'separate')
  assert.equal(c.useTemplates, true)
})

test('explicit fields override the mode preset', () => {
  const c = resolveConfig({ mode: 'lite', maxQuestions: 8, decomposeFirst: true })
  assert.equal(c.maxQuestions, 8)
  assert.equal(c.decomposeFirst, true)
  assert.equal(c.useTemplates, false)
})

test('resolveConfig rejects unknown keys', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown key/)
})

test('resolveConfig rejects wrong types and enums', () => {
  assert.throws(() => resolveConfig({ minQuestions: 'x' }), /must be an integer/)
  assert.throws(() => resolveConfig({ reaskOnSkip: 'yes' }), /must be a boolean/)
  assert.throws(() => resolveConfig({ hardGate: 'on' }), /must be a boolean/)
  assert.throws(() => resolveConfig({ mode: 'max' }), /must be one of lite \/ standard \/ deep/)
  assert.throws(() => resolveConfig({ playback: 'later' }), /must be one of gate \/ separate \/ off/)
  assert.throws(() => resolveConfig({ dimensions: [1, 2] }), /array of non-empty strings/)
  assert.throws(() => resolveConfig({ dimensions: [] }), /must not be empty/)
  assert.throws(() => resolveConfig({ preGateTools: [] }), /must not be empty/)
  assert.throws(() => resolveConfig({ gateQuestion: ' ' }), /non-empty string/)
})

test('resolveConfig clamps range bounds to 1..12', () => {
  const c = resolveConfig({ minQuestions: 50 })
  assert.equal(c.minQuestions, 12)
  assert.equal(c.maxQuestions, 12)
  const swapped = resolveConfig({ minQuestions: 5, maxQuestions: 2 })
  assert.equal(swapped.minQuestions, 5)
  assert.equal(swapped.maxQuestions, 5)
  const rounds = resolveConfig({ clarifyRounds: 99 })
  assert.equal(rounds.clarifyRounds, 3)
})

test('resolveConfig validates taskTemplates', () => {
  assert.throws(() => resolveConfig({ taskTemplates: [] }), /must be an object/)
  assert.throws(() => resolveConfig({ taskTemplates: { code: {} } }), /label/)
  assert.throws(() => resolveConfig({ taskTemplates: { code: { label: 'x', fields: [] } } }), /fields/)
  assert.throws(() => resolveConfig({ taskTemplates: {} }), /must not be empty/)
  const custom = resolveConfig({
    taskTemplates: { design: { label: '设计', fields: ['目标用户', '成功标准'] } },
  })
  assert.deepEqual(Object.keys(custom.taskTemplates), ['design'])
  assert.deepEqual(custom.taskTemplates.design.fields, ['目标用户', '成功标准'])
})

test('resolveConfig accepts an explicitly empty extraRules (patch-file default)', () => {
  // cordis.patch.yml ships extraRules: '' — that must activate cleanly.
  const c = resolveConfig({ extraRules: '' })
  assert.equal(c.extraRules, '')
  assert.throws(() => resolveConfig({ extraRules: 0 }), /must be a string/)
})

test('resolveConfig always keeps the gate popup callable', () => {
  const c = resolveConfig({ preGateTools: ['read'] })
  assert.deepEqual(c.preGateTools, ['ask_user_question', 'read'])
})

test('buildProtocol renders the gate question and its fixed id', () => {
  const text = buildProtocol(resolveConfig({}))
  assert.ok(text.includes('id `execute_gate`'))
  assert.ok(text.includes('这些方向是否满足你的需求？是否开始执行任务？'))
  assert.ok(text.includes('满足，开始执行'))
  assert.ok(text.includes('between 1 and 10'))
})

test('buildProtocol renders configured values', () => {
  const text = buildProtocol(resolveConfig({
    minQuestions: 2,
    maxQuestions: 4,
    gateQuestionId: 'go_gate',
    gateQuestion: 'Proceed?',
    gateGoOption: 'Yes, proceed',
    dimensions: ['one — first'],
    extraRules: 'Always answer in Chinese.',
  }))
  assert.ok(text.includes('id `go_gate`'))
  assert.ok(text.includes('Proceed?'))
  assert.ok(text.includes('Yes, proceed'))
  assert.ok(text.includes('between 2 and 4'))
  assert.ok(text.includes('1. one — first'))
  assert.ok(text.includes('Always answer in Chinese.'))
  assert.ok(!text.includes('goal & scope'))
})

test('buildProtocol keeps reaskOnSkip wording switchable', () => {
  const reask = buildProtocol(resolveConfig({ reaskOnSkip: true }))
  const proceed = buildProtocol(resolveConfig({ reaskOnSkip: false }))
  assert.ok(reask.includes('is NOT an answer'))
  assert.ok(proceed.includes('use your professional judgment'))
})

test('buildProtocol documents read-only analysis before the gate', () => {
  const text = buildProtocol(resolveConfig({}))
  assert.ok(text.includes('Analysis stays read-only'))
  assert.ok(text.includes('Do not start any mutating or side-effecting operation'))
})

test('buildProtocol renders the hard-gate section only when enabled', () => {
  const on = buildProtocol(resolveConfig({}))
  assert.ok(on.includes('Engine-level execution gate'))
  assert.ok(on.includes('never retry the denied call before the user clicks go'))
  assert.ok(on.includes(DEFAULT_PRE_GATE_TOOLS.join(', ')))
  const off = buildProtocol(resolveConfig({ hardGate: false }))
  assert.ok(!off.includes('Engine-level execution gate'))
})

test('standard mode renders the coverage flow: decomposition, templates, plan cards, playback', () => {
  const text = buildProtocol(resolveConfig({}))
  assert.ok(text.includes('Decompose → Structured clarify → Plan cards → Playback → Execute gate'))
  assert.ok(text.includes('Stage 0 — Task decomposition'))
  assert.ok(text.includes('Stage 1 — Structured clarification'))
  assert.ok(text.includes('Stage 2 — Plan cards'))
  assert.ok(text.includes('Stage 2.5 — Requirement playback'))
  // Template library is rendered with required items.
  assert.ok(text.includes('`code` 代码开发'))
  assert.ok(text.includes('语言、框架与版本'))
  assert.ok(text.includes('`doc` 文档写作'))
  assert.ok(text.includes('`research` 调研分析'))
  assert.ok(text.includes('`data` 数据/表格'))
  assert.ok(text.includes('`ops` 运营/方案'))
  // Plan cards carry all five fields.
  assert.ok(text.includes('关键假设'))
  assert.ok(text.includes('产出物'))
  // Playback lives inside the gate popup by default.
  assert.ok(text.includes('inside the gate popup'))
})

test('lite mode falls back to the legacy dimension flow', () => {
  const text = buildProtocol(resolveConfig({ mode: 'lite' }))
  assert.ok(!text.includes('Stage 0 — Task decomposition'))
  assert.ok(!text.includes('Stage 1 — Structured clarification'))
  assert.ok(text.includes('Clarification dimensions'))
  assert.ok(text.includes('goal & scope'))
  assert.ok(text.includes('Clarify → Plan-direction checklist → Execute gate'))
  assert.ok(!text.includes('Requirement playback'))
})

test('deep mode renders separate playback and two follow-up rounds', () => {
  const text = buildProtocol(resolveConfig({ mode: 'deep' }))
  assert.ok(text.includes('Requirement playback (separate popup)'))
  assert.ok(text.includes('up to 2 follow-up round(s)'))
})

test('isGateGoAnswer matches a clicked go label with Recommended suffix', () => {
  const c = resolveConfig({})
  const result = { value: { answers: [{
    id: 'execute_gate',
    selected: ['满足，开始执行 (Recommended)'],
  }] } }
  assert.equal(isGateGoAnswer(result, c), true)
})

test('isGateGoAnswer ignores other ids, skips, and custom-only answers', () => {
  const c = resolveConfig({})
  assert.equal(isGateGoAnswer({ value: { answers: [{ id: 'direction', selected: ['满足，开始执行'] }] } }, c), false)
  assert.equal(isGateGoAnswer({ value: { answers: [{ id: 'execute_gate', selected: [], custom: '开始执行吧' }] } }, c), false)
  assert.equal(isGateGoAnswer({ value: { answers: [{ id: 'execute_gate', selected: ['需要修改'] }] } }, c), false)
  assert.equal(isGateGoAnswer({}, c), false)
  assert.equal(isGateGoAnswer({ isError: true, error: {} }, c), false)
})

test('isGateGoAnswer accepts extra configured markers in other languages', () => {
  const c = resolveConfig({ gateGoMarkers: ['start execut'] })
  const result = { value: { answers: [{ id: 'execute_gate', selected: ['Satisfied — start executing now'] }] } }
  assert.equal(isGateGoAnswer(result, c), true)
})

test('execution gate lifecycle: lock on user message, open on gate click', () => {
  const c = resolveConfig({})
  const listeners = {}
  let guardFn
  const session = { header: { origin: 'primary' } }
  const agent = { session }
  const subSession = { header: { origin: 'subagent' } }
  const subAgent = { session: subSession }
  const ctx = {
    on: (name, fn) => { (listeners[name] ??= []).push(fn); return () => {} },
    tools: { guard: (fn) => { guardFn = fn; return () => {} } },
    effect: (register) => { register(); return () => {} },
    systemPrompt: { section: () => () => {} },
  }
  apply(ctx, {})

  // Guards, lock, and unlock listeners are all installed.
  assert.ok(guardFn)
  assert.ok(listeners['session/event'])
  assert.ok(listeners['tools/result'])

  const pwshCall = { name: 'pwsh', agent }
  const readCall = { name: 'read', agent }

  // Fresh session: fail-closed for write tools, allowlist passes.
  assert.ok(typeof guardFn(pwshCall) === 'string' && guardFn(pwshCall).includes('execute_gate'))
  assert.equal(guardFn(readCall), undefined)
  // Agentless calls pass.
  assert.equal(guardFn({ name: 'pwsh' }), undefined)
  // Exempted origins pass.
  assert.equal(guardFn({ name: 'pwsh', agent: subAgent }), undefined)

  // Open the gate via an ask_user_question result.
  for (const fn of listeners['tools/result']) {
    fn({ name: 'ask_user_question', agent }, {
      isError: false,
      value: { answers: [{ id: 'execute_gate', selected: ['满足，开始执行'] }] },
    })
  }
  assert.equal(guardFn(pwshCall), undefined)

  // A new user message re-locks.
  for (const fn of listeners['session/event']) {
    fn(session, { type: 'user/message', data: { source: { kind: 'user' } } })
  }
  assert.ok(typeof guardFn(pwshCall) === 'string')

  // Internal injected contexts do not re-lock an open session.
  for (const fn of listeners['tools/result']) {
    fn({ name: 'ask_user_question', agent }, {
      isError: false,
      value: { answers: [{ id: 'execute_gate', selected: ['满足，开始执行'] }] },
    })
  }
  assert.equal(guardFn(pwshCall), undefined)
  for (const fn of listeners['session/event']) {
    fn(session, { type: 'user/message', data: { source: { kind: 'system-prompt' } } })
    fn(session, { type: 'tool/result', data: {} })
  }
  assert.equal(guardFn(pwshCall), undefined)
})

test('hardGate: false installs no guard at all', () => {
  const ctx = {
    on: () => () => {},
    tools: { guard: () => { throw new Error('guard must not be installed') } },
    effect: (register) => { register(); return () => {} },
    systemPrompt: { section: () => () => {} },
  }
  assert.doesNotThrow(() => apply(ctx, { hardGate: false }))
})

test('apply registers the section with validated config', () => {
  const sections = []
  const ctx = {
    systemPrompt: { section: (spec) => { sections.push(spec); return () => {} } },
    on: () => () => {},
    tools: { guard: () => () => {} },
    // Cordis ctx.effect runs the registration callback immediately and uses
    // its return value as the disposer.
    effect: (register) => { register(); return () => {} },
  }
  apply(ctx, { minQuestions: 2 })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'ask-every-protocol')
  assert.equal(sections[0].order, 10400)
  assert.equal(sections[0].interpolate, false)
  assert.ok(sections[0].text.includes('between 2 and 10'))
  // Invalid config fails activation rather than being ignored.
  assert.throws(() => apply(ctx, { minQuestions: 'bad' }), /must be an integer/)
})

test('apply is a no-op without a systemPrompt registry', () => {
  assert.doesNotThrow(() => apply({}, {}))
})

test('MODE_PRESETS are internally consistent', () => {
  for (const [name, preset] of Object.entries(MODE_PRESETS)) {
    assert.ok(Number.isInteger(preset.maxQuestions), `${name}.maxQuestions`)
    assert.ok(Number.isInteger(preset.clarifyRounds))
    assert.ok(typeof preset.decomposeFirst === 'boolean')
    assert.ok(['gate', 'separate', 'off'].includes(preset.playback))
  }
})
