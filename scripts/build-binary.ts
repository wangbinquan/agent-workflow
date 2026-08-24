// P-5-05 build pipeline — produces a single executable that contains the
// daemon, the compiled frontend, and the drizzle migrations.
//
// Steps:
//   1. `bun --filter @agent-workflow/frontend build` → packages/frontend/dist/
//   2. Walk that dist + packages/backend/db/migrations and render an in-memory
//      embed.generated.ts with `import … with { type: 'file' }` declarations
//      for every file. The runtime helpers in packages/backend/src/embed.ts
//      read from those imports.
//   3. Compile through Bun.build({ files }) so the generated module overrides
//      the on-disk stub only inside the build. The watched source tree is never
//      rewritten, so a binary build cannot restart a concurrently running dev
//      daemon.
//
// Run from the repo root: `bun run scripts/build-binary.ts`.
//
// Notes:
//   - This intentionally does no cross-compilation. Run it on each target OS.
//     CI invokes it per matrix entry.
//   - The binary name follows the design.md convention: macos / linux + arm64
//     / x86_64. (`process.arch` returns 'x64' for x86_64; we rename it.)

import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, posix, relative, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const frontendDist = join(repoRoot, 'packages', 'frontend', 'dist')
const migrationsDir = join(repoRoot, 'packages', 'backend', 'db', 'migrations')
const backendSrc = join(repoRoot, 'packages', 'backend', 'src')
// RFC-029: opencode plugin .mjs files that need to ride along inside the
// binary so the runner can copy them into per-run dirs at task time.
const pluginsDir = join(backendSrc, 'services', 'runtime', 'opencode', 'plugin')
const generatedPath = join(backendSrc, 'embed.generated.ts')
const mainEntry = join(backendSrc, 'main.ts')
// RFC-311 实现门 P0-1:`new Worker(new URL('./x.ts', import.meta.url))` 不被
// bundler 追踪——worker 必须显式作为**额外入口**参与 --compile,否则发布版单
// 二进制里它 ModuleNotFound,备份的 off-thread VACUUM 每次都落到回退路径。
// 新增 worker 时把文件加进这个清单(backup.ts 侧仍保留能力等价的同线程回退)。
const WORKER_ENTRIES = [join(backendSrc, 'services', 'backupVacuumWorker.ts')]
// Test-only external executables are owned by the unified system mock package.
const stubEntry = join(repoRoot, 'packages', 'system-mocks', 'src', 'runtime', 'dispatch.ts')
const systemMockToolEntry = join(repoRoot, 'packages', 'system-mocks', 'src', 'tool.ts')
const outDir = join(repoRoot, 'dist')

/**
 * RFC-254 T26 — `win32` is spelled `windows` in the artifact name, matching how
 * every other project (including OpenCode itself) names its release assets.
 */
function platformSuffix(): string {
  const raw = process.platform
  const platform = raw === 'darwin' ? 'macos' : raw === 'win32' ? 'windows' : raw
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch
  return `${platform}-${arch}`
}

/**
 * The extension an executable must carry to BE executable on this platform.
 * Without `.exe`, Windows will not run the file at all — and the failure looks
 * like "file not found", not "not executable".
 */
function executableExtension(): string {
  return process.platform === 'win32' ? '.exe' : ''
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

async function run(cmd: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  process.stdout.write(`\n$ ${cmd.join(' ')}\n`)
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  })
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

function renderGenerated(): {
  readonly contents: string
  readonly counts: {
    readonly frontendCount: number
    readonly migrationCount: number
    readonly pluginCount: number
    readonly grammarCount: number
  }
} {
  const frontFiles = walkFiles(frontendDist)
  const migFiles = walkFiles(migrationsDir)
  // RFC-029: only `.mjs` plugin assets get embedded (the .ts source is
  // dev-time only; the runner copies the .mjs into the per-run dir).
  const pluginFiles = walkFiles(pluginsDir).filter((p) => p.endsWith('.mjs'))

  const lines: string[] = [
    '// AUTO-GENERATED by scripts/build-binary.ts — do not edit.',
    '// This module exists only in Bun.build({ files }); the on-disk dev stub',
    '// remains untouched while the compiled binary embeds these assets.',
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

  return {
    contents: lines.join('\n'),
    counts: {
      frontendCount: frontEntries.length,
      migrationCount: migEntries.length,
      pluginCount: pluginEntries.length,
      grammarCount: grammarEntries.length,
    },
  }
}

async function buildDaemonBinary(input: {
  readonly outfile: string
  readonly buildVersion: string
  readonly generatedContents: string
}): Promise<void> {
  process.stdout.write(
    `\n$ bun build ${mainEntry} ${WORKER_ENTRIES.join(' ')} --compile --target=bun --minify --virtual-embed=${generatedPath}\n`,
  )
  const result = await Bun.build({
    entrypoints: [mainEntry, ...WORKER_ENTRIES],
    target: 'bun',
    minify: true,
    define: { AW_BUILD_VERSION: JSON.stringify(input.buildVersion) },
    compile: { outfile: input.outfile },
    files: { [generatedPath]: input.generatedContents },
  })
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${String(log)}\n`)
    throw new Error(`bun build failed for ${input.outfile}`)
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
  const includeE2eBinary = Bun.argv.includes('--include-e2e')

  // 1. Frontend → dist.
  await buildFrontend()

  // 2. Render the production embed table in memory. The source-tree stub is a
  //    watched dev dependency and must remain byte-for-byte untouched.
  const generated = renderGenerated()
  const counts = generated.counts
  process.stdout.write(
    `\nprepared virtual ${generatedPath}: ${counts.frontendCount} frontend files + ${counts.migrationCount} migration files + ${counts.pluginCount} opencode-plugin files + ${counts.grammarCount} grammar wasms\n`,
  )

  // 3. bun build --compile.
  const outfile = join(outDir, `agent-workflow-${platformSuffix()}${executableExtension()}`)
  const e2eOutfile = join(outDir, `agent-workflow-e2e-${platformSuffix()}${executableExtension()}`)
  const stubOutfile = join(outDir, `stub-opencode-${platformSuffix()}${executableExtension()}`)
  const systemMockToolOutfile = join(
    outDir,
    `system-mock-tool-${platformSuffix()}${executableExtension()}`,
  )
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
  await buildDaemonBinary({
    outfile,
    buildVersion,
    generatedContents: generated.contents,
  })
  const size = statSync(outfile).size
  process.stdout.write(`\nbuilt: ${outfile} (${(size / 1024 / 1024).toFixed(1)} MiB)\n`)
  if (includeE2eBinary) {
    await buildDaemonBinary({
      outfile: e2eOutfile,
      buildVersion,
      generatedContents: generated.contents,
    })
    const e2eSize = statSync(e2eOutfile).size
    process.stdout.write(
      `\nbuilt test-only: ${e2eOutfile} (${(e2eSize / 1024 / 1024).toFixed(1)} MiB)\n`,
    )
    // RFC-254 T28b — the e2e model stand-in, compiled for the same reason the
    // daemon is: `opencodePath` must name something the OS can execute, and
    // Windows cannot execute a `#!/bin/sh` script (nor a `.cmd` shim, which
    // would let cmd.exe re-tokenize the argv the runner carefully built).
    //
    // ONE artifact for every mode. `bun build --compile` embeds a whole Bun
    // runtime, so a binary per stub would be well over a gigabyte per CI run;
    // the modes are bundled and `AW_STUB_MODE` selects between them.
    await run(
      [
        'bun',
        'build',
        stubEntry,
        '--compile',
        '--target=bun',
        '--minify',
        `--outfile=${stubOutfile}`,
      ],
      repoRoot,
    )
    const stubSize = statSync(stubOutfile).size
    process.stdout.write(
      `\nbuilt e2e stub: ${stubOutfile} (${(stubSize / 1024 / 1024).toFixed(1)} MiB)\n`,
    )
    // One additional executable covers every external CLI-shaped dependency:
    // SCIP indexers are selected from their argv, while `mcp-stdio` selects
    // the long-lived stdio MCP server. Keeping them together avoids embedding
    // another Bun runtime per protocol.
    await run(
      [
        'bun',
        'build',
        systemMockToolEntry,
        '--compile',
        '--target=bun',
        '--minify',
        `--outfile=${systemMockToolOutfile}`,
      ],
      repoRoot,
    )
    const toolSize = statSync(systemMockToolOutfile).size
    process.stdout.write(
      `\nbuilt system mock tool: ${systemMockToolOutfile} (${(toolSize / 1024 / 1024).toFixed(1)} MiB)\n`,
    )
  }

  // Spot-check the binary: `--version` should print and exit 0.
  await run([outfile, 'version'], repoRoot)
  process.stdout.write(`\nsmoke ok: ${outfile} version\n`)
  if (includeE2eBinary) {
    await run([e2eOutfile, 'version'], repoRoot)
    process.stdout.write(`\nsmoke ok: ${e2eOutfile} version\n`)
    // The stub answers `--version` in every mode, so this also proves the
    // dispatcher survived compilation with its mode table intact.
    await run([stubOutfile, '--version'], repoRoot, { AW_STUB_MODE: 'basic' })
    process.stdout.write(`\nsmoke ok: ${stubOutfile} --version\n`)
    await run([systemMockToolOutfile, '--version'], repoRoot)
    process.stdout.write(`\nsmoke ok: ${systemMockToolOutfile} --version\n`)
  }
}

main().catch(async (err: unknown) => {
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
