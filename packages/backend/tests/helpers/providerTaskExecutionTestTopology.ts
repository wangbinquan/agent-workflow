import type { ProviderNeutralDatabase } from '../../src/db/query'
import type { RunTaskOptions } from '../../src/services/execution/taskEngineRuntimeOptions'
import { join } from 'node:path'
import { ulid } from 'ulid'
import {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
} from '../../src/modules/task-execution/application/drive/taskDriveCoordinator'
import { resolveTaskDriveConfig } from '../../src/modules/task-execution/application/drive/taskDriveTypes'
import { createPostgresqlTaskDriverLifecyclePort } from '../../src/modules/task-execution/infrastructure/postgresqlTaskDriverLifecycle'
import { createLogger } from '../../src/util/log'
import type { ProviderDatabaseHarness } from './eachProvider'
import { createProviderHttpApplication } from './providerHttpApplication'
import { runTaskWithRealTestTopology } from './taskExecutionTestTopology'

/** Runtime participants are supplied by the selected fixture composition. */
export type ProviderTaskExecutionTestRunOptions = Omit<
  RunTaskOptions,
  | 'memoryInjectionQueries'
  | 'persistence'
  | 'runtimeSessionLeases'
  | 'runtimeRegistry'
  | 'taskDagCollaboration'
  | 'collaborationRuntime'
  | 'workgroupTurns'
  | 'childLaunch'
  | 'dynamicWorkflow'
  | 'processConcurrencyScope'
  | 'identityAccess'
  | 'codeHostConnections'
  | 'repositoryPublicationTransport'
  | 'executionContext'
  | 'signal'
> & { readonly db: ProviderNeutralDatabase }

export interface ProviderTaskExecutionTestTopology {
  runTask(options: ProviderTaskExecutionTestRunOptions): Promise<void>
  dispose(): Promise<void>
}

/**
 * Native fixtures retain their direct runtime. PostgreSQL borrows the complete
 * unstarted application runtime, including its actual child/lifecycle ports.
 * PG drives submit a real intent and await claim/attach/drive/release. A later
 * drive of the same task uses a fresh resume intent and the next owner epoch.
 * Callers await disposal before removing their directory or releasing the DB.
 */
export async function createProviderTaskExecutionTestTopology(
  harness: ProviderDatabaseHarness,
  appHome: string,
): Promise<ProviderTaskExecutionTestTopology> {
  const binding = harness.applicationBinding
  if (binding.provider === 'sqlite') {
    return Object.freeze({
      runTask(options: ProviderTaskExecutionTestRunOptions) {
        if (options.db !== binding.db) throw new Error('task fixture database mismatch')
        return runTaskWithRealTestTopology({ ...options, db: binding.db })
      },
      async dispose() {},
    })
  }

  const application = await createProviderHttpApplication(harness, {
    appHome,
    configPath: join(appHome, 'config.json'),
    token: 'task-execution-test-token',
    dbVersion: 0,
    opencodeVersion: null,
  })
  try {
    const selected = application.taskExecution
    if (selected.provider !== 'postgresql') throw new Error('task fixture provider mismatch')
    return Object.freeze({
      async runTask(options: ProviderTaskExecutionTestRunOptions) {
        const { db, taskId, ...runConfig } = options
        if (db !== binding.db) throw new Error('task fixture database mismatch')
        const provider = selected.selected
        const log = options.log ?? createLogger('provider-task-execution-test')
        const previousOwner = await provider.persistence.ownership.read(taskId)
        const intent = await provider.persistence.intents.submitContinuation({
          taskId,
          intentId: ulid(),
          kind: previousOwner === null ? 'launch' : 'resume',
          source: 'internal',
          actorUserId: null,
          payload: { v: 1 },
          now: Date.now(),
          advanceOperationGeneration: false,
        })
        const coordinator = new DefaultTaskDriveCoordinator({
          runtime: resolveTaskDriveConfig(runConfig),
          lifecycle: createPostgresqlTaskDriverLifecyclePort({
            db: binding.db,
            module: provider.executionModule,
            persistence: provider.persistence,
            log,
            finalizeWorkspace: (id) => selected.workspace.finalizeClaimedWorkspace(id),
          }),
          repositoryPreparation: skipRepositoryPreparation,
          engineOrchestrator: {
            async drive(context) {
              await provider.runtime.schedulerDriver.drive({
                ...runConfig,
                taskId,
                signal: context.signal,
                executionContext: context.execution,
              })
            },
          },
          failureReporter: {
            async report({ error, execution }) {
              const now = Date.now()
              await provider.persistence.runtimeLifecycle.trySet({
                taskId,
                to: 'failed',
                allowedFrom: ['pending', 'running'],
                extra: {
                  finishedAt: now,
                  errorSummary: 'task drive failed',
                  errorMessage: error instanceof Error ? error.message : String(error),
                },
                executionContext: execution,
                now,
                reason: 'task-drive',
              })
              await provider.persistence.intentTerminalization.terminalize({
                taskId,
                state: 'failed',
                failureCode: 'task-drive-failed',
                now,
                claimedOwnerEpoch: execution.token.epoch,
              })
            },
          },
        })
        const receipt = await coordinator.submit({
          taskId,
          intentId: intent.intentId,
          completionMode: 'await-settle',
        })
        if (receipt.kind !== 'settled') throw new Error('task fixture ownership not attached')
      },
      dispose: application.dispose,
    })
  } catch (error) {
    try {
      await application.dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'task fixture composition and cleanup failed')
    }
    throw error
  }
}
