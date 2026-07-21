// P-5-05 build pipeline — produces a single executable that contains the
// daemon, the compiled frontend, and the drizzle migrations.
//
// Steps:
//   1. `bun --filter @agent-workflow/frontend build` → packages/frontend/dist/
//   2. Walk that dist + packages/backend/db/migrations and rewrite
//      packages/backend/src/embed.generated.ts with `import … with
//      { type: 'file' }` declarations for every file. The runtime helpers in
//      packages/backend/src/embed.ts read from those imports.
//   3. `bun build packages/backend/src/main.ts --compile --target=bun
//      --outfile=dist/agent-workflow-<platform>-<arch>`
//   4. Restore the stub embed.generated.ts so subsequent dev / typecheck /
//      lint runs don't see stale generated content.
//
// Run from the repo root: `bun run scripts/build-binary.ts`.
//
// Notes:
//   - This intentionally does no cross-compilation. Run it on each target OS.
//     CI invokes it per matrix entry.
//   - The binary name follows the design.md convention: macos / linux + arm64
//     / x86_64. (`process.arch` returns 'x64' for x86_64; we rename it.)

import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, posix, relative, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const repoRoot = resolve(import.meta.dirname, '..')
const frontendDist = join(repoRoot, 'packages', 'frontend', 'dist')
const migrationsDir = join(repoRoot, 'packages', 'backend', 'db', 'migrations')
const backendSrc = join(repoRoot, 'packages', 'backend', 'src')
// RFC-029: opencode plugin .mjs files that need to ride along inside the
// binary so the runner can copy them into per-run dirs at task time.
const pluginsDir = join(backendSrc, 'opencode-plugin')
const generatedPath = join(backendSrc, 'embed.generated.ts')
const mainEntry = join(backendSrc, 'main.ts')
const outDir = join(repoRoot, 'dist')

const STUB_CONTENTS = `// P-5-05 single-binary embed table.
//
// In dev this file is a stub — the backend reads frontend dist and migrations
// from the filesystem (paths.migrationsDir + the vite dev server). The
// \`scripts/build-binary.ts\` script rewrites this file with \`import … with
// { type: 'file' }\` statements for every embedded asset before running
// \`bun build --compile\`, so the compiled binary ships all of them inside its
// executable. Keep the stub committed so dev/typecheck/lint never fail
// because the file is missing.

export const IS_EMBEDDED = false

/** url-path -> embedded file path (resolves to a /$bunfs/... path at runtime). */
export const FRONTEND_FILES: Record<string, string> = {}

/** migrations-rel-path -> embedded file path. */
export const MIGRATION_FILES: Record<string, string> = {}

/**
 * RFC-029: opencode plugin asset table. Each entry maps a filename (no
 * path) to the embedded \`/$bunfs/...\` path at runtime. The runner copies
 * these into per-run dirs so opencode child processes can load them via
 * inline OPENCODE_CONFIG_CONTENT.plugin file:// URLs. In dev this stays
 * empty (the runner reads the source tree directly).
 */
export const PLUGIN_FILES: Record<string, string> = {}

/**
 * RFC-083: tree-sitter grammar + runtime wasm table for the structural-diff
 * engine. Keyed by basename (e.g. \`tree-sitter-python.wasm\`,
 * \`tree-sitter.wasm\`) → embedded \`/$bunfs/...\` path. In dev this stays empty
 * and \`services/structuralDiff/lang/grammars.ts\` resolves the wasms from
 * node_modules instead.
 */
export const GRAMMAR_FILES: Record<string, string> = {}
`

function platformSuffix(): string {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch
  return `${platform}-${arch}`
}

function walkFiles(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      if (entry === '.gitkeep') continue
      const abs = join(dir, entry)
      const st = statSync(abs)
      if (st.isDirectory()) stack.push(abs)
      else if (st.isFile()) out.push(abs)
    }
  }
  return out.sort()
}

function safeIdent(prefix: string, rel: string): string {
  return (
    prefix +
    '_' +
    rel.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') +
    '_' +
    Math.abs(hashCode(rel)).toString(36)
  )
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return h
}

async function run(cmd: string[], cwd: string): Promise<void> {
  process.stdout.write(`\n$ ${cmd.join(' ')}\n`)
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`command failed (${code}): ${cmd.join(' ')}`)
  }
}

function relImport(absPath: string): string {
  // Imports in embed.generated.ts are resolved relative to backendSrc.
  const rel = relative(backendSrc, absPath)
  // Ensure forward-slash, prefix with ./ when needed.
  const posixRel = rel.split(/[\\/]/).join(posix.sep)
  return posixRel.startsWith('.') ? posixRel : './' + posixRel
}

async function buildFrontend(): Promise<void> {
  await run(['bun', 'run', '--filter', '@agent-workflow/frontend', 'build'], repoRoot)
  if (!existsSync(join(frontendDist, 'index.html'))) {
    throw new Error(`frontend build did not produce ${frontendDist}/index.html`)
  }
}

function writeGenerated(): {
  frontendCount: number
  migrationCount: number
  pluginCount: number
} {
  const frontFiles = walkFiles(frontendDist)
  const migFiles = walkFiles(migrationsDir)
  // RFC-029: only `.mjs` plugin assets get embedded (the .ts source is
  // dev-time only; the runner copies the .mjs into the per-run dir).
  const pluginFiles = walkFiles(pluginsDir).filter((p) => p.endsWith('.mjs'))

  const lines: string[] = [
    '// AUTO-GENERATED by scripts/build-binary.ts — do not edit.',
    '// This file is restored to its stub form right after `bun build --compile`',
    '// finishes, so any manual edits will be lost.',
    '',
  ]

  const frontEntries: Array<[string, string]> = []
  for (const abs of frontFiles) {
    const rel = relative(frontendDist, abs).split(/[\\/]/).join(posix.sep)
    const id = safeIdent('fe', rel)
    lines.push(`import ${id} from '${relImport(abs)}' with { type: 'file' }`)
    frontEntries.push([rel, id])
  }
  lines.push('')

  const migEntries: Array<[string, string]> = []
  for (const abs of migFiles) {
    const rel = relative(migrationsDir, abs).split(/[\\/]/).join(posix.sep)
    const id = safeIdent('mig', rel)
    lines.push(`import ${id} from '${relImport(abs)}' with { type: 'file' }`)
    migEntries.push([rel, id])
  }
  lines.push('')

  const pluginEntries: Array<[string, string]> = []
  for (const abs of pluginFiles) {
    // Plugin entries are keyed by basename (no nested subdirs allowed here).
    const rel = relative(pluginsDir, abs).split(/[\\/]/).join(posix.sep)
    const id = safeIdent('plug', rel)
    lines.push(`import ${id} from '${relImport(abs)}' with { type: 'file' }`)
    pluginEntries.push([rel, id])
  }
  lines.push('')
  lines.push('export const IS_EMBEDDED = true')
  lines.push('')

  lines.push('export const FRONTEND_FILES: Record<string, string> = {')
  for (const [rel, id] of frontEntries) lines.push(`  ${JSON.stringify(rel)}: ${id},`)
  lines.push('}')
  lines.push('')

  lines.push('export const MIGRATION_FILES: Record<string, string> = {')
  for (const [rel, id] of migEntries) lines.push(`  ${JSON.stringify(rel)}: ${id},`)
  lines.push('}')
  lines.push('')

  lines.push('export const PLUGIN_FILES: Record<string, string> = {')
  for (const [rel, id] of pluginEntries) lines.push(`  ${JSON.stringify(rel)}: ${id},`)
  lines.push('}')
  lines.push('')

  // RFC-083: embed the tree-sitter runtime + per-language grammar wasms so the
  // structural-diff engine works inside the compiled binary (no node_modules at
  // runtime). Keyed by basename — grammars.ts looks them up via GRAMMAR_FILES.
  const grammarEntries: Array<[string, string]> = []
  for (const abs of grammarWasmPaths()) {
    const base = basename(abs)
    const id = safeIdent('gram', base)
    lines.push(`import ${id} from '${relImport(abs)}' with { type: 'file' }`)
    grammarEntries.push([base, id])
  }
  lines.push('')
  lines.push('export const GRAMMAR_FILES: Record<string, string> = {')
  for (const [rel, id] of grammarEntries) lines.push(`  ${JSON.stringify(rel)}: ${id},`)
  lines.push('}')
  lines.push('')

  writeFileSync(generatedPath, lines.join('\n'))
  return {
    frontendCount: frontEntries.length,
    migrationCount: migEntries.length,
    pluginCount: pluginEntries.length,
    grammarCount: grammarEntries.length,
  }
}

/** Absolute paths of the wasm assets the structural-diff engine needs: the
 *  web-tree-sitter runtime + the 8 RFC-083 grammars (+ tsx dialect). */
function grammarWasmPaths(): string[] {
  // Resolve from the backend package — tree-sitter-wasms / web-tree-sitter live
  // in packages/backend/node_modules, not the repo root.
  const backendRequire = createRequire(join(backendSrc, 'main.ts'))
  const wasmsOut = join(dirname(backendRequire.resolve('tree-sitter-wasms/package.json')), 'out')
  const runtime = join(
    dirname(backendRequire.resolve('web-tree-sitter/package.json')),
    'tree-sitter.wasm',
  )
  const grammars = [
    'python',
    'go',
    'typescript',
    'tsx',
    'javascript',
    'java',
    'rust',
    'cpp',
    'scala',
  ].map((n) => join(wasmsOut, `tree-sitter-${n}.wasm`))
  return [runtime, ...grammars].filter((p) => existsSync(p))
}

async function main(): Promise<void> {
  process.chdir(repoRoot)
  await mkdir(outDir, { recursive: true })

  // 1. Frontend → dist.
  await buildFrontend()

  // 2. Rewrite embed.generated.ts with imports for every file we want inside
  //    the binary.
  const counts = writeGenerated()
  process.stdout.write(
    `\nwrote ${generatedPath}: ${counts.frontendCount} frontend files + ${counts.migrationCount} migration files + ${counts.pluginCount} opencode-plugin files + ${counts.grammarCount} grammar wasms\n`,
  )

  // 3. bun build --compile.
  const outfile = join(outDir, `agent-workflow-${platformSuffix()}`)
  // RFC-213 impl-gate P1-3: stamp a real binary identity into the executable so
  // the pre-migration restore gate can tell two releases apart (util/version.ts).
  // git describe gives the tag on releases and tag-N-gSHA on intermediate builds;
  // outside a git checkout fall back to a non-release marker.
  let buildVersion = '0.0.0-unknown'
  try {
    const proc = Bun.spawnSync(['git', 'describe', '--tags', '--always'], { cwd: repoRoot })
    const out = proc.stdout.toString().trim()
    if (proc.exitCode === 0 && out.length > 0) buildVersion = out
  } catch {
    /* no git — keep the fallback */
  }
  try {
    await run(
      [
        'bun',
        'build',
        mainEntry,
        '--compile',
        '--target=bun',
        '--minify',
        `--define=AW_BUILD_VERSION="${buildVersion}"`,
        `--outfile=${outfile}`,
      ],
      repoRoot,
    )
    const size = statSync(outfile).size
    process.stdout.write(`\nbuilt: ${outfile} (${(size / 1024 / 1024).toFixed(1)} MiB)\n`)
  } finally {
    // 4. Always restore the stub so dev mode is unaffected.
    writeFileSync(generatedPath, STUB_CONTENTS)
  }

  // Spot-check the binary: `--version` should print and exit 0.
  await run([outfile, 'version'], repoRoot)
  process.stdout.write(`\nsmoke ok: ${outfile} version\n`)
}

main().catch(async (err: unknown) => {
  // If the build threw before the finally block could run, force-restore the
  // stub here so we never leave a polluted file in the working tree.
  writeFileSync(generatedPath, STUB_CONTENTS)
  process.stderr.write(
    '\nbuild failed: ' + (err instanceof Error ? err.message : String(err)) + '\n',
  )
  // Clean up partial outDir if it's empty.
  const entries = existsSync(outDir) ? readdirSync(outDir) : []
  if (entries.length === 0) {
    try {
      await rm(outDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  process.exit(1)
})
