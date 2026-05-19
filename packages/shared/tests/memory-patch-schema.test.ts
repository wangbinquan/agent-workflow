// RFC-045 — MemoryPatchRequestSchema unit tests.
// Locks the partial-PATCH contract surfaced at PATCH /api/memories/:id:
//   * at least one of {scopeType, scopeId, title, bodyMd, tags}
//   * field-level limits (title 1-120, bodyMd 1-4000, tag 1-40, max 16)
//   * scopeType ↔ scopeId invariant only when *both* are present
//   * scopeType-only patches are accepted (row-level synth + re-validate in
//     service layer; see design.md §4.2 step 3)

import { describe, expect, test } from 'bun:test'
import { MEMORY_PATCH_FIELDS, MemoryPatchRequestSchema } from '../src/schemas/memory'

describe('MemoryPatchRequestSchema', () => {
  test('rejects fully empty body', () => {
    const r = MemoryPatchRequestSchema.safeParse({})
    expect(r.success).toBe(false)
  })

  test('accepts a single-field patch (title only)', () => {
    const r = MemoryPatchRequestSchema.safeParse({ title: 'renamed' })
    expect(r.success).toBe(true)
  })

  test('accepts scopeType=global + scopeId=null pair', () => {
    const r = MemoryPatchRequestSchema.safeParse({ scopeType: 'global', scopeId: null })
    expect(r.success).toBe(true)
  })

  test('rejects scopeType=global + scopeId="x"', () => {
    const r = MemoryPatchRequestSchema.safeParse({ scopeType: 'global', scopeId: 'x' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(JSON.stringify(r.error.format())).toContain('global scope must have scopeId=null')
    }
  })

  test('rejects scopeType=agent + scopeId=null', () => {
    const r = MemoryPatchRequestSchema.safeParse({ scopeType: 'agent', scopeId: null })
    expect(r.success).toBe(false)
  })

  test('rejects scopeType=agent + scopeId=""', () => {
    const r = MemoryPatchRequestSchema.safeParse({ scopeType: 'agent', scopeId: '' })
    expect(r.success).toBe(false)
  })

  test('accepts scopeType-only patch (scopeId not provided — service layer re-validates)', () => {
    const r = MemoryPatchRequestSchema.safeParse({ scopeType: 'agent' })
    expect(r.success).toBe(true)
  })

  test('accepts scopeId-only patch (scopeType not provided — service layer re-validates)', () => {
    const r = MemoryPatchRequestSchema.safeParse({ scopeId: 'agent-x' })
    expect(r.success).toBe(true)
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
  test('is the canonical 5-tuple in fixed order', () => {
    expect(MEMORY_PATCH_FIELDS).toEqual(['scopeType', 'scopeId', 'title', 'bodyMd', 'tags'])
  })
})
