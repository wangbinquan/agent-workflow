// RFC-232 — list-only owner DTOs are strict so role/status/email cannot leak
// through a permissive parse, while the existing TaskSummary/ScheduledTask
// contracts remain unchanged.

import { describe, expect, test } from 'bun:test'

import { OwnerIdentitySchema, ScheduledTaskListItemSchema, TaskListItemSchema } from '../src'

const owner = {
  id: 'user-1',
  username: 'alice',
  displayName: 'Alice',
}

const taskItem = {
  id: 'task-1',
  name: 'Task',
  workflowId: 'workflow-1',
  workflowName: 'Workflow',
  repoPath: '/tmp/repo',
  repoUrl: null,
  cachedRepoId: null,
  status: 'done',
  startedAt: 1,
  finishedAt: 2,
  errorSummary: null,
  repoCount: 1,
  spaceKind: 'remote',
  ownerUserId: owner.id,
  owner,
}

const scheduledItem = {
  id: 'scheduled-1',
  name: 'Nightly',
  ownerUserId: owner.id,
  owner,
  launchKind: 'workflow',
  launchPayload: null,
  scheduleSpec: null,
  migrationNeeded: false,
  migrationError: null,
  launchPayloadWorkflowId: null,
  enabled: false,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastTaskId: null,
  consecutiveFailures: 0,
  createdAt: 1,
  updatedAt: 1,
}

describe('RFC-232 owner list schemas', () => {
  test('accepts complete task and scheduled list items', () => {
    expect(TaskListItemSchema.safeParse(taskItem).success).toBe(true)
    expect(ScheduledTaskListItemSchema.safeParse(scheduledItem).success).toBe(true)
  })

  test('requires list-only owner fields', () => {
    const { owner: _taskOwner, ...taskMissingOwner } = taskItem
    const { owner: _scheduledOwner, ...scheduledMissingOwner } = scheduledItem
    expect(TaskListItemSchema.safeParse(taskMissingOwner).success).toBe(false)
    expect(ScheduledTaskListItemSchema.safeParse(scheduledMissingOwner).success).toBe(false)
  })

  test('strictly rejects extra identity and top-level fields', () => {
    expect(OwnerIdentitySchema.safeParse({ ...owner, role: 'admin' }).success).toBe(false)
    expect(
      TaskListItemSchema.safeParse({
        ...taskItem,
        owner: { ...owner, status: 'active' },
      }).success,
    ).toBe(false)
    expect(
      ScheduledTaskListItemSchema.safeParse({ ...scheduledItem, email: 'alice@example.com' })
        .success,
    ).toBe(false)
  })
})
