import { taskExecutionParticipants } from './helpers/taskExecutionParticipantBindings'
import { composeCollaborationTaskRolePolicy } from '@/modules/resource-catalog/composition'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { schemaFixtureDb } from './helpers/schemaFixture'
// RFC-395 wave 2 follow-ups: exercise the actual factories with controlled
// downstream collaborators, without installing process-wide module mocks.
// FX-1 also covers the profile content store when reviewArtifacts is omitted.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { DbClient } from '@/db/client'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { ContentStore } from '@/platform/content/contentStore'
import type { CollaborationCommandContextInput } from '@/modules/collaboration/infrastructure/collaborationCommandContext'
import type { HumanGateTaskLockPort } from '@/modules/collaboration/composition/required-ports'
import type { ClarifyDecisionCommandPort } from '@/modules/collaboration/application/ports/clarifyDecisionCommand'
import type { ReviewArtifactSelection } from '@/modules/collaboration/application/ports/reviewArtifactSelection'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import type * as ClarifyCommands from '@/modules/collaboration/infrastructure/clarifyDecisionCommand'
import type * as QuestionCommands from '@/modules/collaboration/infrastructure/questionDispatchCommand'
import type * as ReviewCommands from '@/modules/collaboration/infrastructure/reviewDecisionCommand'
import type * as HostedRecovery from '@/modules/collaboration/composition/crewstationHumanGateRecovery'

function factory<T>(path: string, dependencies: Record<string, unknown>): T {
  const source = readFileSync(resolve(import.meta.dir, '../src', path), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  new Function('require', 'exports', code)((id: string) => {
    if (!Object.hasOwn(dependencies, id)) throw new Error(`unexpected factory dependency: ${id}`)
    return dependencies[id]
  }, exports)
  return exports as T
}

const db = {} as DbClient
const taskLock: HumanGateTaskLockPort = () => ({ lockTask: async () => {} })
const actor = { user: { id: 'actor' } } as Parameters<
  ClarifyDecisionCommandPort['submit']
>[0]['actor']
const memoryDistillEnqueuer = {} as MemoryDistillEnqueuer
const denied = new Error('history-only-test-provider')
const restrictions: HistoryRestrictionPort = {
  check: async () => {
    throw denied
  },
}

test('clarify factory and context bridge forward the same restriction provider into submission', async () => {
  const contexts: CollaborationCommandContextInput[] = []
  const seen: unknown[] = []
  const commands = factory<typeof ClarifyCommands>(
    'modules/collaboration/infrastructure/clarifyDecisionCommand.ts',
    {
      './collaborationCommandContext': {
        createCollaborationCommandContext: (input: CollaborationCommandContextInput) => {
          contexts.push(input)
          return {}
        },
      },
      './clarify/autoDispatch': {
        async autoDispatchClarifyRoundWithDecision(input: {
          historyRestrictions?: HistoryRestrictionPort
        }) {
          seen.push(input.historyRestrictions)
          if (!input.historyRestrictions)
            throw new Error('gate-history-restriction-provider-required')
          return input.historyRestrictions.check(db, {
            taskId: 'task',
            nodeRunIds: [],
            action: 'resume',
            gates: [],
          })
        },
      },
    },
  )
  const input = {
    actor,
    actorRole: 'owner' as const,
    nodeRunId: 'run',
    answers: [],
    directive: 'continue' as const,
  }
  await expect(
    commands
      .createClarifyDecisionCommand(db, memoryDistillEnqueuer, taskLock, {
        taskExecutionParticipants,
        historyRestrictions: restrictions,
      })
      .submit(input),
  ).rejects.toBe(denied)
  commands.createClarifyDecisionCommandContext({
    taskExecutionParticipants,
    taskRolePolicy: composeCollaborationTaskRolePolicy(),
    db,
    actor,
    role: 'owner',
    taskLock,
    memoryDistillEnqueuer,
    historyRestrictions: restrictions,
  })
  expect(contexts[0]!.historyRestrictions).toBe(restrictions)
  await expect(contexts[0]!.clarifyDecisions!.submit(input)).rejects.toBe(denied)
  await expect(
    commands
      // @ts-expect-error Verify runtime refusal for an untyped caller without a provider.
      .createClarifyDecisionCommand(db, memoryDistillEnqueuer, taskLock, {
        taskExecutionParticipants,
      })
      .submit(input),
  ).rejects.toThrow('gate-history-restriction-provider-required')
  expect(seen).toEqual([restrictions, restrictions, undefined])
})

test('question dispatch factory and context bridge forward restriction options without a default provider', async () => {
  const contexts: CollaborationCommandContextInput[] = []
  const seen: unknown[] = []
  const commands = factory<typeof QuestionCommands>(
    'modules/collaboration/infrastructure/questionDispatchCommand.ts',
    {
      './collaborationCommandContext': {
        createCollaborationCommandContext: (input: CollaborationCommandContextInput) => {
          contexts.push(input)
          return {}
        },
      },
      './taskQuestionDispatch': {
        async dispatchTaskQuestionsWithDecision(...args: unknown[]) {
          const options = args[7] as { historyRestrictions?: HistoryRestrictionPort }
          seen.push(options.historyRestrictions)
          expect(args[6]).toBe(taskLock)
          expect(args[1]).toBe(taskExecutionParticipants)
          if (!options.historyRestrictions)
            throw new Error('gate-history-restriction-provider-required')
          return options.historyRestrictions.check(db, {
            taskId: 'task',
            nodeRunIds: [],
            action: 'resume',
            gates: [],
          })
        },
      },
    },
  )
  const input = { actor, actorRole: 'owner' as const, taskId: 'task', entryIds: ['entry'] }
  await expect(
    commands
      .createQuestionDispatchCommand(db, taskLock, {
        taskExecutionParticipants,
        historyRestrictions: restrictions,
      })
      .dispatch(input),
  ).rejects.toBe(denied)
  commands.createQuestionDispatchCommandContext({
    taskExecutionParticipants,
    taskRolePolicy: composeCollaborationTaskRolePolicy(),
    db,
    actor,
    role: 'owner',
    taskLock,
    historyRestrictions: restrictions,
  })
  expect(contexts[0]!.historyRestrictions).toBe(restrictions)
  await expect(contexts[0]!.questionDispatches!.dispatch(input)).rejects.toBe(denied)
  await expect(
    commands
      // @ts-expect-error Verify runtime refusal for an untyped caller without a provider.
      .createQuestionDispatchCommand(db, taskLock, { taskExecutionParticipants })
      .dispatch(input),
  ).rejects.toThrow('gate-history-restriction-provider-required')
  expect(seen).toEqual([restrictions, restrictions, undefined])
})

test('review factory and context bridge share the selected content reader and restriction provider', async () => {
  const contexts: CollaborationCommandContextInput[] = []
  const bytes = Buffer.from('\ufeff评审正文\n')
  const content: ContentStore = {
    ...epoch2RuntimeTestPorts(schemaFixtureDb()).content,
    read: async () => bytes,
  }
  const reviewArtifacts: ReviewArtifactSelection = {
    content: { read: async () => null },
    store: {
      planReviewArtifact() {
        throw new Error('unused artifact planner')
      },
      stageReviewArtifact() {
        throw new Error('unused artifact stage')
      },
      finalizeReviewArtifact() {
        throw new Error('unused artifact finalize')
      },
      cleanupReviewArtifact() {
        throw new Error('unused artifact cleanup')
      },
    },
  }
  const readers: unknown[][] = []
  const seen: unknown[] = []
  const fileHomes: string[] = []
  const fileContent: ReviewArtifactSelection['content'] = { read: async () => null }
  const commands = factory<typeof ReviewCommands>(
    'modules/collaboration/infrastructure/reviewDecisionCommand.ts',
    {
      './collaborationCommandContext': {
        createCollaborationCommandContext: (input: CollaborationCommandContextInput) => {
          contexts.push(input)
          return {}
        },
      },
      './committedReviewArtifactReader': {
        DatabaseCommittedReviewArtifactReader: class {
          constructor(
            readerDb: PersistenceDb,
            legacy: ReviewArtifactSelection['content'],
            private readonly store: Pick<ContentStore, 'read'>,
          ) {
            readers.push([readerDb, legacy, store])
          }
          async read() {
            return Buffer.from(
              await this.store.read({} as Parameters<ContentStore['read']>[0]),
            ).toString('utf8')
          }
        },
      },
      './local/fileReviewArtifactContent': {
        createFileReviewArtifactContent(appHome: string) {
          fileHomes.push(appHome)
          return fileContent
        },
      },
      './review': {
        async submitReviewDecision(input: {
          historyRestrictions?: HistoryRestrictionPort
          reviewReader?: { read(reference: string): Promise<string> }
        }) {
          seen.push(input.historyRestrictions)
          expect(await input.reviewReader!.read('doc-content:doc')).toBe(bytes.toString('utf8'))
          if (!input.historyRestrictions)
            throw new Error('gate-history-restriction-provider-required')
          return input.historyRestrictions.check(db, {
            taskId: 'task',
            nodeRunIds: [],
            action: 'resume',
            gates: [],
          })
        },
      },
    },
  )
  const options = {
    taskExecutionParticipants,
    taskRolePolicy: composeCollaborationTaskRolePolicy(),
    db,
    appHome: '/unused-profile-home',
    taskLock,
    upstreamAgents: { outputProfile: async () => null },
    reviewArtifacts,
    content,
    historyRestrictions: restrictions,
  }
  const input = {
    actor,
    authorRole: 'owner' as const,
    nodeRunId: 'run',
    decision: 'approved' as const,
    expectedReviewIteration: 0,
  }
  await expect(commands.createReviewDecisionCommand(options).submit(input)).rejects.toBe(denied)
  commands.createReviewDecisionCommandContext({
    ...options,
    actor,
    authorRole: 'owner',
  })
  expect(contexts[0]!.content).toBe(content)
  expect(contexts[0]!.reviewArtifacts).toBe(reviewArtifacts)
  expect(contexts[0]!.historyRestrictions).toBe(restrictions)
  await expect(contexts[0]!.reviewDecisions!.submit(input)).rejects.toBe(denied)
  await expect(
    commands
      .createReviewDecisionCommand({
        ...options,
        // @ts-expect-error Verify runtime refusal for an untyped caller without a provider.
        historyRestrictions: undefined,
      })
      .submit(input),
  ).rejects.toThrow('gate-history-restriction-provider-required')
  expect(seen).toEqual([restrictions, restrictions, undefined])
  expect(readers).toHaveLength(3)
  for (const [readerDb, legacy, profile] of readers) {
    expect(readerDb).toBe(db)
    expect(legacy).toBe(reviewArtifacts.content)
    expect(profile).toBe(content)
  }
  expect(fileHomes).toEqual([])

  const contentOnlyOptions = { ...options, reviewArtifacts: undefined }
  await expect(commands.createReviewDecisionCommand(contentOnlyOptions).submit(input)).rejects.toBe(
    denied,
  )
  commands.createReviewDecisionCommandContext({
    ...contentOnlyOptions,
    actor,
    authorRole: 'owner',
  })
  expect(contexts[1]!.content).toBe(content)
  expect(contexts[1]!.reviewArtifacts).toBeUndefined()
  expect(contexts[1]!.historyRestrictions).toBe(restrictions)
  await expect(contexts[1]!.reviewDecisions!.submit(input)).rejects.toBe(denied)
  expect(seen).toEqual([restrictions, restrictions, undefined, restrictions, restrictions])
  expect(readers).toHaveLength(5)
  for (const [readerDb, legacy, profile] of readers.slice(3)) {
    expect(readerDb).toBe(db)
    expect(legacy).toBe(fileContent)
    expect(profile).toBe(content)
  }
  expect(fileHomes).toEqual([options.appHome, options.appHome])
})

test('hosted recovery forwards restrictions and preserves the transaction fence', async () => {
  const events: string[] = []
  const tx = {} as PersistenceTx
  const lease = { epoch: 7, leaseId: 'lease', instanceId: 'instance' }
  let persistenceArgs: unknown[] = []
  const recovery = factory<typeof HostedRecovery>(
    'modules/collaboration/composition/crewstationHumanGateRecovery.ts',
    {
      '@/platform/persistence/databaseTransaction': {
        databaseSessionFor: () => ({
          transaction: async (body: (tx: PersistenceTx) => Promise<unknown>) => {
            events.push('transaction')
            return body(tx)
          },
        }),
      },
      '../infrastructure/humanGateOperationPersistence': {
        DatabaseHumanGateOperationPersistence: class {
          constructor(...args: unknown[]) {
            persistenceArgs = args
          }
        },
      },
      '../application/recoverHumanGateOperations': { HumanGateOperationRecovery: class {} },
    },
  )
  const input = {
    db,
    taskLock,
    historyRestrictions: restrictions,
    artifacts: {} as Parameters<
      typeof recovery.composeCrewStationHumanGateRecovery
    >[0]['artifacts'],
    fence: {
      current: () => {
        events.push('current')
        return lease
      },
      assertHeld: async (actualTx: PersistenceDb, actualLease: unknown) => {
        expect(actualTx).toBe(tx)
        expect(actualLease).toBe(lease)
        events.push('fence')
      },
    } as Parameters<typeof recovery.composeCrewStationHumanGateRecovery>[0]['fence'],
  }
  recovery.composeCrewStationHumanGateRecovery(input)
  expect(persistenceArgs[1]).toBe(taskLock)
  expect(persistenceArgs[2]).toEqual({ historyRestrictions: restrictions })
  const session = persistenceArgs[0] as {
    transaction(body: (tx: PersistenceTx) => Promise<void>): Promise<void>
  }
  await session.transaction(async (actualTx) => {
    expect(actualTx).toBe(tx)
    events.push('body')
  })
  expect(events).toEqual(['current', 'transaction', 'fence', 'body'])
  // @ts-expect-error Verify runtime refusal for an untyped caller without a provider.
  recovery.composeCrewStationHumanGateRecovery({ ...input, historyRestrictions: undefined })
  expect(persistenceArgs[2]).toEqual({ historyRestrictions: undefined })
})
