// Locks the daemon-shutdown regression found on 2026-09-02: every SQLite
// daemon shutdown logged
//   WARN [daemon] SQLite daemon shutdown error
//     error="failed to close daemon provider sessions"
// and the detail behind that AggregateError was
//   TaskExecutionError: task execution admission is sealed for daemon shutdown.
//
// Shutdown seals task execution first (graceful drain), then closes the
// provider session; the session's freeze pauses the same claim gate, and
// `pause()` used to reject a sealed gate. The rejection failed the freeze,
// which made `close()` throw *before* `closeFrozenComposition`, so no close
// participant, no identity shutdown and no database close ever ran on the
// shutdown path.
//
// Two layers are locked here: the gate's own seal/pause algebra, and the
// consequence at the session boundary (the provider still closes).
import { describe, expect, test } from 'bun:test'

import {
  createDaemonProviderRuntimeSession,
  type DaemonProviderCloseParticipant,
  type DaemonProviderRuntimeAdmission,
  type DaemonProviderRuntimeHandleFactory,
} from '../src/cli/daemonProviderRuntimeSession'
import {
  describeDaemonProviderSessionFailure,
  type DaemonProviderSessionLifecycleInput,
} from '../src/cli/daemonProviderSession'
import { TaskClaimGate } from '../src/modules/task-execution/application/taskClaimGate'

const lifecycle: DaemonProviderSessionLifecycleInput = {
  operationId: 'shutdown-1',
  provider: 'sqlite',
  generationId: 'sqlite-1',
}

function admission(): DaemonProviderRuntimeAdmission {
  return {
    closeWriterAdmission() {},
    openWriterAdmission() {},
    closeWebSocketAdmission() {},
    openWebSocketAdmission() {},
  }
}

describe('RFC-349 shutdown seals task execution before the provider session closes', () => {
  test('pausing an already sealed claim gate is a no-op, not a conflict', () => {
    const gate = new TaskClaimGate('generation-1')
    gate.seal()

    expect(() => gate.pause()).not.toThrow()
    expect(gate.isSealed).toBe(true)
    expect(gate.isPaused).toBe(true)
  })

  test('a sealed gate still refuses new admissions and refuses to reopen', () => {
    const gate = new TaskClaimGate('generation-1')
    gate.seal()
    gate.pause()

    expect(() => gate.enter()).toThrow(/sealed for daemon shutdown/)
    expect(() => gate.resume()).toThrow(/sealed for daemon shutdown/)
  })

  test('pause before seal still freezes admission and stays reversible', () => {
    const gate = new TaskClaimGate('generation-1')
    gate.pause()

    expect(gate.isPaused).toBe(true)
    expect(gate.isSealed).toBe(false)
    expect(() => gate.enter()).toThrow(/paused for provider-session freeze/)

    gate.resume()
    expect(gate.isPaused).toBe(false)
    expect(() => gate.enter()).not.toThrow()
  })

  test('closing the session after shutdown sealed the gate still closes the provider', async () => {
    const gate = new TaskClaimGate('generation-1')
    const events: string[] = []

    // Mirrors the daemon wiring: the task-execution background handle's stop
    // pauses the very gate that graceful shutdown has already sealed.
    const taskExecutionHandle: DaemonProviderRuntimeHandleFactory = {
      id: 'task-execution',
      start() {
        return {
          stop() {
            gate.pause()
            events.push('handle:stop')
          },
          drain() {
            events.push('handle:drain')
          },
        }
      },
    }
    const closeParticipant: DaemonProviderCloseParticipant = {
      id: 'task-execution-final-close',
      close() {
        events.push('participant:close')
      },
    }

    const session = await createDaemonProviderRuntimeSession({
      provider: 'sqlite',
      generationId: 'sqlite-1',
      runtime: {
        fetch: () => new Response('ok'),
        tryUpgrade: () => false,
        websocketHandlers: Object.freeze({ open: () => undefined }),
      },
      admission: admission(),
      backgroundWriterFactories: [taskExecutionHandle],
      providerCloseParticipants: [closeParticipant],
      shutdownIdentity: () => {
        events.push('identity:shutdown')
      },
      closeProvider: () => {
        events.push('provider:close')
      },
    })
    await session.resume(lifecycle)

    // Graceful shutdown drains and seals task execution first.
    gate.seal()

    await session.close({ reason: 'daemon-shutdown' })

    expect(events).toEqual([
      'handle:stop',
      'handle:drain',
      'participant:close',
      'identity:shutdown',
      'provider:close',
    ])
    expect(session.state().phase).toBe('closed')
  })
})

// The regression above stayed invisible for a day because the shutdown log
// printed only the outermost AggregateError message. Diagnosing it required
// the causes, so the log line now flattens the whole chain.
describe('RFC-349 provider session failure description', () => {
  test('flattens nested aggregates down to every leaf cause', () => {
    const leaf = new Error('task execution admission is sealed for daemon shutdown')
    leaf.name = 'TaskExecutionError'
    const description = describeDaemonProviderSessionFailure(
      new AggregateError(
        [new AggregateError([leaf], 'failed to freeze daemon provider runtime session for close')],
        'failed to close daemon provider sessions',
      ),
    )

    expect(description).toBe(
      'failed to close daemon provider sessions: ' +
        '[failed to freeze daemon provider runtime session for close: ' +
        '[TaskExecutionError: task execution admission is sealed for daemon shutdown]]',
    )
  })

  test('keeps a plain error and its cause chain', () => {
    const description = describeDaemonProviderSessionFailure(
      new Error('outer', { cause: new Error('inner') }),
    )

    expect(description).toBe('Error: outer <- Error: inner')
  })

  test('survives a self-referential aggregate instead of recursing forever', () => {
    const cyclic = new AggregateError([], 'cyclic')
    ;(cyclic as { errors: unknown[] }).errors = [cyclic]

    expect(describeDaemonProviderSessionFailure(cyclic)).toBe('cyclic: [<circular>]')
  })

  test('describes a non-error rejection reason', () => {
    expect(describeDaemonProviderSessionFailure('boom')).toBe('boom')
  })
})
