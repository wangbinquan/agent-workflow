// RFC-370 v3 V6: node event chunks are `node-event-archive` publications whose
// bytes are always re-encoded from their still-present source rows (no inline
// copy in the database). Publication and deletion of exactly the source range
// commit together; a service replacement resumes with the same lifetime; the
// task object sweep releases the chunks of deleted tasks.
import { expect, test } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import {
  hostedNodeEventArchives,
  hostedObjectPublications,
  nodeRunEvents,
  nodeRuns,
  tasks,
  workflows,
} from '@/db/schema'
import { createHostedBackupReleaseHorizon } from '@/modules/system-operations/infrastructure/crewstation/backupReleaseHorizon'
import { createHostedObjectPublications } from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import { createHostedTaskObjectSweep } from '@/modules/task-execution/infrastructure/crewstation/hostedObjectSweep'
import {
  createHostedNodeEventArchive,
  HOSTED_EVENT_ARCHIVE_OWNER,
} from '@/modules/task-execution/infrastructure/crewstation/nodeEventArchive'
import {
  nodeRunEventsProjection,
  nodeRunStdoutProjection,
} from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { archiveEventsWithStore } from '@/platform/persistence/sqlite/systemEventsArchive'
import { createEventsArchiveStore } from '@/platform/persistence/eventsArchiveStore'
import { objectFixture } from './helpers/rfc370Objects'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-370 hosted node event archive', (harness) => {
  const setup = async () => {
    const db = harness.db,
      objects = objectFixture()
    await db.insert(workflows).values({ id: 'wf', name: 'archive', definition: '{}' })
    await db.insert(tasks).values({
      id: 'task',
      name: 'archive',
      workflowId: 'wf',
      workflowSnapshot: '{}',
      repoPath: '',
      worktreePath: '',
      baseBranch: 'main',
      branch: 'archive',
      status: 'done',
      inputs: '{}',
      startedAt: 1,
      finishedAt: 2,
    })
    await db.insert(nodeRuns).values({ id: 'run', taskId: 'task', nodeId: 'node', status: 'done' })
    await db.insert(nodeRunEvents).values(
      Array.from({ length: 7 }, (_, i) => ({
        nodeRunId: 'run',
        ts: i + 1,
        kind: 'text' as const,
        payload: `line ${i + 1}`,
        sessionId: i < 3 ? 'root-session' : 'child-session',
        parentSessionId: i < 3 ? null : 'root-session',
      })),
    )
    const all = await createEventsArchiveStore(db).listOldestEvents('run', 100)
    let held = true,
      loseAfterUpload = false
    const fence = {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      assertHeld: async () => {
        if (!held) throw new Error('lease lost')
      },
    }
    const storage = {
      ...objects.objects,
      async putStream(...args: Parameters<typeof objects.objects.putStream>) {
        const stored = await objects.objects.putStream(...args)
        if (loseAfterUpload) {
          held = false
          loseAfterUpload = false
        }
        return stored
      },
    }
    const journal = createHostedObjectPublications({
      db,
      fence,
      objects: storage,
      abandonAfterMs: 0,
    })
    const reopen = () =>
      createHostedNodeEventArchive({
        db,
        fence,
        objects: storage,
        publications: journal.publications,
      })
    const sweep = createHostedTaskObjectSweep({
      db,
      fence,
      publications: journal.publications,
      graceMs: -1,
    })
    return {
      db,
      objects,
      all,
      reopen,
      sweep: () => sweep.sweep({ now: Date.now() }),
      settle: () =>
        journal.maintenance({ horizon: createHostedBackupReleaseHorizon({ db }) }).run(),
      loseNextUpload: () => {
        loseAfterUpload = true
      },
      acquire: () => {
        held = true
      },
      publications: () =>
        db
          .select()
          .from(hostedObjectPublications)
          .where(eq(hostedObjectPublications.owner, HOSTED_EVENT_ARCHIVE_OWNER)),
    }
  }

  test('lost authority after pin retains source rows; a cold owner publishes once and restores complete pages', async () => {
    const f = await setup()
    f.loseNextUpload()
    await expect(
      f.reopen().archive({ taskId: 'task', nodeRunId: 'run', rows: f.all.slice(0, 4) }),
    ).rejects.toThrow('lease lost')
    expect(await f.db.select().from(nodeRunEvents)).toHaveLength(7)
    expect(await f.db.select().from(hostedNodeEventArchives)).toMatchObject([
      { state: 'prepared', objectId: null },
    ])
    expect(await f.publications()).toMatchObject([{ state: 'pending', scope: 'task' }])
    f.acquire()
    const archive = f.reopen()
    expect((await archive.recover()).archived).toBe(4)
    expect((await archive.recover()).archived).toBe(0)
    expect(f.objects.stored.size).toBe(1)
    expect(f.objects.pins).toHaveLength(1)
    expect(await f.publications()).toMatchObject([{ state: 'ready', sourceSealed: null }])
    expect(await f.db.select().from(nodeRunEvents)).toHaveLength(3)
    expect(await archive.read('task', 'run', 0, 2)).toEqual(f.all.slice(0, 2))
    expect(await archive.read('task', 'run', f.all[1]!.id, 100)).toEqual(f.all.slice(2, 4))
    expect(await archive.read('different-task', 'run', 0, 100)).toEqual([])
    expect((await archive.read('task', 'run', 0, 100))[3]).toMatchObject({
      sessionId: 'child-session',
      parentSessionId: 'root-session',
    })
    const page = await nodeRunEventsProjection(
      { db: f.db, archivedEvents: archive },
      'task',
      'run',
      { limit: 100 },
    )
    expect(page.events.map((event) => event.id)).toEqual(f.all.map((event) => event.id))
    expect(
      await nodeRunStdoutProjection({ db: f.db, archivedEvents: archive }, 'task', 'run'),
    ).toBe(f.all.map((event) => event.payload).join('\n'))
    expect(await archive.files('task')).toHaveLength(1)
    f.objects.tamper('body')
    await expect(archive.read('task', 'run', 0, 1)).rejects.toThrow()
  })

  test('wrong owner, altered source and a pending overlapping range cannot delete events', async () => {
    const f = await setup(),
      archive = f.reopen()
    await expect(
      archive.archive({ taskId: 'other', nodeRunId: 'run', rows: f.all }),
    ).rejects.toThrow('owner-mismatch')
    await expect(
      archive.archive({
        taskId: 'task',
        nodeRunId: 'run',
        rows: [{ ...f.all[0]!, payload: 'forged' }],
      }),
    ).rejects.toThrow('source-changed')
    f.loseNextUpload()
    await expect(
      archive.archive({ taskId: 'task', nodeRunId: 'run', rows: f.all.slice(0, 4) }),
    ).rejects.toThrow('lease lost')
    f.acquire()
    await expect(
      f.reopen().archive({ taskId: 'task', nodeRunId: 'run', rows: f.all.slice(0, 2) }),
    ).rejects.toThrow('pending-range')
    await expect(f.reopen().files('task')).rejects.toThrow('pending')
    expect(await f.db.select().from(nodeRunEvents)).toHaveLength(7)
    await f.reopen().recover()
    expect(await f.db.select().from(nodeRunEvents).orderBy(asc(nodeRunEvents.id))).toMatchObject(
      f.all.slice(4).map((event) => ({ id: event.id })),
    )
  })

  test('the original bounded archive algorithm selects object content; the task sweep releases it after deletion', async () => {
    const f = await setup(),
      archive = f.reopen()
    const result = await archiveEventsWithStore(
      createEventsArchiveStore(f.db),
      {
        eventsArchiveThresholds: { perNodeRunRows: 2, globalRows: 100 },
      },
      '/must-not-create-service-local-files',
      { content: archive, rowBudgetRows: 4 },
    )
    expect(result.perGroupArchived).toBe(4)
    expect(result.files[0]).toStartWith('aw-event-archive:')
    expect(await archive.read('task', 'run', 0, 100)).toEqual(f.all.slice(0, 4))
    // The chunk stays readable until the task's references are reconciled.
    await f.db.delete(tasks).where(eq(tasks.id, 'task'))
    expect(await f.reopen().read('task', 'run', 0, 100)).toEqual(f.all.slice(0, 4))
    expect(await f.sweep()).toBe(1)
    expect(await f.db.select().from(hostedNodeEventArchives)).toEqual([])
    expect(await f.publications()).toMatchObject([{ state: 'releasing' }])
    expect(await f.settle()).toMatchObject({ released: 1 })
    expect(f.objects.releases).toHaveLength(1)
  })

  test('deleting a task after a lost upload reply releases its orphaned pin through the sweep', async () => {
    const f = await setup()
    f.loseNextUpload()
    await expect(
      f.reopen().archive({ taskId: 'task', nodeRunId: 'run', rows: f.all }),
    ).rejects.toThrow('lease lost')
    await f.db.delete(tasks).where(eq(tasks.id, 'task'))
    f.acquire()
    // A prepared chunk of a deleted run no longer blocks recovery of live runs.
    expect((await f.reopen().recover()).archived).toBe(0)
    expect(await f.sweep()).toBe(1)
    expect(await f.db.select().from(hostedNodeEventArchives)).toEqual([])
    expect(await f.settle()).toMatchObject({ released: 1 })
    expect(f.objects.pins).toHaveLength(1)
    expect(f.objects.releases).toEqual(f.objects.pins)
  })
})
