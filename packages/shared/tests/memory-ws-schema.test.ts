// RFC-041 — locks both WS message unions.

import { describe, expect, test } from 'bun:test'
import { MemoryDistillJobWsMessageSchema, MemoryWsMessageSchema } from '../src/schemas/ws'

describe('MemoryWsMessageSchema', () => {
  test('parses memory.candidate.created with a MemorySummary', () => {
    const ok = MemoryWsMessageSchema.parse({
      type: 'memory.candidate.created',
      memory: {
        id: 'm_001',
        scopeType: 'agent',
        scopeId: 'a',
        title: 'foo',
        status: 'candidate',
        tags: [],
        approvedAt: null,
        version: 1,
        distillAction: 'new',
        fusedIntoSkillId: null,
      },
    })
    expect(ok.type).toBe('memory.candidate.created')
  })
  test('memory.candidate.promoted supports optional supersededIds', () => {
    expect(
      MemoryWsMessageSchema.parse({
        type: 'memory.candidate.promoted',
        memoryId: 'm_001',
        newStatus: 'approved',
      }),
    ).toBeTruthy()
    expect(
      MemoryWsMessageSchema.parse({
        type: 'memory.candidate.promoted',
        memoryId: 'm_001',
        newStatus: 'approved',
        supersededIds: ['m_old'],
      }),
    ).toBeTruthy()
  })
  test('archived / unarchived / deleted', () => {
    expect(MemoryWsMessageSchema.parse({ type: 'memory.archived', memoryId: 'x' })).toBeTruthy()
    expect(MemoryWsMessageSchema.parse({ type: 'memory.unarchived', memoryId: 'x' })).toBeTruthy()
    expect(MemoryWsMessageSchema.parse({ type: 'memory.deleted', memoryId: 'x' })).toBeTruthy()
  })
  test('superseded carries oldId + newId', () => {
    expect(
      MemoryWsMessageSchema.parse({ type: 'memory.superseded', oldId: 'a', newId: 'b' }),
    ).toBeTruthy()
  })
  test('rejects unknown type', () => {
    expect(() => MemoryWsMessageSchema.parse({ type: 'memory.unknown', memoryId: 'x' })).toThrow()
  })
})

describe('MemoryDistillJobWsMessageSchema', () => {
  test('4 message variants parse', () => {
    expect(
      MemoryDistillJobWsMessageSchema.parse({
        type: 'distill.queued',
        jobId: 'j',
        debounceKey: 'k',
      }),
    ).toBeTruthy()
    expect(
      MemoryDistillJobWsMessageSchema.parse({ type: 'distill.started', jobId: 'j' }),
    ).toBeTruthy()
    expect(
      MemoryDistillJobWsMessageSchema.parse({
        type: 'distill.done',
        jobId: 'j',
        candidatesCreated: 3,
      }),
    ).toBeTruthy()
    expect(
      MemoryDistillJobWsMessageSchema.parse({
        type: 'distill.failed',
        jobId: 'j',
        error: 'boom',
      }),
    ).toBeTruthy()
  })
  test('rejects malformed', () => {
    expect(() =>
      MemoryDistillJobWsMessageSchema.parse({
        type: 'distill.done',
        jobId: 'j',
        // missing candidatesCreated
      }),
    ).toThrow()
  })
})
