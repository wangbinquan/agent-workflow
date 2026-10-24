// RFC-379: the sole ordered daemon program. Provider roots supply implementations by id.
import type { DaemonProviderKind } from './daemonProviderSession'
import type {
  DaemonProviderRuntimeHandleFactory,
  DaemonProviderCloseParticipant,
  DaemonBootStepReceipt,
} from './daemonProviderRuntimeSession'
import { validateDaemonJobFactories } from './daemonProviderRuntimeSession'
import { startOnExecutionActive } from './executionActivation'
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'
import { createLogger } from '@/util/log'

export type DaemonPhase = 'prepare' | 'execution-recovery' | 'post-ready'
export type DaemonFailurePolicy = 'fail-closed' | 'best-effort' | 'tracked-detached'
export interface DaemonBootStepDeclaration {
  readonly id: string
  readonly phase: DaemonPhase
  readonly failure: DaemonFailurePolicy
  readonly providers?: readonly DaemonProviderKind[]
  readonly providerReason?: string
  readonly profile?: 'crewstation'
}
export const DAEMON_BOOT_STEPS = [
  { id: 'runtime-declarations', phase: 'prepare', failure: 'fail-closed' },
  { id: 'process-registrations', phase: 'prepare', failure: 'fail-closed' },
  {
    id: 'repository-url-sealing',
    phase: 'prepare',
    failure: 'fail-closed',
    providers: ['sqlite'],
    providerReason:
      'Legacy SQLite plaintext repository URL convergence; PostgreSQL has no legacy URL migration.',
  },
  { id: 'transport-projections', phase: 'prepare', failure: 'fail-closed' },
  { id: 'git-credential-lease-cleanup', phase: 'prepare', failure: 'best-effort' },
  {
    id: 'daemon-identity',
    phase: 'prepare',
    failure: 'fail-closed',
    providers: ['postgresql'],
    providerReason:
      'PostgreSQL retains its daemon identity boot check; both providers admit per operation.',
  },
  { id: 'skill-identity-barrier', phase: 'prepare', failure: 'fail-closed' },
  { id: 'fusion-provenance', phase: 'prepare', failure: 'fail-closed' },
  { id: 'skill-availability-gate', phase: 'prepare', failure: 'fail-closed' },
  { id: 'skill-live-files', phase: 'prepare', failure: 'best-effort' },
  { id: 'runtime-registry', phase: 'prepare', failure: 'fail-closed' },
  { id: 'event-catalog', phase: 'prepare', failure: 'fail-closed' },
  { id: 'employee-agent-templates', phase: 'prepare', failure: 'fail-closed' },
  { id: 'employee-tool-catalog', phase: 'prepare', failure: 'fail-closed' },
  { id: 'employee-authoring-ready', phase: 'prepare', failure: 'fail-closed' },
  { id: 'employee-writer-state', phase: 'prepare', failure: 'fail-closed' },
  { id: 'scheduled-payload-heal', phase: 'prepare', failure: 'best-effort' },
  { id: 'fusion-resource-seed', phase: 'prepare', failure: 'best-effort' },
  { id: 'demo-seed', phase: 'prepare', failure: 'best-effort' },
  { id: 'task-execution-recovery', phase: 'execution-recovery', failure: 'fail-closed' },
  { id: 'observation-interrupt', phase: 'execution-recovery', failure: 'fail-closed' },
  { id: 'task-delete-recovery', phase: 'execution-recovery', failure: 'best-effort' },
  { id: 'archive-recovery', phase: 'execution-recovery', failure: 'best-effort' },
  { id: 'workspace-maintenance-recovery', phase: 'execution-recovery', failure: 'best-effort' },
  { id: 'fusion-decision-recovery', phase: 'execution-recovery', failure: 'best-effort' },
  { id: 'mr-terminal-reconcile', phase: 'execution-recovery', failure: 'fail-closed' },
  { id: 'webhook-delivery-recovery', phase: 'execution-recovery', failure: 'fail-closed' },
  {
    id: 'legacy-mission-recovery',
    phase: 'execution-recovery',
    failure: 'best-effort',
  },
  { id: 'employee-upgrade-settlement', phase: 'execution-recovery', failure: 'fail-closed' },
  { id: 'maintenance-boot-snapshot', phase: 'execution-recovery', failure: 'fail-closed' },
  {
    id: 'hosted-targeted-resume',
    phase: 'execution-recovery',
    failure: 'fail-closed',
    profile: 'crewstation',
  },
  { id: 'resource-reverify', phase: 'post-ready', failure: 'tracked-detached' },
  { id: 'bootstrap-admin-hint', phase: 'post-ready', failure: 'best-effort' },
] as const satisfies readonly DaemonBootStepDeclaration[]

export const DAEMON_RUNTIME_JOBS = [
  {
    id: 'intent-queued-resumption',
    phase: 'pre-listen',
    requiresExecution: true,
    stopTimeoutMs: 10000,
  },
  { id: 'task-execution', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 30000 },
  { id: 'maintenance', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 10000 },
  { id: 'mcp-runtime-tests', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 10000 },
] as const

export const DAEMON_BACKGROUND_JOBS = [
  {
    id: 'webhook-terminal-control',
    phase: 'pre-listen',
    requiresExecution: true,
    stopTimeoutMs: 10000,
  },
  {
    id: 'after-commit-event-pump',
    phase: 'pre-listen',
    requiresExecution: true,
    stopTimeoutMs: 10000,
  },
  {
    id: 'human-gate-continuation',
    phase: 'pre-listen',
    requiresExecution: true,
    stopTimeoutMs: 10000,
  },
  {
    id: 'committed-event-dispatcher',
    phase: 'pre-listen',
    requiresExecution: true,
    stopTimeoutMs: 10000,
  },
  { id: 'memory-distill', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 10000 },
  { id: 'development-wake', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 10000 },
  { id: 'digital-employee-os', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 10000 },
  { id: 'event-center', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 10000 },
  { id: 'fusion-reconcile', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 10000 },
  { id: 'resource-limits', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 10000 },
  { id: 'task-idle-timeout', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 10000 },
  { id: 'scheduled-backup', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 10000 },
  { id: 'submodule-refresh', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 10000 },
  { id: 'batch-import-gc', phase: 'pre-listen', requiresExecution: true, stopTimeoutMs: 10000 },
  {
    id: 'hosted-execution-settlement',
    phase: 'pre-listen',
    requiresExecution: true,
    stopTimeoutMs: 10_000,
    profile: 'crewstation',
  },
  {
    id: 'hosted-workspace-command-reconciliation',
    phase: 'pre-listen',
    requiresExecution: true,
    stopTimeoutMs: 10_000,
    profile: 'crewstation',
  },
  {
    id: 'hosted-workspace-lifecycle',
    phase: 'pre-listen',
    requiresExecution: true,
    stopTimeoutMs: 10_000,
    profile: 'crewstation',
  },
] as const

export const DAEMON_CLOSE_PARTICIPANTS = [
  { id: 'memory-distill-recover-running' },
  { id: 'task-execution-final-close' },
  { id: 'maintenance-final-close' },
  { id: 'mcp-runtime-tests-final-close' },
  { id: 'task-execution-graceful-shutdown' },
  { id: 'webhook-terminal-control' },
] as const

export type DaemonBootStepId = (typeof DAEMON_BOOT_STEPS)[number]['id']
export type DaemonRuntimeJobId = (typeof DAEMON_RUNTIME_JOBS)[number]['id']
type BackgroundDeclaration = (typeof DAEMON_BACKGROUND_JOBS)[number]
export type DaemonBackgroundJobId = Exclude<
  BackgroundDeclaration,
  { readonly profile: 'crewstation' }
>['id']
export type DaemonCloseParticipantId = (typeof DAEMON_CLOSE_PARTICIPANTS)[number]['id']
export const NotApplicable = Symbol('daemon-step-not-applicable')
export type DaemonBootStep = () => void | Promise<void>
export type DaemonBootSteps = Record<DaemonBootStepId, DaemonBootStep | typeof NotApplicable>
export interface DaemonLifecycleInput {
  readonly provider: DaemonProviderKind
  readonly profile?: 'standalone' | 'crewstation'
  readonly steps: DaemonBootSteps
  readonly runtimeJobs: Record<DaemonRuntimeJobId, DaemonProviderRuntimeHandleFactory>
  readonly backgroundJobs: Record<DaemonBackgroundJobId, DaemonProviderRuntimeHandleFactory>
  readonly closeParticipants: Record<DaemonCloseParticipantId, DaemonProviderCloseParticipant>
  readonly profileJobs?: readonly DaemonProviderRuntimeHandleFactory[]
  readonly detachedTimeoutMs?: number
  readonly log?: Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>
}

export type DaemonLifecycle = ReturnType<typeof composeDaemonLifecycle>
export function composeDaemonLifecycle(input: DaemonLifecycleInput) {
  const profile = input.profile ?? 'standalone'
  const log = input.log ?? createLogger('daemon-lifecycle')
  const declarations = DAEMON_BOOT_STEPS.filter(
    (step) => !('profile' in step) || step.profile === profile,
  )
  for (const step of DAEMON_BOOT_STEPS) {
    const implementation = input.steps[step.id]
    const applicable =
      !('providers' in step) || (step.providers as readonly string[]).includes(input.provider)
    if (applicable ? typeof implementation !== 'function' : implementation !== NotApplicable) {
      throw new Error(`daemon lifecycle invalid implementation: ${step.id} (${input.provider})`)
    }
  }
  const profileDeclarations = DAEMON_BACKGROUND_JOBS.filter(
    (job) => 'profile' in job && job.profile === profile,
  )
  const profileJobs = input.profileJobs ?? []
  if (
    profileJobs.length !== profileDeclarations.length ||
    profileJobs.some((job, i) => job.id !== profileDeclarations[i]?.id)
  ) {
    throw new Error('daemon lifecycle invalid profile jobs')
  }
  const ordered = <T extends { readonly id: string }>(
    declarations: readonly { readonly id: string }[],
    record: Record<string, T>,
  ): T[] =>
    declarations.map(({ id }) => {
      const implementation = record[id]
      if (implementation === undefined || implementation.id !== id)
        throw new Error(`daemon lifecycle missing or mismatched implementation: ${id}`)
      return implementation
    })
  const runtimeFactories = ordered(DAEMON_RUNTIME_JOBS, input.runtimeJobs).map((factory, i) => ({
    ...factory,
    stopTimeoutMs: DAEMON_RUNTIME_JOBS[i]!.stopTimeoutMs,
  }))
  const backgroundWriterFactories = [
    ...ordered(
      DAEMON_BACKGROUND_JOBS.filter((job) => !('profile' in job)),
      input.backgroundJobs,
    ),
    ...profileJobs,
  ].map((factory) => ({ ...factory, stopTimeoutMs: 10_000 }))
  validateDaemonJobFactories([...runtimeFactories, ...backgroundWriterFactories])
  const providerCloseParticipants = ordered(DAEMON_CLOSE_PARTICIPANTS, input.closeParticipants)
  const receipts: DaemonBootStepReceipt[] = []
  const stepStarts = new Map<string, number>()
  let initialization: Promise<void> | undefined
  const phases = new Map<DaemonPhase, Promise<void>>()
  const detached = new Set<Promise<void>>()
  let closed = false
  let authority: Pick<ExecutionAuthorityPort, 'current' | 'whenActive'> | undefined
  const record = (
    step: DaemonBootStepDeclaration,
    startedAt: number,
    outcome: DaemonBootStepReceipt['outcome'],
    error?: unknown,
  ) => {
    const receipt: DaemonBootStepReceipt = {
      id: step.id,
      phase: step.phase,
      outcome,
      durationMs: Date.now() - startedAt,
      ...(error === undefined ? {} : { error: String(error) }),
    }
    receipts.push(receipt)
    log[outcome === 'failed' || outcome === 'abandoned' ? 'warn' : 'info']('lifecycle step', {
      ...receipt,
    })
  }
  const runPhase = (phase: DaemonPhase): Promise<void> => {
    const existing = phases.get(phase)
    if (existing !== undefined) return existing
    const run = async () => {
      for (const step of declarations.filter((step) => step.phase === phase)) {
        if (closed) return
        const startedAt = Date.now()
        stepStarts.set(step.id, startedAt)
        const implementation = input.steps[step.id]
        if (implementation === NotApplicable) {
          record(step, startedAt, 'skipped')
          continue
        }
        if (step.failure === 'tracked-detached') {
          // Log admission in canonical order; completion updates this same receipt.
          record(step, startedAt, 'running')
          const index = receipts.length - 1
          const work = Promise.resolve()
            .then(async () => {
              if (step.id === 'resource-reverify') await authority?.whenActive()
              if (!closed) await implementation()
            })
            .then(
              () => {
                if (receipts[index]!.outcome === 'running')
                  receipts[index] = {
                    ...receipts[index]!,
                    outcome: 'ok',
                    durationMs: Date.now() - startedAt,
                  }
              },
              (error: unknown) => {
                if (receipts[index]!.outcome === 'running') {
                  receipts[index] = {
                    ...receipts[index]!,
                    outcome: 'failed',
                    durationMs: Date.now() - startedAt,
                    error: String(error),
                  }
                  log.warn('lifecycle detached failed', { ...receipts[index]! })
                }
              },
            )
            .finally(() => {
              detached.delete(work)
            })
          detached.add(work)
          continue
        }
        try {
          await implementation()
          record(step, startedAt, 'ok')
        } catch (error) {
          record(step, startedAt, 'failed', error)
          if (step.failure === 'fail-closed') throw error
        }
      }
    }
    const pending = run()
    phases.set(phase, pending)
    return pending
  }
  const drain = async (reason: 'provider-switch' | 'daemon-shutdown') => {
    closed = true
    const work = Promise.allSettled([...phases.values(), ...detached]).then(() => undefined)
    if (reason !== 'daemon-shutdown') {
      await work
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, input.detachedTimeoutMs ?? 10_000)
        }),
      ])
      for (let i = 0; i < receipts.length; i++) {
        if (receipts[i]!.outcome === 'running') {
          receipts[i] = {
            ...receipts[i]!,
            outcome: 'abandoned',
            durationMs: Date.now() - stepStarts.get(receipts[i]!.id)!,
          }
          log.warn('lifecycle detached abandoned', { ...receipts[i]! })
        }
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  return Object.freeze({
    declarations,
    runtimeFactories,
    backgroundWriterFactories,
    providerCloseParticipants,
    runPhase,
    initialize(initializeExecution?: (work: () => Promise<void>) => Promise<void>) {
      return (initialization ??= (async () => {
        await runPhase('prepare')
        if (initializeExecution === undefined) await runPhase('execution-recovery')
        else
          await initializeExecution(() =>
            closed ? Promise.resolve() : runPhase('execution-recovery'),
          )
      })())
    },
    sessionOptions(execution?: {
      readonly authority: Pick<ExecutionAuthorityPort, 'current' | 'whenActive'>
      readonly onActivationFailure: (error: unknown) => void
    }) {
      authority = execution?.authority
      const gate = (factory: DaemonProviderRuntimeHandleFactory) =>
        execution === undefined
          ? factory
          : startOnExecutionActive(execution.authority, factory, execution.onActivationFailure)
      return {
        runtimeFactories: runtimeFactories.map(gate),
        backgroundWriterFactories: backgroundWriterFactories.map(gate),
        providerCloseParticipants,
        beforeResume: async () => {
          const register = input.steps['process-registrations']
          if (register !== NotApplicable) await register()
        },
        beforeClose: drain,
        bootSteps: () => receipts.map((receipt) => ({ ...receipt })),
        postReady: () => runPhase('post-ready'),
      }
    },
  })
}
