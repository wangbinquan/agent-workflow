import { describe, expect, test } from 'bun:test'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  nodeRunStdoutProjection,
  STDOUT_OMITTED_MARKER,
  STDOUT_TAIL_BUDGET_BYTES,
} from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { describeEachProvider } from './helpers/eachProvider'
import { nodeRunFixture, taskFixture, workflowFixture } from './helpers/model'
import {
  createRunHistorySnapshot,
  loadFrameChain,
  type ContainerRunRow,
  type RunHistoryFacts,
} from '@/modules/task-execution/public/queries'

describe('task-execution public history and frame contracts', () => {
  test('history combines frame identity with inclusive and exclusive sequence bounds without mutating source rows', async () => {
    const rows: RunHistoryFacts[] = [9, 3, 7, 5, 1].map((seq) => ({
      id: `run-${20 - seq}`,
      seq,
      nodeId: 'worker',
      containerRunId: 'container',
      parentNodeRunId: null,
      shardKey: null,
      iteration: 2,
      status: 'done',
    }))
    rows.push({ ...rows[0]!, id: 'other-frame', seq: 6, containerRunId: 'other' })
    rows.push({ ...rows[0]!, id: 'child', seq: 6, parentNodeRunId: 'parent' })
    rows.push({ ...rows[0]!, id: 'other-shard', seq: 6, shardKey: 'shard' })
    const originalIds = rows.map((row) => row.id)
    const history = createRunHistorySnapshot('task', rows)
    const family = { nodeId: 'worker', containerRunId: 'container', shardKey: null, iteration: 2 }
    const inclusive = await history.familyHistory('task', family, {
      topLevelOnly: true,
      from: { id: 'not-the-row-id', seq: 3 },
      through: { id: 'not-the-row-id', seq: 7 },
    })
    expect(inclusive.map((row) => row.seq)).toEqual([3, 5, 7])
    const exclusive = await history.familyHistory('task', family, {
      topLevelOnly: true,
      after: { id: 'ignored-identity', seq: 3 },
      before: { id: 'ignored-identity', seq: 7 },
      direction: 'desc',
    })
    expect(exclusive.map((row) => row.seq)).toEqual([5])
    expect(rows.map((row) => row.id)).toEqual(originalIds)
    await expect(history.familyHistory('other-task', {})).rejects.toThrow(
      'run-history-task-mismatch',
    )
    expect(await history.familyHistory('task', { nodeIds: [] })).toEqual([])
  })

  test('frame loading reads only ancestry once per frame and terminates a cyclic chain', async () => {
    const depth = 128
    const rows = new Map<string, ContainerRunRow>()
    for (let index = 0; index < depth; index++) {
      rows.set(`frame-${index}`, {
        id: `frame-${index}`,
        nodeId: `loop-${index}`,
        iteration: index,
        containerRunId: index === depth - 1 ? 'frame-0' : `frame-${index + 1}`,
      })
    }
    const reads: string[] = []
    const reader = {
      async read(id: string) {
        reads.push(id)
        return rows.get(id)
      },
    }
    const result = await loadFrameChain(reader, { containerRunId: 'frame-0', iteration: 0 })
    expect(result.rows.size).toBe(depth)
    expect(reads).toEqual([...rows.keys()])
    expect(result.rows.get('frame-127')).toEqual(rows.get('frame-127'))
    reads.length = 0
    expect((await loadFrameChain(reader, { containerRunId: null, iteration: 0 })).rows.size).toBe(0)
    expect(reads).toEqual([])
  })

  test('missing ancestry ends at the first missing frame and read errors propagate without retries', async () => {
    const reads: string[] = []
    const reader = {
      async read(id: string): Promise<ContainerRunRow | null> {
        reads.push(id)
        return id === 'present'
          ? { id, nodeId: 'loop', iteration: 4, containerRunId: 'missing' }
          : null
      },
    }
    const result = await loadFrameChain(reader, { containerRunId: 'present', iteration: 4 })
    expect([...result.rows.keys()]).toEqual(['present'])
    expect(reads).toEqual(['present', 'missing'])
    const failure = new Error('ancestry storage unavailable')
    let attempts = 0
    await expect(
      loadFrameChain(
        {
          async read() {
            attempts++
            throw failure
          },
        },
        {
          containerRunId: 'present',
          iteration: 4,
        },
      ),
    ).rejects.toBe(failure)
    expect(attempts).toBe(1)
  })
})

describeEachProvider('task-execution output read budget contract', (harness) => {
  test('a UTF-8 stdout tail filled by live rows performs zero archive reads and retains the newest complete line', async () => {
    await workflowFixture(harness.db, { id: 'stdout-workflow', name: 'workflow', definition: '{}' })
    await taskFixture(harness.db, {
      id: 'stdout-task',
      name: 'task',
      workflowId: 'stdout-workflow',
      workflowSnapshot: '{}',
      repoPath: '/unused',
      worktreePath: '/unused',
      baseBranch: 'main',
      branch: 'stdout-task',
      status: 'done',
      inputs: '{}',
      startedAt: 1,
    })
    await nodeRunFixture(harness.db, {
      id: 'stdout-run',
      taskId: 'stdout-task',
      nodeId: 'worker',
      status: 'done',
      retryIndex: 0,
      startedAt: 1,
    })
    const newest = `new:${'界'.repeat(200_000)}`
    const { nodeRunEvents } = tablesOf(harness.db)
    await insertOne(harness.db, nodeRunEvents, {
      id: 1,
      nodeRunId: 'stdout-run',
      ts: 1,
      kind: 'text',
      payload: `old:${'界'.repeat(200_000)}`,
    })
    await insertOne(harness.db, nodeRunEvents, {
      id: 2,
      nodeRunId: 'stdout-run',
      ts: 2,
      kind: 'text',
      payload: newest,
    })
    let archiveReads = 0
    const recording = harness.recordStatements()
    try {
      const output = await nodeRunStdoutProjection(
        {
          db: harness.db,
          archivedEvents: {
            async read() {
              archiveReads++
              throw new Error('older archive must not be read when live rows fill the tail')
            },
          },
        },
        'stdout-task',
        'stdout-run',
      )
      expect(output).toBe(`${STDOUT_OMITTED_MARKER}\n${newest}`)
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(
        STDOUT_TAIL_BUDGET_BYTES + Buffer.byteLength(STDOUT_OMITTED_MARKER) + 1,
      )
      expect(archiveReads).toBe(0)
      expect(recording.selects()).toHaveLength(2)
    } finally {
      recording.stop()
    }
  })
})
