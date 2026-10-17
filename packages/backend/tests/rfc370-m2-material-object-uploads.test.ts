// RFC-370 v3 V6: binary skill files of a hosted Agent material are
// `agent-material` publications of the neutral journal (one per distinct body
// and execution, scope = task). The AW pin is temporary: once CS acknowledges
// the material version, the execution's publications are released. Replaces
// the deleted per-owner `hosted_material_object_uploads` journal.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { hostedObjectPublications } from '@/db/schema'
import { createHostedObjectPublications } from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import {
  createHostedMaterialObjectUploads,
  HOSTED_MATERIAL_OWNER,
} from '@/modules/task-execution/infrastructure/crewstation/materialObjectUploads'
import { describeEachProvider } from './helpers/eachProvider'
import { objectFixture } from './helpers/rfc370Objects'

describeEachProvider('RFC-370 hosted skill material objects', (harness) => {
  const fixture = () => {
    const f = objectFixture()
    let parent = 'running'
    const journal = createHostedObjectPublications({
      db: harness.db,
      fence: {
        current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
        assertHeld: async () => undefined,
      },
      objects: f.objects,
    })
    const material = createHostedMaterialObjectUploads({
      api: {
        getTask: async (id) => ({ id, state: parent, generation: 1 }) as never,
      },
      publications: journal.publications,
    })
    const request = (executionId: string, bytes = new Uint8Array([0, 255, 128, 13, 10])) => ({
      executionId,
      taskId: 'task-1',
      businessTaskId: 'parent',
      files: [
        { path: 'skill/data.bin', bytes, mode: 0o755 },
        { path: 'skill/copy.bin', bytes },
        { path: 'skill/SKILL.md', content: '# skill' },
      ],
    })
    return {
      f,
      material,
      request,
      parent: (state: string) => {
        parent = state
      },
      rows: () =>
        harness.db
          .select()
          .from(hostedObjectPublications)
          .where(eq(hostedObjectPublications.owner, HOSTED_MATERIAL_OWNER)),
    }
  }

  test('each distinct body of an execution is one publication and text files pass through', async () => {
    const f = fixture()
    const staged = await f.material.files.stage(f.request('agent:task-1:node-1'))
    expect(staged[0]).toMatchObject({ path: 'skill/data.bin', mode: 0o755, object: { size: 5 } })
    expect(staged[1]).toMatchObject({ path: 'skill/copy.bin', object: staged[0]!.object })
    expect(staged[2]).toEqual({ path: 'skill/SKILL.md', content: '# skill' })
    expect(await f.f.objects.read(staged[0]!.object!.objectId)).toEqual(
      new Uint8Array([0, 255, 128, 13, 10]),
    )
    expect(await f.rows()).toMatchObject([{ state: 'ready', scope: 'task-1' }])
    expect(f.f.pins).toHaveLength(1)
    // Re-staging the same execution reuses the same publication.
    await f.material.files.stage(f.request('agent:task-1:node-1'))
    expect(f.f.pins).toHaveLength(1)
  })

  test('changed skill bytes for the same execution land on a new key instead of conflicting', async () => {
    const f = fixture()
    await f.material.files.stage(f.request('agent:task-1:node-1'))
    await f.material.files.stage(f.request('agent:task-1:node-1', new Uint8Array([9, 9, 9])))
    expect((await f.rows()).map((row) => row.state)).toEqual(['ready', 'ready'])
  })

  test('the acknowledged material version releases only its own execution', async () => {
    const f = fixture()
    await f.material.files.stage(f.request('agent:task-1:node-1'))
    await f.material.files.stage(f.request('agent:task-1:node-2', new Uint8Array([7])))
    await f.material.files.published('agent:task-1:node-1', 'material-1')
    const states = (await f.rows()).map((row) => row.state).sort()
    expect(states).toEqual(['ready', 'releasing'])
    // Physical unpin happens in maintenance, never on the dispatch path.
    expect(f.f.releases).toEqual([])
  })

  test('a parent that is not running and malformed files are refused before any upload', async () => {
    const f = fixture()
    f.parent('paused')
    await expect(f.material.files.stage(f.request('agent:task-1:node-1'))).rejects.toThrow(
      'hosted-material-parent-not-running',
    )
    f.parent('running')
    for (const file of [
      { path: '../escape', bytes: new Uint8Array([1]) },
      { path: 'skill/.crewstation/x', bytes: new Uint8Array([1]) },
      { path: 'skill/x', bytes: new Uint8Array([1]), mode: 0o1777 },
    ])
      await expect(
        f.material.files.stage({ ...f.request('agent:task-1:node-1'), files: [file] }),
      ).rejects.toThrow(/hosted-material-file-(path|mode)-invalid/)
    expect(f.f.pins).toEqual([])
    expect(await f.rows()).toEqual([])
  })
})
