// RFC-320 — Git identity is account-owned. Public launch schemas reject both
// legacy keys and successful parses never materialize them.

import { describe, expect, test } from 'bun:test'
import {
  rejectRetiredStartTaskKeys,
  StartAgentTaskSchema,
  StartTaskSchema,
} from '../src/schemas/task'
import { StartWorkgroupTaskSchema } from '../src/schemas/workgroup'

const WORKFLOW = {
  workflowId: 'wf-1',
  name: 'fixture-task',
  repoUrl: 'https://github.com/o/repo.git',
  inputs: {},
}

describe('RFC-320 public launch schemas', () => {
  test('ordinary workflow body parses without identity keys', () => {
    const parsed = StartTaskSchema.safeParse(WORKFLOW)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect('gitUserName' in parsed.data).toBe(false)
      expect('gitUserEmail' in parsed.data).toBe(false)
    }
  })

  for (const [key, value] of [
    ['gitUserName', 'Forged User'],
    ['gitUserEmail', 'forged@example.test'],
  ] as const) {
    test(`workflow schema rejects retired ${key}`, () => {
      const parsed = StartTaskSchema.safeParse({ ...WORKFLOW, [key]: value })
      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) => issue.message === 'task-git-identity-client-owned'),
        ).toBe(true)
      }
      expect(rejectRetiredStartTaskKeys({ ...WORKFLOW, [key]: value })).toBe(key)
    })
  }

  test('agent and workgroup kind-specific schemas reject the same keys', () => {
    const agent = StartAgentTaskSchema.safeParse({
      name: 'agent task',
      description: 'do it',
      scratch: true,
      gitUserName: 'Forged User',
    })
    const workgroup = StartWorkgroupTaskSchema.safeParse({
      name: 'group task',
      goal: 'do it',
      scratch: true,
      gitUserEmail: 'forged@example.test',
    })
    expect(agent.success).toBe(false)
    expect(workgroup.success).toBe(false)
  })
})
