// RFC-363: lock the irreversible Task admission boundary independently of adapters.
import { expect, test } from 'bun:test'
import { launchTask } from '@/modules/task-execution/application/launch/launchTask'
import { ValidationError } from '@/util/errors'

function fixture(failAt?: string, failedWorkspace = false) {
  const trace: string[] = []
  const failure = new ValidationError('fixture-launch-error', 'launch failed')
  const step = (name: string) => {
    trace.push(name)
    if (failAt === name) throw failure
  }
  const workspace = { taskId: 'task', commit: () => step('commit') }
  const ports = {
    preflight: async () => {
      step('preflight')
      return { taskId: 'task' }
    },
    prepare: async () => {
      step('prepare')
      return workspace
    },
    initialInputs: () => ({ upload: '' }),
    applyUploads: async (
      _: { taskId: string },
      __: typeof workspace,
      inputs: { upload: string },
    ) => {
      step('upload')
      inputs.upload = 'landed.txt'
    },
    admit: async (_: { taskId: string }, __: typeof workspace, inputs: { upload: string }) => {
      step('admit')
      expect(inputs.upload).toBe('landed.txt')
      return { taskId: 'task', failed: failedWorkspace, projection: { id: 'task' } }
    },
    rollback: async () => {
      step('rollback')
      return { complete: true }
    },
    uploadFailure: (error: unknown, report: { complete: boolean }) => {
      expect(report.complete).toBe(true)
      step('uploadFailure')
      return error
    },
    publish: async () => {
      step('publish')
    },
    submit: async () => {
      step('submit')
    },
    guard: {
      taskCommitted: async () => {
        step('taskCommitted')
      },
      launchSettled: async () => {
        step('settled')
      },
      failed: async (code: string) => {
        trace.push(`failed:${code}`)
        throw new Error('receipt unavailable')
      },
      release: () => step('release'),
    },
  }
  return { ports, trace, failure, workspace }
}

test('admission follows uploads; committed events precede dispatch; failed workspace never dispatches', async () => {
  for (const failed of [false, true]) {
    const f = fixture(undefined, failed)
    expect(await launchTask(f.ports)).toEqual({ id: 'task' })
    expect(f.trace).toEqual([
      'preflight',
      'prepare',
      'upload',
      'admit',
      'taskCommitted',
      'commit',
      'publish',
      ...(failed ? [] : ['submit']),
      'settled',
      'release',
    ])
  }
})
test('pre-admission failures compensate once and preserve the original error when guard receipts fail', async () => {
  for (const point of ['preflight', 'prepare', 'upload', 'admit']) {
    const f = fixture(point)
    await expect(launchTask(f.ports)).rejects.toBe(f.failure)
    expect(f.trace.filter((x) => x === 'rollback')).toHaveLength(
      ['upload', 'admit'].includes(point) ? 1 : 0,
    )
    expect(f.trace).not.toContain('commit')
    expect(f.trace.slice(-2)).toEqual(['failed:fixture-launch-error', 'release'])
    expect(f.trace.includes('uploadFailure')).toBe(point === 'upload')
  }
})
test('post-admission failures cannot compensate a committed Task workspace', async () => {
  for (const point of ['taskCommitted', 'commit', 'publish', 'submit', 'settled']) {
    const f = fixture(point)
    await expect(launchTask(f.ports)).rejects.toBe(f.failure)
    expect(f.trace).not.toContain('rollback')
    expect(f.trace.slice(-2)).toEqual(['failed:fixture-launch-error', 'release'])
  }
})
test('a mismatched preparation is compensated before uploads or admission', async () => {
  const f = fixture()
  f.workspace.taskId = 'another-task'
  await expect(launchTask(f.ports)).rejects.toThrow('task-route-workspace-id-mismatch')
  expect(f.trace).toEqual(['preflight', 'prepare', 'rollback', 'failed:launch-failed', 'release'])
})
