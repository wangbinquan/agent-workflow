// RFC-371: real owner/source EOF, including every row beyond the former total caps.
import { expect, test } from 'bun:test'
import {
  AcceptedObservationInvocationSchema,
  type ObservationTaskFacts,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { readUsageCaptures } from '../src/modules/run-observability/infrastructure/usageCapturePersistence'
import { buildActor } from '../src/auth/actor'
import {
  nodeRuns,
  observationInvocations,
  observationUsageCaptures,
  observationUsageCurrent,
  tasks,
  users,
} from '../src/db/schema'
import { sha256Hex } from '../src/util/hash'
import { createTaskObservationFacts } from '../src/modules/task-execution/composition/taskObservationFacts'
import { createCompleteObservationSources } from '../src/modules/run-observability/infrastructure/completeObservationSources'
import type { CompleteSourceReader } from '../src/modules/run-observability/ports/completeReport'
import type { UsageLedgerRecord } from '../src/modules/run-observability/domain/usageLedger'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = Date.parse('2026-10-03T00:00:00Z')
const user = {
  id: 'full-reader',
  username: 'full-reader',
  displayName: 'Full reader',
  role: 'admin' as const,
  status: 'active' as const,
}
const actor = buildActor({ user, source: 'session' })
const id = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, '0')}`
const task = (n: number): typeof tasks.$inferInsert => ({
  id: id('task', n),
  name: id('task', n),
  workflowId: 'workflow',
  workflowSnapshot: '{}',
  inputs: '{}',
  repoPath: '/fixture',
  worktreePath: '/fixture',
  baseBranch: 'main',
  branch: 'task/fixture',
  branchStartedAt: NOW,
  startedAt: NOW,
  status: 'done',
  rootTaskId: id('task', n),
  ownerUserId: user.id,
})
async function readAll<T>(reader: CompleteSourceReader<T>, key: (item: T) => string) {
  const rows: T[] = [],
    seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page = await reader.next(cursor)
    expect(page.snapshotId).toBe('original-snapshot')
    expect(page.items.length).toBeLessThanOrEqual(61)
    for (const item of page.items) {
      expect(seen.has(key(item))).toBe(false)
      seen.add(key(item))
      rows.push(item)
    }
    cursor = page.nextCursor
  } while (cursor !== null)
  return rows
}
const usage = (n: number): UsageLedgerRecord => ({
  sourceId: 'original-source',
  measurement: {
    schemaVersion: 1,
    taskId: id('task', 0),
    invocationId: id('invocation', n % 2001),
    nodeRunId: null,
    agentId: null,
    recordId: id('meter', n),
    revision: 1,
    occurredAt: NOW,
    observedAt: NOW,
    model: { provider: 'native', id: 'actual' },
    adapterVersion: 'fixture',
    reporting: 'delta',
    inclusion: 'self',
    coverage: 'complete',
    validity: 'valid',
    basis: { kind: 'invocation' },
    usage: {
      input: String(n + 1),
      cacheRead: String((n + 1) * 3),
      cacheWrite: String((n + 1) * 5),
      output: String((n + 1) * 7),
    },
  },
  observedRevision: 1,
  contribution: {
    input: String(n + 1),
    cacheRead: String((n + 1) * 3),
    cacheWrite: String((n + 1) * 5),
    output: String((n + 1) * 7),
  },
  complete: true,
  issues: [],
})

describeEachProvider('RFC-371 complete original source pages', (harness) => {
  test('all 201 tasks, 1001 attempts, 2001 invocations/captures and 10001 usage records reach true EOF', async () => {
    await harness.db
      .insert(users)
      .values({
        ...user,
        passwordHash: 'fixture',
        forcePasswordChange: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run()
    for (let start = 0; start < 201; start += 50)
      await harness.db
        .insert(tasks)
        .values(Array.from({ length: Math.min(50, 201 - start) }, (_, i) => task(start + i)))
        .run()
    for (let start = 0; start < 1001; start += 50)
      await harness.db
        .insert(nodeRuns)
        .values(
          Array.from({ length: Math.min(50, 1001 - start) }, (_, i) => ({
            id: id('run', start + i),
            taskId: id('task', 0),
            nodeId: 'node',
            status: 'done' as const,
            startedAt: NOW,
            finishedAt: NOW + i,
          })),
        )
        .run()
    for (let start = 0; start < 2001; start += 50) {
      const numbers = Array.from({ length: Math.min(50, 2001 - start) }, (_, i) => start + i)
      await harness.db
        .insert(observationInvocations)
        .values(
          numbers.map((n) => {
            const document = AcceptedObservationInvocationSchema.parse({
              invocationId: id('invocation', n),
              taskId: id('task', 0),
              nodeRunId: null,
              agentId: null,
              agentRevision: null,
              purpose: 'task',
              nativeCaptureContract: 'opencode-child-steps-v1',
              authority: { kind: 'local', runtime: null },
              acceptedAt: NOW,
              priceBookRevision: null,
            })
            return {
              id: document.invocationId,
              taskId: document.taskId,
              canonicalExecution: sha256Hex(JSON.stringify(['local', document.invocationId])),
              fingerprint: JSON.stringify(document),
              document: JSON.stringify(document),
            }
          }),
        )
        .run()
      await harness.db
        .insert(observationUsageCaptures)
        .values(
          numbers.map((n) => {
            const evidence = {
              invocationId: id('invocation', n),
              taskId: id('task', 0),
              capture: {
                contract: 'opencode-child-steps-v1',
                nativeSource: 'fixture-native',
                rootSessionId: 'root',
                state: 'complete',
                baseline: { kind: 'fresh', fingerprint: null },
                snapshotFingerprint: 'original-proof',
                observedAt: NOW,
                scannedSessions: 1,
                scannedSteps: 0,
                issues: [],
                priorRevisions: [],
              },
            }
            return {
              invocationId: evidence.invocationId,
              taskId: evidence.taskId,
              sourceId: 'original-source',
              sourceCursor: id('source-row', n),
              nativeRootKey: null,
              priorRevisionGap: 0,
              repairPending: 0,
              document: JSON.stringify({ evidence, resolutions: [] }),
              summary: JSON.stringify({ evidence, resolutions: [] }),
            }
          }),
        )
        .run()
    }
    for (let start = 0; start < 10001; start += 50)
      await harness.db
        .insert(observationUsageCurrent)
        .values(
          Array.from({ length: Math.min(50, 10001 - start) }, (_, i) => {
            const row = usage(start + i)
            return {
              id: sha256Hex(
                JSON.stringify([
                  row.sourceId,
                  row.measurement.invocationId,
                  row.measurement.recordId,
                ]),
              ),
              taskId: row.measurement.taskId,
              sourceId: row.sourceId,
              document: JSON.stringify(row),
            }
          }),
        )
        .run()
    await harness.session.snapshotRead(async (db) => {
      const sources = createCompleteObservationSources({
        db,
        tasks: createTaskObservationFacts(db),
        snapshotId: 'original-snapshot',
        pageSize: 61,
      })
      const window = await readAll(
        sources.tasks(actor, { from: NOW - 1, to: NOW + 1, timezone: 'Asia/Shanghai' }),
        (row: ObservationTaskFacts) => row.id,
      )
      expect(window.map((row) => row.id).sort()).toEqual(
        Array.from({ length: 201 }, (_, n) => id('task', n)),
      )
      const attempts = await readAll(sources.attempts(id('task', 0)), (row) => row.id)
      expect(attempts.map((row) => row.id)).toEqual(
        Array.from({ length: 1001 }, (_, n) => id('run', n)),
      )
      const invocations = await readAll(
        sources.invocations(id('task', 0)),
        (row) => row.invocationId,
      )
      expect(invocations.map((row) => row.invocationId)).toEqual(
        Array.from({ length: 2001 }, (_, n) => id('invocation', n)),
      )
      const captures = await readAll(sources.captures(id('task', 0)), (row) => row.invocationId)
      expect(captures.map((row) => row.invocationId)).toEqual(
        invocations.map((row) => row.invocationId),
      )
      const records = await readAll(sources.usage(id('task', 0)), (row) => row.measurement.recordId)
      expect(records.map((row) => row.measurement.recordId).sort()).toEqual(
        Array.from({ length: 10001 }, (_, n) => id('meter', n)),
      )
      const actual = { input: 0n, cacheRead: 0n, cacheWrite: 0n, output: 0n }
      for (const row of records)
        for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const)
          actual[bucket] += BigInt(row.contribution[bucket]!)
      const sum = (10001n * 10002n) / 2n
      expect(actual).toEqual({
        input: sum,
        cacheRead: sum * 3n,
        cacheWrite: sum * 5n,
        output: sum * 7n,
      })
      const first = await sources.invocations(id('task', 0)).next(null)
      await expect(sources.invocations(id('task', 1)).next(first.nextCursor)).rejects.toThrow(
        'parent',
      )
      const other = createCompleteObservationSources({
        db,
        tasks: createTaskObservationFacts(db),
        snapshotId: 'another-snapshot',
        pageSize: 61,
      })
      await expect(other.invocations(id('task', 0)).next(first.nextCursor)).rejects.toThrow(
        'snapshot',
      )
    })
  }, 60000)
  test('retains same-native-root history gaps from another task and clears them only after original repair', async () => {
    const evidence = (n: number) => ({
      invocationId: id('gap-invocation', n),
      taskId: id('gap-task', n),
      capture: {
        contract: 'opencode-child-steps-v1',
        nativeSource: 'fixture-native',
        rootSessionId: n === 2 ? 'other-root' : 'shared-root',
        state: 'complete',
        baseline: { kind: 'fresh', fingerprint: null },
        snapshotFingerprint: 'original-proof',
        observedAt: NOW,
        scannedSessions: 1,
        scannedSteps: 0,
        issues: [],
        priorRevisions: [],
      },
    })
    await harness.db
      .insert(observationUsageCaptures)
      .values(
        [0, 1, 2].map((n) => {
          const e = evidence(n)
          return {
            invocationId: e.invocationId,
            taskId: e.taskId,
            sourceId: 'original-source',
            sourceCursor: id('gap-cursor', n),
            nativeRootKey: sha256Hex(
              JSON.stringify([e.capture.nativeSource, e.capture.rootSessionId]),
            ),
            priorRevisionGap: n === 1 ? 1 : 0,
            repairPending: n === 1 ? 1 : 0,
            document: JSON.stringify({ evidence: e, resolutions: [] }),
            summary: JSON.stringify({ evidence: e, resolutions: [] }),
          }
        }),
      )
      .run()
    const read = async () =>
      harness.session.snapshotRead(async (db) => {
        const sources = createCompleteObservationSources({
          db,
          tasks: createTaskObservationFacts(db),
          snapshotId: 'original-snapshot',
          pageSize: 1,
        })
        const original = await readUsageCaptures(db, [id('gap-invocation', 0)])
        const page = await sources.captures(id('gap-task', 0)).next(null)
        expect(page.nextCursor).toBeNull()
        expect(page.items).toEqual(original)
        expect(
          (await sources.captures(id('gap-task', 2)).next(null)).items[0]!.priorRevisionGap,
        ).toBe(false)
        return page.items[0]!.priorRevisionGap
      })
    expect(await read()).toBe(true)
    await harness.db
      .update(observationUsageCaptures)
      .set({ priorRevisionGap: 0, repairPending: 0 })
      .where(eq(observationUsageCaptures.invocationId, id('gap-invocation', 1)))
      .run()
    expect(await read()).toBe(false)
  })
})
