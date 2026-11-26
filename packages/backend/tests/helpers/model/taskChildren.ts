// Minimal target-model facts for child-navigation projections. Unlike taskFixture,
// these rows deliberately have no launch/workspace/runtime aggregate: the query
// must work from core facts alone, even when a definition has an unknown subject.
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { fixtureRows, fixtureTransaction, type FixtureHandle } from './core'
import type { TaskFixtureSpec } from './task.spec'

type TaskDefinitionFixtureRow = PersistenceTables['taskDefinitions']['$inferInsert']

export type TaskChildrenFixtureSpec = Pick<
  TaskFixtureSpec,
  'id' | 'name' | 'status' | 'startedAt' | 'parentTaskId' | 'catalogVisibility'
> & { subjectKind?: TaskDefinitionFixtureRow['subjectKind'] }

export async function taskChildrenFixture(
  db: FixtureHandle,
  input: TaskChildrenFixtureSpec | readonly TaskChildrenFixtureSpec[],
): Promise<void> {
  const specs = fixtureRows(input)
  await fixtureTransaction(db, async (tx) => {
    const { tasks, taskDefinitions } = tablesOf(tx)
    // Keep setup bounded on both providers; setup statements are not part of the
    // recorded read budget. Complete runtime fixtures still use taskFixture.
    for (let offset = 0; offset < specs.length; offset += 100) {
      const batch = specs.slice(offset, offset + 100)
      await tx.insert(tasks).values(
        batch.map((spec) => ({
          id: spec.id,
          name: spec.name ?? spec.id,
          status: spec.status,
          startedAt: spec.startedAt,
          parentTaskId: spec.parentTaskId,
          catalogVisibility: spec.catalogVisibility ?? 'public',
        })),
      )
      const definitions = batch.flatMap<TaskDefinitionFixtureRow>((spec) =>
        spec.subjectKind === undefined
          ? []
          : [
              {
                taskId: spec.id,
                subjectKind: spec.subjectKind,
                definitionOrigin: 'authored',
                engineKind: spec.subjectKind === 'workgroup' ? 'workgroup-turns' : 'dag',
                workflowSnapshot: '{}',
                inputs: '{}',
              },
            ],
      )
      if (definitions.length) await tx.insert(taskDefinitions).values(definitions)
    }
  })
}
