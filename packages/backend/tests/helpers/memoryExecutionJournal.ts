import { ulid } from 'ulid'
import { join } from 'node:path'
import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  SystemAgentRunFamily,
  SystemAgentRunRequest,
  PreparedSystemAgentRunResult,
} from '@/modules/task-execution/public/participants'
import { createLocalSystemAgentRetainedContents } from '@/modules/runtime-management/infrastructure/local/systemAgentRetainedContents'
import { composeMemoryOperationsFor } from '@/modules/memory/composition'
import { composeNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { createFileReviewArtifactContent } from '@/modules/collaboration/infrastructure/local/fileReviewArtifactContent'
import { emptySystemAgentOutputEvidence } from '@/services/systemAgentRun'
import type { SystemAgentObservationFactory } from '@/modules/task-execution/application/ports/systemAgentObservation'

export function memoryJournalOperations(
  db: ProviderNeutralDatabase,
  root: string,
  input: {
    readonly current?: () => boolean
    readonly preparedRecovery?: true
    readonly observations?: SystemAgentObservationFactory
    readonly respond?: (
      request: SystemAgentRunRequest,
      call: number,
    ) => Promise<{
      readonly text: string
      readonly status?: PreparedSystemAgentRunResult['status']
    }>
  } = {},
) {
  const contents = createLocalSystemAgentRetainedContents({ appHome: () => root })
  const state = {
    calls: 0,
    recoveries: 0,
    reaped: true,
    requests: [] as SystemAgentRunRequest[],
    observationIds: [] as string[],
  }
  const family: SystemAgentRunFamily = {
    workspaces: contents.workspaces,
    retainedContents: contents.contents,
    recovery: {
      async recoverReference(value) {
        state.recoveries += 1
        return { executionRef: value.executionRef, state: state.reaped ? 'reaped' : 'unknown' }
      },
    },
    async run(request) {
      const opened = contents.open({
        scope: request.workspaceScope,
        ...(request.resumeRetainedRef === undefined
          ? {}
          : { resumeRetainedRef: request.resumeRetainedRef }),
        feature: () => request.feature,
        seedFiles: () => request.seedFiles,
      })
      await opened.workspace.prepare()
      const executionRef = 'aw-test-execution:' + ulid()
      const prepared = {
        executionRef,
        retainedRef: opened.workspace.retainedRef,
        startedAt: null,
        recoveryRef: input.preparedRecovery ? 'fixture-prepared:' + executionRef : null,
      }
      await request.executionReceipts?.prepared(prepared)
      if (request.admitExecution?.() === false)
        return {
          status: 'spawn-failed',
          exitCode: null,
          eventText: '',
          stderrTail: 'system-agent-execution-admission-expired',
          durationMs: 1,
          scratchRetained: true,
          retainedRef: prepared.retainedRef,
          executionReceipt: prepared,
          outputEvidence: emptySystemAgentOutputEvidence(),
        }
      const started = {
        ...prepared,
        startedAt: Date.now(),
        recoveryRef: 'fixture-original:' + executionRef,
      }
      await request.executionReceipts?.started(started)
      if (request.admitExecution?.() === false)
        return {
          status: 'spawn-failed',
          exitCode: null,
          eventText: '',
          stderrTail: 'system-agent-execution-admission-expired',
          durationMs: 1,
          scratchRetained: true,
          retainedRef: prepared.retainedRef,
          executionReceipt: started,
          outputEvidence: emptySystemAgentOutputEvidence(),
        }
      state.calls += 1
      state.requests.push(request)
      const observation = await input.observations?.open({
        feature: request.feature,
        agentName: request.agentName,
        protocol: request.protocol,
        startedAt: started.startedAt,
        ...(request.runtimeObservationIdentity
          ? { runtimeObservationIdentity: request.runtimeObservationIdentity }
          : {}),
        ...(request.observationDemand ? { demand: request.observationDemand } : {}),
      })
      if (observation) {
        state.observationIds.push(observation.invocationId)
        await observation.accept({})
      }
      const response = (await input.respond?.(request, state.calls)) ?? {
        text: memoryEnvelope(request),
      }
      await observation?.settle(response.status ?? 'ok', Date.now())
      return {
        status: response.status ?? 'ok',
        exitCode: response.status === 'unreaped' ? null : 0,
        eventText: response.text,
        stderrTail: '',
        durationMs: 1,
        scratchRetained: true,
        capturedSessionId: 'original-memory-native-session',
        retainedRef: prepared.retainedRef,
        executionReceipt: started,
        outputEvidence: emptySystemAgentOutputEvidence(),
        ...(response.status === 'unreaped'
          ? {
              executionRecovery: {
                executionRef,
                async recoverOriginal() {
                  state.recoveries += 1
                  return state.reaped
                },
              },
            }
          : {}),
      }
    },
  }
  const operations = composeMemoryOperationsFor({
    db,
    systemAgentBinding: {
      family,
      bindRuntime: (runtime) => ({ ...runtime, runtimeBinding: null }),
    },
    nodeRunPrompts: composeNodeRunPromptOperations(undefined, join(root, 'runs')),
    reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(
      db,
      createFileReviewArtifactContent(root),
    ),
  })
  return { operations, state, family }
}

export function memoryEnvelope(
  request: SystemAgentRunRequest,
  candidates: readonly unknown[] = [],
) {
  const nonce = /nonce="([^"]+)"/.exec(request.prompt)?.[1] ?? ''
  return `<workflow-output nonce="${nonce}"><port name="candidates">${JSON.stringify({ candidates })}</port></workflow-output>`
}
