import { describe, expect, test } from 'bun:test'

import {
  buildRunSandboxCtx,
  ContainmentAdmissionAborted,
  ContainmentAdmissionError,
  ContainmentCoordinator,
  ContainmentProviderQualificationError,
  wrapSandbox,
} from '@/services/sandbox'

function provider(mode: 'enforce' | 'warn' | 'off' = 'warn') {
  return {
    mode,
    status: { mechanism: 'bwrap', available: true, detail: null },
    appHome: '/srv/agent-workflow',
  } as const
}

describe('RFC-233 containment coordinator', () => {
  test('warn turns exact qualification failure into one atomic none topology', async () => {
    const coordinator = new ContainmentCoordinator({
      provider: provider('warn'),
      qualifyBwrap: async () => {
        throw new ContainmentProviderQualificationError('provider-owner-unsafe')
      },
      bootId: 'boot-warn',
      now: () => 42,
    })

    const plan = await coordinator.admit('opencode-verified-v1')
    expect(plan.receipt).toMatchObject({
      coordinatorBootId: 'boot-warn',
      mode: 'warn',
      decision: 'degraded',
      profileId: 'opencode-verified-v1',
      admittedAt: 42,
    })
    expect(plan.receipt.reasonCodes).toEqual([
      'provider-owner-unsafe',
      'required-capability-missing',
    ])
    expect(plan.topology).toBe('none')
    expect(plan.sandbox.status.available).toBe(false)
    expect(plan.childProvider).toEqual({ providerId: 'none', config: {} })
  })

  test('enforce blocks with the new stable failure code before a plan is returned', async () => {
    const coordinator = new ContainmentCoordinator({
      provider: provider('enforce'),
      qualifyBwrap: async () => {
        throw new ContainmentProviderQualificationError('provider-trial-rejected')
      },
    })

    await expect(coordinator.admit('opencode-verified-v1')).rejects.toMatchObject({
      code: 'execution-identity-containment-required',
      receipt: {
        mode: 'enforce',
        decision: 'blocked',
        reasonCodes: ['provider-trial-rejected', 'required-capability-missing'],
      },
    })
    await expect(coordinator.admit('opencode-verified-v1')).rejects.toBeInstanceOf(
      ContainmentAdmissionError,
    )
  })

  test('off performs zero provider qualification', async () => {
    let calls = 0
    const coordinator = new ContainmentCoordinator({
      provider: provider('off'),
      qualifyBwrap: async () => {
        calls += 1
        return '/usr/bin/bwrap'
      },
    })

    const plan = await coordinator.admit('opencode-verified-v1')
    expect(calls).toBe(0)
    expect(plan.receipt.decision).toBe('off')
    expect(plan.receipt.probeGeneration).toBeNull()
    expect(plan.topology).toBe('none')
  })

  test('mode update linearizes an in-flight admission and all future admissions', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const coordinator = new ContainmentCoordinator({
      provider: provider('enforce'),
      qualifyBwrap: async () => {
        await gate
        throw new ContainmentProviderQualificationError('provider-trial-rejected')
      },
      bootId: 'boot-race',
    })

    const pending = coordinator.admit('opencode-verified-v1')
    expect(coordinator.setMode('warn')).toBe(2)
    release()
    const plan = await pending
    expect(plan.receipt).toMatchObject({
      policyGeneration: 2,
      mode: 'warn',
      decision: 'degraded',
    })

    expect(coordinator.setMode('off')).toBe(3)
    const off = await coordinator.admit('opencode-verified-v1')
    expect(off.receipt).toMatchObject({
      policyGeneration: 3,
      mode: 'off',
      decision: 'off',
      probeGeneration: null,
    })
  })

  test('switching off during qualification commits off and starts no later probe', async () => {
    let release!: () => void
    let calls = 0
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const coordinator = new ContainmentCoordinator({
      provider: provider('enforce'),
      qualifyBwrap: async () => {
        calls += 1
        await gate
        return '/usr/bin/bwrap'
      },
    })

    const pending = coordinator.admit('opencode-verified-v1')
    coordinator.setMode('off')
    release()
    const raced = await pending
    expect(raced.receipt).toMatchObject({
      mode: 'off',
      decision: 'off',
      providerId: null,
      probeGeneration: 1,
    })
    expect(raced.sandbox.mode).toBe('off')

    const later = await coordinator.admit('opencode-verified-v1')
    expect(later.receipt.probeGeneration).toBeNull()
    expect(calls).toBe(1)
  })

  test('qualified outer and child plans share the canonical bwrap executable', async () => {
    const coordinator = new ContainmentCoordinator({
      provider: provider('enforce'),
      qualifyBwrap: async () => '/opt/root-owned/bin/bwrap',
    })
    const plan = await coordinator.admit('opencode-verified-v1')
    const ctx = buildRunSandboxCtx(
      plan.sandbox,
      'task-a',
      '/work/task-a',
      '/srv/agent-workflow/runs/task-a/run-a',
    )

    expect(plan.receipt.decision).toBe('contained')
    expect(plan.topology).toBe('runner-outer-and-child')
    expect(plan.childProvider).toEqual({
      providerId: 'linux-bwrap',
      config: { bwrapPath: '/opt/root-owned/bin/bwrap' },
    })
    expect(wrapSandbox(['/runtime/opencode'], ctx)[0]).toBe('/opt/root-owned/bin/bwrap')
  })

  test('partial Linux proof contains filesystem profile but atomically degrades stronger OpenCode profile', async () => {
    const coordinator = new ContainmentCoordinator({
      provider: provider('warn'),
      qualifyBwrapFilesystem: async () => '/usr/bin/bwrap',
      qualifyBwrapFull: async () => {
        throw new ContainmentProviderQualificationError('provider-trial-rejected')
      },
    })

    const filesystem = await coordinator.admit('runner-filesystem-v1')
    expect(filesystem.receipt).toMatchObject({
      decision: 'contained',
      capabilities: {
        platformHomeIsolation: 'strong',
        immutableArtifactView: 'strong',
        modelChildNetworkDeny: 'absent',
      },
    })
    expect(filesystem.topology).toBe('runner-outer')
    expect(filesystem.childProvider).toEqual({ providerId: 'none', config: {} })

    const opencode = await coordinator.admit('opencode-verified-v1')
    expect(opencode.receipt).toMatchObject({
      decision: 'degraded',
      reasonCodes: ['provider-trial-rejected', 'required-capability-missing'],
    })
    expect(opencode.topology).toBe('none')
    expect(opencode.childProvider).toEqual({ providerId: 'none', config: {} })
  })

  test('trusted future provider qualifies through the generic descriptor seam', async () => {
    const capabilities = {
      platformHomeIsolation: 'strong',
      immutableArtifactView: 'strong',
      modelChildNetworkDeny: 'strong',
      descendantLifetimeBound: 'best-effort',
    } as const
    const futureSandbox = {
      mode: 'enforce' as const,
      status: { mechanism: 'windows-appcontainer', available: true, detail: null },
      appHome: '/srv/agent-workflow',
      runtimeContainment: {
        providerId: 'windows-appcontainer-v1',
        capabilities,
        childProviderPlan: { profile: 'agent-workflow' },
      },
      wrapCommand: (command: readonly string[]) => ['appcontainer-launch', ...command],
    }
    const coordinator = new ContainmentCoordinator({
      provider: futureSandbox,
      qualifyProvider: async () => ({
        providerId: 'windows-appcontainer-v1',
        capabilities,
        childProvider: {
          providerId: 'windows-appcontainer-v1',
          config: { profile: 'agent-workflow' },
        },
        sandbox: futureSandbox,
      }),
    })

    const plan = await coordinator.admit('opencode-verified-v1')
    expect(plan.receipt).toMatchObject({
      providerId: 'windows-appcontainer-v1',
      decision: 'contained',
    })
    expect(plan.childProvider.providerId).toBe('windows-appcontainer-v1')
  })

  test('future provider descriptor fails closed when renderer evidence contradicts capabilities', async () => {
    const capabilities = {
      platformHomeIsolation: 'strong',
      immutableArtifactView: 'strong',
      modelChildNetworkDeny: 'strong',
      descendantLifetimeBound: 'best-effort',
    } as const
    const coordinator = new ContainmentCoordinator({
      provider: provider('warn'),
      qualifyProvider: async () => ({
        providerId: 'future-provider',
        capabilities,
        childProvider: { providerId: 'none', config: {} },
        sandbox: {
          mode: 'warn',
          status: { mechanism: 'future-provider', available: true, detail: null },
          appHome: '/srv/agent-workflow',
          runtimeContainment: {
            providerId: 'future-provider',
            capabilities,
          },
        },
      }),
    })

    const plan = await coordinator.admit('opencode-verified-v1')
    expect(plan.receipt).toMatchObject({
      decision: 'degraded',
      reasonCodes: ['provider-contract-invalid', 'required-capability-missing'],
    })
    expect(plan.topology).toBe('none')
  })

  test('status observation has a bounded cache while every admission requalifies', async () => {
    let calls = 0
    let now = 1_000
    const coordinator = new ContainmentCoordinator({
      provider: provider('warn'),
      qualifyBwrap: async () => {
        calls += 1
        return '/usr/bin/bwrap'
      },
      now: () => now,
    })

    const first = await coordinator.observe('opencode-verified-v1', 30_000)
    now += 5_000
    const cached = await coordinator.observe('opencode-verified-v1', 30_000)
    expect(calls).toBe(1)
    expect(cached.receipt.probeGeneration).toBe(first.receipt.probeGeneration)
    expect(cached.receipt.probeCheckedAt).toBe(first.receipt.probeCheckedAt)

    await coordinator.admit('opencode-verified-v1')
    expect(calls).toBe(2)
    now += 31_000
    await coordinator.observe('opencode-verified-v1', 30_000)
    expect(calls).toBe(3)
  })

  test('an aborted waiter detaches without canceling the shared exact qualification', async () => {
    let release!: () => void
    let calls = 0
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const coordinator = new ContainmentCoordinator({
      provider: provider('enforce'),
      qualifyBwrap: async () => {
        calls += 1
        await gate
        return '/usr/bin/bwrap'
      },
    })
    const controller = new AbortController()

    const aborted = coordinator.admit('opencode-verified-v1', {
      signal: controller.signal,
    })
    const survivor = coordinator.admit('opencode-verified-v1')
    controller.abort()
    await expect(aborted).rejects.toBeInstanceOf(ContainmentAdmissionAborted)
    release()
    await expect(survivor).resolves.toMatchObject({
      receipt: { decision: 'contained', probeGeneration: 1 },
    })
    expect(calls).toBe(1)
  })
})
