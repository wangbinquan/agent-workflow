// RFC-045 — WS schema for the new 'memory.updated' event.

import { describe, expect, test } from 'bun:test'
import { MemoryWsMessageSchema } from '../src/schemas/ws'

describe("MemoryWsMessageSchema 'memory.updated'", () => {
  test('accepts a happy-path event with all 5 fields changed', () => {
    const r = MemoryWsMessageSchema.safeParse({
      type: 'memory.updated',
      memoryId: '01HXX',
      changedFields: ['scopeType', 'scopeId', 'title', 'bodyMd', 'tags'],
      version: 2,
    })
    expect(r.success).toBe(true)
  })

  test('accepts a single-field change', () => {
    const r = MemoryWsMessageSchema.safeParse({
      type: 'memory.updated',
      memoryId: '01HXX',
      changedFields: ['tags'],
      version: 7,
    })
    expect(r.success).toBe(true)
  })

  test('rejects empty changedFields', () => {
    const r = MemoryWsMessageSchema.safeParse({
      type: 'memory.updated',
      memoryId: '01HXX',
      changedFields: [],
      version: 2,
    })
    expect(r.success).toBe(false)
  })

  test('rejects unknown field name in changedFields', () => {
    const r = MemoryWsMessageSchema.safeParse({
      type: 'memory.updated',
      memoryId: '01HXX',
      changedFields: ['version'],
      version: 2,
    })
    expect(r.success).toBe(false)
  })

  test('rejects version < 2 (PATCH never produces v1)', () => {
    const r = MemoryWsMessageSchema.safeParse({
      type: 'memory.updated',
      memoryId: '01HXX',
      changedFields: ['title'],
      version: 1,
    })
    expect(r.success).toBe(false)
  })

  test('existing memory.* cases still parse (regression guard)', () => {
    const cases = [
      { type: 'memory.candidate.promoted', memoryId: '01HXX', newStatus: 'approved' },
      { type: 'memory.archived', memoryId: '01HXX' },
      { type: 'memory.unarchived', memoryId: '01HXX' },
      { type: 'memory.deleted', memoryId: '01HXX' },
      { type: 'memory.superseded', oldId: '01HXX', newId: '01HYY' },
    ]
    for (const c of cases) {
      const r = MemoryWsMessageSchema.safeParse(c)
      expect(r.success).toBe(true)
    }
  })
})
