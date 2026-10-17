// RFC-370 v3 V6 — original task input uploads are `task-artifact`
// publications (files and their manifest, scope = task id) whose
// hosted_task_artifacts rows commit in each ready transaction. A retried
// request reuses its objects; a changed request is refused. Coverage moved here
// from the deleted recovery-input test (its recovery machinery was removed).
import { expect, test } from 'bun:test'
import { hostedObjectPublications, hostedTaskArtifacts } from '@/db/schema'
import { createHostedObjectPublications } from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import { createHostedTaskInputFiles } from '@/modules/task-execution/infrastructure/crewstation/taskInputFiles'
import { describeEachProvider } from './helpers/eachProvider'
import { objectFixture } from './helpers/rfc370Objects'

describeEachProvider('RFC-370 hosted task input files', (harness) => {
  const setup = () => {
    const f = objectFixture()
    const journal = createHostedObjectPublications({
      db: harness.db,
      fence: {
        current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
        assertHeld: async () => undefined,
      },
      objects: f.objects,
    })
    return {
      f,
      inputs: createHostedTaskInputFiles({
        db: harness.db,
        objects: f.objects,
        publications: journal.publications,
      }),
    }
  }
  const request = (requestDigest = 'a'.repeat(64)) => ({
    taskId: 'task-1',
    requestDigest,
    limits: { perFile: 100, perRequest: 200, perCount: 4 },
    files: [
      {
        inputKey: 'doc',
        filename: 'spec.md',
        declaredMime: 'text/markdown',
        bytes: Buffer.from('# spec'),
      },
      {
        inputKey: 'data',
        filename: 'data.bin',
        declaredMime: '',
        bytes: new Uint8Array([0, 1, 2]),
      },
    ],
  })

  test('retained inputs read back byte for byte and every object has its task reference', async () => {
    const { f, inputs } = setup()
    await inputs.retain(request())
    const read = await inputs.read('task-1')
    expect(read).toMatchObject({ requestDigest: 'a'.repeat(64), limits: request().limits })
    expect(read!.files.map((file) => Buffer.from(file.bytes).toString('hex'))).toEqual([
      Buffer.from('# spec').toString('hex'),
      '000102',
    ])
    expect(
      (await harness.db.select().from(hostedTaskArtifacts)).map((row) => row.reference).sort(),
    ).toEqual([
      'runs/task-1/inputs/files/0',
      'runs/task-1/inputs/files/1',
      'runs/task-1/inputs/manifest.json',
    ])
    const publications = await harness.db.select().from(hostedObjectPublications)
    expect(publications).toHaveLength(3)
    expect(publications.every((row) => row.state === 'ready' && row.scope === 'task-1')).toBe(true)
    expect(f.pins).toHaveLength(3)
    expect(await inputs.read('other-task')).toBeNull()
  })

  test('a retried request reuses its objects; a different request for the same task is refused', async () => {
    const { f, inputs } = setup()
    await inputs.retain(request())
    await inputs.retain(request())
    expect(f.pins).toHaveLength(3)
    await expect(inputs.retain(request('b'.repeat(64)))).rejects.toThrow(
      'hosted-input-request-changed',
    )
    await expect(inputs.retain({ ...request(), taskId: '../escape' })).rejects.toThrow(
      'hosted-input-task-invalid',
    )
  })
})
