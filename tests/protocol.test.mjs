import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  buildProtocol,
  resolveConfig,
  DEFAULT_DIMENSIONS,
  DEFAULT_GATE_QUESTION_ID,
} from '../index.js'

test('resolveConfig fills defaults', () => {
  const c = resolveConfig({})
  assert.equal(c.minQuestions, 1)
  assert.equal(c.maxQuestions, 6)
  assert.equal(c.reaskOnSkip, true)
  assert.equal(c.extraRules, '')
  assert.deepEqual(c.dimensions, DEFAULT_DIMENSIONS)
  assert.equal(c.gateQuestionId, DEFAULT_GATE_QUESTION_ID)
  assert.ok(c.gateQuestion.length > 0)
  assert.ok(c.gateGoOption.length > 0)
  assert.ok(c.gateReviseOption.length > 0)
  assert.ok(c.gateAddOption.length > 0)
})

test('resolveConfig rejects unknown keys', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown key/)
})

test('resolveConfig rejects wrong types', () => {
  assert.throws(() => resolveConfig({ minQuestions: 'x' }), /must be an integer/)
  assert.throws(() => resolveConfig({ reaskOnSkip: 'yes' }), /must be a boolean/)
  assert.throws(() => resolveConfig({ dimensions: [1, 2] }), /array of non-empty strings/)
  assert.throws(() => resolveConfig({ dimensions: [] }), /must not be empty/)
  assert.throws(() => resolveConfig({ gateQuestion: ' ' }), /non-empty string/)
})

test('resolveConfig clamps range bounds', () => {
  const c = resolveConfig({ minQuestions: 50 })
  // min is clamped to its own max of 10, then max clamps up to it.
  assert.equal(c.minQuestions, 10)
  assert.equal(c.maxQuestions, 10)
  const swapped = resolveConfig({ minQuestions: 5, maxQuestions: 2 })
  assert.equal(swapped.minQuestions, 5)
  assert.equal(swapped.maxQuestions, 5)
})

test('buildProtocol renders the gate question and its fixed id', () => {
  const text = buildProtocol(resolveConfig({}))
  assert.ok(text.includes('id `execute_gate`'))
  assert.ok(text.includes('这份计划方向清单是否满足你的需求？是否开始执行任务？'))
  assert.ok(text.includes('满足，开始执行'))
  assert.ok(text.includes('between 1 and 6'))
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

test('apply registers the section with validated config', () => {
  const sections = []
  const effects = []
  const ctx = {
    systemPrompt: { section: (spec) => { sections.push(spec); return () => {} } },
    // Cordis ctx.effect runs the registration callback immediately and uses
    // its return value as the disposer.
    effect: (register) => { register(); return () => {} },
  }
  apply(ctx, { minQuestions: 2 })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'ask-every-protocol')
  assert.equal(sections[0].order, 10400)
  assert.equal(sections[0].interpolate, false)
  assert.ok(sections[0].text.includes('between 2 and 6'))
  // Invalid config fails activation rather than being ignored.
  assert.throws(() => apply(ctx, { minQuestions: 'bad' }), /must be an integer/)
  // Missing systemPrompt service: apply is a no-op, not a crash.
  apply({}, {})
})

test('apply is a no-op without a systemPrompt registry', () => {
  assert.doesNotThrow(() => apply({}, {}))
})
