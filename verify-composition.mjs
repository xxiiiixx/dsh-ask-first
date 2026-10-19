/**
 * Composition check: compose the desktop profile through the real loader and
 * assert the ask-first row is present, enabled, and resolvable.
 *
 * This is the "will the desktop app actually mount it?" proof. It is the
 * complement of verify-wiring.mjs, which proves the mounted plugin *works*.
 *
 * Machine-specific by design: it reads the local desktop profile. Bundles that
 * do not resolve are reported and skipped, so one pre-existing broken link in a
 * profile does not hide whether ask-first is wired correctly.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const profileDir = join(homedir(), '.dsh', 'profiles', 'desktop')
const manifestPath = join(profileDir, 'package.json')

if (!existsSync(manifestPath)) {
  console.warn('SKIP: no desktop profile at', profileDir)
  process.exit(0)
}

const require = createRequire(manifestPath)
let boot
try {
  boot = await import('file:///' + require.resolve('@deepseek-ai/dsh-app-boot').replace(/\\/g, '/'))
} catch (error) {
  console.warn('SKIP: @deepseek-ai/dsh-app-boot is not resolvable from the desktop profile —', error.message)
  process.exit(0)
}

const anchorCandidates = [
  join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/package.json'),
  join(profileDir, 'node_modules/@deepseek-ai/dsh/package.json'),
  join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/package.json'.replace(/^\/+/, ''))
]
const anchor = anchorCandidates.find((path) => path !== '' && existsSync(path))

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = manifest?.dsh?.profile?.bundles ?? []

const resolvable = []
const broken = []
for (const name of bundles) {
  try {
    require.resolve(name + '/package.json')
    resolvable.push(name)
  } catch {
    broken.push(name)
  }
}
if (broken.length > 0) console.warn('WARN: unresolvable bundles skipped:', broken.join(', '))

const layers = []
for (const packageName of resolvable) {
  let packageDir
  try {
    packageDir = boot.resolveBundleDir('dsh', packageName, anchor, profileDir)
  } catch (error) {
    console.warn('WARN: bundle dir unresolved, skipped:', packageName, '—', error.message)
    continue
  }
  const declared = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).dsh?.bundle?.patch
  if (declared === undefined) {
    console.warn('WARN: bundle declares no dsh.bundle.patch, skipped:', packageName)
    continue
  }
  layers.push(boot.loadOverlayPatches('dsh', join(packageDir, declared)))
}

const entries = boot.composeEntries(layers, () => {})
const rows = entries.filter((entry) => String(entry.name ?? '').includes('ask-first'))

let failures = 0
const check = (ok, title, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${title}${ok ? '' : `\n       ${detail}`}`)
  if (!ok) failures += 1
}

check(rows.length === 1, 'exactly one ask-first row is composed', `found ${rows.length}`)
if (rows.length === 1) {
  const [row] = rows
  check(row.disabled !== true, 'the ask-first row is enabled')
  check(row.name === 'dsh-ask-first', 'the row names dsh-ask-first', String(row.name))
  let resolved
  try {
    resolved = require.resolve(row.name)
    check(true, 'the row resolves to a module', '')
    console.log('       →', resolved)
  } catch (error) {
    check(false, 'the row resolves to a module', error.message)
  }
}

console.log(failures === 0 ? '\nComposition OK.\n' : `\n${failures} composition check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
