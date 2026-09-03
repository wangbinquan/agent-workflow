// RFC-349 — daemon-local request/writer admission used by the one-click
// migration composition root. It does not know either database client. The
// bootstrap supplies provider-composition and background-writer callbacks,
// while this state machine owns the no-new-work + bounded-drain invariant.

import { databaseProviderTraits } from '@/platform/persistence/providerTraits'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { DatabaseMigrationAdmissionPort } from '../application/databaseMigrationRunner'

export type DatabaseAdmissionProvider = DatabaseProvider
export type DatabaseAdmissionPhase =
  | 'open'
  | 'draining'
  | 'frozen'
  | 'switching'
  | 'recovering'
  | 'stopped'

export interface DatabaseMigrationDaemonAdmissionLiveState {
  readonly phase: DatabaseAdmissionPhase
  readonly provider: DatabaseAdmissionProvider
  readonly generationId: string
  readonly operationId: string | null
  readonly activeBusinessRequests: number
}

export interface DatabaseMigrationDaemonAdmissionOptions {
  readonly initialProvider: DatabaseAdmissionProvider
  readonly initialGenerationId: string
  /** Fence and drain scheduler/worker/outbox/apply/WS writers. */
  readonly pauseBackgroundWriters: (input: {
    readonly operationId: string
    readonly provider: DatabaseAdmissionProvider
    readonly generationId: string
  }) => Promise<void>
  /** Rebuild provider-owned adapters before admission is opened. */
  readonly switchProviderComposition: (input: {
    readonly operationId: string
    readonly provider: DatabaseAdmissionProvider
    readonly generationId: string
  }) => Promise<void>
  /** Restart only after the selected provider composition is ready. */
  readonly resumeBackgroundWriters: (input: {
    readonly operationId: string
    readonly provider: DatabaseAdmissionProvider
    readonly generationId: string
  }) => Promise<void>
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export interface DatabaseMigrationDaemonAdmission {
  readonly migration: DatabaseMigrationAdmissionPort
  runBusinessRequest(request: Request, next: () => Promise<Response>): Promise<Response>
  live(): DatabaseMigrationDaemonAdmissionLiveState
  stop(): void
}

export class DatabaseMigrationDaemonAdmissionError extends Error {
  constructor(
    public readonly code:
      | 'database-admission-operation-conflict'
      | 'database-admission-state'
      | 'database-admission-drain-timeout'
      | 'database-admission-stopped',
    message: string,
  ) {
    super(message)
    this.name = 'DatabaseMigrationDaemonAdmissionError'
  }
}

function isMigrationControlRequest(request: Request): boolean {
  const path = new URL(request.url).pathname
  return (
    path === '/api/database' ||
    path.startsWith('/api/database/') ||
    path === '/api/health' ||
    // The endpoint an operator (and the RFC-349 evidence run) watches a
    // migration through. It reads an in-memory maintenance projection plus
    // in-memory pool telemetry — no database work of its own — so refusing it
    // only blinds the caller during the exact window it exists to describe.
    path === '/api/maintenance/status' ||
    (!path.startsWith('/api/') && !path.startsWith('/ws/'))
  )
}

function maintenanceResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      code: 'database-maintenance',
      message: 'database migration maintenance is in progress',
    }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  )
}

export function createDatabaseMigrationDaemonAdmission(
  options: DatabaseMigrationDaemonAdmissionOptions,
): DatabaseMigrationDaemonAdmission {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let phase: DatabaseAdmissionPhase = 'open'
  let stopped = false
  let provider = options.initialProvider
  let generationId = options.initialGenerationId
  let operationId: string | null = null
  let activeBusinessRequests = 0
  let freezePromise: Promise<void> | null = null
  let drainResolve: (() => void) | null = null
  let drainAbort: ((error: Error) => void) | null = null

  const live = (): DatabaseMigrationDaemonAdmissionLiveState =>
    Object.freeze({ phase, provider, generationId, operationId, activeBusinessRequests })

  const assertLive = (): void => {
    if (stopped) {
      throw new DatabaseMigrationDaemonAdmissionError(
        'database-admission-stopped',
        'database migration admission is stopped',
      )
    }
  }

  const assertOperation = (candidate: string): void => {
    if (operationId !== candidate) {
      throw new DatabaseMigrationDaemonAdmissionError(
        'database-admission-operation-conflict',
        `database admission belongs to ${operationId ?? 'no operation'}`,
      )
    }
  }

  const waitForBusinessDrain = async (timeoutMs: number): Promise<void> => {
    if (activeBusinessRequests === 0) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimer(() => {
        if (drainResolve === finish) drainResolve = null
        drainAbort = null
        reject(
          new DatabaseMigrationDaemonAdmissionError(
            'database-admission-drain-timeout',
            `database business request drain exceeded ${timeoutMs}ms`,
          ),
        )
      }, timeoutMs)
      const finish = (): void => {
        clearTimer(timer)
        if (drainResolve === finish) drainResolve = null
        drainAbort = null
        resolve()
      }
      drainAbort = (error) => {
        clearTimer(timer)
        if (drainResolve === finish) drainResolve = null
        drainAbort = null
        reject(error)
      }
      drainResolve = finish
    })
  }

  const restoreOpenAfterFailedFreeze = async (candidateOperationId: string): Promise<void> => {
    phase = 'recovering'
    try {
      await options.resumeBackgroundWriters({
        operationId: candidateOperationId,
        provider,
        generationId,
      })
    } finally {
      phase = 'open'
      operationId = null
    }
  }

  const freezeAndDrain: DatabaseMigrationAdmissionPort['freezeAndDrain'] = async (input) => {
    assertLive()
    if (phase === 'frozen') {
      assertOperation(input.operationId)
      return
    }
    if (phase === 'draining') {
      assertOperation(input.operationId)
      if (freezePromise === null) {
        throw new DatabaseMigrationDaemonAdmissionError(
          'database-admission-state',
          'database admission is draining without an owner promise',
        )
      }
      return await freezePromise
    }
    if (phase !== 'open') {
      throw new DatabaseMigrationDaemonAdmissionError(
        'database-admission-state',
        `database admission cannot freeze from ${phase}`,
      )
    }

    phase = 'draining'
    operationId = input.operationId
    const perform = (async (): Promise<void> => {
      try {
        await options.pauseBackgroundWriters({
          operationId: input.operationId,
          provider,
          generationId,
        })
        await waitForBusinessDrain(input.timeoutMs)
        assertOperation(input.operationId)
        phase = 'frozen'
      } catch (error) {
        if (stopped) throw error
        await restoreOpenAfterFailedFreeze(input.operationId)
        throw error
      }
    })()
    freezePromise = perform
    try {
      await perform
    } finally {
      if (freezePromise === perform) freezePromise = null
    }
  }

  const migration: DatabaseMigrationAdmissionPort = {
    freezeAndDrain,
    async reopenSqlite(input) {
      assertLive()
      // Already open on the migration source ⇒ nothing to reopen.
      if (phase === 'open' && databaseProviderTraits(provider).migrationRole === 'source') return
      assertOperation(input.operationId)
      if (phase !== 'frozen' && phase !== 'switching' && phase !== 'recovering') {
        throw new DatabaseMigrationDaemonAdmissionError(
          'database-admission-state',
          `database admission cannot reopen SQLite from ${phase}`,
        )
      }
      phase = 'switching'
      if (provider !== 'sqlite' || generationId !== input.sourceGenerationId) {
        await options.switchProviderComposition({
          operationId: input.operationId,
          provider: 'sqlite',
          generationId: input.sourceGenerationId,
        })
        provider = 'sqlite'
        generationId = input.sourceGenerationId
      }
      await options.resumeBackgroundWriters({
        operationId: input.operationId,
        provider,
        generationId,
      })
      phase = 'open'
      operationId = null
    },
    async activatePostgresql(input) {
      assertLive()
      assertOperation(input.operationId)
      if (phase !== 'frozen') {
        throw new DatabaseMigrationDaemonAdmissionError(
          'database-admission-state',
          `database admission cannot activate PostgreSQL from ${phase}`,
        )
      }
      phase = 'switching'
      // Composition replacement can complete before its callback reports an
      // error. Record the intended provider first so recovery always performs
      // an explicit SQLite rebuild instead of trusting stale local state.
      provider = 'postgresql'
      generationId = input.generationId
      await options.switchProviderComposition({
        operationId: input.operationId,
        provider: 'postgresql',
        generationId: input.generationId,
      })
    },
    async openPostgresqlAdmission(input) {
      assertLive()
      assertOperation(input.operationId)
      if (provider !== 'postgresql' || generationId !== input.generationId) {
        throw new DatabaseMigrationDaemonAdmissionError(
          'database-admission-state',
          'database admission PostgreSQL generation does not match the activated composition',
        )
      }
      if (phase !== 'switching' && phase !== 'frozen') {
        throw new DatabaseMigrationDaemonAdmissionError(
          'database-admission-state',
          `database admission cannot open PostgreSQL from ${phase}`,
        )
      }
      await options.resumeBackgroundWriters({
        operationId: input.operationId,
        provider,
        generationId,
      })
      phase = 'open'
      operationId = null
    },
  }

  return Object.freeze({
    migration,
    async runBusinessRequest(request: Request, next: () => Promise<Response>) {
      if (isMigrationControlRequest(request)) return await next()
      if (phase !== 'open') return maintenanceResponse()
      activeBusinessRequests += 1
      try {
        return await next()
      } finally {
        activeBusinessRequests -= 1
        if (activeBusinessRequests === 0) drainResolve?.()
      }
    },
    live,
    stop() {
      stopped = true
      phase = 'stopped'
      operationId = null
      drainAbort?.(
        new DatabaseMigrationDaemonAdmissionError(
          'database-admission-stopped',
          'database migration admission stopped during drain',
        ),
      )
      drainResolve = null
      drainAbort = null
    },
  })
}
