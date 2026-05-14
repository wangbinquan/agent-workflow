// `agent-workflow doctor` — run all health checks without starting daemon.
// Mirrors design.md §11.3.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { loadConfig } from '@/config'
import {
  compareSemver,
  extractVersion,
  MIN_OPENCODE_VERSION,
  probeOpencode,
} from '@/util/opencode'
import { Paths } from '@/util/paths'

export interface CheckResult {
  name: string
  ok: boolean
  message: string
}

export interface DoctorResult {
  ok: boolean
  checks: CheckResult[]
}

export async function doctorCommand(): Promise<DoctorResult> {
  const checks: CheckResult[] = []

  // 1. opencode binary
  let opencodePath: string | undefined
  try {
    if (existsSync(Paths.config)) opencodePath = loadConfig(Paths.config).opencodePath
  } catch {
    // ignore — separate check below catches config issues
  }
  const probe = await probeOpencode(opencodePath)
  if (probe.version === null) {
    checks.push({
      name: 'opencode binary',
      ok: false,
      message: `'${probe.binary}' not found or not executable; install opencode and ensure PATH or set 'opencodePath' in config`,
    })
  } else if (!probe.compatible) {
    checks.push({
      name: 'opencode version',
      ok: false,
      message: `${probe.version} is older than required ${MIN_OPENCODE_VERSION}`,
    })
  } else {
    checks.push({
      name: 'opencode version',
      ok: true,
      message: `${probe.version} (>=${MIN_OPENCODE_VERSION})`,
    })
  }

  // 2. git binary
  checks.push(await checkGit())

  // 3. app home writable
  checks.push(checkAppHome())

  // 4. config loads
  checks.push(checkConfig())

  // 5. token file (if present) has mode 0600
  checks.push(checkTokenFileMode())

  // 6. migrations present
  checks.push(checkMigrations())

  const ok = checks.every((c) => c.ok)
  return { ok, checks }
}

async function checkGit(): Promise<CheckResult> {
  try {
    const proc = Bun.spawn({ cmd: ['git', '--version'], stdout: 'pipe', stderr: 'pipe' })
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (exitCode !== 0) {
      return { name: 'git', ok: false, message: 'git --version failed' }
    }
    const v = extractVersion(out)
    if (v === null) return { name: 'git', ok: false, message: `unparseable git output: ${out.trim()}` }
    if (compareSemver(v, '2.5.0') < 0) {
      return { name: 'git version', ok: false, message: `${v} is older than required 2.5.0` }
    }
    return { name: 'git version', ok: true, message: `${v} (>=2.5.0)` }
  } catch (err) {
    return { name: 'git', ok: false, message: `git not executable: ${(err as Error).message}` }
  }
}

function checkAppHome(): CheckResult {
  try {
    const exists = existsSync(Paths.root)
    if (!exists) {
      return {
        name: 'app home',
        ok: true,
        message: `${Paths.root} (will be created on first daemon start)`,
      }
    }
    const st = statSync(Paths.root)
    if (!st.isDirectory()) {
      return { name: 'app home', ok: false, message: `${Paths.root} exists but is not a directory` }
    }
    return { name: 'app home', ok: true, message: Paths.root }
  } catch (err) {
    return { name: 'app home', ok: false, message: (err as Error).message }
  }
}

function checkConfig(): CheckResult {
  if (!existsSync(Paths.config)) {
    return { name: 'config', ok: true, message: '(not yet created; defaults will apply)' }
  }
  try {
    const cfg = loadConfig(Paths.config)
    return { name: 'config', ok: true, message: `loaded ($schema_version=${cfg.$schema_version})` }
  } catch (err) {
    return { name: 'config', ok: false, message: (err as Error).message }
  }
}

function checkTokenFileMode(): CheckResult {
  if (!existsSync(Paths.tokenFile)) {
    return { name: 'token file', ok: true, message: '(will be created on first daemon start)' }
  }
  try {
    const mode = statSync(Paths.tokenFile).mode & 0o777
    if (mode !== 0o600) {
      return {
        name: 'token file mode',
        ok: false,
        message: `${Paths.tokenFile} has mode ${mode.toString(8)} (expected 600)`,
      }
    }
    return { name: 'token file mode', ok: true, message: 'mode 600 ✓' }
  } catch (err) {
    return { name: 'token file', ok: false, message: (err as Error).message }
  }
}

function checkMigrations(): CheckResult {
  if (!existsSync(Paths.migrationsDir)) {
    return {
      name: 'migrations folder',
      ok: false,
      message: `${Paths.migrationsDir} missing; run \`bun run --filter '@agent-workflow/backend' db:generate\``,
    }
  }
  const sqls = readdirSync(Paths.migrationsDir).filter((f) => f.endsWith('.sql'))
  if (sqls.length === 0) {
    return {
      name: 'migrations folder',
      ok: false,
      message: 'no .sql migrations found; run db:generate',
    }
  }
  return {
    name: 'migrations folder',
    ok: true,
    message: `${sqls.length} migration${sqls.length === 1 ? '' : 's'} bundled`,
  }
}

export function formatDoctor(r: DoctorResult): string {
  const lines: string[] = []
  for (const c of r.checks) {
    lines.push(`  ${c.ok ? '✓' : '✗'} ${c.name}: ${c.message}`)
  }
  lines.push(r.ok ? '\nall checks passed' : '\none or more checks failed')
  return lines.join('\n') + '\n'
}
