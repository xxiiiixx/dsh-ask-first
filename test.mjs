/**
 * Behavioural test for dsh-ask-first, run against a minimal fake `ctx`.
 *
 * The fake mirrors the exact contract the real harness exposes:
 *   - `ctx.effect(factory, label)` runs the factory and records its disposer
 *   - `ctx.systemPrompt.section(section)` records the registration
 *   - `ctx.on(event, listener, options)` records the listener
 *
 * This is a unit test of the plugin's own logic, not of the harness.
 */

import assert from 'node:assert/strict'
import { apply, SECTION_NAME, SECTION_ORDER, TOPICS, TOPIC_NAMES, normalizeConfig, renderPolicy, renderReminder } from './index.js'

let failures = 0
function test(title, fn) {
  try {
    fn()
    console.log(`  ok   ${title}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${title}\n       ${error.message}`)
  }
}

/** Build a fake plugin context that records what the plugin registers. */
function createFakeCtx() {
  const sections = []
  const listeners = []
  const infos = []
  const ctx = {
    effect(factory, label) {
      const dispose = factory()
      return () => {
        dispose?.()
        return label
      }
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      }
    },
    on(event, listener, options) {
      listeners.push({ event, listener, options })
      return () => {}
    },
    logger: { info: (...args) => infos.push(args) }
  }
  return { ctx, sections, listeners, infos }
}

/** Drive one pre-step through the registered listener. */
async function runPreStep(record, { messages = [], turn = 1, step = 1 } = {}) {
  const next = async () => ({ kind: 'enter', messages })
  return record.listener({ agent: {}, messages, turn, step, signal: undefined }, next)
}

console.log('\n── config validation ──')
test('defaults mount with an empty config', () => {
  const settings = normalizeConfig({})
  assert.deepEqual(settings.topics, TOPIC_NAMES)
  assert.equal(settings.reminder, true)
  assert.equal(settings.reminderAt, 'turn')
})

test('undefined config behaves like empty config', () => {
  assert.deepEqual(normalizeConfig(undefined).topics, TOPIC_NAMES)
  assert.deepEqual(normalizeConfig(null).topics, TOPIC_NAMES)
})

test('a topic subset is canonicalised to TOPIC_NAMES order', () => {
  const settings = normalizeConfig({ topics: ['MISMATCH', 'ambiguous', 'ambiguous', ''] })
  assert.deepEqual(settings.topics, ['ambiguous', 'mismatch'])
})

test('an unknown topic throws (fail loud)', () => {
  assert.throws(() => normalizeConfig({ topics: ['bad-name'] }), /unknown topic/)
})

test('a non-string topic throws', () => {
  assert.throws(() => normalizeConfig({ topics: [42] }), /must be strings/)
})

test('reminder: false disables the reminder but keeps topics', () => {
  const settings = normalizeConfig({ reminder: false })
  assert.equal(settings.reminder, false)
  assert.equal(settings.reminderAt, 'off')
})

test('reminder: "step" and "off" are accepted', () => {
  assert.equal(normalizeConfig({ reminder: 'step' }).reminderAt, 'step')
  assert.equal(normalizeConfig({ reminder: 'off' }).reminder, false)
})

test('an unknown reminder value throws', () => {
  assert.throws(() => normalizeConfig({ reminder: 'always' }), /must be true, false/)
})

console.log('\n── rendered text ──')
test('policy names every enabled topic', () => {
  const text = renderPolicy(TOPIC_NAMES)
  for (const name of TOPIC_NAMES) assert.ok(text.includes(TOPICS[name]), `missing ${name}`)
})

test('policy states the anti-over-asking counterweight', () => {
  const text = renderPolicy(TOPIC_NAMES)
  assert.ok(text.includes('must not be re-confirmed'), 'missing the "do not re-confirm" rule')
  assert.ok(text.includes('never ask for something you can find out yourself'), 'missing the inspect-first rule')
})

test('a subset policy omits disabled topics', () => {
  const text = renderPolicy(['ambiguous'])
  assert.ok(text.includes(TOPICS.ambiguous))
  assert.ok(!text.includes(TOPICS.design))
})

test('reminder is framed as a system-reminder and names the tool', () => {
  const text = renderReminder(TOPIC_NAMES)
  assert.ok(text.startsWith('<system-reminder>'))
  assert.ok(text.endsWith('</system-reminder>'))
  assert.ok(text.includes('ask_user_question'))
})

console.log('\n── registration ──')
test('apply registers exactly one section with the documented name/order', () => {
  const { ctx, sections } = createFakeCtx()
  apply(ctx, {})
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, SECTION_NAME)
  assert.equal(sections[0].order, SECTION_ORDER)
  assert.equal(typeof sections[0].text, 'string')
  assert.ok(sections[0].text.length > 100)
})

test('apply registers exactly one agent/pre-step listener, prepended', () => {
  const { ctx, listeners } = createFakeCtx()
  apply(ctx, {})
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'agent/pre-step')
  assert.deepEqual(listeners[0].options, { prepend: true })
})

console.log('\n── pre-step behaviour ──')
test('step 1 of a turn gets one plugin-sourced reminder', async () => {
  const { ctx, listeners } = createFakeCtx()
  apply(ctx, {})
  const decision = await runPreStep(listeners[0], { turn: 1, step: 1 })
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1)
  const [message] = decision.messages
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.plugin, 'ask-first')
  assert.ok(message.content[0].text.includes('ask_user_question'))
})

test('later steps of the same turn are NOT re-reminded (turn scope)', async () => {
  const { ctx, listeners } = createFakeCtx()
  apply(ctx, {})
  const decision = await runPreStep(listeners[0], { turn: 1, step: 3 })
  assert.equal(decision.messages.length, 0)
})

test('reminder: "step" reminds on every step', async () => {
  const { ctx, listeners } = createFakeCtx()
  apply(ctx, { reminder: 'step' })
  const decision = await runPreStep(listeners[0], { turn: 1, step: 3 })
  assert.equal(decision.messages.length, 1)
})

test('reminder: false emits nothing but still registers the section', async () => {
  const { ctx, sections, listeners } = createFakeCtx()
  apply(ctx, { reminder: false })
  assert.equal(sections.length, 1)
  const decision = await runPreStep(listeners[0], { turn: 1, step: 1 })
  assert.equal(decision.messages.length, 0)
})

test('a rejected pre-step is passed through untouched', async () => {
  const { ctx, listeners } = createFakeCtx()
  apply(ctx, {})
  const decision = await listeners[0].listener({ agent: {}, messages: [], turn: 1, step: 1 }, async () => ({ kind: 'reject' }))
  assert.deepEqual(decision, { kind: 'reject' })
})

test('an existing ask-first message in the batch is not duplicated', async () => {
  const { ctx, listeners } = createFakeCtx()
  apply(ctx, {})
  const existing = { role: 'user', content: [], source: { kind: 'plugin', plugin: 'ask-first' } }
  const decision = await runPreStep(listeners[0], { messages: [existing], turn: 1, step: 1 })
  assert.equal(decision.messages.length, 1)
})

test('an unrelated plugin message does not suppress the reminder', async () => {
  const { ctx, listeners } = createFakeCtx()
  apply(ctx, {})
  const other = { role: 'user', content: [], source: { kind: 'plugin', plugin: 'time-context' } }
  const decision = await runPreStep(listeners[0], { messages: [other], turn: 1, step: 1 })
  assert.equal(decision.messages.length, 2)
})

test('the claimed user message is preserved ahead of the reminder', async () => {
  const { ctx, listeners } = createFakeCtx()
  apply(ctx, {})
  const claimed = { role: 'user', content: [{ type: 'text', text: 'do the thing' }], source: { kind: 'user' } }
  const decision = await runPreStep(listeners[0], { messages: [claimed], turn: 1, step: 1 })
  assert.equal(decision.messages[0], claimed)
  assert.equal(decision.messages.length, 2)
})

test('rendered text is deterministic for a fixed config (KV-cache safe)', () => {
  assert.equal(renderPolicy(TOPIC_NAMES), renderPolicy(normalizeConfig({}).topics))
  assert.equal(renderReminder(TOPIC_NAMES), renderReminder(normalizeConfig({}).topics))
})

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
