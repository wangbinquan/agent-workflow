import { describe, expect, test } from 'bun:test'

import {
  createDaemonProviderSessionController,
  type DaemonProviderSessionError,
  type DaemonProviderSessionLifecycleInput,
  type ManagedDaemonProviderSession,
} from '../src/cli/daemonProviderSession'

interface TestSession extends ManagedDaemonProviderSession {
  readonly events: string[]
}

function session(
  provider: 'sqlite' | 'postgresql',
  generationId: string,
  events: string[],
  input: { readonly failCloseOnce?: boolean; readonly failResumeOnce?: boolean } = {},
): TestSession {
  let closeFailures = input.failCloseOnce === true ? 1 : 0
  let resumeFailures = input.failResumeOnce === true ? 1 : 0
  return Object.freeze({
    provider,
    generationId,
    events,
    async pause(lifecycleInput: DaemonProviderSessionLifecycleInput) {
      events.push(`pause:${provider}:${lifecycleInput.operationId}`)
    },
    async resume(lifecycleInput: DaemonProviderSessionLifecycleInput) {
      events.push(`resume:${provider}:${lifecycleInput.operationId}`)
      if (resumeFailures > 0) {
        resumeFailures -= 1
        throw new Error(`resume-${provider}-failed`)
      }
    },
    async close({ reason }: { readonly reason: 'provider-switch' | 'daemon-shutdown' }) {
      events.push(`close:${provider}:${reason}`)
      if (closeFailures > 0) {
        closeFailures -= 1
        throw new Error(`close-${provider}-failed`)
      }
    },
  })
}

const migration = (
  provider: 'sqlite' | 'postgresql',
  generationId: string,
): DaemonProviderSessionLifecycleInput => ({
  operationId: 'op-1',
  provider,
  generationId,
})

describe('RFC-349 daemon provider session lifecycle', () => {
  test('composes the target while the source is frozen, then resumes only the target', async () => {
    const events: string[] = []
    const sqlite = session('sqlite', 'sqlite-1', events)
    const postgresql = session('postgresql', 'pg-1', events)
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: {
        async create(input) {
          events.push(`compose:${input.provider}:${input.generationId}`)
          return postgresql
        },
      },
    })

    await controller.pauseBackgroundWriters(migration('sqlite', 'sqlite-1'))
    await controller.switchProviderComposition(migration('postgresql', 'pg-1'))
    await controller.resumeBackgroundWriters(migration('postgresql', 'pg-1'))

    expect(controller.current()).toBe(postgresql)
    expect(events).toEqual([
      'pause:sqlite:op-1',
      'compose:postgresql:pg-1',
      'resume:postgresql:op-1',
      'close:sqlite:provider-switch',
    ])
  })

  test('keeps the exact source session current when target composition fails', async () => {
    const events: string[] = []
    const sqlite = session('sqlite', 'sqlite-1', events)
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: {
        async create() {
          events.push('compose:postgresql:failed')
          throw new Error('pg-bootstrap-failed')
        },
      },
    })

    await controller.pauseBackgroundWriters(migration('sqlite', 'sqlite-1'))
    await expect(
      controller.switchProviderComposition(migration('postgresql', 'pg-1')),
    ).rejects.toThrow('pg-bootstrap-failed')
    await controller.resumeBackgroundWriters(migration('sqlite', 'sqlite-1'))

    expect(controller.current()).toBe(sqlite)
    expect(events).toEqual(['pause:sqlite:op-1', 'compose:postgresql:failed', 'resume:sqlite:op-1'])
  })

  test('retains a failed standby close and retries it during daemon shutdown', async () => {
    const events: string[] = []
    const sqlite = session('sqlite', 'sqlite-1', events, { failCloseOnce: true })
    const postgresql = session('postgresql', 'pg-1', events)
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: { create: async () => postgresql },
    })

    await controller.pauseBackgroundWriters(migration('sqlite', 'sqlite-1'))
    await controller.switchProviderComposition(migration('postgresql', 'pg-1'))
    await controller.resumeBackgroundWriters(migration('postgresql', 'pg-1'))
    expect(controller.current()).toBe(postgresql)

    await controller.stop()
    expect(events).toEqual([
      'pause:sqlite:op-1',
      'resume:postgresql:op-1',
      'close:sqlite:provider-switch',
      'close:postgresql:daemon-shutdown',
      'close:sqlite:daemon-shutdown',
    ])
  })

  test('reuses the frozen source session when cutover rolls back before resume', async () => {
    const events: string[] = []
    const sqlite = session('sqlite', 'sqlite-1', events)
    const postgresql = session('postgresql', 'pg-1', events)
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: {
        async create(input) {
          events.push(`compose:${input.provider}:${input.generationId}`)
          return postgresql
        },
      },
    })

    await controller.pauseBackgroundWriters(migration('sqlite', 'sqlite-1'))
    await controller.switchProviderComposition(migration('postgresql', 'pg-1'))
    await controller.switchProviderComposition(migration('sqlite', 'sqlite-1'))
    await controller.resumeBackgroundWriters(migration('sqlite', 'sqlite-1'))

    expect(controller.current()).toBe(sqlite)
    expect(events).toEqual([
      'pause:sqlite:op-1',
      'compose:postgresql:pg-1',
      'close:postgresql:provider-switch',
      'resume:sqlite:op-1',
    ])
  })

  test('keeps the frozen source available when target writer resume fails', async () => {
    const events: string[] = []
    const sqlite = session('sqlite', 'sqlite-1', events)
    const postgresql = session('postgresql', 'pg-1', events, { failResumeOnce: true })
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: { create: async () => postgresql },
    })

    await controller.pauseBackgroundWriters(migration('sqlite', 'sqlite-1'))
    await controller.switchProviderComposition(migration('postgresql', 'pg-1'))
    await expect(
      controller.resumeBackgroundWriters(migration('postgresql', 'pg-1')),
    ).rejects.toThrow('resume-postgresql-failed')
    await controller.switchProviderComposition(migration('sqlite', 'sqlite-1'))
    await controller.resumeBackgroundWriters(migration('sqlite', 'sqlite-1'))

    expect(controller.current()).toBe(sqlite)
    expect(events).toEqual([
      'pause:sqlite:op-1',
      'resume:postgresql:op-1',
      'close:postgresql:provider-switch',
      'resume:sqlite:op-1',
    ])
  })

  test('rejects mismatched generations and migration owners', async () => {
    const controller = createDaemonProviderSessionController({
      initial: session('sqlite', 'sqlite-1', []),
      factory: { create: async () => session('postgresql', 'pg-1', []) },
    })

    await expect(
      controller.pauseBackgroundWriters(migration('sqlite', 'wrong-generation')),
    ).rejects.toMatchObject({
      code: 'daemon-provider-session-mismatch',
    } satisfies Partial<DaemonProviderSessionError>)

    await controller.pauseBackgroundWriters(migration('sqlite', 'sqlite-1'))
    await expect(
      controller.switchProviderComposition({
        operationId: 'op-2',
        provider: 'postgresql',
        generationId: 'pg-1',
      }),
    ).rejects.toMatchObject({
      code: 'daemon-provider-session-operation-conflict',
    } satisfies Partial<DaemonProviderSessionError>)
  })

  test('retries only provider sessions whose daemon-shutdown close failed', async () => {
    const events: string[] = []
    const sqlite = session('sqlite', 'sqlite-1', events, { failCloseOnce: true })
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: { create: async () => session('postgresql', 'pg-1', events) },
    })

    await expect(controller.stop()).rejects.toThrow('failed to close daemon provider sessions')
    await controller.stop()

    expect(events).toEqual(['close:sqlite:daemon-shutdown', 'close:sqlite:daemon-shutdown'])
  })
})
