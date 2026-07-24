import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  admitRuntimeContainment,
  inspectRuntimeContainment,
} from '@/services/runtime/opencode/containment'
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

function provider(mode: 'enforce' | 'warn' | 'off', mechanism: string | null, available: boolean) {
  return {
    mode,
    status: {
      mechanism,
      available,
      detail: available ? null : 'fixture unavailable',
    },
    appHome: '/private/agent-workflow',
  } as const
}

describe('RFC-227 containment admission truth table', () => {
  test('Linux and macOS built-ins both satisfy enforce without an OS-name gate', () => {
    const linux = admitRuntimeContainment(provider('enforce', 'bwrap', true))
    expect(linux.childProvider.providerId).toBe('linux-bwrap')
    expect(linux.receipt.capabilities.descendantLifetimeBound).toBe('strong')

    const mac = admitRuntimeContainment(provider('enforce', 'seatbelt', true))
    expect(mac.childProvider).toEqual({
      providerId: 'macos-seatbelt',
      config: { sandboxExecPath: '/usr/bin/sandbox-exec' },
    })
    expect(mac.receipt.capabilities.platformHomeIsolation).toBe('strong')
    expect(mac.receipt.capabilities.descendantLifetimeBound).toBe('best-effort')
  })

  test('enforce blocks missing/partial capability, warn degrades, and off runs unwrapped', () => {
    expect(() => admitRuntimeContainment(provider('enforce', 'bwrap', false))).toThrow(
      'execution-identity-sandbox-required',
    )

    const warn = admitRuntimeContainment(provider('warn', 'bwrap', false))
    expect(warn.childProvider).toEqual({ providerId: 'none', config: {} })
    expect(warn.receipt.degradedReasons).toContain('containment-provider-unavailable')

    const off = admitRuntimeContainment(provider('off', null, false))
    expect(off.childProvider).toEqual({ providerId: 'none', config: {} })
    expect(off.receipt.mode).toBe('off')
  })

  test('future Windows provider passes the same core contract through opaque plans', () => {
    const windows = {
      ...provider('enforce', 'windows-job-object', true),
      runtimeContainment: {
        providerId: 'windows-job-object',
        capabilities: {
          platformHomeIsolation: 'strong',
          immutableArtifactView: 'strong',
          modelChildNetworkDeny: 'strong',
          descendantLifetimeBound: 'strong',
        },
        childProviderPlan: {
          jobKillOnClose: true,
          appContainerProfile: 'agent-workflow-runtime',
        },
      },
      wrapCommand: (cmd: readonly string[]) => ['windows-provider-host', ...cmd],
    } as const

    const admission = admitRuntimeContainment(windows)
    expect(admission.childProvider).toEqual({
      providerId: 'windows-job-object',
      config: {
        jobKillOnClose: true,
        appContainerProfile: 'agent-workflow-runtime',
      },
    })
    expect(inspectRuntimeContainment(windows)?.degradedReasons).toEqual([])
  })

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
    let bwrapCalls = 0

    const plan = await buildVerifiedOpencodePlan({
      sandbox: {
        mode: 'enforce',
        status: { mechanism: 'seatbelt', available: true, detail: null },
        appHome,
      },
      appHome,
      command: ['/runtime/opencode'],
      storeRoot: join(appHome, 'opencode-stores', 'system', 'fixture'),
      binaryPath: snapshotPath,
      fffProbeRoot: join(root, 'run', 'fff'),
      dependencies: {
        requireBwrap: async () => {
          bwrapCalls += 1
          return '/usr/bin/bwrap'
        },
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

    expect(bwrapCalls).toBe(0)
    expect(plan.childProvider).toEqual({
      providerId: 'macos-seatbelt',
      config: { sandboxExecPath: '/usr/bin/sandbox-exec' },
    })
    expect(plan.fffCapability).toBeNull()
    expect(plan.readOnlySubtrees).toEqual([])
  })
})

describe('RFC-227 degraded verified-plan assembly', () => {
  test('warn and off build an executable uncontained plan without consulting bwrap', async () => {
    for (const mode of ['warn', 'off'] as const) {
      const root = await mkdtemp(join(tmpdir(), `rfc227-${mode}-plan-`))
      roots.push(root)
      const appHome = join(root, 'app-home')
      const snapshotPath = join(root, 'run', 'seal', 'opencode')
      let bwrapCalls = 0

      const plan = await buildVerifiedOpencodePlan({
        sandbox: {
          mode,
          status: {
            mechanism: mode === 'warn' ? 'bwrap' : null,
            available: false,
            detail: 'fixture unavailable',
          },
          appHome,
        },
        appHome,
        command: ['/runtime/opencode'],
        storeRoot: join(appHome, 'opencode-stores', 'system', mode),
        binaryPath: snapshotPath,
        fffProbeRoot: join(root, 'run', 'fff'),
        dependencies: {
          requireBwrap: async () => {
            bwrapCalls += 1
            return '/usr/bin/bwrap'
          },
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

      expect(bwrapCalls).toBe(0)
      expect(plan.childProvider).toEqual({ providerId: 'none', config: {} })
      expect(plan.containment.mode).toBe(mode)
      expect(plan.fffCapability).toBeNull()
    }
  })
})
