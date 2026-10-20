// RFC-379: canonical order, provider parity, failure policies and authority timing.
import { describe, expect, test } from 'bun:test'
import {
  DAEMON_BOOT_STEPS,
  DAEMON_RUNTIME_JOBS,
  DAEMON_BACKGROUND_JOBS,
  DAEMON_CLOSE_PARTICIPANTS,
  NotApplicable,
  composeDaemonLifecycle,
} from '../src/cli/daemonLifecycleProgram'
import { selectExecutionInitialization } from '../src/bootstrap/executionInitialization'
import type {
  ExecutionFence,
  ExecutionAuthorityPort,
} from '../src/modules/system-operations/public/participants'
import { deferred, lifecycleFixture, runtimeSession, lifecycle } from './helpers/daemonLifecycle'

const expectedSteps = [
  'runtime-declarations',
  'process-registrations',
  'repository-url-sealing',
  'transport-projections',
  'git-credential-lease-cleanup',
  'daemon-identity',
  'skill-identity-barrier',
  'fusion-provenance',
  'skill-availability-gate',
  'skill-live-files',
  'runtime-registry',
  'event-catalog',
  'employee-agent-templates',
  'employee-tool-catalog',
  'employee-authoring-ready',
  'employee-writer-state',
  'scheduled-payload-heal',
  'fusion-resource-seed',
  'demo-seed',
  'task-execution-recovery',
  'observation-interrupt',
  'task-delete-recovery',
  'archive-recovery',
  'workspace-maintenance-recovery',
  'frame-backfill',
  'fusion-decision-recovery',
  'mr-terminal-reconcile',
  'webhook-delivery-recovery',
  'legacy-mission-recovery',
  'employee-upgrade-settlement',
  'maintenance-boot-snapshot',
  'hosted-targeted-resume',
  'resource-reverify',
  'bootstrap-admin-hint',
] as const

test('the canonical program declares every step, phase, failure policy and profile slot', () => {
  expect(DAEMON_BOOT_STEPS.map(({ id }) => id)).toEqual([...expectedSteps])
  expect(DAEMON_RUNTIME_JOBS.map(({ id }) => id)).toEqual([
    'intent-queued-resumption',
    'task-execution',
    'maintenance',
    'mcp-runtime-tests',
  ])
  expect(DAEMON_BACKGROUND_JOBS.map(({ id }) => id)).toEqual([
    'webhook-terminal-control',
    'after-commit-event-pump',
    'human-gate-continuation',
    'committed-event-dispatcher',
    'memory-distill',
    'development-wake',
    'digital-employee-os',
    'event-center',
    'fusion-reconcile',
    'resource-limits',
    'task-idle-timeout',
    'scheduled-backup',
    'submodule-refresh',
    'batch-import-gc',
    'hosted-execution-settlement',
    'hosted-workspace-command-reconciliation',
    'hosted-workspace-lifecycle',
  ])
  expect(DAEMON_CLOSE_PARTICIPANTS.map(({ id }) => id)).toEqual([
    'memory-distill-recover-running',
    'task-execution-final-close',
    'maintenance-final-close',
    'mcp-runtime-tests-final-close',
    'task-execution-graceful-shutdown',
    'webhook-terminal-control',
  ])
  for (const step of DAEMON_BOOT_STEPS)
    if ('providers' in step) expect(step.providerReason.length).toBeGreaterThan(30)
})

test('G12: full provider records yield identical standalone lists and only the declared hosted additions', () => {
  const lists = (provider: 'sqlite' | 'postgresql', profile: 'standalone' | 'crewstation') => {
    const program = lifecycleFixture(provider, profile).compose()
    return [
      program.declarations,
      program.runtimeFactories,
      program.backgroundWriterFactories,
      program.providerCloseParticipants,
    ].map((list) => list.map(({ id }) => id))
  }
  expect(lists('sqlite', 'standalone')).toEqual(lists('postgresql', 'standalone'))
  const hosted = lists('postgresql', 'crewstation'),
    local = lists('postgresql', 'standalone')
  expect(hosted[0]!.filter((id) => id !== 'hosted-targeted-resume')).toEqual(local[0]!)
  expect(hosted[1]).toEqual(local[1])
  expect(hosted[2]!.slice(0, -3)).toEqual(local[2]!)
  expect(hosted[3]).toEqual(local[3])
})

for (const provider of ['sqlite', 'postgresql'] as const)
  describe(provider, () => {
    test('composition is passive; prepare/recovery run once per session and registrations repeat on resume', async () => {
      const fixture = lifecycleFixture(provider),
        program = fixture.compose()
      expect(fixture.events).toEqual([])
      await program.initialize()
      const first = [...fixture.events]
      await program.initialize()
      expect(fixture.events).toEqual(first)
      const session = await runtimeSession({ provider, ...program.sessionOptions() })
      await session.resume({ ...lifecycle, provider })
      await session.pause({ ...lifecycle, provider })
      await session.resume({ ...lifecycle, provider })
      expect(fixture.events.filter((id) => id === 'process-registrations')).toHaveLength(3)
      expect(fixture.events.indexOf('task-execution-recovery')).toBeLessThan(
        fixture.events.indexOf('mr-terminal-reconcile'),
      )
      expect(fixture.events.indexOf('task-execution-recovery')).toBeLessThan(
        fixture.events.indexOf('webhook-delivery-recovery'),
      )
      expect(fixture.events.indexOf('employee-agent-templates')).toBeLessThan(
        fixture.events.indexOf('employee-tool-catalog'),
      )
      expect(fixture.events).not.toContain('bootstrap-admin-hint')
      await session.postReady()
      await session.close({ reason: 'provider-switch' })
      expect(session.state().steps.map(({ id }) => id)).toEqual(
        expectedSteps.filter((id) => id !== 'hosted-targeted-resume'),
      )
      const target = fixture.compose()
      await target.initialize()
      expect(fixture.events.filter((id) => id === 'task-execution-recovery')).toHaveLength(2)
    })
  })

test('NotApplicable, missing records, id mismatches and invalid profile jobs fail construction', () => {
  for (const id of ['runtime-declarations', 'repository-url-sealing'] as const) {
    const fixture = lifecycleFixture()
    fixture.input.steps[id] = NotApplicable
    expect(fixture.compose).toThrow(id)
  }
  const wrongProvider = lifecycleFixture('postgresql')
  wrongProvider.input.steps['repository-url-sealing'] = () => {}
  expect(wrongProvider.compose).toThrow('repository-url-sealing')
  const dependency = lifecycleFixture()
  dependency.input.runtimeJobs['intent-queued-resumption'] = {
    ...dependency.input.runtimeJobs['intent-queued-resumption'],
    dependsOn: ['task-execution'],
  }
  expect(dependency.compose).toThrow('non-earlier')
  const absent = lifecycleFixture()
  delete (absent.input.runtimeJobs as Partial<typeof absent.input.runtimeJobs>)['maintenance']
  expect(absent.compose).toThrow('maintenance')
  expect(() =>
    composeDaemonLifecycle({
      ...lifecycleFixture().input,
      profileJobs: [{ id: 'unknown', start: () => ({ stop() {}, drain() {} }) }],
    }),
  ).toThrow('profile')
  expect(() =>
    composeDaemonLifecycle({
      ...lifecycleFixture('postgresql', 'crewstation').input,
      profileJobs: [],
    }),
  ).toThrow('profile')
})

test('fail-closed aborts its phase; best-effort records error and continues', async () => {
  const fatal = lifecycleFixture()
  fatal.input.steps['skill-identity-barrier'] = () => {
    throw new Error('identity failed')
  }
  const program = fatal.compose()
  await expect(program.runPhase('prepare')).rejects.toThrow('identity failed')
  expect(fatal.events).not.toContain('employee-tool-catalog')
  expect(
    program
      .sessionOptions()
      .bootSteps()
      .find(({ id }) => id === 'skill-identity-barrier'),
  ).toMatchObject({ outcome: 'failed', error: 'Error: identity failed' })
  const best = lifecycleFixture()
  best.input.steps['skill-live-files'] = () => {
    throw new Error('files failed')
  }
  const continuing = best.compose()
  await continuing.initialize()
  expect(best.events).toContain('task-execution-recovery')
  expect(
    continuing
      .sessionOptions()
      .bootSteps()
      .find(({ id }) => id === 'skill-live-files'),
  ).toMatchObject({ outcome: 'failed' })
})

test('tracked post-ready work is drained, rejected work is observed, and shutdown abandons stuck work', async () => {
  for (const outcome of ['ok', 'failed', 'abandoned'] as const) {
    const work = deferred(),
      fixture = lifecycleFixture()
    fixture.input.steps['resource-reverify'] = () => work.promise
    const program = composeDaemonLifecycle({ ...fixture.input, detachedTimeoutMs: 10 })
    await program.runPhase('post-ready')
    expect(fixture.events).toContain('bootstrap-admin-hint')
    if (outcome === 'ok') work.resolve()
    if (outcome === 'failed') work.reject(new Error('verification failed'))
    await program.sessionOptions().beforeClose('daemon-shutdown')
    expect(
      program
        .sessionOptions()
        .bootSteps()
        .find(({ id }) => id === 'resource-reverify')?.outcome,
    ).toBe(outcome)
    work.resolve()
  }
})

test('hosted standby starts authority only after prepare, and recovers before any job or targeted resume', async () => {
  const active = deferred<ExecutionFence>(),
    fixture = lifecycleFixture('postgresql', 'crewstation')
  let state: ReturnType<ExecutionAuthorityPort['current']> = { kind: 'standby', reason: 'test' }
  const raw = {
    mode: 'crewstation' as const,
    current: () => state,
    whenActive: () => active.promise,
    onLost: () => () => {},
    close: async () => {},
    start: () => {
      fixture.events.push('authority-start')
    },
  }
  const selected = selectExecutionInitialization(raw)
  const program = fixture.compose()
  await program.initialize(selected.initialize)
  await program.initialize(selected.initialize)
  expect(fixture.events.filter((id) => id === 'authority-start')).toHaveLength(1)
  expect(fixture.events.indexOf('runtime-registry')).toBeLessThan(
    fixture.events.indexOf('authority-start'),
  )
  for (const id of [
    'task-execution-recovery',
    'mr-terminal-reconcile',
    'webhook-delivery-recovery',
    'employee-upgrade-settlement',
    'hosted-targeted-resume',
  ])
    expect(fixture.events).not.toContain(id)
  const session = await runtimeSession({
    provider: 'postgresql',
    ...program.sessionOptions({
      authority: selected.authority,
      onActivationFailure: (error) => {
        throw error
      },
    }),
  })
  await session.resume({ ...lifecycle, provider: 'postgresql' })
  expect(fixture.events.filter((event) => event.startsWith('start:'))).toEqual([])
  const fence = { epoch: 1 } as ExecutionFence
  state = { kind: 'active', fence }
  active.resolve(fence)
  await selected.authority.whenActive()
  await new Promise<void>((resolve) => setImmediate(resolve))
  for (const id of [
    'mr-terminal-reconcile',
    'webhook-delivery-recovery',
    'employee-upgrade-settlement',
    'hosted-targeted-resume',
  ])
    expect(fixture.events.indexOf(id)).toBeGreaterThan(
      fixture.events.indexOf('task-execution-recovery'),
    )
  expect(fixture.events.indexOf('hosted-targeted-resume')).toBeLessThan(
    fixture.events.indexOf('start:task-execution'),
  )
  await session.close({ reason: 'daemon-shutdown' })
})
