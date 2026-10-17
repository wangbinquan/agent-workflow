// RFC-370 v3 V6 — Task Execution's hosted object sweep. Task deletion and
// archival remove task rows by cascade; this owner sweep (run by the single
// hosted object job) releases every task-scoped publication of a task whose
// row and launch preparation are both gone, and drops the task's own
// `hosted_task_artifacts` rows. It replaces the old "material GC inside task
// archive" and "event archive retire inside events archive" side effects.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  hostedObjectPublications,
  hostedTaskArtifacts,
  taskWorkspacePreparations,
} from '@/db/schema'
import { createHostedObjectPublications } from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import { createHostedTaskObjectSweep } from '@/modules/task-execution/infrastructure/crewstation/hostedObjectSweep'
import { retainHostedTaskArtifactInTx } from '@/modules/task-execution/infrastructure/crewstation/taskArtifacts'
import { describeEachProvider } from './helpers/eachProvider'
import { objectFixture } from './helpers/rfc370Objects'
import { seedTask } from './helpers/questionDispatchFixture'

describeEachProvider('RFC-370 hosted task object sweep', (harness) => {
  const setup = () => {
    const f = objectFixture()
    const fence = {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      assertHeld: async () => undefined,
    }
    const journal = createHostedObjectPublications({ db: harness.db, fence, objects: f.objects })
    const artifact = (taskId: string, path: string) =>
      journal.publications.publish(
        [
          {
            owner: 'task-artifact',
            key: `runs/${taskId}/${path}`,
            scope: taskId,
            bytes: Buffer.from(`${taskId}:${path}`),
          },
        ],
        {
          commit: (tx, [object]) =>
            retainHostedTaskArtifactInTx(tx, {
              reference: `runs/${taskId}/${path}`,
              taskId,
              object: object!,
            }),
        },
      )
    const states = async (owner: string) =>
      new Map(
        (
          await harness.db
            .select()
            .from(hostedObjectPublications)
            .where(eq(hostedObjectPublications.owner, owner))
        ).map((row) => [row.scope, row.state] as const),
      )
    return { journal, fence, artifact, states }
  }

  test('publications of deleted tasks are released and their artifact rows dropped; live and launching tasks keep theirs', async () => {
    const { journal, fence, artifact, states } = setup()
    await seedTask(harness.db, 'live-task')
    await harness.db.insert(taskWorkspacePreparations).values({
      id: 'launching-task',
      admissionKey: 'admission',
      requestDigest: 'd'.repeat(64),
      lane: 'pre-materialized',
      state: 'prepared',
      createdAt: 1,
      updatedAt: 1,
    })
    for (const taskId of ['live-task', 'deleted-task', 'launching-task'])
      await artifact(taskId, 'inputs/manifest.json')
    await journal.publications.publish([
      { owner: 'agent-material', key: 'e/1', scope: 'deleted-task', bytes: Buffer.from('m') },
      { owner: 'agent-material', key: 'e/2', scope: 'live-task', bytes: Buffer.from('n') },
    ])
    // Fresh publications are within the launch grace period.
    const graced = createHostedTaskObjectSweep({
      db: harness.db,
      fence,
      publications: journal.publications,
    })
    expect(await graced.sweep({ now: Date.now() })).toBe(0)
    const sweep = createHostedTaskObjectSweep({
      db: harness.db,
      fence,
      publications: journal.publications,
      graceMs: -1,
      pageSize: 1,
    })
    expect(await sweep.sweep({ now: Date.now() })).toBe(2)
    expect(await states('task-artifact')).toEqual(
      new Map([
        ['live-task', 'ready'],
        ['deleted-task', 'releasing'],
        ['launching-task', 'ready'],
      ]),
    )
    expect(await states('agent-material')).toEqual(
      new Map([
        ['deleted-task', 'releasing'],
        ['live-task', 'ready'],
      ]),
    )
    expect(
      (await harness.db.select().from(hostedTaskArtifacts)).map((row) => row.taskId).sort(),
    ).toEqual(['launching-task', 'live-task'])
    // Nothing left to reconcile on the next pass.
    expect(await sweep.sweep({ now: Date.now() })).toBe(0)
  })
})
