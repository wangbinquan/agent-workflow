// RFC-041 — locks zod boundary cases for memory schemas. Any change to
// MemorySchema / MemoryCandidatePromoteSchema / MemoryCreateRequestSchema /
// MemoryListFilterSchema must keep these assertions green.

import { describe, expect, test } from 'bun:test'
import {
  MemoryCandidatePromoteSchema,
  MemoryCreateRequestSchema,
  MemoryListFilterSchema,
  MemorySchema,
  MemoryScopeSchema,
  MemorySourceKindSchema,
  MemoryStatusSchema,
  DistillActionSchema,
  ResolvedDistillScopeSchema,
  MemoryDistillJobSchema,
} from '../src/schemas/memory'

const VALID_MEMORY = {
  id: '01JABCDEF',
  scopeType: 'agent' as const,
  scopeId: 'agent_xyz',
  title: 'prefer functional components',
  bodyMd: 'When generating React components, default to function components with hooks.',
  tags: ['react', 'frontend'],
  status: 'approved' as const,
  sourceKind: 'review' as const,
  sourceEventId: 'review_001',
  sourceTaskId: 't_001',
  distillJobId: 'j_001',
  distillAction: 'new' as const,
  supersedesId: null,
  supersededById: null,
  approvedByUserId: 'u_admin',
  approvedAt: 1_700_000_000_000,
  createdAt: 1_699_000_000_000,
  version: 1,
}

describe('MemoryScopeSchema', () => {
  test('accepts the 4 canonical scopes', () => {
    for (const s of ['agent', 'workflow', 'repo', 'global']) {
      expect(MemoryScopeSchema.parse(s)).toBe(s)
    }
  })
  test('rejects unknown scope', () => {
    expect(() => MemoryScopeSchema.parse('user')).toThrow()
    expect(() => MemoryScopeSchema.parse('')).toThrow()
  })
})

describe('MemoryStatusSchema / MemorySourceKindSchema / DistillActionSchema', () => {
  test('status enum is exactly 6 members', () => {
    const statuses = ['candidate', 'approved', 'archived', 'superseded', 'rejected', 'fused']
    expect(MemoryStatusSchema.options).toEqual(statuses)
    for (const s of statuses) {
      expect(MemoryStatusSchema.parse(s)).toBe(s)
    }
  })
  test('source_kind enum is exactly 4 members', () => {
    expect(MemorySourceKindSchema.options.length).toBe(4)
    expect(MemorySourceKindSchema.parse('clarify')).toBe('clarify')
    expect(MemorySourceKindSchema.parse('feedback')).toBe('feedback')
    expect(MemorySourceKindSchema.parse('manual')).toBe('manual')
    expect(() => MemorySourceKindSchema.parse('chat')).toThrow()
  })
  test('distill_action enum is exactly 4 members', () => {
    expect(DistillActionSchema.options.length).toBe(4)
    for (const a of ['new', 'update_of', 'duplicate_of', 'conflict_with']) {
      expect(DistillActionSchema.parse(a)).toBe(a)
    }
  })
})

describe('MemorySchema', () => {
  test('accepts a well-formed approved memory', () => {
    expect(MemorySchema.parse(VALID_MEMORY)).toMatchObject({ id: '01JABCDEF', version: 1 })
  })

  test('global scope requires scopeId=null', () => {
    const ok = MemorySchema.parse({ ...VALID_MEMORY, scopeType: 'global', scopeId: null })
    expect(ok.scopeType).toBe('global')
    expect(() =>
      MemorySchema.parse({ ...VALID_MEMORY, scopeType: 'global', scopeId: 'something' }),
    ).toThrow(/global scope must have scopeId=null/)
  })

  test('non-global scope rejects null / empty scopeId', () => {
    expect(() =>
      MemorySchema.parse({ ...VALID_MEMORY, scopeType: 'agent', scopeId: null }),
    ).toThrow(/non-global scope requires scopeId/)
    expect(() =>
      MemorySchema.parse({ ...VALID_MEMORY, scopeType: 'workflow', scopeId: '' }),
    ).toThrow()
  })

  test('title length boundaries: 1..120', () => {
    expect(() => MemorySchema.parse({ ...VALID_MEMORY, title: '' })).toThrow()
    expect(() => MemorySchema.parse({ ...VALID_MEMORY, title: '  ' })).toThrow() // trim → empty
    expect(MemorySchema.parse({ ...VALID_MEMORY, title: 'x'.repeat(120) }).title.length).toBe(120)
    expect(() => MemorySchema.parse({ ...VALID_MEMORY, title: 'x'.repeat(121) })).toThrow()
  })

  test('body length boundaries: 1..4000', () => {
    expect(() => MemorySchema.parse({ ...VALID_MEMORY, bodyMd: '' })).toThrow()
    expect(MemorySchema.parse({ ...VALID_MEMORY, bodyMd: 'x'.repeat(4000) }).bodyMd.length).toBe(
      4000,
    )
    expect(() => MemorySchema.parse({ ...VALID_MEMORY, bodyMd: 'x'.repeat(4001) })).toThrow()
  })

  test('tags array: 0..16 items, each 1..40 chars', () => {
    expect(MemorySchema.parse({ ...VALID_MEMORY, tags: [] }).tags).toEqual([])
    const sixteen = Array(16).fill('tag-x')
    expect(MemorySchema.parse({ ...VALID_MEMORY, tags: sixteen }).tags.length).toBe(16)
    const seventeen = Array(17).fill('tag-x')
    expect(() => MemorySchema.parse({ ...VALID_MEMORY, tags: seventeen })).toThrow()
    expect(() => MemorySchema.parse({ ...VALID_MEMORY, tags: [''] })).toThrow()
    expect(() => MemorySchema.parse({ ...VALID_MEMORY, tags: ['x'.repeat(41)] })).toThrow()
  })

  test('version must be ≥ 1', () => {
    expect(() => MemorySchema.parse({ ...VALID_MEMORY, version: 0 })).toThrow()
    expect(() => MemorySchema.parse({ ...VALID_MEMORY, version: -1 })).toThrow()
    expect(MemorySchema.parse({ ...VALID_MEMORY, version: 99 }).version).toBe(99)
  })

  test('all foreign-key-like fields accept null', () => {
    const m = MemorySchema.parse({
      ...VALID_MEMORY,
      sourceEventId: null,
      sourceTaskId: null,
      distillJobId: null,
      distillAction: null,
      supersedesId: null,
      supersededById: null,
      approvedByUserId: null,
      approvedAt: null,
    })
    expect(m.sourceEventId).toBeNull()
    expect(m.approvedAt).toBeNull()
  })
})

describe('MemoryCandidatePromoteSchema', () => {
  test('approve action without tags override', () => {
    expect(MemoryCandidatePromoteSchema.parse({ action: 'approve' })).toEqual({ action: 'approve' })
  })
  test('approve action with tags override', () => {
    expect(
      MemoryCandidatePromoteSchema.parse({ action: 'approve', tagsOverride: ['a', 'b'] }),
    ).toMatchObject({ action: 'approve', tagsOverride: ['a', 'b'] })
  })
  test('approve_and_supersede requires non-empty supersedeIds', () => {
    expect(() =>
      MemoryCandidatePromoteSchema.parse({ action: 'approve_and_supersede', supersedeIds: [] }),
    ).toThrow()
    expect(
      MemoryCandidatePromoteSchema.parse({
        action: 'approve_and_supersede',
        supersedeIds: ['m_001'],
      }),
    ).toMatchObject({ action: 'approve_and_supersede' })
  })
  test('approve_and_supersede caps at 8 ids', () => {
    expect(() =>
      MemoryCandidatePromoteSchema.parse({
        action: 'approve_and_supersede',
        supersedeIds: Array(9).fill('m'),
      }),
    ).toThrow()
  })
  test('reject is a leaf without extra fields', () => {
    expect(MemoryCandidatePromoteSchema.parse({ action: 'reject' })).toEqual({ action: 'reject' })
  })
  test('unknown action rejected', () => {
    expect(() => MemoryCandidatePromoteSchema.parse({ action: 'maybe' })).toThrow()
  })
})

describe('MemoryCreateRequestSchema', () => {
  test('strips trim and accepts minimum payload', () => {
    const r = MemoryCreateRequestSchema.parse({
      scopeType: 'global',
      scopeId: null,
      title: '  hello  ',
      bodyMd: '  body  ',
    })
    expect(r.title).toBe('hello')
    expect(r.bodyMd).toBe('body')
    expect(r.tags).toBeUndefined()
  })
  test('rejects body > 4000', () => {
    expect(() =>
      MemoryCreateRequestSchema.parse({
        scopeType: 'agent',
        scopeId: 'a',
        title: 't',
        bodyMd: 'x'.repeat(4001),
      }),
    ).toThrow()
  })
})

describe('MemoryListFilterSchema', () => {
  test('all fields optional', () => {
    expect(MemoryListFilterSchema.parse({})).toEqual({})
  })
  test('rejects unknown status', () => {
    expect(() => MemoryListFilterSchema.parse({ status: 'nope' })).toThrow()
  })
  test('search trim and length cap 200', () => {
    expect(MemoryListFilterSchema.parse({ search: '  abc  ' }).search).toBe('abc')
    expect(() => MemoryListFilterSchema.parse({ search: 'x'.repeat(201) })).toThrow()
  })
})

describe('ResolvedDistillScopeSchema / MemoryDistillJobSchema', () => {
  test('ResolvedDistillScopeSchema accepts empty arrays + nullable ids', () => {
    expect(
      ResolvedDistillScopeSchema.parse({
        agentIds: [],
        workflowId: null,
        repoId: null,
        includeGlobal: true,
      }),
    ).toBeTruthy()
  })
  test('MemoryDistillJobSchema rejects unknown status', () => {
    expect(() =>
      MemoryDistillJobSchema.parse({
        id: 'j1',
        debounceKey: 't:clarify',
        sourceKind: 'clarify',
        sourceEventId: 's1',
        taskId: 't1',
        scopeResolved: { agentIds: [], workflowId: null, repoId: null, includeGlobal: true },
        status: 'unknown',
        attempts: 0,
        nextRunAt: 1,
        lastError: null,
        createdAt: 1,
        startedAt: null,
        finishedAt: null,
      }),
    ).toThrow()
  })
})
