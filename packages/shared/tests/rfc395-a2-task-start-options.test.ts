// RFC-395 II-a A2: internal launches omit catalog identity while the HTTP StartTask contract stays intact.
import { expect, test } from 'bun:test'
import { StartTaskSchema, TaskStartOptionsSchema } from '../src/schemas/task'

test('only the HTTP schema requires a workflowId and both retain launch validation and defaults', () => {
  const options = { name: 'Subject launch', scratch: true }
  expect(StartTaskSchema.safeParse(options).success).toBe(false)
  expect(StartTaskSchema.safeParse({ ...options, workflowId: '' }).success).toBe(false)
  const internal = TaskStartOptionsSchema.parse(options)
  expect(internal).not.toHaveProperty('workflowId')
  expect(StartTaskSchema.parse({ ...options, workflowId: 'authored' })).toEqual({
    ...internal,
    workflowId: 'authored',
  })
  for (const bad of [
    { ...options, repoGroupId: 'group' },
    { ...options, sourceTaskId: 'task' },
    { ...options, maxDurationMs: -1 },
  ]) {
    expect(TaskStartOptionsSchema.safeParse(bad).success).toBe(false)
    expect(StartTaskSchema.safeParse({ ...bad, workflowId: 'authored' }).success).toBe(false)
  }
})
