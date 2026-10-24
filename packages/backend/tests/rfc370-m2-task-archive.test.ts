import { o2Ports } from './helpers/o2Closure'
// RFC-370 v3 V6: the hosted task archive index (`hosted_task_archive_entries`)
// lists object parts that are `task-archive` publications of the neutral
// journal; object-backed sources are linked, never copied, and no archived byte
// is stored in the database.
import { nodeRunFixture, readTaskFixtures, taskFixture, workflowFixture } from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { createHostedObjectPublications } from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import type { HostedStoredObject } from '@/platform/crewstation/objectStorage'
import {
  createHostedTaskArchiveContent,
  type HostedArchiveSources,
} from '@/modules/task-execution/infrastructure/crewstation/taskArchiveContent'
import { createDrizzleTaskArchiveMaintenanceCommand } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import { executeTaskImageArchive } from '@/modules/task-execution/composition/taskImageArchive'
import { retainWorkVolumeWriter } from '@/platform/crewstation/workVolumeWriters'
import { objectFixture } from './helpers/rfc370Objects'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-370 durable task archive', (harness) => {
  const setup = async () => {
    const db = harness.db
    const f = objectFixture()
    let held = true
    const fence = {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      async assertHeld() {
        if (!held) throw new Error('lost archive fence')
      },
    }
    const journal = createHostedObjectPublications({ db, fence, objects: f.objects })
    const linked = new Map<string, HostedStoredObject>()
    const sources: HostedArchiveSources = {
      exists: async (kind) => kind === 'runs',
      async snapshot(_kind, taskId) {
        const bytes = Buffer.from(`task file ${taskId}`)
        const object = linked.get(taskId)
        return [
          {
            path: 'node/prompt.md',
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            ...(object === undefined ? {} : { object }),
            open: () => new Blob([bytes]).stream(),
          },
        ]
      },
    }
    // The parent's own volume; the child works in it and has none of its own.
    const abandoned: string[] = []
    const workspaces = {
      find: async (taskId: string) => (taskId === 'parent' ? { taskId } : null),
      abandon: async (taskId: string) => {
        abandoned.push(taskId)
      },
    }
    const reopen = () =>
      createHostedTaskArchiveContent({
        db,
        objects: f.objects,
        fence,
        sources,
        publications: journal.publications,
        workspaces,
      })
    const { nodeExecutionEventSources } = tablesOf(db)
    await workflowFixture(db, { id: 'wf', name: 'archive', definition: '{}' })
    for (const [id, parentTaskId] of [
      ['parent', null],
      ['child', 'parent'],
    ] as const)
      await taskFixture(db, {
        id,
        name: id,
        workflowId: 'wf',
        workflowSnapshot: '{}',
        repoPath: 'unused',
        worktreePath: 'unused',
        baseBranch: 'main',
        branch: id,
        status: 'done',
        inputs: '{}',
        startedAt: 1,
        finishedAt: 2,
        parentTaskId,
      })
    await nodeRunFixture(db, {
      id: 'run',
      taskId: 'parent',
      nodeId: 'node',
      status: 'done',
      startedAt: 1,
      finishedAt: 2,
    })
    await insertOne(db, nodeExecutionEventSources, { sourceKey: 'cs:event:1', nodeRunId: 'run' })
    return {
      db,
      f,
      reopen,
      journal,
      abandoned,
      /** Makes a task's source an existing immutable object (a task artifact). */
      async link(taskId: string) {
        const [object] = await journal.publications.publish([
          {
            owner: 'task-artifact',
            key: `runs/${taskId}/node/prompt.md`,
            scope: taskId,
            bytes: Buffer.from(`task file ${taskId}`),
          },
        ])
        linked.set(taskId, object!)
        return object!
      },
      loseFence: () => {
        held = false
      },
    }
  }

  test('whole tree, JSONL chunks and file objects survive removal of live task rows and a cold receiver', async () => {
    const f = await setup()
    for (let offset = 0; offset < 2001; offset += 500) {
      const { nodeRunEvents } = tablesOf(f.db)
      await f.db.insert(nodeRunEvents).values(
        Array.from({ length: Math.min(500, 2001 - offset) }, (_, index) => ({
          nodeRunId: 'run',
          ts: offset + index,
          kind: 'text' as const,
          payload: `event ${offset + index}`,
        })),
      )
    }
    const binding = f.reopen()
    const command = createDrizzleTaskArchiveMaintenanceCommand(
      f.db,
      o2Ports(f.db).collaborationReads.archive,
      binding,
    )
    const result = await command.runSweep(
      { enabled: true, retentionDays: 1 },
      { ...binding.locations, now: 100 * 86400_000 },
    )
    expect(result.archived).toHaveLength(1)
    expect([...result.archived[0]!.taskIds].sort()).toEqual(['child', 'parent'])
    expect(await readTaskFixtures(f.db)).toHaveLength(0)
    const second = f.reopen()
    const root = 'cs-archive:tasks/parent'
    expect(JSON.parse(await second.readText(`${root}/manifest.json`)).rows.node_run_events).toBe(
      2001,
    )
    const events = (await second.readText(`${root}/db/node_run_events.jsonl`))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events).toHaveLength(2001)
    expect(new Set(events.map((event) => event.payload)).size).toBe(2001)
    expect(await second.readText(`${root}/runs/parent/node/prompt.md`)).toBe('task file parent')
    expect(await second.readText(`${root}/runs/child/node/prompt.md`)).toBe('task file child')
    expect(await second.readText(`${root}/db/node_execution_event_sources.jsonl`)).toContain(
      'cs:event:1',
    )
    // 2026-10-19 hosted acceptance (user decision): archiving releases each
    // archived task's own volume; before, the volume stayed counted against the
    // project's PVC quota with no task left to close it.
    expect(f.abandoned).toEqual(['parent'])
    f.f.tamper('body')
    await expect(second.readText(`${root}/manifest.json`)).rejects.toThrow('content-mismatch')
  })

  test('lost publication reply keeps online rows until cold recovery sees the complete archive', async () => {
    const f = await setup()
    const first = f.reopen()
    let lost = false
    const command = createDrizzleTaskArchiveMaintenanceCommand(
      f.db,
      o2Ports(f.db).collaborationReads.archive,
      {
        ...first,
        content: {
          ...first.content,
          async move(from, to) {
            await first.content.move(from, to)
            if (to === 'cs-archive:tasks/parent' && !lost) {
              lost = true
              throw new Error('archive publication reply lost')
            }
          },
        },
      },
    )
    await command.runSweep(
      { enabled: true, retentionDays: 1 },
      { ...first.locations, now: 100 * 86400_000 },
    )
    expect(lost).toBe(true)
    expect(await readTaskFixtures(f.db)).toHaveLength(2)
    const second = f.reopen()
    const recovery = createDrizzleTaskArchiveMaintenanceCommand(
      f.db,
      o2Ports(f.db).collaborationReads.archive,
      second,
    )
    await recovery.recover({ ...second.locations, now: 101 * 86400_000 })
    expect(await readTaskFixtures(f.db)).toHaveLength(0)
    expect(await second.readText('cs-archive:tasks/parent/runs/child/node/prompt.md')).toBe(
      'task file child',
    )
  })

  test('object-backed sources are linked without copying; removing a temporary tree releases only its links', async () => {
    const f = await setup()
    const object = await f.link('parent')
    const stored = f.f.stored.size
    const binding = f.reopen()
    await binding.content.move('cs-archive:runs/parent', 'cs-archive:tasks/.tmp-parent/runs/parent')
    expect(f.f.stored.size).toBe(stored)
    expect(f.f.activeReferences(object.id)).toBe(2)
    expect(await binding.readText('cs-archive:tasks/.tmp-parent/runs/parent/node/prompt.md')).toBe(
      'task file parent',
    )
    expect(await binding.content.list('cs-archive:tasks/.tmp-parent/runs')).toEqual(['parent'])
    await binding.content.remove('cs-archive:tasks/.tmp-parent', true)
    const { hostedObjectPublications } = tablesOf(f.db)
    const states = (
      await f.db
        .select()
        .from(hostedObjectPublications)
        .where(eq(hostedObjectPublications.objectId, object.id))
    )
      .map((row) => `${row.owner}:${row.state}`)
      .sort()
    expect(states).toEqual(['task-archive:releasing', 'task-artifact:ready'])
    expect(await binding.content.exists('cs-archive:tasks/.tmp-parent')).toBe(false)
  })

  test('fence loss or incomplete manifest cannot publish or delete a task', async () => {
    const f = await setup()
    const binding = f.reopen()
    await binding.content.createDirectory('cs-archive:tasks/.tmp-parent/db')
    await expect(
      binding.content.move('cs-archive:tasks/.tmp-parent', 'cs-archive:tasks/parent'),
    ).rejects.toThrow('manifest-missing')
    f.loseFence()
    await expect(
      binding.content.appendText('cs-archive:tasks/.tmp-parent/db/tasks.jsonl', '{}\n'),
    ).rejects.toThrow('lost archive fence')
    expect(await readTaskFixtures(f.db, { id: 'parent' })).toHaveLength(1)
    expect(await binding.content.exists('cs-archive:tasks/parent')).toBe(false)
    expect(() => binding.content.resolve('cs-archive:tasks', '..', 'escape')).toThrow(
      'reference-invalid',
    )
  })
})

test('task-image archive refuses live writers and links, and hashes exact retained bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rfc370-archive-'))
  try {
    mkdirSync(join(root, 'runs', 'task', 'node'), { recursive: true })
    writeFileSync(join(root, 'runs', 'task', 'node', 'prompt.md'), 'retained')
    const writer = retainWorkVolumeWriter(root, 'writer', join(root, 'repo'))
    await expect(executeTaskImageArchive({ kind: 'runs', taskId: 'task' }, root)).rejects.toThrow(
      'writer-not-settled',
    )
    writer.release()
    expect((await executeTaskImageArchive({ kind: 'runs', taskId: 'task' }, root)).files).toEqual([
      {
        path: 'node/prompt.md',
        size: 8,
        sha256: createHash('sha256').update('retained').digest('hex'),
      },
    ])
    if (process.platform !== 'win32') {
      symlinkSync(
        join(root, 'runs', 'task', 'node', 'prompt.md'),
        join(root, 'runs', 'task', 'link'),
      )
      await expect(executeTaskImageArchive({ kind: 'runs', taskId: 'task' }, root)).rejects.toThrow(
        'special-file-refused',
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
