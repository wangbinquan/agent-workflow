// RFC-370 A2: content ACKs must precede archive finalization; recovery uses the same claim.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRunEvents,
  nodeRuns,
  taskArchiveAudit,
  taskExecutionMaintenanceClaims,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import type { TaskArchiveContentPort } from '@/modules/task-execution/application/ports/taskArchiveContent'
import { createDrizzleTaskArchiveMaintenanceCommand } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_278_400_000
const DAY = 86_400_000
const ROOT = 'archive-content-task'
const OPTIONS = {
  archiveDir: 'artifact:archive',
  runsDir: 'artifact:runs',
  logsDir: 'artifact:logs',
  now: NOW,
}
const TEMPORARY = `${OPTIONS.archiveDir}/.tmp-${ROOT}`
const FINAL = `${OPTIONS.archiveDir}/${ROOT}`

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function memoryContent(
  control: {
    before?: (operation: string, reference: string) => void | Promise<void>
    after?: (operation: string, reference: string) => void | Promise<void>
    restored?: boolean
  } = {},
) {
  const files = new Map<string, string>()
  const directories = new Set<string>()
  const calls: Array<{ operation: string; reference: string; text?: string }> = []
  function makeDirectory(reference: string) {
    directories.add(reference)
    const parent = reference.lastIndexOf('/')
    if (parent >= 0) makeDirectory(reference.slice(0, parent))
  }
  function putFile(reference: string, text: string) {
    makeDirectory(reference.slice(0, reference.lastIndexOf('/')))
    files.set(reference, text)
  }
  async function before(operation: string, reference: string, text?: string) {
    calls.push({ operation, reference, ...(text === undefined ? {} : { text }) })
    await control.before?.(operation, reference)
  }
  const content: TaskArchiveContentPort = {
    resolve(reference, ...segments) {
      expect(this).toBe(content)
      return [reference, ...segments].join('/')
    },
    async exists(reference) {
      expect(this).toBe(content)
      await before('exists', reference)
      return directories.has(reference) || files.has(reference)
    },
    async list(reference) {
      expect(this).toBe(content)
      await before('list', reference)
      return [
        ...new Set(
          [...directories, ...files.keys()]
            .filter((key) => key.startsWith(reference + '/'))
            .map((key) => key.slice(reference.length + 1).split('/')[0]!),
        ),
      ]
    },
    async createDirectory(reference) {
      expect(this).toBe(content)
      await before('create', reference)
      makeDirectory(reference)
    },
    async remove(reference, recursive) {
      expect(this).toBe(content)
      await before('remove', reference)
      for (const key of [...files.keys()]) {
        if (key === reference || (recursive === true && key.startsWith(reference + '/')))
          files.delete(key)
      }
      for (const key of [...directories]) {
        if (key === reference || (recursive === true && key.startsWith(reference + '/')))
          directories.delete(key)
      }
    },
    async move(from, to) {
      expect(this).toBe(content)
      await before('move', from)
      if (!directories.has(from) && !files.has(from))
        throw new Error(`missing selected content: ${from}`)
      for (const [key, text] of [...files]) {
        if (key === from || key.startsWith(from + '/')) {
          files.delete(key)
          putFile(to + key.slice(from.length), text)
        }
      }
      for (const key of [...directories]) {
        if (key === from || key.startsWith(from + '/')) {
          directories.delete(key)
          makeDirectory(to + key.slice(from.length))
        }
      }
      await control.after?.('move', from)
    },
    async appendText(reference, text) {
      expect(this).toBe(content)
      await before('append', reference, text)
      expect(directories.has(reference.slice(0, reference.lastIndexOf('/')))).toBe(true)
      files.set(reference, (files.get(reference) ?? '') + text)
    },
    async writeText(reference, text) {
      expect(this).toBe(content)
      await before('write', reference, text)
      expect(directories.has(reference.slice(0, reference.lastIndexOf('/')))).toBe(true)
      files.set(reference, text)
    },
    async restoreMovedDirectories(temporary, kind) {
      expect(this).toBe(content)
      await before('restore', `${temporary}/${kind}`)
      return control.restored ?? true
    },
  }
  return { content, files, directories, calls, putFile, makeDirectory }
}

async function seedTask(db: ProviderNeutralDatabase) {
  await db.insert(users).values({
    id: 'archive-user',
    username: 'archive-user',
    displayName: 'archive-user',
    role: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
  })
  const definition = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
  await db
    .insert(workflows)
    .values({ id: 'archive-workflow', name: 'archive-workflow', definition })
  await db.insert(tasks).values({
    id: ROOT,
    name: ROOT,
    workflowId: 'archive-workflow',
    workflowSnapshot: definition,
    repoPath: 'workspace://source',
    worktreePath: 'workspace://task',
    baseBranch: 'main',
    branch: `agent-workflow/${ROOT}`,
    status: 'done',
    inputs: '{}',
    startedAt: NOW - 11 * DAY,
    finishedAt: NOW - 10 * DAY,
    runningMs: 0,
    ownerUserId: 'archive-user',
    launchOrigin: 'manual',
    parentTaskId: null,
    invocationDepth: 0,
  })
}

async function claims(db: ProviderNeutralDatabase) {
  return await db
    .select()
    .from(taskExecutionMaintenanceClaims)
    .where(eq(taskExecutionMaintenanceClaims.rootTaskId, ROOT))
}

async function taskExists(db: ProviderNeutralDatabase) {
  return (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, ROOT))).length > 0
}

function runSweep(db: ProviderNeutralDatabase, content: TaskArchiveContentPort) {
  return createDrizzleTaskArchiveMaintenanceCommand(db, { content }).runSweep(
    { enabled: true, retentionDays: 1, maxTreesPerSweep: 10 },
    OPTIONS,
  )
}

describeEachProvider('RFC-370 selected archive content', (harness) => {
  for (const [operation, reference] of [
    ['append', `${TEMPORARY}/db/tasks.jsonl`],
    ['write', `${TEMPORARY}/manifest.json`],
    ['move', TEMPORARY],
  ]) {
    test(`${operation} ACK precedes database deletion and audit completion`, async () => {
      const db = harness.db
      await seedTask(db)
      const entered = barrier()
      const release = barrier()
      const store = memoryContent({
        before: async (op, ref) => {
          if (op === operation && ref === reference) {
            entered.release()
            await release.promise
          }
        },
      })
      store.putFile(`${OPTIONS.runsDir}/${ROOT}/prompt.md`, 'prompt bytes')
      store.putFile(`${OPTIONS.logsDir}/${ROOT}/events.ndjson`, 'event bytes\n')
      const pending = runSweep(db, store.content)
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('archive settled before selected ACK barrier')
          }),
        ])
        expect(await taskExists(db)).toBe(true)
        const snapshot = await claims(db)
        expect(snapshot).toHaveLength(1)
        expect(snapshot[0]!.state).toBe('claimed')
        expect(await db.select().from(taskArchiveAudit)).toEqual([])
        expect(store.directories.has(FINAL)).toBe(false)
        release.release()
        const result = await pending
        expect(result.skipped).toBe(0)
        expect(result.archived.map((tree) => tree.rootTaskId)).toEqual([ROOT])
        expect(await taskExists(db)).toBe(false)
        expect((await claims(db))[0]!.id).toBe(snapshot[0]!.id)
        expect((await claims(db))[0]!.state).toBe('completed')
        expect(store.files.get(`${FINAL}/runs/${ROOT}/prompt.md`)).toBe('prompt bytes')
        expect(store.files.get(`${FINAL}/logs/${ROOT}/events.ndjson`)).toBe('event bytes\n')
        const manifest = JSON.parse(store.files.get(`${FINAL}/manifest.json`)!)
        expect(manifest.schemaVersion).toBe(2)
        expect(manifest.taskIds).toEqual([ROOT])
        expect(manifest.rows.tasks).toBe(1)
        expect(manifest.rows.runs_dirs).toBe(1)
        expect(manifest.rows.logs_dirs).toBe(1)
        expect(manifest.terminalMaintenance.claim.id).toBe(snapshot[0]!.id)
        expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/)
      } finally {
        release.release()
        await pending
      }
    }, 20_000)
  }

  test('lost commit ACK keeps online rows and recovers the same committed artifact and claim', async () => {
    const db = harness.db
    await seedTask(db)
    let lostAck = true
    const store = memoryContent({
      after: (operation, reference) => {
        if (operation === 'move' && reference === TEMPORARY && lostAck) {
          lostAck = false
          throw new Error('selected commit ACK lost')
        }
      },
    })
    const command = createDrizzleTaskArchiveMaintenanceCommand(db, { content: store.content })
    const first = await command.runSweep(
      { enabled: true, retentionDays: 1, maxTreesPerSweep: 10 },
      OPTIONS,
    )
    expect(first).toEqual({ archived: [], skipped: 1 })
    expect(await taskExists(db)).toBe(true)
    const snapshot = (await claims(db))[0]!
    expect(snapshot.state).toBe('claimed')
    const manifest = store.files.get(`${FINAL}/manifest.json`)
    expect(manifest).toBeDefined()
    const writes = store.calls.filter(
      (call) =>
        call.operation === 'append' || call.operation === 'write' || call.operation === 'move',
    ).length
    await command.recover(OPTIONS)
    expect(await taskExists(db)).toBe(false)
    const recovered = (await claims(db))[0]!
    expect(recovered.id).toBe(snapshot.id)
    expect(recovered.state).toBe('completed')
    expect(store.files.get(`${FINAL}/manifest.json`)).toBe(manifest)
    expect(
      store.calls.filter(
        (call) =>
          call.operation === 'append' || call.operation === 'write' || call.operation === 'move',
      ),
    ).toHaveLength(writes)
  }, 20_000)

  test('append rejection retries the original claim with rebuilt JSONL', async () => {
    const db = harness.db
    await seedTask(db)
    let rejected = true
    const store = memoryContent({
      before: (operation, reference) => {
        if (operation === 'append' && reference.endsWith('/db/tasks.jsonl') && rejected) {
          rejected = false
          throw new Error('selected append rejected')
        }
      },
    })
    const command = createDrizzleTaskArchiveMaintenanceCommand(db, { content: store.content })
    expect(
      await command.runSweep({ enabled: true, retentionDays: 1, maxTreesPerSweep: 10 }, OPTIONS),
    ).toEqual({ archived: [], skipped: 1 })
    expect(await taskExists(db)).toBe(true)
    const claim = (await claims(db))[0]!
    expect(claim.state).toBe('claimed')
    expect((await command.recover(OPTIONS)).promoted).toEqual([ROOT])
    expect(await taskExists(db)).toBe(false)
    expect((await claims(db))[0]!.id).toBe(claim.id)
    expect((await claims(db))[0]!.state).toBe('completed')
    const rows = store.files
      .get(`${FINAL}/db/tasks.jsonl`)!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rows.map((row) => row.id)).toEqual([ROOT])
  }, 20_000)

  test('JSONL keeps the original 2000-row batches and complete event order', async () => {
    const db = harness.db
    await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'archive-run',
      taskId: ROOT,
      nodeId: 'n1',
      status: 'done',
      startedAt: NOW - 11 * DAY,
      finishedAt: NOW - 10 * DAY,
    })
    await db.insert(nodeRunEvents).values(
      Array.from({ length: 2_001 }, (_, index) => ({
        nodeRunId: 'archive-run',
        ts: NOW - 11 * DAY + index,
        kind: 'text' as const,
        payload: `event-${index}`,
      })),
    )
    const store = memoryContent()
    const result = await runSweep(db, store.content)
    expect(result.skipped).toBe(0)
    expect(result.archived).toHaveLength(1)
    const appends = store.calls.filter(
      (call) => call.operation === 'append' && call.reference.endsWith('/db/node_run_events.jsonl'),
    )
    expect(appends.map((call) => call.text!.trim().split('\n').length)).toEqual([2_000, 1])
    const exported = store.files
      .get(`${FINAL}/db/node_run_events.jsonl`)!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(exported.map((row) => row.payload)).toEqual(
      Array.from({ length: 2_001 }, (_, index) => `event-${index}`),
    )
    const manifest = JSON.parse(store.files.get(`${FINAL}/manifest.json`)!)
    expect(manifest.rows.node_run_events).toBe(2_001)
    expect(await db.select().from(nodeRunEvents)).toEqual([])
  }, 20_000)

  for (const restored of [true, false]) {
    test(`legacy temporary recovery awaits restoration=${restored} before discarding`, async () => {
      const db = harness.db
      await seedTask(db)
      const entered = barrier()
      const release = barrier()
      const store = memoryContent({
        restored,
        before: async (operation, reference) => {
          if (operation === 'restore' && reference === `${TEMPORARY}/runs`) {
            entered.release()
            await release.promise
          }
        },
      })
      store.makeDirectory(`${TEMPORARY}/db`)
      const pending = createDrizzleTaskArchiveMaintenanceCommand(db, {
        content: store.content,
      }).recover(OPTIONS)
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('recovery settled before selected restore ACK')
          }),
        ])
        expect(store.directories.has(TEMPORARY)).toBe(true)
        expect(store.calls.some((call) => call.operation === 'remove')).toBe(false)
        release.release()
        expect((await pending).discarded).toEqual(restored ? [ROOT] : [])
        expect(store.directories.has(TEMPORARY)).toBe(!restored)
        expect(
          store.calls.filter((call) => call.operation === 'restore').map((call) => call.reference),
        ).toEqual([`${TEMPORARY}/runs`, `${TEMPORARY}/logs`])
        expect(await taskExists(db)).toBe(true)
      } finally {
        release.release()
        await pending
      }
    }, 20_000)
  }
})
