// RFC-045 / RFC-342 — content PATCH + dedicated scope move schemas.
// Locks the partial-PATCH contract surfaced at PATCH /api/memories/:id:
//   * at least one of {title, bodyMd, tags}
//   * field-level limits (title 1-120, bodyMd 1-4000, tag 1-40, max 16)
//   * scope fields are rejected rather than silently stripped
// Move has its own strict expectedVersion + target scope contract.

import { describe, expect, test } from 'bun:test'
import {
  MEMORY_PATCH_FIELDS,
  MemoryMoveRequestSchema,
  MemoryPatchRequestSchema,
} from '../src/schemas/memory'

describe('MemoryPatchRequestSchema', () => {
  test('rejects fully empty body', () => {
    const r = MemoryPatchRequestSchema.safeParse({})
    expect(r.success).toBe(false)
  })

  test('accepts a single-field patch (title only)', () => {
    const r = MemoryPatchRequestSchema.safeParse({ title: 'renamed' })
    expect(r.success).toBe(true)
  })

  test('rejects scopeType and scopeId even when content is also present', () => {
    expect(MemoryPatchRequestSchema.safeParse({ scopeType: 'global', title: 'x' }).success).toBe(
      false,
    )
    expect(MemoryPatchRequestSchema.safeParse({ scopeId: null, bodyMd: 'x' }).success).toBe(false)
  })

  test('rejects title="" (trim min 1)', () => {
    const r = MemoryPatchRequestSchema.safeParse({ title: '   ' })
    expect(r.success).toBe(false)
  })

  test('rejects title > 120 chars', () => {
    const r = MemoryPatchRequestSchema.safeParse({ title: 'x'.repeat(121) })
    expect(r.success).toBe(false)
  })

  test('rejects bodyMd > 4000 chars', () => {
    const r = MemoryPatchRequestSchema.safeParse({ bodyMd: 'x'.repeat(4001) })
    expect(r.success).toBe(false)
  })

  test('rejects 17 tags', () => {
    const tags = Array.from({ length: 17 }, (_, i) => `t${i}`)
    const r = MemoryPatchRequestSchema.safeParse({ tags })
    expect(r.success).toBe(false)
  })

  test('rejects a tag > 40 chars', () => {
    const r = MemoryPatchRequestSchema.safeParse({ tags: ['ok', 'x'.repeat(41)] })
    expect(r.success).toBe(false)
  })

  test('accepts 16 tags, each within length bounds', () => {
    const tags = Array.from({ length: 16 }, (_, i) => `t${i}`)
    const r = MemoryPatchRequestSchema.safeParse({ tags })
    expect(r.success).toBe(true)
  })

  test('strips unknown fields silently (zod default)', () => {
    const r = MemoryPatchRequestSchema.safeParse({
      title: 'ok',
      version: 99, // server-controlled — must not leak through
      status: 'approved', // server-controlled
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect('version' in r.data).toBe(false)
      expect('status' in r.data).toBe(false)
    }
  })
})

describe('MEMORY_PATCH_FIELDS', () => {
  test('is the canonical content-only tuple in fixed order', () => {
    expect(MEMORY_PATCH_FIELDS).toEqual(['title', 'bodyMd', 'tags'])
  })
})

describe('MemoryMoveRequestSchema', () => {
  test('accepts versioned global and resource targets', () => {
    expect(
      MemoryMoveRequestSchema.safeParse({
        expectedVersion: 3,
        scopeType: 'global',
        scopeId: null,
      }).success,
    ).toBe(true)
    expect(
      MemoryMoveRequestSchema.safeParse({
        expectedVersion: 3,
        scopeType: 'workflow',
        scopeId: 'workflow-1',
      }).success,
    ).toBe(true)
  })

  test('rejects invalid scope pairs and missing/invalid versions', () => {
    expect(
      MemoryMoveRequestSchema.safeParse({
        expectedVersion: 1,
        scopeType: 'global',
        scopeId: 'not-null',
      }).success,
    ).toBe(false)
    expect(
      MemoryMoveRequestSchema.safeParse({
        expectedVersion: 0,
        scopeType: 'agent',
        scopeId: 'agent-1',
      }).success,
    ).toBe(false)
    expect(
      MemoryMoveRequestSchema.safeParse({ scopeType: 'agent', scopeId: 'agent-1' }).success,
    ).toBe(false)
  })

  test('strictly rejects caller-supplied authority snapshots', () => {
    expect(
      MemoryMoveRequestSchema.safeParse({
        expectedVersion: 1,
        scopeType: 'agent',
        scopeId: 'agent-1',
        actor: { user: { id: 'forged-admin' } },
        permissions: ['resource-acl:bypass'],
      }).success,
    ).toBe(false)
  })
})
