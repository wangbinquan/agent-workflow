import { readFile } from 'node:fs/promises'
import { release } from 'node:os'
import { join } from 'node:path'
import { canonicalJson } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import { runManagedProcess } from '@/platform/execution/local/managedProcess'

async function pathRuntime(command: string, workspacePath: string) {
  const executable = Bun.which(command, { cwd: workspacePath })
  if (!executable) return { executable: null, status: 'missing', version: null }
  const probe = await runManagedProcess({
    argv: [executable, '--version'],
    cwd: workspacePath,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    timeoutMs: 2_000,
    killEscalationGraceMs: 100,
    captureRawStdout: true,
  })
  const version = probe.rawStdout?.trim() ?? ''
  const status =
    probe.outcome === 'timeout'
      ? 'timeout'
      : probe.outcome === 'exited' && probe.exitCode === 0 && version && version.length <= 1_000
        ? 'observed'
        : 'failed'
  return { executable, status, version: status === 'observed' ? version : null }
}

/** Observed on the actual execution host; no daemon-host identity is substituted for a worker. */
export async function readVerificationEnvironment(workspacePath: string) {
  const dependencies: Record<string, string> = {}
  for (const file of [
    'bun.lock',
    'bun.lockb',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'Cargo.lock',
    'uv.lock',
    'poetry.lock',
    'go.sum',
    'requirements.txt',
    'node_modules/.package-lock.json',
  ]) {
    try {
      dependencies[file] = sha256Hex(await readFile(join(workspacePath, file)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const [bun, node] = await Promise.all([
    pathRuntime('bun', workspacePath),
    pathRuntime('node', workspacePath),
  ])
  const description = canonicalJson({
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    verifierRuntime: { bun: process.versions.bun ?? null, node: process.versions.node },
    // A compiled verifier may embed a different Bun/Node version than the
    // commands found by a profile script. Missing/failed probes stay explicit.
    pathRuntimes: { bun, node },
    runtimeProbeScope: 'PATH bun/node only; profile scripts may select other tools',
    locale: process.env.LANG ?? null,
    timezone: process.env.TZ ?? null,
    dependencies,
  })
  return { description, digest: sha256Hex(description) }
}
