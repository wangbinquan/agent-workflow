// Hosted real-process oracle: kill a production Task launch before its row is committed.
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  WorkflowDefinitionSchema,
  StartTaskSchema,
  type DatabaseConfig,
} from '@agent-workflow/shared'
import { openDb } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, workflows } from '@/db/schema'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { actorOfDirectAuthority, admitDaemonIdentity } from '@/auth/session'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import {
  createRootTaskLaunchKernel,
  createTaskRouteWorkspaceParticipant,
} from '@/modules/task-execution/composition/taskRouteLaunch'
import { createWorkspacePreparationJournal } from '@/modules/task-execution/infrastructure/workspacePreparationJournal'
import { compensatePreMaterializedRepository } from '@/modules/task-execution/infrastructure/preMaterializedRepositoryWorkspace'
import { compensateScratchWorkspace } from '@/modules/task-execution/infrastructure/scratchWorkspacePreparation'
import { createTaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import { composeTaskExecutionResourceBinding } from '@/modules/resource-catalog/composition/taskExecution'
import { taskExecutionResourceDependencies } from '@/services/execution/taskExecutionResourceDependencies'

interface Input {
  root: string
  taskId: string
  workflowId: string
  remote: string
  scratch: boolean
  provider:
    | { kind: 'sqlite' }
    | {
        kind: 'postgresql'
        config: Extract<DatabaseConfig, { provider: 'postgresql' }>
        generationId: string
      }
}
const file = process.argv[2]
if (file === undefined) throw new Error('missing worker input')
const input = JSON.parse(readFileSync(file, 'utf8')) as Input
let db: ProviderNeutralDatabase
let close: () => Promise<void>
if (input.provider.kind === 'sqlite') {
  const opened = openDb({
    path: join(input.root, 'db.sqlite'),
    migrationsFolder: resolve(import.meta.dir, '..', '..', 'db', 'migrations'),
  })
  db = opened
  close = async () => {
    opened.$client.close()
  }
} else {
  const runtime = createPostgresqlDatabaseRuntime({
    config: input.provider.config,
    generationId: input.provider.generationId,
  })
  db = createPostgresqlDatabaseClient(runtime)
  close = () => runtime.close()
}
function checkpoint(stage: string, worktreePath: string, baseCommit: string | null) {
  if (process.env.RFC363_TASK_CRASH_POINT !== stage) return
  writeFileSync(join(worktreePath, 'preserve.txt'), 'physical preparation survived')
  writeFileSync(join(input.root, 'ready.tmp'), JSON.stringify({ stage, worktreePath, baseCommit }))
  renameSync(join(input.root, 'ready.tmp'), join(input.root, 'ready.json'))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  throw new Error('crash latch unexpectedly released')
}
try {
  const identityAccess = createIdentityAccessRuntime({ db })
  const identity = await admitDaemonIdentity(identityAccess)
  if (identity === null) throw new Error('daemon identity missing')
  const actor = actorOfDirectAuthority(identity)
  const appHome = join(input.root, 'home')
  const binding = composeRepositoryPreparation({ db, appHome })
  const participant = createTaskRouteWorkspaceParticipant({
    db,
    appHome,
    sourceContexts: identityAccess.taskPreparationContext,
    repositoryPreparation: {
      ...binding,
      async prepareScratch(request) {
        const space = await binding.prepareScratch(request)
        checkpoint('scratch-root-before-artifact', space.worktreePath, space.baseCommit)
        return space
      },
    },
  })
  const definition = WorkflowDefinitionSchema.parse({
    $schema_version: 1,
    inputs: [],
    nodes: [],
    edges: [],
  })
  await db
    .insert(workflows)
    .values({
      id: input.workflowId,
      name: input.workflowId,
      definition: JSON.stringify(definition),
    })
    .onConflictDoNothing()
  const kernel = createRootTaskLaunchKernel({
    db,
    id: () => input.taskId,
    gitCommitIdentity: identityAccess.getUserGitCommitIdentity,
    workspace: {
      async prepare(request) {
        const space = await participant.prepare(request)
        checkpoint('prepared-before-upload', space.worktreePath, space.baseCommit)
        return {
          ...space,
          async admit(tx) {
            checkpoint('uploaded-before-admit', space.worktreePath, space.baseCommit)
            await space.admit!(tx)
          },
        }
      },
    },
    coordinator: {
      async submit(request) {
        return { kind: 'accepted', taskId: request.taskId }
      },
    },
  })
  const task = await kernel.launch({
    actor,
    resourceAuthority: {
      actor,
      authority: identity.authority,
      resources: createTaskExecutionResourceBinding(
        db,
        composeTaskExecutionResourceBinding(taskExecutionResourceDependencies),
      ),
    },
    invoker: { type: 'user', launchKind: 'direct-json' },
    task: StartTaskSchema.parse({
      workflowId: input.workflowId,
      name: 'crash recovery',
      inputs: {},
      ...(input.scratch ? { scratch: true } : { repoUrl: input.remote }),
    }),
    subject: {
      workflowId: input.workflowId,
      workflowName: input.workflowId,
      workflowVersion: 1,
      workflowSnapshot: definition,
      builtin: false,
    },
    uploads: {
      parts: [
        {
          inputKey: 'refs',
          filename: 'attachment.txt',
          declaredMime: 'text/plain',
          blob: new Blob(['durable upload']),
        },
      ],
      definitions: new Map([['refs', { key: 'refs', targetDir: 'inputs' }]]),
      limits: { perFile: 1024, perRequest: 1024, perCount: 1 },
    },
  })
  let cleanupRejected = false
  try {
    await (input.scratch ? compensateScratchWorkspace : compensatePreMaterializedRepository)({
      db,
      binding,
      taskId: task.id,
    })
  } catch {
    cleanupRejected = true
  }
  writeFileSync(
    join(input.root, 'result.json'),
    JSON.stringify({
      task,
      rows: await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, input.taskId)),
      plan: await createWorkspacePreparationJournal(db).forTask(input.taskId),
      cleanupRejected,
    }),
  )
} finally {
  await close()
}
