import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { runtimeContainmentAdmissionFromPrepared } from '@/services/runtime/opencode/containment'
import { ContainmentCoordinator, ContainmentProviderQualificationError } from '@/services/sandbox'
import {
  registerNetlessSubprocessProvider,
  runNetlessSubprocess,
} from '@/services/runtime/opencode/sealedSubprocess'
import { buildVerifiedOpencodePlan } from '@/services/runtime/opencode/verifiedPlanCore'

const roots: string[] = []
const DIGEST = 'd'.repeat(64)

async function reopenDirectories(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) return
  await chmod(path, 0o700)
  await Promise.all((await readdir(path)).map((entry) => reopenDirectories(join(path, entry))))
}

afterEach(async () => {
  const pending = roots.splice(0)
  await Promise.all(pending.map(reopenDirectories))
  await Promise.all(pending.map((root) => rm(root, { recursive: true, force: true })))
})

async function coordinatedAdmission(input: {
  mode: 'enforce' | 'warn' | 'off'
  mechanism: 'bwrap' | 'seatbelt' | null
  appHome: string
  qualifyBwrap?: () => Promise<string>
}) {
  const coordinator = new ContainmentCoordinator({
    provider: {
      mode: input.mode,
      status: {
        mechanism: input.mechanism,
        available: input.mechanism !== null,
        detail: null,
      },
      appHome: input.appHome,
    },
    ...(input.mechanism === 'bwrap'
      ? {
          qualifyBwrap:
            input.qualifyBwrap ??
            (async () => {
              throw new ContainmentProviderQualificationError('provider-not-found')
            }),
        }
      : {}),
    ...(input.mechanism === 'seatbelt' ? { qualifySeatbelt: async () => undefined } : {}),
  })
  return runtimeContainmentAdmissionFromPrepared(await coordinator.admit('model-child-netless-v1'))
}

describe('RFC-227 provider-owned child rendering', () => {
  test('a future provider owns child rendering without an OpenCode core branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc227-provider-renderer-'))
    roots.push(root)
    const worktreePath = join(root, 'worktree')
    const scratchPath = join(root, 'scratch')
    const manifestPath = join(root, 'manifest.json')
    await mkdir(worktreePath, { recursive: true })
    await mkdir(scratchPath, { recursive: true })

    registerNetlessSubprocessProvider('windows-job-object-fixture', (manifest, providerPlan) => {
      expect(providerPlan.config).toEqual({
        appContainerProfile: 'agent-workflow-runtime',
        jobKillOnClose: true,
      })
      return {
        cmd: [process.execPath, '-e', 'process.exit(0)'],
        cwd: manifest.worktreePath,
        env: {},
      }
    })
    await writeFile(
      manifestPath,
      JSON.stringify({
        codec: 1,
        mode: 'mcp',
        provider: {
          providerId: 'windows-job-object-fixture',
          config: {
            appContainerProfile: 'agent-workflow-runtime',
            jobKillOnClose: true,
          },
        },
        worktreePath,
        scratchPath,
        appHome: join(root, 'app-home'),
        realHome: join(root, 'real-home'),
        gitCommonDirs: [],
        bindReadOnly: [],
        env: {},
        command: ['provider-owned'],
      }),
    )

    expect(await runNetlessSubprocess(manifestPath, [])).toBe(0)
  })
})

describe('RFC-227 macOS verified-plan assembly', () => {
  test('builds a Seatbelt plan without requiring bwrap or materializing FFF', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc227-seatbelt-plan-'))
    roots.push(root)
    const appHome = join(root, 'app-home')
    const snapshotPath = join(root, 'run', 'seal', 'opencode')
    const admission = await coordinatedAdmission({
      mode: 'enforce',
      mechanism: 'seatbelt',
      appHome,
    })

    const plan = await buildVerifiedOpencodePlan({
      admission,
      appHome,
      command: ['/runtime/opencode'],
      storeRoot: join(appHome, 'opencode-stores', 'system', 'fixture'),
      binaryPath: snapshotPath,
      fffProbeRoot: join(root, 'run', 'fff'),
      dependencies: {
        snapshotBinary: async ({ snapshotPath: destination }) => {
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
          await writeFile(destination, 'seatbelt runtime fixture', {
            flag: 'wx',
            mode: 0o500,
          })
          await chmod(destination, 0o500)
          return {
            resolvedPath: '/runtime/opencode',
            snapshotPath: destination,
            digest: DIGEST,
          }
        },
      },
    })

    expect(plan.childProvider).toEqual({
      providerId: 'macos-seatbelt',
      config: { sandboxExecPath: '/usr/bin/sandbox-exec' },
    })
    expect(plan.fffCapability).toBeNull()
    expect(plan.readOnlySubtrees).toEqual([])
  })
})

describe('RFC-227 degraded verified-plan assembly', () => {
  test('warn degrades atomically when the boot probe is green but exact bwrap qualification fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc233-warn-exact-qualification-'))
    roots.push(root)
    const appHome = join(root, 'app-home')
    const snapshotPath = join(root, 'run', 'seal', 'opencode')
    let bwrapCalls = 0
    const admission = await coordinatedAdmission({
      mode: 'warn',
      mechanism: 'bwrap',
      appHome,
      qualifyBwrap: async () => {
        bwrapCalls += 1
        throw new ContainmentProviderQualificationError('provider-owner-unsafe')
      },
    })

    const plan = await buildVerifiedOpencodePlan({
      admission,
      appHome,
      command: ['/runtime/opencode'],
      storeRoot: join(appHome, 'opencode-stores', 'system', 'warn-exact-failure'),
      binaryPath: snapshotPath,
      fffProbeRoot: join(root, 'run', 'fff'),
      dependencies: {
        snapshotBinary: async ({ snapshotPath: destination }) => {
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
          await writeFile(destination, 'warn runtime fixture', {
            flag: 'wx',
            mode: 0o500,
          })
          return {
            resolvedPath: '/runtime/opencode',
            snapshotPath: destination,
            digest: DIGEST,
          }
        },
      },
    })

    expect(bwrapCalls).toBe(1)
    expect(plan.childProvider).toEqual({ providerId: 'none', config: {} })
    expect(plan.containment.available).toBe(false)
    expect(plan.containment.degradedReasons).toContain('provider-owner-unsafe')
    expect(plan.fffCapability).toBeNull()
  })

  test('warn and off build an executable uncontained plan without core requalification', async () => {
    for (const mode of ['warn', 'off'] as const) {
      const root = await mkdtemp(join(tmpdir(), `rfc227-${mode}-plan-`))
      roots.push(root)
      const appHome = join(root, 'app-home')
      const snapshotPath = join(root, 'run', 'seal', 'opencode')
      let bwrapCalls = 0
      const admission = await coordinatedAdmission({
        mode,
        mechanism: mode === 'warn' ? 'bwrap' : null,
        appHome,
        qualifyBwrap: async () => {
          bwrapCalls += 1
          throw new ContainmentProviderQualificationError('provider-not-found')
        },
      })

      const plan = await buildVerifiedOpencodePlan({
        admission,
        appHome,
        command: ['/runtime/opencode'],
        storeRoot: join(appHome, 'opencode-stores', 'system', mode),
        binaryPath: snapshotPath,
        fffProbeRoot: join(root, 'run', 'fff'),
        dependencies: {
          snapshotBinary: async ({ snapshotPath: destination }) => {
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
            await writeFile(destination, `${mode} runtime fixture`, {
              flag: 'wx',
              mode: 0o500,
            })
            return {
              resolvedPath: '/runtime/opencode',
              snapshotPath: destination,
              digest: DIGEST,
            }
          },
        },
      })

      expect(bwrapCalls).toBe(mode === 'warn' ? 1 : 0)
      expect(plan.childProvider).toEqual({ providerId: 'none', config: {} })
      expect(plan.containment.mode).toBe(mode)
      expect(plan.fffCapability).toBeNull()
    }
  })
})
