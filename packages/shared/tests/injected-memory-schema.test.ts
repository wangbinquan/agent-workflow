// RFC-046 — locks zod boundary cases for InjectedMemorySnapshotSchema and
// the optional `injectedMemories` field on NodeRunSchema. Existing without
// the field on the input must still parse so older API responses (or any
// caller using the schema as a passthrough decoder) keep working.

import { describe, expect, test } from 'bun:test'
import { InjectedMemorySnapshotSchema } from '../src/schemas/memory'
import { NodeRunSchema } from '../src/schemas/task'

const VALID_SNAPSHOT = {
  id: 'mem_01JABC',
  version: 1,
  scopeType: 'agent' as const,
  scopeId: 'agent_xyz',
  title: 'prefer functional components',
  bodyMd: 'Default to function components with hooks.',
  tags: ['react', 'frontend'],
  sourceKind: 'review',
  approvedAt: 1_700_000_000_000,
}

const BASE_RUN = {
  seq: 1,
  id: 'run_01JABCDEF',
  taskId: 't_001',
  nodeId: 'agent-1',
  parentNodeRunId: null,
  iteration: 0,
  shardKey: null,
  retryIndex: 0,
  reviewIteration: 0,
  clarifyIteration: 0,
  status: 'done' as const,
  startedAt: 1,
  finishedAt: 2,
  pid: 1000,
  exitCode: 0,
  errorMessage: null,
  promptText: null,
  tokInput: null,
  tokOutput: null,
  tokTotal: null,
  tokCacheCreate: null,
  tokCacheRead: null,
  opencodeSessionId: null,
}

describe('InjectedMemorySnapshotSchema', () => {
  test('S1: round-trip a valid snapshot', () => {
    const parsed = InjectedMemorySnapshotSchema.parse(VALID_SNAPSHOT)
    expect(parsed.id).toBe('mem_01JABC')
    expect(parsed.scopeType).toBe('agent')
    expect(parsed.scopeId).toBe('agent_xyz')
    expect(parsed.tags).toEqual(['react', 'frontend'])
    expect(parsed.approvedAt).toBe(1_700_000_000_000)
  })

  test('S2: scopeId nullable across all scopeTypes (validation is the DB / route layer responsibility)', () => {
    // Snapshot schema deliberately does NOT enforce the
    // global<>scopeId=null pairing — that lives in MemorySchema /
    // MemoryCreateRequestSchema. Snapshots are runtime audit records of
    // whatever the runner saw; if a malformed row ever slips into memories
    // we still want to record it verbatim rather than refuse to parse.
    const okGlobal = InjectedMemorySnapshotSchema.parse({
      ...VALID_SNAPSHOT,
      scopeType: 'global' as const,
      scopeId: null,
    })
    expect(okGlobal.scopeType).toBe('global')

    const okAgentNullId = InjectedMemorySnapshotSchema.parse({
      ...VALID_SNAPSHOT,
      scopeId: null,
    })
    expect(okAgentNullId.scopeId).toBeNull()
  })

  test('S3: tags 17 entries → reject (mirrors MemorySchema 16-tag ceiling)', () => {
    const tooManyTags = Array.from({ length: 17 }, (_, i) => `t${i}`)
    expect(() =>
      InjectedMemorySnapshotSchema.parse({ ...VALID_SNAPSHOT, tags: tooManyTags }),
    ).toThrow()
  })

  test('S4: bogus scopeType → reject', () => {
    expect(() =>
      InjectedMemorySnapshotSchema.parse({ ...VALID_SNAPSHOT, scopeType: 'project' }),
    ).toThrow()
  })

  test('S5: NodeRunSchema parses a legacy row without injectedMemories (back-compat)', () => {
    const parsed = NodeRunSchema.parse(BASE_RUN)
    expect(parsed.injectedMemories).toBeUndefined()
  })

  test('S6: NodeRunSchema accepts injectedMemories=[snapshot]', () => {
    const parsed = NodeRunSchema.parse({
      ...BASE_RUN,
      injectedMemories: [VALID_SNAPSHOT],
    })
    expect(parsed.injectedMemories?.length).toBe(1)
    expect(parsed.injectedMemories?.[0]?.id).toBe('mem_01JABC')
  })

  test('S7: NodeRunSchema accepts injectedMemories=null explicitly', () => {
    const parsed = NodeRunSchema.parse({ ...BASE_RUN, injectedMemories: null })
    expect(parsed.injectedMemories).toBeNull()
  })
})
