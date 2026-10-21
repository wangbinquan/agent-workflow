// RFC-379: complete fake provider records exercise the real lifecycle program.
import {
  DAEMON_BOOT_STEPS,
  DAEMON_RUNTIME_JOBS,
  DAEMON_BACKGROUND_JOBS,
  DAEMON_CLOSE_PARTICIPANTS,
  NotApplicable,
  composeDaemonLifecycle,
  type DaemonLifecycleInput,
} from '../../src/bootstrap/daemonLifecycleProgram'
import {
  createDaemonProviderRuntimeSession,
  type CreateDaemonProviderRuntimeSessionInput,
} from '../../src/bootstrap/daemonProviderRuntimeSession'

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
export function lifecycleFixture(
  provider: 'sqlite' | 'postgresql' = 'sqlite',
  profile: 'standalone' | 'crewstation' = 'standalone',
) {
  const events: string[] = []
  const factory = (id: string) => ({
    id,
    start: () => {
      events.push(`start:${id}`)
      return {
        stop: () => {
          events.push(`stop:${id}`)
        },
        drain: () => {
          events.push(`drain:${id}`)
        },
      }
    },
  })
  const input: DaemonLifecycleInput = {
    provider,
    profile,
    steps: Object.fromEntries(
      DAEMON_BOOT_STEPS.map((step) => [
        step.id,
        'providers' in step && !(step.providers as readonly string[]).includes(provider)
          ? NotApplicable
          : () => {
              events.push(step.id)
            },
      ]),
    ) as DaemonLifecycleInput['steps'],
    runtimeJobs: Object.fromEntries(
      DAEMON_RUNTIME_JOBS.map(({ id }) => [id, factory(id)]),
    ) as unknown as DaemonLifecycleInput['runtimeJobs'],
    backgroundJobs: Object.fromEntries(
      DAEMON_BACKGROUND_JOBS.filter((job) => !('profile' in job)).map(({ id }) => [
        id,
        factory(id),
      ]),
    ) as unknown as DaemonLifecycleInput['backgroundJobs'],
    closeParticipants: Object.fromEntries(
      DAEMON_CLOSE_PARTICIPANTS.map(({ id }) => [
        id,
        {
          id,
          close: () => {
            events.push(`close:${id}`)
          },
        },
      ]),
    ) as unknown as DaemonLifecycleInput['closeParticipants'],
    profileJobs:
      profile === 'crewstation'
        ? DAEMON_BACKGROUND_JOBS.filter((job) => 'profile' in job).map(({ id }) => factory(id))
        : [],
    log: { info() {}, warn() {} },
  }
  return { input, events, compose: () => composeDaemonLifecycle(input) }
}
export const lifecycle = {
  provider: 'sqlite' as const,
  generationId: 'fixture',
  operationId: 'boot',
}
export function runtimeSession(input: Partial<CreateDaemonProviderRuntimeSessionInput> = {}) {
  return createDaemonProviderRuntimeSession({
    ...lifecycle,
    runtime: { fetch: () => new Response('ok'), tryUpgrade: () => false, websocketHandlers: {} },
    admission: {
      closeWriterAdmission() {},
      openWriterAdmission() {},
      closeWebSocketAdmission() {},
      openWebSocketAdmission() {},
    },
    shutdownIdentity() {},
    closeProvider() {},
    ...input,
  })
}
