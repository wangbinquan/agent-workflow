// RFC-264 — human-readable (Chinese) workflow / workgroup names, server side.
//
// User report: 「工作组、工作流名称要能支持中文」. The shared charset + normalizer
// are covered in packages/shared/tests/resource-display-name.test.ts; this file
// locks the SERVICE-level consequences that unit-testing the regex cannot:
//
//   1. create / rename / YAML-import accept Chinese and store the FOLDED name;
//   2. the workgroup owner-unique index still holds — and now cannot be evaded
//      by padding a name with spaces (they fold away before the insert);
//   3. an illegal name is still refused with the same error codes as before;
//   4. workflow duplicate names remain legal (they are not identity).

import {
  CreateWorkflowSchema,
  CreateWorkgroupSchema,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { users } from '../src/db/schema'
import { createWorkflow, getWorkflow } from '../src/services/workflow'
import { previewWorkflowYaml } from '../src/services/workflow.yaml'
import { createWorkgroup, getWorkgroupById, renameWorkgroup } from '../src/services/workgroups'
import { ulid } from 'ulid'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const EMPTY_DEFINITION: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [],
  edges: [],
}

let db: DbClient

function actor(id: string): Actor {
  return buildActor({
    source: 'session',
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
  })
}

function seedUser(id: string): void {
  const now = Date.now()
  db.insert(users)
    .values({
      id,
      username: id,
      displayName: id,
      role: 'user' as const,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

beforeEach(() => {
  db = createInMemoryDb(MIGRATIONS)
  seedUser('alice')
  seedUser('bob')
})

function workgroupInput(name: string) {
  return CreateWorkgroupSchema.parse({ name, description: '' })
}

/**
 * Validation + normalization live in the CREATE SCHEMA, which is what the
 * route parses — the `createWorkflow` service itself stays permissive so
 * framework seeding can write its own rows. Going through the schema here is
 * therefore the real user boundary, not a shortcut.
 */
function workflowInput(name: string) {
  return CreateWorkflowSchema.parse({ name, description: '', definition: EMPTY_DEFINITION })
}

describe('RFC-264 workflow names', () => {
  test('create accepts Chinese and stores the folded name', async () => {
    const created = await createWorkflow(db, workflowInput('代码审计流水线 '))
    expect(created.name).toBe('代码审计流水线')
    expect((await getWorkflow(db, created.id))?.name).toBe('代码审计流水线')
  })

  test('mixed script, uppercase and full-width punctuation all pass', async () => {
    for (const name of ['审计 Pipeline v2', 'Code Review（重构专用）', '审计　流程']) {
      const created = await createWorkflow(db, workflowInput(name))
      // U+3000 folds to an ordinary space; everything else is verbatim.
      expect(created.name).toBe(name.replace('　', ' '))
    }
  })

  test('illegal names are still refused at the create boundary', () => {
    for (const name of ['_reserved', 'two\nlines', '   ', '审'.repeat(129)]) {
      expect(() => workflowInput(name)).toThrow()
    }
  })

  test('duplicate workflow names stay legal (the ULID is the identity)', async () => {
    const first = await createWorkflow(db, workflowInput('代码审计'))
    const second = await createWorkflow(db, workflowInput('代码审计'))
    expect(first.id).not.toBe(second.id)
    expect(second.name).toBe('代码审计')
  })
})

describe('RFC-264 YAML import', () => {
  test('a Chinese name previews as the folded value', () => {
    const preview = previewWorkflowYaml(
      ['name: 代码审计流水线', 'description: ""', 'definition:', '  $schema_version: 4'].join('\n'),
    )
    expect(preview.name).toBe('代码审计流水线')
  })

  test('the name is folded on the way in', () => {
    const preview = previewWorkflowYaml(
      ['name: "代码审计  流程 "', 'description: ""', 'definition:', '  $schema_version: 4'].join(
        '\n',
      ),
    )
    expect(preview.name).toBe('代码审计 流程')
  })

  test('an illegal name is a workflow-name-invalid 422, not a silent rewrite', () => {
    expect(() =>
      previewWorkflowYaml(
        ['name: _reserved', 'description: ""', 'definition:', '  $schema_version: 4'].join('\n'),
      ),
    ).toThrow(expect.objectContaining({ code: 'workflow-name-invalid' }))
  })
})

describe('RFC-264 workgroup names', () => {
  test('create + rename accept Chinese and store the folded name', async () => {
    const created = await createWorkgroup(db, workgroupInput('代码审计组 '), {
      ownerUserId: 'alice',
      actor: actor('alice'),
    })
    expect(created.name).toBe('代码审计组')

    const renamed = await renameWorkgroup(
      db,
      created.id,
      {
        newName: '审计 Squad v2',
        expectedVersion: created.version,
        clientMutationId: ulid(),
      },
      { kind: 'actor', actor: actor('alice') },
    )
    expect(renamed.workgroup.name).toBe('审计 Squad v2')
    expect((await getWorkgroupById(db, created.id))?.name).toBe('审计 Squad v2')
  })

  test('the owner-unique index holds — and padding no longer evades it', async () => {
    await createWorkgroup(db, workgroupInput('代码审计组'), {
      ownerUserId: 'alice',
      actor: actor('alice'),
    })
    // Same owner, same folded name (only whitespace differs) ⇒ conflict.
    await expect(
      createWorkgroup(db, workgroupInput('  代码审计组  '), {
        ownerUserId: 'alice',
        actor: actor('alice'),
      }),
    ).rejects.toMatchObject({ status: 409 })
    // A different owner keeps their own namespace.
    const bobs = await createWorkgroup(db, workgroupInput('代码审计组'), {
      ownerUserId: 'bob',
      actor: actor('bob'),
    })
    expect(bobs.name).toBe('代码审计组')
  })

  test('illegal names are still refused at the schema boundary', () => {
    for (const name of ['_reserved', 'two\nlines', '   ']) {
      expect(() => workgroupInput(name)).toThrow()
    }
  })
})
