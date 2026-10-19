/**
 * Integration test: mount dsh-ask-first on a real cordis Context and a real
 * `dsh-system-prompt` registry, then assert what the model would actually see.
 *
 * This exercises the plugin against the shipped services instead of a fake,
 * which is the part the unit test cannot prove.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'

const profileDir = join(homedir(), '.dsh', 'profiles', 'desktop')
const require = createRequire(join(profileDir, 'package.json'))

const importEsm = async (specifier) =>
  import('file:///' + require.resolve(specifier).replace(/\\/g, '/'))

const { Context } = await importEsm('@deepseek-ai/cordis')
const systemPrompt = await importEsm('@deepseek-ai/dsh-system-prompt')

// Resolve the plugin relative to this file, so the script keeps working
// wherever the source tree lives.
const pluginPath = join(fileURLToPath(new URL('.', import.meta.url)), 'index.js')
const plugin = await import('file:///' + pluginPath.replace(/\\/g, '/'))

let failures = 0
const check = (ok, title, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${title}${ok ? '' : `\n       ${detail}`}`)
  if (!ok) failures += 1
}

const ctx = new Context()
ctx.plugin(systemPrompt.default)
await new Promise((resolve) => setTimeout(resolve, 50))

// Mount the plugin exactly as the loader would: cordis takes the apply
// function, with `inject` attached as its own property.
const pluginFn = plugin.apply
pluginFn.inject = plugin.inject
ctx.plugin(pluginFn)
await new Promise((resolve) => setTimeout(resolve, 50))

const assembly = await ctx.systemPrompt.assemble()
const section = assembly.sections.find((entry) => entry.name === plugin.SECTION_NAME)

// The assembled section holds the raw template; renderPrompt interpolates it.
const { renderPrompt } = systemPrompt
const rendered = renderPrompt(assembly)

check(section !== undefined, 'the ask-first section reaches the real registry')
{
  // `AssembledSection` carries only name/text — `order` decides the sort and is
  // not preserved. Prove the position instead: the 150 band must sort after the
  // harness identity (-100) and the deployment persona (0).
  const names = assembly.sections.map((entry) => entry.name)
  const at = names.indexOf(plugin.SECTION_NAME)
  const identityAt = names.indexOf('harness:identity')
  check(at > 0, 'the ask-first section is not first', names.join(' | '))
  check(
    identityAt === -1 || at > identityAt,
    'the ask-first section sorts after the harness identity',
    names.join(' | ')
  )
  check(at === names.length - 1, 'the ask-first section is the last static section', names.join(' | '))
}
check(rendered.includes('## Asking instead of assuming'), 'the rendered prompt contains the policy heading')
check(rendered.includes('Ambiguous goal'), 'the rendered prompt names the ambiguity classes')
check(rendered.includes('ask_user_question'), 'the rendered prompt names the tool to use')
check(rendered.includes('delegated subagent'), 'the rendered prompt covers the subagent case')

// A second assembly must be byte-identical (KV-cache safety).
const second = renderPrompt(await ctx.systemPrompt.assemble())
check(second === rendered, 'two assemblies render identically')

// The pre-step listener must be registered on the real context.
let seen = 0
const decision = await ctx.waterfall('agent/pre-step', { agent: { id: 'probe' }, messages: [], turn: 1, step: 1, signal: undefined }, async () => {
  seen += 1
  return { kind: 'enter', messages: [] }
})
check(seen === 1, 'the listener delegates to next()')
check(decision.kind === 'enter', 'the decision stays enter')
check(
  decision.messages.some((message) => message.source?.plugin === 'ask-first'),
  'the entering decision carries a plugin-sourced reminder',
  JSON.stringify(decision.messages.map((m) => m.source))
)

const text = decision.messages.find((m) => m.source?.plugin === 'ask-first')?.content?.[0]?.text ?? ''
check(text.includes('<system-reminder>'), 'the reminder is framed as a system reminder')
check(text.includes('ask_user_question'), 'the reminder names the tool')

console.log(failures === 0 ? '\nIntegration OK.\n' : `\n${failures} integration check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
