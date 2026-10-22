import { readFile } from 'node:fs/promises'
import { release } from 'node:os'
import { join } from 'node:path'
import { canonicalJson } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'

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
  const description = canonicalJson({
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    runtimes: { bun: process.versions.bun ?? null, node: process.versions.node },
    locale: process.env.LANG ?? null,
    timezone: process.env.TZ ?? null,
    dependencies,
  })
  return { description, digest: sha256Hex(description) }
}
