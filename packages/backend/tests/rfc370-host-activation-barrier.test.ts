// RFC-370: actual SO write receipts and actual runtime handles must agree on
// activation. These are control-contract cases, not a substitute for root E2E.
import { expect, test } from 'bun:test'
import { hostExecutionWriteContexts } from '@/db/schema'
import { createLocalHostExecutionAuthorityFactory } from '@/modules/system-operations/infrastructure/local/hostExecutionAuthority'
import type {
  HostExecutionGrantContext,
  HostExecutionRecoveryFamily,
} from '@/modules/system-operations/public/participants'
import {
  composeDaemonHostExecutionBootstrap,
  installDaemonHostExecutionSession,
  resumeDaemonResourcesForServing,
} from '../src/cli/daemonHostExecutionBootstrap'
import { createAuthorityPollingDaemonRuntimeHandleBinding } from '../src/cli/daemonProviderRuntimeHandles'
import { createDaemonProviderRuntimeSession } from '../src/cli/daemonProviderRuntimeSession'
import {
  bindHttpHostExecutionAvailability,
  runHttpHostExecutionRequest,
} from '@/platform/http/hostExecutionAvailability'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { deferred, nextTurn } from './helpers/taskHostExecution'
import { eventually } from './helpers/eventually'
import { bindMemoryDistillHostOwner } from '../src/cli/daemonHostExecutionOwners'
import {
  IndeterminateRuntimeProcessError,
  MemoryDistillSettlementPendingError,
} from '@/modules/memory/composition'
import type { MemoryDistillWorker } from '@/modules/memory/public/commands'
import { ConfigSchema } from '@agent-workflow/shared'

const unexpected = (error: unknown): never => {
  throw error
}
async function fixture(
  harness: ProviderHarness,
  hooks: {
    prepareSecond?: (context: HostExecutionGrantContext) => Promise<void>
    run?: (context: HostExecutionGrantContext, current: () => boolean) => Promise<void>
    onFailure?: (error: unknown) => void
    memory?: MemoryDistillWorker
  } = {},
) {
  const generation = 'actual-activation-barrier',
    contexts: HostExecutionGrantContext[] = [],
    runs: HostExecutionGrantContext[] = []
  const provider = harness.applicationBinding.provider
  const bootstrap = await composeDaemonHostExecutionBootstrap({
    db: harness.db,
    provider,
    generation,
    selection: {
      mode: 'execution',
      recoveryKind: 'local-startup',
      authority: createLocalHostExecutionAuthorityFactory(),
      leaseFacts: {
        forGrant: () => ({ holder: 'actual-activation-holder', expiresAt: Date.now() + 60_000 }),
      },
    },
    onFailure: hooks.onFailure ?? unexpected,
  })
  const owners = [
    createAuthorityPollingDaemonRuntimeHandleBinding({
      id: 'first-original-worker',
      group: 'task',
      intervalMs: 60_000,
      runImmediately: true,
      async run({ context, current }) {
        runs.push(context)
        await hooks.run?.(context, current)
      },
      onError: unexpected,
    }),
    createAuthorityPollingDaemonRuntimeHandleBinding({
      id: 'second-original-worker',
      group: 'observation',
      intervalMs: 60_000,
      async beforeStart({ context }) {
        await harness.db.select().from(hostExecutionWriteContexts)
        await hooks.prepareSecond?.(context)
      },
      run: async () => {},
      onError: unexpected,
    }),
  ]
  if (hooks.memory)
    owners.push(
      bindMemoryDistillHostOwner({
        worker: hooks.memory,
        configuration: {
          read: () => ({ ...ConfigSchema.parse({}), memoryDistillerEnabled: false }),
        },
        onError: unexpected,
      }),
    )
  const session = await createDaemonProviderRuntimeSession({
    provider,
    generationId: generation,
    hostExecutionRuntime: { handles: owners },
    runtime: {
      fetch: async () => new Response('resource'),
      tryUpgrade: () => false,
      websocketHandlers: {},
    },
    admission: {
      closeWriterAdmission() {},
      openWriterAdmission() {},
      closeWebSocketAdmission() {},
      openWebSocketAdmission() {},
    },
    shutdownIdentity() {},
    beforeCloseProvider: bootstrap.beforeCloseProvider,
    closeProvider() {},
  })
  const recovery: HostExecutionRecoveryFamily = {
    kind: 'local-startup',
    async prepare(context) {
      contexts.push(context)
      expect((await harness.db.select().from(hostExecutionWriteContexts))[0]?.phase).toBe(
        'preparing',
      )
      return {
        kind: 'prepared',
        preparationDigest: 'actual-write-receipt-qualified',
        acceptedTaskContractVersions: [],
        readyGroups: hooks.memory ? ['task', 'observation', 'memory'] : ['task', 'observation'],
      }
    },
    quiesce() {},
    drain() {},
  }
  const installed = installDaemonHostExecutionSession({ bootstrap, session, recovery })
  const scope = { provider, generationId: generation, operationId: 'activation-barrier' }
  return {
    bootstrap,
    installed,
    scope,
    contexts,
    runs,
    row: async () => (await harness.db.select().from(hostExecutionWriteContexts))[0],
    close: () => installed.session.close({ reason: 'daemon-shutdown' }),
  }
}

describeEachProvider('RFC-370 exact activation barrier', (harness) => {
  test('cold blocked execution keeps actual resource HTTP accessible, and explicit activation waits for the original ACK', async () => {
    let acknowledged = false,
      physical = 0
    const original = new IndeterminateRuntimeProcessError(
      'original cold runtime remains unknown',
      async () => {
        physical += 1
        return acknowledged
      },
    )
    original.retainOriginalSettlement(['original-job'], async () => {})
    const f = await fixture(harness, {
      memory: {
        tick: async () => {
          throw new Error('blocked memory tick')
        },
        start: () => {
          throw new Error('native memory loop')
        },
        listJobs: async () => [],
        async recoverRunning() {
          if (!original.originalRecoveryAcknowledged()) throw original
          return { recovered: 0 }
        },
      },
      onFailure: () => {},
    })
    const failures: unknown[] = []
    try {
      await resumeDaemonResourcesForServing({
        session: f.installed.session,
        scope: f.scope,
        host: f.bootstrap,
        onExecutionUnavailable: (error) => {
          failures.push(error)
        },
      })
      expect(failures).toHaveLength(1)
      expect(f.installed.session.state().phase).toBe('running')
      const resource = await f.installed.session.runtime.fetch(
        new Request('http://actual-root.test/api/resources'),
      )
      expect(resource.status).toBe(200)
      expect(await resource.text()).toBe('resource')
      expect(f.bootstrap.admission.acquire('task').kind).toBe('unavailable')
      await expect(f.bootstrap.http.recovery.retryActivation()).rejects.toBeInstanceOf(Error)
      expect(physical).toBe(0)
      expect((await f.row())?.closed).toBe(false)
      acknowledged = true
      expect(await original.recoverOriginal()).toBe(true)
      await f.bootstrap.http.recovery.retryActivation()
      expect(f.bootstrap.queries.snapshot().phase).toBe('active')
      const admitted = f.bootstrap.admission.acquire('task')
      expect(admitted.kind).toBe('admitted')
      if (admitted.kind === 'admitted') admitted.lease.complete()
      expect(physical).toBe(1)
    } finally {
      acknowledged = true
      await original.recoverOriginal()
      await f.close()
    }
  })

  for (const kind of ['physical', 'settlement'] as const)
    test(`cold Memory ${kind} recovery keeps the failed owner until its real ACK, then starts a new write epoch`, async () => {
      let physicalAllowed = false,
        settlementAllowed = false,
        recoveries = 0,
        writes = 0
      const original =
        kind === 'physical'
          ? new IndeterminateRuntimeProcessError(
              'original physical execution still unknown',
              async () => {
                recoveries += 1
                return physicalAllowed
              },
            )
          : new MemoryDistillSettlementPendingError(
              async () => {
                writes += 1
                if (!settlementAllowed) throw new Error('original business ACK lost')
              },
              new Error('original business ACK lost'),
              ['original-job'],
            )
      if (original instanceof IndeterminateRuntimeProcessError)
        original.retainOriginalSettlement(['original-job'], async () => {
          writes += 1
          if (!settlementAllowed) throw new Error('original business ACK lost')
        })
      const acknowledged = () =>
        original instanceof IndeterminateRuntimeProcessError
          ? original.originalRecoveryAcknowledged()
          : original.originalSettlementAcknowledged()
      let starts = 0
      const worker: MemoryDistillWorker = {
        tick: async () => {
          throw new Error('blocked owner must not run a distillation')
        },
        start: () => {
          throw new Error('native loop must not run')
        },
        listJobs: async () => [],
        async recoverRunning() {
          starts += 1
          if (!acknowledged()) throw original
          return { recovered: 0 }
        },
      }
      const f = await fixture(harness, { memory: worker, onFailure: () => {} })
      try {
        await expect(f.installed.resume(f.scope)).rejects.toBeInstanceOf(Error)
        const first = f.contexts[0]!,
          before = await f.row()
        expect(f.bootstrap.queries.snapshot()).toMatchObject({ phase: 'draining', readyGroups: [] })
        expect(f.installed.session.state().activeHandleIds).toContain('memory-distill')
        expect(f.runs).toHaveLength(0)
        expect(before?.closed).toBe(false)
        expect(acknowledged()).toBe(false)
        expect(recoveries).toBe(0)
        if (original instanceof IndeterminateRuntimeProcessError) {
          expect(await original.recoverOriginal()).toBe(false)
          physicalAllowed = true
          await expect(original.recoverOriginal()).rejects.toThrow('original business ACK lost')
        }
        await expect(f.installed.resume(f.scope)).rejects.toBeInstanceOf(Error)
        expect(first.current()).toBe(false)
        expect((await f.row())?.closed).toBe(false)
        settlementAllowed = true
        if (original instanceof IndeterminateRuntimeProcessError)
          expect(await original.recoverOriginal()).toBe(true)
        else await original.retryOriginalSettlement()
        await f.installed.resume(f.scope)
        expect(f.contexts).toHaveLength(2)
        expect(f.contexts[1]!.reference).not.toBe(first.reference)
        expect(f.bootstrap.queries.snapshot().phase).toBe('active')
        expect((await f.row())?.closed).toBe(false)
        expect(starts).toBe(2)
        expect(acknowledged()).toBe(true)
        await eventually(
          async () => f.runs.length,
          (length) => length === 1,
        )
        expect(f.runs[0]).toBe(f.contexts[1])
        expect(writes).toBeGreaterThan(0)
      } finally {
        physicalAllowed = true
        settlementAllowed = true
        if (original instanceof IndeterminateRuntimeProcessError) await original.recoverOriginal()
        else await original.retryOriginalSettlement()
        await f.close()
      }
    })

  test('a fatal actual polling owner closes admission immediately but cannot retire its unacknowledged write lifetime', async () => {
    const entered = deferred(),
      release = deferred(),
      failures: unknown[] = []
    const failure = new Error('original owner fatal failure')
    const f = await fixture(harness, {
      run: async () => {
        entered.resolve()
        await release.promise
        throw failure
      },
      onFailure: (error) => {
        failures.push(error)
      },
    })
    const root = {}
    bindHttpHostExecutionAvailability(root, f.bootstrap.http)
    try {
      await f.installed.resume(f.scope)
      await entered.promise
      release.resolve()
      await eventually(
        async () => f.bootstrap.queries.snapshot().phase,
        (phase) => phase === 'draining',
      )
      expect(f.bootstrap.status.readCurrent()).toMatchObject({
        mode: 'execution',
        status: { phase: 'draining', readyGroups: [], reason: 'host-execution-owner-failed' },
      })
      await expect(
        runHttpHostExecutionRequest(root, 'task', async () => {
          throw new Error('new dispatch must not run')
        }),
      ).rejects.toMatchObject({ status: 503 })
      expect((await f.row())?.closed).toBe(false)
      expect(failures).toContain(failure)
      await expect(f.close()).rejects.toBeInstanceOf(Error)
      expect((await f.row())?.closed).toBe(false)
    } finally {
      release.resolve()
      await f.close().catch(() => {})
    }
  })

  test('an old grant failure report cannot close a newly activated exact write epoch', async () => {
    const failures: unknown[] = []
    const f = await fixture(harness, {
      onFailure: (error) => {
        failures.push(error)
      },
    })
    try {
      await f.installed.resume(f.scope)
      const prior = f.contexts[0]!
      expect(typeof prior.reportFailure).toBe('function')
      await f.installed.pause(f.scope)
      await f.installed.resume(f.scope)
      const active = f.contexts[1]!,
        before = await f.row()
      expect(active.reference).not.toBe(prior.reference)
      prior.reportFailure!(new Error('late old owner failure'))
      await nextTurn()
      expect(active.current()).toBe(true)
      expect(f.bootstrap.queries.snapshot().phase).toBe('active')
      expect(await f.row()).toEqual(before)
      expect(failures).toEqual([])
    } finally {
      await f.close()
    }
  })

  test('a failure report during normal pause cannot replace the original pause and drain policy', async () => {
    const entered = deferred(),
      release = deferred(),
      failures: unknown[] = []
    const f = await fixture(harness, {
      run: async () => {
        entered.resolve()
        await release.promise
      },
      onFailure: (error) => {
        failures.push(error)
      },
    })
    try {
      await f.installed.resume(f.scope)
      await entered.promise
      const original = f.contexts[0]!
      let paused = false
      const pausing = f.installed.pause(f.scope).then(() => {
        paused = true
      })
      await eventually(
        async () => f.bootstrap.queries.snapshot().phase,
        (phase) => phase === 'draining',
      )
      original.reportFailure!(new Error('late failure during normal pause'))
      await nextTurn()
      expect(paused).toBe(false)
      expect(f.bootstrap.queries.snapshot().reason).not.toBe('host-execution-owner-failed')
      release.resolve()
      await pausing
      expect(failures).toEqual([])
      expect((await f.row())?.closed).toBe(true)
    } finally {
      release.resolve()
      await f.close()
    }
  })
  test('a real admitted HTTP request keeps the same write lifetime draining until its original promise settles', async () => {
    const entered = deferred(),
      release = deferred()
    const f = await fixture(harness),
      root = {}
    bindHttpHostExecutionAvailability(root, f.bootstrap.http)
    let request: Promise<void> | undefined
    try {
      await f.installed.resume(f.scope)
      request = runHttpHostExecutionRequest(root, 'task', async () => {
        entered.resolve()
        await release.promise
      })
      await entered.promise
      let paused = false
      const pausing = f.installed.pause(f.scope).then(() => {
        paused = true
      })
      await nextTurn()
      expect(paused).toBe(false)
      await eventually(f.row, (row) => row?.phase === 'draining', {
        what: 'actual host write quiesce ACK',
      })
      await expect(
        runHttpHostExecutionRequest(root, 'task', async () => {
          throw new Error('new request cannot be admitted')
        }),
      ).rejects.toThrow('not ready')
      release.resolve()
      await request
      await pausing
      expect((await f.row())?.phase).toBe('closed')
    } finally {
      release.resolve()
      await request
      await f.close()
    }
  })

  test('the first immediate worker cannot run before every actual start ACK', async () => {
    const entered = deferred(),
      release = deferred(),
      ran = deferred()
    const f = await fixture(harness, {
      async prepareSecond() {
        entered.resolve()
        await release.promise
      },
      async run(context, current) {
        expect(current()).toBe(true)
        expect(context.canDispatch?.()).toBe(true)
        expect(context.whenActive && (await context.whenActive)).toBe(true)
        ran.resolve()
      },
    })
    try {
      const starting = f.installed.resume(f.scope)
      await entered.promise
      await nextTurn()
      expect(f.runs).toHaveLength(0)
      expect(f.bootstrap.queries.snapshot().phase).toBe('preparing')
      expect(f.bootstrap.admission.acquire('task').kind).toBe('unavailable')
      release.resolve()
      await starting
      await ran.promise
      expect((await f.row())?.phase).toBe('active')
      expect(f.installed.session.state().activeHandleIds).toEqual([
        'first-original-worker',
        'second-original-worker',
      ])
    } finally {
      release.resolve()
      await f.close()
    }
  })

  test('normal pause closes new dispatch and the real write row before waiting for an admitted result', async () => {
    const entered = deferred(),
      release = deferred()
    let current: (() => boolean) | undefined
    const f = await fixture(harness, {
      async run(_context, captured) {
        current = captured
        entered.resolve()
        await release.promise
      },
    })
    try {
      await f.installed.resume(f.scope)
      await entered.promise
      const context = f.contexts[0]!
      let paused = false
      const pausing = f.installed.pause(f.scope).then(() => {
        paused = true
      })
      await nextTurn()
      expect(paused).toBe(false)
      expect(context.current()).toBe(true)
      expect(current?.()).toBe(false)
      expect(context.canDispatch?.()).toBe(false)
      expect(f.bootstrap.admission.acquire('task').kind).toBe('unavailable')
      await eventually(f.row, (row) => row?.phase === 'draining', {
        what: 'actual host write quiesce ACK',
      })
      release.resolve()
      await pausing
      expect(context.current()).toBe(false)
      expect((await f.row())?.phase).toBe('closed')
      expect(f.installed.session.state().activeHandleIds).toEqual([])
    } finally {
      release.resolve()
      await f.close()
    }
  })

  test('pause during the second startup cancels activation without dispatching the first worker', async () => {
    const entered = deferred(),
      release = deferred()
    const f = await fixture(harness, {
      async prepareSecond() {
        entered.resolve()
        await release.promise
      },
    })
    const starting = f.installed.resume(f.scope)
    void starting.catch(() => {})
    try {
      await entered.promise
      const context = f.contexts[0]!,
        pausing = f.installed.pause(f.scope)
      expect(context.current()).toBe(false)
      expect(context.whenActive && (await context.whenActive)).toBe(false)
      release.resolve()
      await starting.catch(() => {})
      await pausing
      expect(f.runs).toHaveLength(0)
      expect((await f.row())?.phase).toBe('closed')
    } finally {
      release.resolve()
      await starting.catch(() => {})
      await f.close()
    }
  })

  test('a rejected startup leaves activation false; a later real lifetime can start cleanly', async () => {
    let rejectStart = true
    const ran = deferred(),
      original = new Error('original-config-read-rejected')
    const f = await fixture(harness, {
      async prepareSecond() {
        if (rejectStart) throw original
      },
      run: async () => {
        ran.resolve()
      },
    })
    try {
      await expect(f.installed.resume(f.scope)).rejects.toThrow('original-config-read-rejected')
      expect(f.runs).toHaveLength(0)
      const first = f.contexts[0]!
      expect(first.whenActive && (await first.whenActive)).toBe(false)
      expect((await f.row())?.phase).toBe('closed')
      rejectStart = false
      await f.installed.resume(f.scope)
      await ran.promise
      expect(f.contexts[1]!.reference).not.toBe(first.reference)
      expect(f.contexts[1]!.whenActive && (await f.contexts[1]!.whenActive)).toBe(true)
      expect(first.canDispatch?.()).toBe(false)
    } finally {
      await f.close()
    }
  })

  test('resume after normal pause allocates a fresh exact control/write epoch', async () => {
    const events: HostExecutionGrantContext[] = [],
      second = deferred()
    const f = await fixture(harness, {
      async run(context) {
        events.push(context)
        if (events.length === 2) second.resolve()
      },
    })
    try {
      await f.installed.resume(f.scope)
      await nextTurn()
      const first = f.contexts[0]!,
        old = await f.row()
      await f.installed.pause(f.scope)
      await f.installed.resume(f.scope)
      await second.promise
      expect(f.contexts[1]!.reference).not.toBe(first.reference)
      expect(first.current()).toBe(false)
      expect(events).toEqual(f.contexts)
      expect((await f.row())!.revision).toBeGreaterThan(old!.revision)
    } finally {
      await f.close()
    }
  })

  test('a mismatched pause scope cannot change control or any original write receipt', async () => {
    const f = await fixture(harness)
    try {
      await f.installed.resume(f.scope)
      const before = await f.row()
      await expect(
        f.installed.pause({ ...f.scope, generationId: 'different-generation' }),
      ).rejects.toThrow('scope does not match')
      expect(await f.row()).toEqual(before)
      expect(f.bootstrap.queries.snapshot().phase).toBe('active')
    } finally {
      await f.close()
    }
  })
})
