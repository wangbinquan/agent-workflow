// RFC-370 H7: actual SO writes and provider sessions share one construction
// graph. These cases cover construction/activation, not the nineteen-owner roster.
import { expect, test } from 'bun:test'
import { hostExecutionWriteContexts } from '@/db/schema'
import {
  assertTaskHostWriteCapture,
  consumeTaskHostNewWork,
  consumeTaskHostIssuedAck,
} from '@/modules/task-execution/application/taskHostWriteCapture'
import {
  composeDaemonHostExecutionBootstrap,
  installDaemonHostExecutionSession,
  type DaemonHostExecutionSelection,
} from '../src/cli/daemonHostExecutionBootstrap'
import { createDaemonProviderRuntimeSession } from '../src/cli/daemonProviderRuntimeSession'
import type {
  HostExecutionAuthorityDriver,
  HostExecutionGrantContext,
  HostExecutionRecoveryFamily,
  HostExecutionRuntimeFamily,
} from '@/modules/system-operations/public/participants'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { deferred } from './helpers/taskHostExecution'

function fixture(
  harness: ProviderHarness,
  mode: DaemonHostExecutionSelection['mode'] = 'execution',
) {
  const provider = harness.applicationBinding.provider
  const generation = 'host-bootstrap-generation'
  const calls: string[] = []
  const reference = Object.freeze({})
  const contexts: HostExecutionGrantContext[] = []
  const failures: unknown[] = []
  let observation: Parameters<HostExecutionAuthorityDriver['subscribe']>[0] | undefined
  const driver: HostExecutionAuthorityDriver = {
    claim() {
      calls.push('claim')
      return { kind: 'granted', reference }
    },
    renew(actual) {
      expect(actual).toBe(reference)
      return { kind: 'granted', reference }
    },
    activate(request) {
      calls.push('activate')
      expect(request.reference).toBe(reference)
      expect(request.preparationDigest).toBe('real-recovery-result')
      return { kind: 'granted', reference }
    },
    quiesce() {
      calls.push('driver.quiesce')
    },
    release(actual) {
      expect(actual).toBe(reference)
      calls.push('release')
    },
    subscribe(input) {
      observation = input
      calls.push('subscribe')
      return {
        close() {
          calls.push('unsubscribe')
        },
      }
    },
  }
  const recovery: HostExecutionRecoveryFamily = {
    kind: 'local-startup',
    async prepare(context) {
      expect<HostExecutionRecoveryFamily>(this).toBe(recovery)
      contexts.push(context)
      calls.push('prepare')
      const rows = await harness.db.select().from(hostExecutionWriteContexts)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        generation,
        holder: 'host-bootstrap-holder',
        phase: 'preparing',
      })
      return {
        kind: 'prepared',
        preparationDigest: 'real-recovery-result',
        acceptedTaskContractVersions: ['task.v1'],
        readyGroups: ['task'],
      }
    },
    quiesce({ context }) {
      expect<HostExecutionRecoveryFamily>(this).toBe(recovery)
      expect(contexts).toContain(context)
      calls.push('recovery.quiesce')
    },
    drain(context) {
      expect<HostExecutionRecoveryFamily>(this).toBe(recovery)
      expect(contexts).toContain(context)
      calls.push('recovery.drain')
    },
  }
  const input = {
    db: harness.db,
    provider,
    generation,
    selection: {
      mode,
      recoveryKind: 'local-startup' as const,
      authority: {
        create() {
          calls.push('create')
          return driver
        },
      },
      leaseFacts: {
        forGrant(context: HostExecutionGrantContext) {
          expect(context.reference).toBe(reference)
          return { holder: 'host-bootstrap-holder', expiresAt: Date.now() + 60000 }
        },
      },
    },
    onFailure(error: unknown) {
      failures.push(error)
    },
  }
  return {
    input,
    provider,
    generation,
    calls,
    contexts,
    failures,
    recovery,
    lose() {
      observation!.onObservation({ kind: 'lost', reason: 'test-loss' })
    },
  }
}

describeEachProvider('RFC-370 host execution bootstrap', (harness) => {
  test('construction awaits the actual factory without claims, writes or exposed lifecycle', async () => {
    const f = fixture(harness)
    const entered = deferred<void>(),
      release = deferred<void>()
    const create = f.input.selection.authority.create
    let ready = false
    const pending = composeDaemonHostExecutionBootstrap({
      ...f.input,
      selection: {
        ...f.input.selection,
        authority: {
          async create() {
            entered.resolve()
            await release.promise
            return create()
          },
        },
      },
    }).then((value) => {
      ready = true
      return value
    })
    await entered.promise
    expect(ready).toBe(false)
    expect(await harness.db.select().from(hostExecutionWriteContexts)).toEqual([])
    release.resolve()
    const bootstrap = await pending
    expect(f.calls).toEqual(['create'])
    expect('lifecycle' in bootstrap).toBe(false)
    expect(bootstrap.taskHost.admission.acquire().kind).toBe('unavailable')
    expect(await harness.db.select().from(hostExecutionWriteContexts)).toEqual([])
  })

  test('installation rejects partial or foreign owners without consuming the valid installation', async () => {
    const f = fixture(harness)
    const bootstrap = await composeDaemonHostExecutionBootstrap(f.input)
    const runtime: HostExecutionRuntimeFamily = { start() {}, quiesce() {}, drain() {} }
    expect(() =>
      bootstrap.install({ scope: { ...bootstrap.scope }, recovery: f.recovery, runtime }),
    ).toThrow('daemon-host-owner-scope-mismatch')
    expect(() =>
      bootstrap.install({
        scope: bootstrap.scope,
        recovery: { ...f.recovery, kind: 'durable-intent' },
        runtime,
      }),
    ).toThrow('daemon-host-recovery-kind-mismatch')
    expect(() =>
      bootstrap.install({
        scope: bootstrap.scope,
        recovery: f.recovery,
        runtime: { ...runtime, drain: undefined } as unknown as HostExecutionRuntimeFamily,
      }),
    ).toThrow('daemon-host-runtime-missing-drain')
    const authority = bootstrap.install({ scope: bootstrap.scope, recovery: f.recovery, runtime })
    expect(authority.admission).toBe(bootstrap.admission)
    expect(authority.queries).toBe(bootstrap.queries)
    expect(() =>
      bootstrap.install({ scope: bootstrap.scope, recovery: f.recovery, runtime }),
    ).toThrow('daemon-host-owners-already-installed')
    expect(f.calls).toEqual(['create'])
    await authority.lifecycle.close()
  })

  for (const mode of ['execution', 'resource-only'] as const) {
    test(`${mode} opens resources first and only the execution mode prepares and starts handles`, async () => {
      const f = fixture(harness, mode)
      const bootstrap = await composeDaemonHostExecutionBootstrap(f.input)
      let failResourceAdmission = true
      const resourceFailure = new Error('resource HTTP admission failed')
      const drained = deferred<void>(),
        drainEntered = deferred<void>()
      const session = await createDaemonProviderRuntimeSession({
        provider: f.provider,
        generationId: f.generation,
        runtime: {
          fetch: () => new Response('resources'),
          tryUpgrade: () => false,
          websocketHandlers: {},
        },
        admission: {
          closeWriterAdmission() {
            f.calls.push('http.close')
          },
          openWriterAdmission() {
            f.calls.push('http.open')
            if (failResourceAdmission) throw resourceFailure
          },
          closeWebSocketAdmission() {
            f.calls.push('ws.close')
          },
          openWebSocketAdmission() {
            f.calls.push('ws.open')
          },
        },
        runtimeFactories: [
          {
            id: 'task-execution',
            start() {
              throw new Error('native fallback')
            },
          },
        ],
        hostExecutionRuntime: {
          handles: [
            {
              id: 'task-execution',
              group: 'task',
              async start({ context }) {
                expect(context).toBe(f.contexts[0])
                f.calls.push('runtime.start')
                expect((await harness.db.select().from(hostExecutionWriteContexts))[0]?.phase).toBe(
                  'active',
                )
                return {
                  stop() {
                    f.calls.push('normal.stop')
                  },
                  drain() {
                    f.calls.push('normal.drain')
                  },
                }
              },
              quiesceAuthorityLoss({ context }) {
                expect(context).toBe(f.contexts[0])
                f.calls.push('loss.quiesce')
              },
              drainAuthorityLoss() {
                f.calls.push('loss.drain')
                drainEntered.resolve()
                return drained.promise
              },
            },
          ],
        },
        shutdownIdentity() {
          f.calls.push('identity.close')
        },
        closeProvider() {
          f.calls.push('provider.close')
        },
      })
      const selected = installDaemonHostExecutionSession({
        bootstrap,
        recovery: f.recovery,
        session,
      })
      // The installed callbacks retain the exact original methods and receivers.
      f.recovery.prepare = () => {
        throw new Error('replacement recovery')
      }
      const resumeScope = { operationId: 'boot', provider: f.provider, generationId: f.generation }
      await expect(selected.resume(resumeScope)).rejects.toBe(resourceFailure)
      expect(f.calls).not.toContain('claim')
      expect(f.calls).not.toContain('prepare')
      expect(session.state().phase).toBe('frozen')
      expect(await harness.db.select().from(hostExecutionWriteContexts)).toEqual([])
      failResourceAdmission = false
      await selected.resume({
        operationId: 'boot',
        provider: f.provider,
        generationId: f.generation,
      })
      expect(session.state().phase).toBe('running')
      expect(await (await session.runtime.fetch(new Request('http://aw/resources'))).text()).toBe(
        'resources',
      )
      expect(f.calls.indexOf('ws.open')).toBeLessThan(f.calls.indexOf('http.open'))
      if (mode === 'resource-only') {
        expect(f.calls).not.toContain('claim')
        expect(f.calls).not.toContain('prepare')
        expect(f.calls).not.toContain('runtime.start')
        expect(await harness.db.select().from(hostExecutionWriteContexts)).toEqual([])
        expect(bootstrap.queries.snapshot().readyGroups).toEqual([])
      } else {
        expect(f.calls.indexOf('http.open')).toBeLessThan(f.calls.indexOf('claim'))
        expect(f.calls.indexOf('prepare')).toBeLessThan(f.calls.indexOf('activate'))
        expect(f.calls.indexOf('activate')).toBeLessThan(f.calls.indexOf('runtime.start'))
        const admission = bootstrap.taskHost.admission.acquire()
        expect(admission.kind).toBe('admitted')
        if (admission.kind !== 'admitted') throw new Error('missing Task admission')
        // Capture comes from this bootstrap's actual persisted preparing/active receipt.
        assertTaskHostWriteCapture(admission.lease.capture, bootstrap.taskHost.writes.port)
        await harness.session.transaction(async (tx) => {
          await consumeTaskHostNewWork(
            admission.lease.capture,
            bootstrap.taskHost.writes.transactionFor(tx),
          )
        })
        f.lose()
        await drainEntered.promise
        expect(bootstrap.taskHost.admission.acquire().kind).toBe('unavailable')
        expect(f.calls).not.toContain('normal.stop')
        expect(f.calls).not.toContain('release')
        expect(session.state().phase).toBe('running')
        await harness.session.transaction(async (tx) => {
          await consumeTaskHostIssuedAck(
            admission.lease.capture,
            bootstrap.taskHost.writes.transactionFor(tx),
          )
        })
        drained.resolve()
        admission.lease.complete()
        await selected.authority.lifecycle.settled()
        expect(f.calls).toContain('release')
        expect((await harness.db.select().from(hostExecutionWriteContexts))[0]?.phase).toBe(
          'closed',
        )
      }
      await selected.authority.lifecycle.close()
      await session.close({ reason: 'daemon-shutdown' })
      expect(f.failures).toEqual([])
    })
  }
})
