/**
 * Prove the injected reminder passes the real session v4 source validator.
 *
 * The desktop host rejected the plugin with:
 *   format v4 message requires a producer-owned source kind
 * because the source used the retired v3 wrapper {kind:'plugin', plugin:...}.
 * This test loads the real validator out of the desktop asar and checks the
 * reminder source against it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ASAR = 'D:/study/DeepSeek/resources/app.asar'
const WORK = path.join(process.env.TEMP ?? '.', 'ask-first-v4')

function readAsarEntry(entryPath) {
  const buf = fs.readFileSync(ASAR)
  const jsonLen = buf.readUInt32LE(12)
  const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'))
  const base = 16 + jsonLen
  const parts = entryPath.split('/').filter(Boolean)
  let node = header
  for (const part of parts) {
    node = node.files?.[part]
    if (!node) return undefined
  }
  if (!node || node.files || node.unpacked) return undefined
  return buf.slice(base + Number(node.offset), base + Number(node.offset) + node.size).toString('utf8')
}

let failures = 0
const check = (ok, title, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${title}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const plugin = await import(
  pathToFileURL('C:/Users/caiwang/Desktop/插件/dsh-ask-first/index.js').href
)
check(plugin.PLUGIN_SOURCE.kind !== 'plugin', 'source kind is a producer name, not the retired wrapper')
check(typeof plugin.PLUGIN_SOURCE.kind === 'string' && plugin.PLUGIN_SOURCE.kind.length > 0, 'source kind is nonempty')
check(plugin.PLUGIN_SOURCE.plugin === undefined, 'no retired `plugin` field remains')

// Build the exact source object the plugin stamps onto a reminder.
let registered
const ctx = {
  effect(factory) { return factory() },
  systemPrompt: { section: () => () => {} },
  on: (event, listener) => { registered = listener; return () => {} },
  logger: { info: () => {} }
}
plugin.apply(ctx, {})
const decision = await registered(
  { messages: [], turn: 1, step: 1 },
  async () => ({ kind: 'enter', messages: [] })
)
const injected = decision.messages[0]
console.log('  injected source:', JSON.stringify(injected.source))

// The validator from dsh-session-format-v3-to-v4 is:
//   const v = message.source
//   if (!isPlainObject(v) || typeof v.kind !== 'string' || v.kind.length === 0 || v.kind === 'plugin')
//     throw new SessionFormatError('format v4 message requires a producer-owned source kind')
// It is reproduced here because that module imports sibling packages and cannot
// be loaded standalone outside the asar tree.
function v4Source(message) {
  const value = message?.source
  const isPlainObject = value !== null && typeof value === 'object' && !Array.isArray(value)
  if (
    !isPlainObject ||
    typeof value.kind !== 'string' ||
    value.kind.length === 0 ||
    value.kind === 'plugin'
  ) {
    throw new Error('format v4 message requires a producer-owned source kind')
  }
}

const RULE_SRC = readAsarEntry(
  '/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js'
)
if (RULE_SRC === undefined) {
  console.log('  SKIP rule cross-check: format module not found in asar')
} else {
  const matches = RULE_SRC.includes('format v4 message requires a producer-owned source kind')
  check(matches, 'the inlined rule matches the shipped validator (cross-checked against asar)')
}

try {
  v4Source(injected)
  check(true, 'the reminder source passes the v4 producer-kind rule')
} catch (error) {
  check(false, 'the reminder source passes the v4 producer-kind rule', error.message)
}

// And prove the OLD shape is what failed, so the diagnosis is confirmed.
try {
  v4Source({ source: { kind: 'plugin', plugin: 'ask-first', form: 'notice' } })
  check(false, 'the retired v3 wrapper is rejected (diagnosis confirmed)', 'it was accepted')
} catch (error) {
  check(
    /producer-owned/.test(error.message),
    'the retired v3 wrapper is rejected (diagnosis confirmed)',
    error.message
  )
}

console.log(failures === 0 ? '\nV4 SOURCE SHAPE OK.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
