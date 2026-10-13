import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEachProvider } from './helpers/eachProvider'
import { composeMemoryOperationsFor } from '../src/modules/memory/composition'
import { composeNodeRunPromptOperations } from '../src/modules/task-execution/composition/nodeRunPrompts'
import { composeLocalSystemAgentRunFamily } from '../src/modules/task-execution/composition/localSystemAgentRunFamily'
import { DatabaseCommittedReviewArtifactReader } from '../src/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { createFileReviewArtifactContent } from '../src/modules/collaboration/infrastructure/local/fileReviewArtifactContent'
import { emptySystemAgentOutputEvidence } from '../src/services/systemAgentRun'
import { IndeterminateRuntimeProcessError } from '../src/modules/memory/application/distill/memoryDistiller'

describeEachProvider('RFC-370 memory original execution recovery composition', (scope) => {
  test('explicit recovery retains original scratch and queue identity, and blocks same-instance boot requeue until the actual ACK', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-memory-issued-recovery-'))
    let permitted = false,
      physical = 0,
      runs = 0,
      scratch = ''
    const selected = composeLocalSystemAgentRunFamily({ appHome: () => root }).withFixture(
      async (input) => {
        runs += 1
        scratch = join(input.scratchParent, input.scratchName ?? 'original')
        mkdirSync(scratch, { recursive: true })
        return {
          status: 'unreaped',
          exitCode: null,
          eventText: '',
          stderrTail: 'original unknown',
          durationMs: 1,
          scratchDir: scratch,
          scratchRetained: true,
          outputEvidence: emptySystemAgentOutputEvidence(),
          executionRecovery: {
            executionRef: 'original:memory-execution',
            async recoverOriginal() {
              physical += 1
              return permitted
            },
          },
        }
      },
    )
    const operations = composeMemoryOperationsFor({
      db: scope.db,
      reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(
        scope.db,
        createFileReviewArtifactContent(root),
      ),
      nodeRunPrompts: composeNodeRunPromptOperations(undefined, join(root, 'runs')),
      systemAgentBinding: selected,
    })
    try {
      const queued = await operations.distillCommands.enqueue({
        sourceKind: 'clarify',
        sourceEventId: 'original:source',
        taskId: null,
        debounceMs: 0,
      })
      if (!queued) throw new Error('original memory job was not admitted')
      const error = await operations.distillWorker
        .tick({ execution: { current: () => true } })
        .catch((error) => error as unknown)
      expect(error).toBeInstanceOf(IndeterminateRuntimeProcessError)
      expect(scratch).not.toBe('')
      expect(existsSync(scratch)).toBe(true)
      await expect(operations.distillWorker.recoverRunning()).rejects.toBe(error)
      await expect(
        operations.distillWorker.tick({ execution: { current: () => true } }),
      ).rejects.toBe(error)
      expect(await operations.distillCommands.recoverIssued('replacement:job')).toBe(false)
      expect(await operations.distillCommands.recoverIssued(queued.jobId)).toBe(false)
      expect((await operations.distillQueries.listJobs())[0]).toMatchObject({
        id: queued.jobId,
        status: 'running',
        attempts: 0,
      })
      expect(existsSync(scratch)).toBe(true)
      permitted = true
      expect(await operations.distillCommands.recoverIssued(queued.jobId)).toBe(true)
      expect(await operations.distillCommands.recoverIssued(queued.jobId)).toBe(true)
      expect((error as IndeterminateRuntimeProcessError).originalRecoveryAcknowledged()).toBe(true)
      expect((await operations.distillQueries.listJobs())[0]).toMatchObject({
        id: queued.jobId,
        status: 'pending',
        attempts: 1,
        startedAt: null,
      })
      expect(existsSync(scratch)).toBe(false)
      expect(await operations.distillWorker.recoverRunning()).toEqual({ recovered: 0 })
      expect(runs).toBe(1)
      expect(physical).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
