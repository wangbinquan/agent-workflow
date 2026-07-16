import { describe, expect, test } from 'vitest'
import type {
  Agent,
  Plugin,
  Skill,
  WorkflowSnapshotHash,
  WorkflowValidationReceipt,
} from '@agent-workflow/shared'
import {
  workflowValidationInventorySignature,
  workflowValidationStaleReason,
} from '@/routes/workflows.edit'

const HASH_A = 'a'.repeat(64) as WorkflowSnapshotHash

function receipt(): WorkflowValidationReceipt {
  return {
    revision: {
      workflowId: 'wf-1',
      version: 3,
      snapshotHash: HASH_A,
      updatedAt: 300,
    },
    validationContextHash: 'c'.repeat(64),
    validatedAt: 1_000,
    ok: true,
    issues: [],
  }
}

describe('workflow validation result binding', () => {
  test('inventory observation is order-stable, secret-free, and changes on semantic revisions', () => {
    const agents = [
      { id: 'a2', name: 'two', updatedAt: 2, bodyMd: 'SECRET TWO' },
      { id: 'a1', name: 'one', updatedAt: 1, bodyMd: 'SECRET ONE' },
    ] as unknown as Agent[]
    const skills = [
      { id: 's1', name: 'skill', contentVersion: 4, updatedAt: 5, managedPath: '/secret' },
    ] as unknown as Skill[]
    const plugins = [
      {
        id: 'p1',
        name: 'plugin',
        enabled: true,
        resolvedVersion: '1.0.0',
        updatedAt: 6,
        options: { token: 'SECRET' },
      },
    ] as unknown as Plugin[]

    const first = workflowValidationInventorySignature(agents, skills, plugins)
    const reordered = workflowValidationInventorySignature([...agents].reverse(), skills, plugins)
    expect(reordered).toBe(first)
    expect(first).not.toContain('SECRET')
    expect(first).not.toContain('/secret')

    const changed = workflowValidationInventorySignature(
      [{ ...agents[0]!, updatedAt: 7 }, agents[1]!],
      skills,
      plugins,
    )
    expect(changed).not.toBe(first)
  })

  test('local/server drift wins over inventory drift; unchanged binding stays current', () => {
    const binding = { localRevision: 8, inventorySignature: 'inventory-a', receipt: receipt() }
    const current = {
      localRevision: 8,
      workflowVersion: 3,
      snapshotHash: HASH_A,
      inventorySignature: 'inventory-a',
    }
    expect(workflowValidationStaleReason(binding, current)).toBeNull()
    expect(
      workflowValidationStaleReason(binding, { ...current, inventorySignature: 'inventory-b' }),
    ).toBe('inventory')
    expect(
      workflowValidationStaleReason(binding, {
        ...current,
        localRevision: 9,
        inventorySignature: 'inventory-b',
      }),
    ).toBe('draft')
  })
})
