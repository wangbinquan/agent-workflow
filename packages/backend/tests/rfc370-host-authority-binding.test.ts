import { expect, test } from 'bun:test'
import {
  composeHostExecutionAuthorityBinding,
  requireHostExecutionAuthorityBinding,
  type HostExecutionAuthoritySelection,
} from '@/modules/system-operations/composition/hostExecutionAuthority'
import { createLocalHostExecutionAuthorityFactory } from '@/modules/system-operations/infrastructure/local/hostExecutionAuthority'
import type { DaemonStartupLease } from '@/modules/system-operations/application/ports/daemonStartupLease'
import type {
  HostExecutionAuthorityFactory,
  HostExecutionRecoveryFamily,
  HostExecutionRuntimeFamily,
} from '@/modules/system-operations/public/participants'

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

function families(events: string[]) {
  const recovery: HostExecutionRecoveryFamily = {
    kind: 'local-startup',
    prepare(context) {
      expect(context.current()).toBe(true)
      events.push('prepare')
      return {
        kind: 'prepared',
        preparationDigest: 'owner-preparation',
        acceptedTaskContractVersions: ['task-intent:v1'],
        readyGroups: ['task'],
      }
    },
    quiesce() {
      events.push('recovery-quiesce')
    },
    drain() {
      events.push('recovery-drain')
    },
  }
  const runtime: HostExecutionRuntimeFamily = {
    start({ context, groups }) {
      expect(context.current()).toBe(true)
      expect(groups).toEqual(['task'])
      events.push('runtime-start')
    },
    quiesce() {
      events.push('runtime-quiesce')
    },
    drain() {
      events.push('runtime-drain')
    },
  }
  return { recovery, runtime }
}

for (const provider of ['sqlite', 'postgresql'] as const) {
  test(`${provider} subroot admission belongs to the same host lifecycle and leaves the PID lease to its host`, async () => {
    const events: string[] = []
    let pidReleases = 0
    const lease: DaemonStartupLease = {
      get diagnostics(): Readonly<Record<string, unknown>> {
        throw new Error('runtime must not read startup diagnostics')
      },
      recoveryAuthority() {
        throw new Error('runtime must not reacquire startup recovery authority')
      },
      release() {
        pidReleases++
      },
      releaseOnExit() {
        throw new Error('runtime must not release startup lease on exit')
      },
    }
    const binding = composeHostExecutionAuthorityBinding({
      provider,
      generation: 'root-generation',
      mode: 'execution',
      selection: { kind: 'local', startupLease: lease, ...families(events) },
      onFailure(error) {
        throw error
      },
    })
    if ('then' in binding) throw new Error('local composition changed its synchronous contract')
    const subroot = requireHostExecutionAuthorityBinding(binding, {
      provider,
      generation: 'root-generation',
    })
    expect(events).toEqual([])
    await binding.lifecycle.start()
    expect(events).toEqual(['prepare', 'runtime-start'])
    const admission = subroot.admission.acquire('task')
    if (admission.kind !== 'admitted') throw new Error(admission.reason)
    let closed = false
    const pending = binding.lifecycle.close().then(() => {
      closed = true
    })
    try {
      await admission.lease.stopped
      await nextTurn()
      expect(closed).toBe(false)
      expect(subroot.admission.acquire('task').kind).toBe('unavailable')
      admission.lease.complete()
      await pending
      expect(pidReleases).toBe(0)
      expect(binding.queries.snapshot().phase).toBe('closed')
      await lease.release()
      expect(pidReleases).toBe(1)
    } finally {
      admission.lease.complete()
      await pending
    }
  })
}

test('selected factory keeps its receiver, scope and pending creation ACK without native fallback', async () => {
  const events: string[] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  class Factory implements HostExecutionAuthorityFactory {
    calls = 0
    async create(scope: { provider: 'sqlite' | 'postgresql'; generation: string }) {
      expect<Factory>(this).toBe(factory)
      expect(scope).toEqual({ provider: 'postgresql', generation: 'chosen-generation' })
      this.calls++
      entered.resolve()
      await release.promise
      return createLocalHostExecutionAuthorityFactory().create(scope)
    }
  }
  const factory = new Factory()
  const ownerFamilies = families(events)
  let settled = false
  const pending = Promise.resolve(
    composeHostExecutionAuthorityBinding({
      provider: 'postgresql',
      generation: 'chosen-generation',
      mode: 'execution',
      selection: {
        kind: 'selected',
        factory,
        ...ownerFamilies,
        recovery: { ...ownerFamilies.recovery, kind: 'durable-intent' },
      },
      onFailure(error) {
        throw error
      },
    }),
  ).then((binding) => {
    settled = true
    return binding
  })
  try {
    await entered.promise
    expect(settled).toBe(false)
    expect(events).toEqual([])
    release.resolve()
    const binding = await pending
    expect(factory.calls).toBe(1)
    expect(binding.selectionKind).toBe('selected')
    await binding.lifecycle.start()
    expect(events).toEqual(['prepare', 'runtime-start'])
    await binding.lifecycle.close()
  } finally {
    release.resolve()
    await (await pending).lifecycle.close()
  }
})

test('an incomplete selected owner family fails before creating any driver', () => {
  let creates = 0
  const factory: HostExecutionAuthorityFactory = {
    create(scope) {
      creates++
      return createLocalHostExecutionAuthorityFactory().create(scope)
    },
  }
  const ownerFamilies = families([])
  expect(() =>
    composeHostExecutionAuthorityBinding({
      provider: 'sqlite',
      generation: 'generation',
      mode: 'execution',
      selection: {
        kind: 'selected',
        factory,
        ...ownerFamilies,
        runtime: { start: ownerFamilies.runtime.start, drain: ownerFamilies.runtime.drain },
      } as HostExecutionAuthoritySelection,
      onFailure() {},
    }),
  ).toThrow('host-execution-runtime-missing-quiesce')
  expect(creates).toBe(0)
})

test('resource-only binding and scope rejection do no recovery or execution work', async () => {
  const events: string[] = []
  const binding = await composeHostExecutionAuthorityBinding({
    provider: 'sqlite',
    generation: 'generation',
    mode: 'resource-only',
    selection: { kind: 'local', ...families(events) },
    onFailure(error) {
      throw error
    },
  })
  expect(() =>
    requireHostExecutionAuthorityBinding(binding, {
      provider: 'postgresql',
      generation: 'generation',
    }),
  ).toThrow('host-execution-binding-generation-mismatch')
  expect(() =>
    requireHostExecutionAuthorityBinding(binding, {
      provider: 'sqlite',
      generation: 'other-generation',
    }),
  ).toThrow('host-execution-binding-generation-mismatch')
  expect(() =>
    requireHostExecutionAuthorityBinding(
      { ...binding },
      { provider: 'sqlite', generation: 'generation' },
    ),
  ).toThrow('host-execution-binding-incomplete')
  await binding.lifecycle.start()
  expect(binding.admission.acquire('task').kind).toBe('unavailable')
  await binding.lifecycle.close()
  expect(events).toEqual([])
})
