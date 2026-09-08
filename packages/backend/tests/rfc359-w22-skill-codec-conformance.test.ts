// RFC-359 AC1 / AC8: preserve the two existing Skill row projections while
// sharing their scalar mapping. The cb0403 originals below intentionally keep
// their different managedPath placement; JSON bytes and property reads matter.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { Skill } from '@agent-workflow/shared'

import { skills } from '@/db/schema'
import { createDatabaseAgentResourceInventoryReadPort } from '@/modules/resource-catalog/infrastructure/agentResourceInventory'
import { resetSkillBootVerifyForTest } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import {
  validateWorkflowDefinition,
  workflowValidationContextHashOf,
  type ValidatorContext,
} from '@/modules/resource-catalog/infrastructure/legacy/workflow.validator'
import {
  skillFromPersistenceRow,
  type SkillPersistenceRow,
} from '@/modules/resource-catalog/infrastructure/skillPersistence'
import { createSkillRepository } from '@/modules/resource-catalog/infrastructure/skillRepository'
import { createWorkflowValidationPort } from '@/modules/resource-catalog/infrastructure/workflowValidation'
import type { WorkflowValidationCandidate } from '@/modules/resource-catalog/application/workflows/ports'
import { describeEachProvider } from './helpers/eachProvider'

// Original skillPersistence.ts:38-54 at cb0403df4fc92e6b5b481548dd1baa2d7311c1ba.
function originalInlineProjection(row: SkillPersistenceRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    aclRevision: row.aclRevision,
    sourceKind: 'managed',
    ...(row.managedPath === null ? {} : { managedPath: row.managedPath }),
    schemaVersion: row.schemaVersion,
    contentVersion: row.contentVersion,
    metaRevision: row.metaRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// Original legacy/skill.ts:956-975 at the same SHA; comments alone are omitted.
function originalCatalogProjection(row: SkillPersistenceRow): Skill {
  const out: Skill = {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    aclRevision: row.aclRevision,
    sourceKind: 'managed',
    schemaVersion: row.schemaVersion,
    contentVersion: row.contentVersion,
    metaRevision: row.metaRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (row.managedPath !== null) out.managedPath = row.managedPath
  return out
}

const PATHS = [
  { label: 'NULL', managedPath: null },
  { label: 'empty string', managedPath: '' },
  { label: 'nonempty Unicode path', managedPath: 'skills/技能/files/' },
] as const

function skillRow(index: number, managedPath: string | null): SkillPersistenceRow {
  return {
    id: `skill-codec-${index}`,
    name: `codec-${index}`,
    description: '原描述\nsecond line',
    managedPath,
    ownerUserId: null,
    visibility: 'public',
    schemaVersion: 1,
    contentVersion: 3,
    aclRevision: 0,
    metaRevision: 7,
    reservationState: 'ready',
    versionState: 'legacy-unbackfilled',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_123,
  }
}

function assertProjection(actual: Skill, expected: Skill): void {
  expect(actual).toStrictEqual(expected)
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
  expect(Object.keys(actual)).toEqual(Object.keys(expected))
  expect(Object.getOwnPropertyDescriptors(actual)).toEqual(
    Object.getOwnPropertyDescriptors(expected),
  )
  expect(Object.hasOwn(actual, 'managedPath')).toBe(Object.hasOwn(expected, 'managedPath'))
}

function observeProjection(row: SkillPersistenceRow, project: (row: SkillPersistenceRow) => Skill) {
  const reads: string[] = []
  const value = project(
    new Proxy(row, {
      get(target, property, receiver) {
        if (typeof property === 'string') reads.push(property)
        return Reflect.get(target, property, receiver)
      },
    }),
  )
  return { value, reads }
}

describe('RFC-359 original Skill projection reads', () => {
  for (const { label, managedPath } of PATHS) {
    test(`default inline projection preserves ${label} bytes, descriptors and read order`, () => {
      const row = skillRow(0, managedPath)
      const expected = observeProjection(row, originalInlineProjection)
      const actual = observeProjection(row, skillFromPersistenceRow)
      assertProjection(actual.value, expected.value)
      expect(actual.reads).toEqual(expected.reads)
    })

    test(`explicit tail projection preserves ${label} bytes, descriptors and read order`, () => {
      const row = skillRow(0, managedPath)
      const expected = observeProjection(row, originalCatalogProjection)
      const actual = observeProjection(row, (value) => skillFromPersistenceRow(value, 'tail'))
      assertProjection(actual.value, expected.value)
      expect(actual.reads).toEqual(expected.reads)
    })
  }
})

describeEachProvider('RFC-359 Skill codec real consumers', (harness) => {
  let appHome: string

  beforeEach(() => {
    resetSkillBootVerifyForTest()
    appHome = mkdtempSync(join(tmpdir(), 'aw-skill-codec-'))
  })

  afterEach(() => {
    try {
      rmSync(appHome, { recursive: true, force: true })
    } finally {
      resetSkillBootVerifyForTest()
    }
  })

  async function insertRow(index: number, managedPath: string | null) {
    const values = skillRow(index, managedPath)
    await harness.db.insert(skills).values(values).run()
    const stored = await harness.db.select().from(skills).where(eq(skills.id, values.id)).get()
    expect(stored).toEqual(values)
    if (stored === undefined) throw new Error('skill codec fixture row missing')
    return stored
  }

  for (const { label, managedPath } of PATHS) {
    test(`real catalog list/get retain ${label} trailing projection and stored fields`, async () => {
      const row = await insertRow(0, managedPath)
      const repository = createSkillRepository(
        harness.db,
        { appHome },
        {
          unfuseForRestore: async () => [],
        },
      )
      const fetched = await repository.get(row.id)
      expect(fetched).not.toBeNull()
      if (fetched === null) throw new Error('stored skill not returned by the catalog')
      assertProjection(fetched, originalCatalogProjection(row))
      const listed = await repository.list()
      expect(listed).toHaveLength(1)
      const listedSkill = listed[0]
      if (listedSkill === undefined) throw new Error('stored skill not listed by the catalog')
      assertProjection(listedSkill, originalCatalogProjection(row))
      expect(await repository.get('missing-skill')).toBeNull()
      expect(await harness.db.select().from(skills).all()).toEqual([row])
    })
  }

  test('the real inventory reader delivers the original inline Skill to its existing port', async () => {
    const rows: SkillPersistenceRow[] = []
    for (const [index, { managedPath }] of PATHS.entries()) {
      rows.push(await insertRow(index, managedPath))
    }
    const captured = new Map<string, Skill>()
    const reader = createDatabaseAgentResourceInventoryReadPort({
      db: harness.db,
      skillAvailability: {
        isAvailable({ skill }) {
          captured.set(skill.id, skill)
          return true
        },
      },
    })
    const inventory = await reader.load()
    expect(captured.size).toBe(rows.length)
    expect(inventory.skills.size).toBe(rows.length)
    for (const row of rows) {
      const observed = captured.get(row.id)
      if (observed === undefined) throw new Error('stored skill did not reach the inventory port')
      assertProjection(observed, originalInlineProjection(row))
      expect(inventory.skills.get(row.id)).toEqual({
        id: row.id,
        name: row.name,
        ownerUserId: row.ownerUserId,
        visibility: row.visibility,
        reservationState: row.reservationState,
        versionState: row.versionState,
        available: true,
      })
    }
    expect(await harness.db.select().from(skills).orderBy(skills.id).all()).toEqual(rows)
  })

  test('the real workflow loader preserves the projected Skill and validation context', async () => {
    const rows: SkillPersistenceRow[] = []
    for (const [index, { managedPath }] of PATHS.entries()) {
      rows.push(await insertRow(index, managedPath))
    }
    const captured = new Map<string, Skill>()
    const validation = createWorkflowValidationPort({
      db: harness.db,
      skillContent: {
        async isAvailable(skill) {
          captured.set(skill.id, skill)
          return true
        },
      },
    })
    const candidate: WorkflowValidationCandidate = {
      definition: { $schema_version: 6, inputs: [], nodes: [], edges: [] },
      currentWorkflow: { id: 'codec-workflow', name: 'codec-workflow' },
    }
    const context: ValidatorContext = {
      agents: [],
      skills: rows.map(originalInlineProjection),
      mcps: [],
      plugins: [],
      callWorkflows: new Map(),
      callWorkgroupNames: new Set(),
      currentWorkflow: candidate.currentWorkflow,
    }
    const result = await validation.validate(candidate)
    expect(captured.size).toBe(rows.length)
    for (const row of rows) {
      const observed = captured.get(row.id)
      if (observed === undefined) throw new Error('stored skill did not reach the workflow loader')
      assertProjection(observed, originalInlineProjection(row))
    }
    expect(result.validationContextHash).toBe(workflowValidationContextHashOf(context))
    expect(result.result).toEqual(validateWorkflowDefinition(candidate.definition, context))
    expect(await harness.db.select().from(skills).orderBy(skills.id).all()).toEqual(rows)
  })
})
