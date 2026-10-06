// RFC-371: real original Task claim and page writer reused by v2 ledger integration cases.
import { randomUUID } from 'node:crypto'
import { tasks, nodeRuns } from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createNativeUsageInvocationPersistence } from '@/modules/task-execution/composition/nativeUsageInvocation'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createObservationInvocationStore } from '@/modules/run-observability/infrastructure/invocationPersistence'
import { DrizzleNativeUsagePages } from '@/modules/task-execution/infrastructure/drizzleNativeUsagePages'
import { openOpencodeUsagePass } from '@/modules/runtime-management/infrastructure/opencodeUsagePass'
import type { NativeUsageOwnerBinding } from '@/modules/task-execution/application/ports/nativeUsagePersistence'
import type { NativeUsagePassOwner } from '@/modules/runtime-management/application/ports/nativeUsageOwner'
import type {
  ObservationNativePassIdentity,
  AcceptObservationInvocation,
} from '@agent-workflow/shared'
import type { ProviderHarness } from './eachProvider'
export async function originalNativeLedgerFixture(
  harness: Pick<ProviderHarness, 'db'>,
  mode: 'fresh' | 'resume' = 'fresh',
  numericPages = true,
  nativeStore: {
    readonly source?: string
    readonly generation?: string | null
    readonly sourceAbsentAt?: number
    readonly producer?: true
    readonly rootSets?: true
    readonly runtime?: Extract<
      AcceptObservationInvocation['authority'],
      { kind: 'local' }
    >['runtime']
  } = {},
) {
  const db = harness.db
  const taskId = 'native-owner-' + randomUUID()
  const nodeRunId = taskId + '-node'
  const invocationId = taskId + '-call'
  const slotPath = [
    { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
  ]
  await db.insert(tasks).values({
    id: taskId,
    name: 'Original native pages',
    workflowId: 'fixture',
    workflowSnapshot: '{}',
    repoPath: '/native-fixture',
    worktreePath: '/native-fixture',
    baseBranch: 'main',
    branch: 'native-fixture',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify(slotPath),
  })
  await db.insert(nodeRuns).values({ id: nodeRunId, taskId, nodeId: 'agent', status: 'running' })
  const persistence = createTaskExecutionPersistence(db, {
    ...(nativeStore.producer
      ? {
          nativeUsage: createNativeUsageInvocationPersistence(db, {
            rootSets: nativeStore.rootSets,
          }),
        }
      : {}),
  })
  const execution = createProviderTaskExecutionModule({
    daemonGeneration: 'native-generation',
    persistence,
  })
  const intentId = taskId + '-intent'
  await persistence.intents.submit({
    intentId,
    request: {
      taskId,
      kind: 'launch',
      source: 'rest',
      actorUserId: 'fixture',
      expectedTaskRevision: 1,
      scope: {
        executionLineageId: taskId,
        continuationSlotKey: taskId + ':root',
        slotPath,
        operationGeneration: 0,
      },
      payload: { v: 1 },
    },
  })
  const claimed = await execution.claimPersisted({ intentId })
  execution.claimGate.leave(claimed.permit)
  const binding: NativeUsageOwnerBinding = {
    taskId,
    nodeRunId,
    invocationId,
    executionContext: createTaskExecutionContext({ intentId, token: claimed.token, persistence }),
  }
  await createObservationInvocationStore(db).accept({
    invocationId,
    taskId,
    nodeRunId,
    agentId: null,
    agentRevision: null,
    purpose: 'task',
    authority: { kind: 'local', runtime: nativeStore.runtime ?? null },
    nativeCaptureContract: nativeStore.rootSets
      ? 'opencode-child-root-pages-v3'
      : 'opencode-child-pages-v2',
    nativeCaptureSource: nativeStore.source ?? 'actual-native-store',
  })
  const pages = new DrizzleNativeUsagePages(db, numericPages)
  const prepareInput = {
    binding,
    nativeSource: nativeStore.source ?? 'actual-native-store',
    sourceGeneration:
      nativeStore.generation === undefined ? 'original-sqlite-generation' : nativeStore.generation,
    ...(nativeStore.sourceAbsentAt === undefined
      ? {}
      : { sourceAbsentAt: nativeStore.sourceAbsentAt }),
    resumeRootSessionId: mode === 'resume' ? 'root' : null,
  }
  const before = await pages.prepare(prepareInput)
  const identity = (phase: 'baseline' | 'final' = 'baseline'): ObservationNativePassIdentity => {
    if (before.sourceGeneration === null)
      throw new Error('First-store fixture requires its actual admitted generation')
    return {
      passId: randomUUID(),
      invocationId,
      nativeSource: before.nativeSource,
      sourceGeneration: before.sourceGeneration,
      rootSessionId: 'root',
      lineage: before.lineage,
      epoch: before.epoch,
      phase,
    }
  }
  const owner = (supersedes?: string): NativeUsagePassOwner => ({
    admit: (identity, initialCursor, rootCreatedAt) =>
      pages.admit({
        binding,
        identity,
        initialCursor,
        rootCreatedAt,
        beforeSpawnReceiptId: before.ownerReceiptId,
        ...(supersedes ? { supersedes } : {}),
      }),
    persist: (page) =>
      pages.persist({
        binding,
        page: {
          ...page,
          sessions: [...page.sessions],
          steps: [...page.steps],
          issues: [...page.issues],
        },
      }),
    interrupt: (identity, reason) => pages.interrupt({ binding, identity, reason }),
  })
  const open = (path: string, pass: ObservationNativePassIdentity, rows = 200) => {
    const reader = openOpencodeUsagePass(path, pass, { pageRows: rows })
    return {
      identity: reader.identity,
      initialCursor: reader.initialCursor,
      rootCreatedAt: reader.rootCreatedAt,
      next: async (cursor: string) => reader.next(cursor),
      acknowledge: async (ordinal: string, digest: string) => reader.acknowledge(ordinal, digest),
      close: async () => reader.close(),
    }
  }
  return { db, binding, persistence, pages, before, prepareInput, identity, owner, open }
}
