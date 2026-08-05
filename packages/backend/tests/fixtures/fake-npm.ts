#!/usr/bin/env bun
// RFC-031 fake npm shim — minimal subset for installPlugin tests.
//
// RFC-254 T32: this was `fake-npm.sh`, which Windows cannot execute at all, so
// every test configuring `npmBin` with it died at spawn with EFTYPE. Rewriting
// it as a `.ts` entry that the runtime executes keeps the call SHELL-FREE —
// which matters here specifically, because one of the arguments is the
// user-controlled package spec and a `.cmd` rewrite would hand it to cmd.exe
// (measured: `a&whoami` executes). `resolveNpmCommand` turns a script path into
// `[runtime, path]`, so this file is spawned as an ordinary argv.
//
// It is also now type-checked with the rest of the suite, which the shell
// version never was.
//
// Supported modes (selected via FAKE_NPM_MODE):
//   --version   → prints "9.0.0\n", exit 0
//   install --prefix <dir> <spec>:
//     success (default) → creates <dir>/node_modules/<pkgName>/package.json
//                          with version=2.4.1 (or FAKE_NPM_VERSION if set)
//     fail        → two ERR! lines on stderr, exit 1
//     timeout     → sleeps longer than any reasonable test timeout
//     pause       → touch FAKE_NPM_PAUSE_STARTED, wait for FAKE_NPM_PAUSE_RELEASE
//     leak-secret → stderr carrying a credential, exit 1 (redaction fixture)
// Other commands → silently exit 0.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = Bun.argv.slice(2)
const mode = process.env.FAKE_NPM_MODE ?? 'success'

if (argv[0] === '--version') {
  process.stdout.write('9.0.0\n')
  process.exit(0)
}

if (argv[0] !== 'install') process.exit(0)

const counterFile = process.env.FAKE_NPM_COUNTER_FILE
if (counterFile !== undefined && counterFile.length > 0) appendFileSync(counterFile, 'install\n')

// Find `--prefix` and the last positional spec, exactly as the shell version's
// argument walk did: flags are consumed, anything else becomes the spec, and a
// later positional overwrites an earlier one.
let prefix = ''
let spec = ''
for (let i = 1; i < argv.length; i += 1) {
  const arg = argv[i]!
  if (arg === '--prefix') {
    prefix = argv[i + 1] ?? ''
    i += 1
    continue
  }
  if (arg.startsWith('-')) continue
  spec = arg
}

if (mode === 'fail') {
  process.stderr.write(`ERR! 404 Not Found - GET https://registry.example.com/fake/${spec}\n`)
  process.stderr.write(`ERR! 404 ${spec} is not in the npm registry.\n`)
  process.exit(1)
}

if (mode === 'timeout') {
  // Longer than any reasonable test timeout; the runner kills it.
  Bun.sleepSync(300_000)
  process.exit(0)
}

if (mode === 'pause') {
  const started = process.env.FAKE_NPM_PAUSE_STARTED
  const release = process.env.FAKE_NPM_PAUSE_RELEASE
  if (started === undefined || release === undefined) {
    process.stderr.write('FAKE_NPM_PAUSE_STARTED and FAKE_NPM_PAUSE_RELEASE are required\n')
    process.exit(1)
  }
  writeFileSync(started, '')
  while (!existsSync(release)) Bun.sleepSync(10)
}

if (mode === 'leak-secret') {
  // Used to verify redactSensitiveString catches secrets in stderr.
  process.stderr.write(
    'ERR! Failed at https://x-token-auth:SUPER_SECRET_TOKEN_123@example.com/foo\n',
  )
  process.exit(1)
}

// Success path. `${SPEC%@*}` strips from the LAST `@`, and does nothing when
// there is none — reproduced exactly, including the scoped-without-version case
// where the shell version also yielded an empty name.
const at = spec.lastIndexOf('@')
const pkgName = at >= 0 ? spec.slice(0, at) : spec
const installDir = pkgName.startsWith('@')
  ? join(
      prefix,
      'node_modules',
      pkgName.slice(0, pkgName.indexOf('/')),
      pkgName.slice(pkgName.indexOf('/') + 1),
    )
  : join(prefix, 'node_modules', pkgName)
const version = process.env.FAKE_NPM_VERSION ?? '2.4.1'

// Mimic real `npm install`: drop transitive deps into node_modules/ with
// DIFFERENT (misleading) versions, so any code that picks "the installed
// package" by walking node_modules blindly resolves the wrong package.json.
// Decoys are created BEFORE the requested package so a creation-ordered
// filesystem returns a decoy first — that is how the production bug manifested.
for (const decoy of ['aaa-decoy-transitive', 'zzz-decoy-transitive']) {
  const dir = join(prefix, 'node_modules', decoy)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: decoy, version: '9.9.9', main: 'index.js' }, null, 2)}\n`,
  )
}

mkdirSync(installDir, { recursive: true })
writeFileSync(
  join(installDir, 'package.json'),
  `${JSON.stringify({ name: pkgName, version, main: 'index.js' }, null, 2)}\n`,
)
writeFileSync(join(installDir, 'index.js'), "export default { id: 'fake' }\n")

// Mimic npm's default --save: record the requested package under the host
// package.json's dependencies, which is the installer's signal for WHICH
// node_modules entry the user actually asked for. The host file is always
// seeded with a literal `"dependencies": {}` by installPluginInner, so the same
// naive substitution the shell version did is faithful.
const hostPkg = join(prefix, 'package.json')
if (existsSync(hostPkg)) {
  const text = readFileSync(hostPkg, 'utf8')
  writeFileSync(
    hostPkg,
    text.replace(/"dependencies":\s*\{\}/, `"dependencies": { "${pkgName}": "^${version}" }`),
  )
}

// RFC-201 immutable-generation identity fixture. Real npm writes this lock
// entry; the installer requires resolved+integrity for npm and a final commit
// SHA for git instead of trusting package.json.version display text.
const isGit = /^(?:git\+|github:|gitlab:|bitbucket:)/.test(spec)
const commit = process.env.FAKE_NPM_COMMIT ?? '0123456789abcdef0123456789abcdef01234567'
const bare = pkgName.slice(pkgName.lastIndexOf('/') + 1)
const resolved = isGit
  ? `git+https://example.test/${pkgName}.git#${commit}`
  : `https://registry.example.test/${pkgName}/-/${bare}-${version}.tgz`
writeFileSync(
  join(prefix, 'package-lock.json'),
  `${JSON.stringify(
    {
      name: 'aw-plugin-host',
      lockfileVersion: 3,
      packages: {
        [`node_modules/${pkgName}`]: {
          version,
          resolved,
          integrity: `sha512-fake-${version}`,
          gitHead: isGit ? commit : null,
        },
      },
    },
    null,
    2,
  )}\n`,
)
process.exit(0)
