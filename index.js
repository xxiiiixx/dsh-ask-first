/**
 * Ask First — an advisory "ask instead of assuming" guard for DeepSeek Harness.
 *
 * The plugin never blocks a tool call and never rewrites a model message. It
 * contributes exactly two model-visible surfaces:
 *
 * 1. One static system-prompt section (`ask-first:policy`) that states the
 *    behaviour contract: when the request is ambiguous, ask before deciding.
 * 2. One per-turn user-role reminder appended to the entering pre-step
 *    decision, so the contract is restated at the moment a turn actually
 *    starts rather than only once in the system prompt.
 *
 * Both surfaces are ordinary harness extension points:
 *   - `ctx.systemPrompt.section()` registers the static section.
 *   - `ctx.on('agent/pre-step')` appends the reminder to `decision.messages`.
 *
 * Every setting has a default, so the row mounts with no config at all. A
 * malformed value fails loud at load time instead of silently degrading the
 * guard into a no-op.
 *
 * @module dsh-ask-first
 */

/** Cordis plugin name. */
export const name = 'ask-first'

/** The prompt registry this row contributes to; it is the only hard dependency. */
export const inject = ['systemPrompt']

/**
 * Section name. The `ask-first:` prefix keeps it out of the shipped
 * `harness:`/`deployment:`/`tool:` bands the runtime already owns.
 */
export const SECTION_NAME = 'ask-first:policy'

/**
 * Order band for the section. `-100` is harness identity and `0` is the
 * deployment persona; `100-199` is owned by shipped tool guidance. Sitting at
 * 150 puts the behaviour contract after all tool guidance, which is where an
 * always-apply behavioural rule reads best.
 */
export const SECTION_ORDER = 150

/**
 * Source stamped on the per-turn reminder. `kind: 'plugin'` is load-bearing:
 * an unlabeled injected message would render as a user prompt in derived
 * history, while a plugin source stays source-attributed and reconstructable
 * from the session log.
 */
export const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'ask-first' }

/**
 * The six ambiguity classes selected for this deployment. Kept as structured
 * data so `topics` can enable a subset without editing prompt prose by hand.
 */
export const TOPICS = {
  ambiguous:
    '**Ambiguous goal.** The request can reasonably produce two materially different results. State the interpretations you see and ask which one is wanted.',
  missing:
    '**Missing key parameters.** A path, file name, scope, format, data source, or target is unspecified and guessing would waste the work. Ask for the missing details.',
  destructive:
    '**Destructive or irreversible actions.** Deleting, overwriting, force-pushing, committing, publishing, or editing files in bulk. Confirm the exact target and scope first.',
  tradeoff:
    '**Real trade-offs.** Performance against readability, speed against robustness, or narrow against broad scope. Ask which side to optimise for.',
  design:
    '**Design choices with lasting maintenance cost.** Selecting a library, an architecture, or a file layout that later work must live with. Ask before committing to one.',
  mismatch:
    '**Reality diverging from the expectation.** A test fails, a file is absent, or an API differs from what was assumed. Ask whether to adapt the plan instead of silently working around it.'
}

/** Every topic name, in the canonical order used for rendering. */
export const TOPIC_NAMES = Object.keys(TOPICS)

/**
 * Canonicalise a topic list: trim, lowercase, drop empties, deduplicate while
 * preserving the canonical `TOPICS` order. Returns `undefined` when the caller
 * supplied no valid topic so the caller can fall back to "all".
 */
function normalizeTopics(values) {
  if (!Array.isArray(values)) return undefined
  const wanted = new Set()
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const key = raw.trim().toLowerCase()
    if (key !== '') wanted.add(key)
  }
  if (wanted.size === 0) return undefined
  return TOPIC_NAMES.filter((key) => wanted.has(key))
}

/** Render the topic bullets in canonical order. */
export function renderTopics(topics) {
  return topics.map((key) => TOPICS[key]).join('\n')
}

/**
 * Build the static system-prompt section text. Deterministic for a given
 * configuration, so the rendered system prompt stays byte-identical across
 * steps and the KV-cache prefix is not disturbed.
 */
export function renderPolicy(topics) {
  return [
    '## Asking instead of assuming',
    '',
    'This session runs with an ask-first policy. Its purpose is to keep judgement with the person you are working for: when a detail is genuinely unclear, ask that person instead of choosing for them. A short question costs seconds; an unstated assumption can cost a whole task.',
    '',
    'Ask before you act in any of these situations:',
    '',
    renderTopics(topics),
    '',
    'When you do ask:',
    '',
    '- Use the `ask_user_question` tool so the question is attached to the run instead of being buried in prose.',
    '- Ask only what you cannot determine otherwise. Inspect the workspace, read the files, and search the code first; never ask for something you can find out yourself.',
    '- Keep it to the decision that blocks progress, and offer the plausible options with a recommendation when one is clearly better.',
    '- If several questions are needed, ask them together in one call rather than one at a time.',
    '- If you are a delegated subagent, `ask_user_question` will be rejected: you cannot reach the human directly. Do not stall and do not guess silently — finish with the unresolved question stated explicitly in your final result, so the delegating agent can put it to the user.',
    '',
    'This policy is deliberately advisory. It does not forbid autonomy and it does not require a question for every turn: routine, well-specified work proceeds without interruption, and a request that is already clear must not be re-confirmed. The rule is only that an unresolved ambiguity is settled by the person who owns it, not by you.'
  ].join('\n')
}

/**
 * The per-turn reminder. Deliberately terse: the full contract lives in the
 * system prompt, and this line only re-anchors attention at turn start.
 */
export function renderReminder(topics) {
  const named =
    topics.length === TOPIC_NAMES.length
      ? 'the ambiguity classes listed in the ask-first system-prompt section'
      : renderTopics(topics)
  return [
    '<system-reminder>',
    'ask-first: if anything blocking is still unclear, use `ask_user_question` before you continue instead of deciding on the user\'s behalf. This covers ' +
      named +
      '.',
    'Do not ask when the request is already clear, and do not ask for facts you can read from the workspace. This is a reminder, not a mandate to interrupt.',
    '</system-reminder>'
  ].join('\n')
}

/** Create a message without importing harness value types (keeps peers optional). */
function createUserMessage(text, summary) {
  return {
    id: `ask-first:${crypto.randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE, form: 'notice', summary }
  }
}

/** Whether an injected message already carries this plugin's source. */
function sameSource(message) {
  const source = message?.source
  return source?.kind === 'plugin' && source?.plugin === PLUGIN_SOURCE.plugin
}

/**
 * Validate configuration fail-loud. A bad `topics` value or an unknown
 * `reminder` mode throws at load instead of silently disabling part of the
 * guard.
 */
export function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}

  for (const value of Array.isArray(raw.topics) ? raw.topics : []) {
    if (typeof value !== 'string') {
      throw new Error(`ask-first: \`topics\` entries must be strings, got ${typeof value}`)
    }
    const key = value.trim().toLowerCase()
    if (key === '') continue
    if (!Object.hasOwn(TOPICS, key)) {
      throw new Error(
        `ask-first: unknown topic ${JSON.stringify(value)}; expected one of ${TOPIC_NAMES.join(', ')}`
      )
    }
  }

  const topics = normalizeTopics(raw.topics) ?? [...TOPIC_NAMES]

  const reminderConfig = raw.reminder
  const reminderAt = (() => {
    if (reminderConfig === false) return 'off'
    if (reminderConfig === undefined || reminderConfig === true) return 'turn'
    const value = String(reminderConfig).trim().toLowerCase()
    if (value === 'turn' || value === 'step' || value === 'off') return value
    throw new Error(
      `ask-first: \`reminder\` must be true, false, "turn", "step", or "off"; got ${JSON.stringify(reminderConfig)}`
    )
  })()

  return { topics, reminder: reminderAt !== 'off', reminderAt }
}

/**
 * Install the plugin.
 *
 * @param ctx - plugin context; the section and listener are scoped to it and
 *   disposed with its fiber.
 * @param config - raw user configuration from the profile row.
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: renderPolicy(settings.topics)
      }),
    'ask-first.section()'
  )

  ctx.on(
    'agent/pre-step',
    async ({ messages, turn, step }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (!settings.reminder) return decision

      // `reminderAt: 'turn'` (default) reminds only at the first step of a turn,
      // so a long multi-step turn is not re-reminded on every step.
      if (settings.reminderAt === 'turn' && step !== 1) return decision

      // The reminder is a per-turn reminder, not a per-session one: on later
      // turns the previous turn's copy is already in history, so re-adding it
      // is intended. Only skip a duplicate inside the same entering batch.
      if (messages.some((message) => sameSource(message))) return decision

      return {
        kind: 'enter',
        messages: [
          ...decision.messages,
          createUserMessage(renderReminder(settings.topics), `ask-first reminder · turn ${String(turn)}`)
        ]
      }
    },
    { prepend: true }
  )

  ctx.logger?.info?.(
    'ask-first: policy section %s active (topics: %s; reminder: %s)',
    SECTION_NAME,
    settings.topics.join(', '),
    settings.reminderAt
  )
}

export default { name, inject, apply }
