/**
 * End-to-end proof against the INSTALLED copy (profile/node_modules), not the
 * workspace source: mount it on a real cordis Context with the shipped
 * dsh-system-prompt registry, then read what the model would actually receive.
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const profileDir = join(homedir(), '.dsh', 'profiles', 'desktop')
const require = createRequire(join(profileDir, 'package.json'))

const importEsm = async (spec) => import('file:///' + require.resolve(spec).replace(/\\/g, '/'))

const { Context } = await importEsm('@deepseek-ai/cordis')
const systemPrompt = await importEsm('@deepseek-ai/dsh-system-prompt')

// Resolve through the profile exactly as the loader does.
const installedEntry = require.resolve('dsh-ask-first')
console.log('installed entry:', installedEntry)
const plugin = await import('file:///' + installedEntry.replace(/\\/g, '/'))

const ctx = new Context()
ctx.plugin(systemPrompt.default)
await new Promise((r) => setTimeout(r, 50))

const fn = plugin.apply
fn.inject = plugin.inject
ctx.plugin(fn)
await new Promise((r) => setTimeout(r, 50))

const { renderPrompt } = systemPrompt
const assembly = await ctx.systemPrompt.assemble()
const text = renderPrompt(assembly)

let fail = 0
const check = (ok, title, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${title}${ok ? '' : ` — ${detail}`}`)
  if (!ok) fail += 1
}

check(text.includes('## Asking instead of assuming'), 'policy section is in the assembled prompt')
check(text.includes('Ambiguous goal'), 'ambiguity classes present')
check(text.includes('ask_user_question'), 'names the tool to use')
check(text.includes('delegated subagent'), 'covers the subagent case')
check(text.includes('must not be re-confirmed'), 'states the anti-over-asking rule')

const names = assembly.sections.map((s) => s.name)
check(names.includes(plugin.SECTION_NAME), 'section registered under its documented name')
check(names[names.length - 1] === plugin.SECTION_NAME, 'section sorts last', names.join(' | '))

const decision = await ctx.waterfall(
  'agent/pre-step',
  { agent: { id: 'probe', options: {}, session: { header: {} } }, messages: [], turn: 1, step: 1, signal: undefined },
  async () => ({ kind: 'enter', messages: [] })
)
const injected = decision.messages.filter((m) => m.source?.plugin === 'ask-first')
check(injected.length === 1, 'exactly one plugin-sourced reminder injected', String(injected.length))
const reminderText = injected[0]?.content?.[0]?.text ?? ''
check(reminderText.includes('<system-reminder>'), 'reminder is system-reminder framed')
check(reminderText.includes('ask_user_question'), 'reminder names the tool')

console.log(fail === 0 ? '\nINSTALLED COPY VERIFIED.\n' : `\n${fail} check(s) failed.\n`)
process.exit(fail === 0 ? 0 : 1)
