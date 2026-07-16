// RFC-199 B1 shared-wire regression lock.
//
// These tests keep the editor's optimistic-concurrency contract closed: a
// workflow save is a complete editable snapshot identified by a canonical
// 128-bit ULID, receipts and WebSocket frames identify the exact revision,
// and validation targets remain a finite strict union.  They also lock the
// canonical serializer used by both persistence and workflow-sync diffing so
// key insertion order can never create a false content change.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import {
  DeleteWorkflowSchema,
  ImportWorkflowRequestSchema,
  ImportWorkflowResultSchema,
  SaveWorkflowReceiptSchema,
  UpdateWorkflowSchema,
  WorkflowDefinitionSchema,
  WorkflowDetailSchema,
  WorkflowDraftSnapshotSchema,
  WorkflowExactRevisionSchema,
  WorkflowMutationIdSchema,
  WorkflowRevisionSchema,
  WorkflowSchema,
  WorkflowValidationReceiptSchema,
  WorkflowValidationRequestSchema,
  WorkflowValidationIssueSchema,
  WorkflowValidationTargetSchema,
  WorkflowsWsMessageSchema,
  canonicalJson,
  serializeWorkflowDefinitionStorageV1,
  serializeWorkflowEditableSnapshotV1,
  stringifyWorkflowYamlDocument,
} from '../src'

const MUTATION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SNAPSHOT_HASH = 'a'.repeat(64)
const DEFINITION = {
  $schema_version: 4,
  inputs: [],
  nodes: [],
  edges: [],
} as const
const SNAPSHOT = {
  name: 'workflow-a',
  description: '',
  definition: DEFINITION,
}

function workflowBase() {
  return {
    id: 'workflow-id',
    name: SNAPSHOT.name,
    description: SNAPSHOT.description,
    definition: SNAPSHOT.definition,
    version: 3,
    schemaVersion: 4,
    createdAt: 10,
    updatedAt: 20,
  }
}

describe('RFC-199 canonical workflow serialization', () => {
  test('canonicalJson recursively sorts object keys and preserves array order', () => {
    expect(canonicalJson({ z: 1, nested: { z: 3, a: 2 }, ordered: [{ z: 1, a: 2 }, 3, 1] })).toBe(
      '{"nested":{"a":2,"z":3},"ordered":[{"a":2,"z":1},3,1],"z":1}',
    )
    expect(canonicalJson([3, 2, 1])).not.toBe(canonicalJson([1, 2, 3]))
  })

  test('shared YAML serializer is immutable and makes the persisted id optional', () => {
    const before = structuredClone(SNAPSHOT)
    const persisted = parseYaml(
      stringifyWorkflowYamlDocument(SNAPSHOT, { id: 'workflow-id' }),
    ) as Record<string, unknown>
    const unsaved = parseYaml(stringifyWorkflowYamlDocument(SNAPSHOT)) as Record<string, unknown>

    expect(persisted).toMatchObject({ id: 'workflow-id', ...SNAPSHOT })
    expect(unsaved).toMatchObject(SNAPSHOT)
    expect(unsaved).not.toHaveProperty('id')
    expect(SNAPSHOT).toEqual(before)
  })

  test('canonicalJson keeps integer-like object keys in lexical, not JS numeric, order', () => {
    expect(canonicalJson({ 2: 'two', 10: 'ten', 1: 'one', a: 'letter' })).toBe(
      '{"1":"one","10":"ten","2":"two","a":"letter"}',
    )
  })

  test('canonicalJson follows JSON omission/null rules without mutating input', () => {
    const value = { z: undefined, a: [{ z: 2, a: 1 }, undefined] }
    const before = Reflect.ownKeys(value)
    expect(canonicalJson(value)).toBe('{"a":[{"a":1,"z":2},null]}')
    expect(Reflect.ownKeys(value)).toEqual(before)
    expect(value.a[0]).toEqual({ z: 2, a: 1 })
  })

  test('storage serialization has no domain prefix or trailing newline and applies schema defaults', () => {
    const definition = WorkflowDefinitionSchema.parse({ $schema_version: 4 })
    expect(serializeWorkflowDefinitionStorageV1(definition)).toBe(
      '{"$schema_version":4,"edges":[],"inputs":[],"nodes":[]}',
    )
  })

  test('editable snapshot serialization is domain-separated and insertion-order independent', () => {
    const reordered = {
      definition: { edges: [], nodes: [], inputs: [], $schema_version: 4 as const },
      description: '',
      name: 'workflow-a',
    }
    const serialized = serializeWorkflowEditableSnapshotV1(SNAPSHOT)
    expect(serialized).toBe(
      'workflow-editable-snapshot/v1\n' +
        '{"definition":{"$schema_version":4,"edges":[],"inputs":[],"nodes":[]},"description":"","name":"workflow-a"}',
    )
    expect(serializeWorkflowEditableSnapshotV1(reordered)).toBe(serialized)
  })

  test('workflow-sync-diff imports the shared canonicalJson instead of retaining a private copy', () => {
    const source = readFileSync(new URL('../src/workflow-sync-diff.ts', import.meta.url), 'utf8')
    expect(source).toContain("import { canonicalJson } from './workflow-canonical'")
    expect(source).not.toContain('function stableStringify')
  })
})

describe('RFC-199 workflow save and delete schemas', () => {
  test('mutation id accepts only canonical 128-bit Crockford ULIDs', () => {
    expect(WorkflowMutationIdSchema.parse(MUTATION_ID)).toBe(MUTATION_ID)
    for (const invalid of [
      '81ARZ3NDEKTSV4RRFFQ69G5FAV',
      'Z1ARZ3NDEKTSV4RRFFQ69G5FAV',
      '01arz3ndektsv4rrffq69g5fav',
      '01ARZ3NDEKTSV4RRFFQ69G5FAI',
      '01ARZ3NDEKTSV4RRFFQ69G5FA',
    ]) {
      expect(WorkflowMutationIdSchema.safeParse(invalid).success).toBe(false)
    }
  })

  test('draft snapshot is complete and strict', () => {
    expect(WorkflowDraftSnapshotSchema.parse(SNAPSHOT)).toEqual(SNAPSHOT)
    expect(WorkflowDraftSnapshotSchema.safeParse({ ...SNAPSHOT, extra: true }).success).toBe(false)
    expect(
      WorkflowDraftSnapshotSchema.safeParse({ name: SNAPSHOT.name, definition: DEFINITION })
        .success,
    ).toBe(false)
  })

  test('PUT is a full strict snapshot replacement with both fences', () => {
    const request = {
      expectedVersion: 3,
      clientMutationId: MUTATION_ID,
      snapshot: SNAPSHOT,
    }
    expect(UpdateWorkflowSchema.parse(request)).toEqual(request)
    expect(UpdateWorkflowSchema.safeParse({ description: 'legacy partial patch' }).success).toBe(
      false,
    )
    expect(UpdateWorkflowSchema.safeParse({ ...request, force: true }).success).toBe(false)
    expect(UpdateWorkflowSchema.safeParse({ ...request, expectedVersion: 0 }).success).toBe(false)
  })

  test('revision, receipt, detail and delete expose one exact revision', () => {
    const revision = {
      workflowId: 'workflow-id',
      version: 4,
      snapshotHash: SNAPSHOT_HASH,
      updatedAt: 21,
    }
    expect(WorkflowRevisionSchema.parse(revision)).toEqual(revision)
    expect(
      SaveWorkflowReceiptSchema.parse({
        clientMutationId: MUTATION_ID,
        requestedBaseVersion: 3,
        revision,
        snapshot: SNAPSHOT,
        outcome: 'committed',
      }).outcome,
    ).toBe('committed')
    expect(
      SaveWorkflowReceiptSchema.safeParse({
        clientMutationId: MUTATION_ID,
        requestedBaseVersion: 3,
        revision,
        snapshot: SNAPSHOT,
        outcome: 'updated',
      }).success,
    ).toBe(false)

    // List/base workflow compatibility stays unchanged: hash is detail-only.
    expect(WorkflowSchema.parse(workflowBase()).id).toBe('workflow-id')
    expect(WorkflowDetailSchema.safeParse(workflowBase()).success).toBe(false)
    expect(WorkflowDetailSchema.parse({ ...workflowBase(), snapshotHash: SNAPSHOT_HASH })).toEqual({
      ...workflowBase(),
      snapshotHash: SNAPSHOT_HASH,
    })

    expect(
      DeleteWorkflowSchema.parse({ expectedVersion: 4, clientMutationId: MUTATION_ID }),
    ).toEqual({ expectedVersion: 4, clientMutationId: MUTATION_ID })
    expect(DeleteWorkflowSchema.safeParse({ expectedVersion: 4 }).success).toBe(false)
  })
})

describe('RFC-199 structured YAML import schemas', () => {
  test('fail/new modes forbid overwrite while overwrite mode requires every fence', () => {
    expect(ImportWorkflowRequestSchema.parse({ yamlText: 'name: x', mode: 'fail' })).toEqual({
      yamlText: 'name: x',
      mode: 'fail',
    })
    expect(
      ImportWorkflowRequestSchema.safeParse({
        yamlText: 'name: x',
        mode: 'new',
        overwrite: {
          workflowId: 'workflow-id',
          expectedVersion: 3,
          clientMutationId: MUTATION_ID,
        },
      }).success,
    ).toBe(false)
    expect(
      ImportWorkflowRequestSchema.parse({
        yamlText: 'name: x',
        mode: 'overwrite',
        overwrite: {
          workflowId: 'workflow-id',
          expectedVersion: 3,
          clientMutationId: MUTATION_ID,
        },
      }).mode,
    ).toBe('overwrite')
    expect(
      ImportWorkflowRequestSchema.safeParse({ yamlText: 'name: x', mode: 'overwrite' }).success,
    ).toBe(false)
  })

  test('result is a strict created-detail or overwritten-receipt union', () => {
    const revision = {
      workflowId: 'workflow-id',
      version: 4,
      snapshotHash: SNAPSHOT_HASH,
      updatedAt: 21,
    }
    expect(
      ImportWorkflowResultSchema.parse({
        outcome: 'created',
        workflow: { ...workflowBase(), snapshotHash: SNAPSHOT_HASH },
      }).outcome,
    ).toBe('created')
    expect(
      ImportWorkflowResultSchema.parse({
        outcome: 'overwritten',
        receipt: {
          clientMutationId: MUTATION_ID,
          requestedBaseVersion: 3,
          revision,
          snapshot: SNAPSHOT,
          outcome: 'already-current',
        },
      }).outcome,
    ).toBe('overwritten')
  })
})

describe('RFC-199 exact workflow WS frames', () => {
  test('updated carries mutation id plus the complete revision identity', () => {
    expect(
      WorkflowsWsMessageSchema.parse({
        type: 'workflow.updated',
        workflowId: 'workflow-id',
        clientMutationId: MUTATION_ID,
        version: 4,
        snapshotHash: SNAPSHOT_HASH,
        updatedAt: 21,
      }).type,
    ).toBe('workflow.updated')
    expect(
      WorkflowsWsMessageSchema.safeParse({
        type: 'workflow.updated',
        workflowId: 'workflow-id',
        version: 4,
        updatedAt: 21,
      }).success,
    ).toBe(false)
  })

  test('deleted carries the destructive mutation id and deleted version', () => {
    expect(
      WorkflowsWsMessageSchema.parse({
        type: 'workflow.deleted',
        workflowId: 'workflow-id',
        clientMutationId: MUTATION_ID,
        deletedVersion: 4,
      }).type,
    ).toBe('workflow.deleted')
    expect(
      WorkflowsWsMessageSchema.safeParse({
        type: 'workflow.deleted',
        workflowId: 'workflow-id',
      }).success,
    ).toBe(false)
  })
})

describe('RFC-199 strict validation targets', () => {
  test('accepts each closed target variant and remains optional on legacy issues', () => {
    const targets = [
      { kind: 'node', nodeId: 'n1' },
      { kind: 'node-field', nodeId: 'n1', field: 'agent' },
      { kind: 'node-port', nodeId: 'n1', direction: 'input', portName: 'query' },
      { kind: 'edge', edgeId: 'e1' },
      { kind: 'workflow-input', inputKey: 'repo' },
      { kind: 'workflow-output', outputName: 'result' },
      { kind: 'workflow' },
    ]
    for (const target of targets)
      expect(WorkflowValidationTargetSchema.parse(target)).toEqual(target)
    expect(WorkflowValidationIssueSchema.parse({ code: 'legacy', message: 'legacy' }).target).toBe(
      undefined,
    )
    expect(
      WorkflowValidationIssueSchema.parse({ code: 'new', message: 'new', target: targets[1] })
        .target,
    ).toEqual(targets[1])
  })

  test('rejects unknown semantic fields and variant-specific extra keys', () => {
    expect(
      WorkflowValidationTargetSchema.safeParse({
        kind: 'node-field',
        nodeId: 'n1',
        field: 'arbitrary-dom-id',
      }).success,
    ).toBe(false)
    expect(
      WorkflowValidationTargetSchema.safeParse({
        kind: 'node',
        nodeId: 'n1',
        edgeId: 'e1',
      }).success,
    ).toBe(false)
  })
})

describe('RFC-199 exact validate/export fences', () => {
  test('exact revision request requires a positive version and lowercase SHA-256', () => {
    const request = { expectedVersion: 4, expectedSnapshotHash: SNAPSHOT_HASH }
    expect(WorkflowExactRevisionSchema.parse(request)).toEqual(request)
    expect(WorkflowValidationRequestSchema.parse(request)).toEqual(request)
    expect(
      WorkflowExactRevisionSchema.safeParse({ ...request, expectedSnapshotHash: 'A'.repeat(64) })
        .success,
    ).toBe(false)
    expect(WorkflowExactRevisionSchema.safeParse({ ...request, expectedVersion: 0 }).success).toBe(
      false,
    )
    expect(WorkflowExactRevisionSchema.safeParse({ ...request, extra: true }).success).toBe(false)
  })

  test('validation receipt binds issues to one workflow revision and context hash', () => {
    const receipt = {
      revision: {
        workflowId: 'workflow-id',
        version: 4,
        snapshotHash: SNAPSHOT_HASH,
        updatedAt: 21,
      },
      validationContextHash: 'b'.repeat(64),
      validatedAt: 22,
      ok: false,
      issues: [{ code: 'broken', message: 'broken', target: { kind: 'workflow' as const } }],
    }
    expect(WorkflowValidationReceiptSchema.parse(receipt)).toEqual(receipt)
    expect(
      WorkflowValidationReceiptSchema.safeParse({
        ...receipt,
        validationContextHash: 'b'.repeat(63),
      }).success,
    ).toBe(false)
    expect(WorkflowValidationReceiptSchema.safeParse({ ...receipt, stale: false }).success).toBe(
      false,
    )
  })
})
