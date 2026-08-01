// RFC-247 — locks the per-route verb mapping (design §2.3).
//
// Why this file exists: before RFC-247 a single `资源:write` point covered
// POST/PUT/PATCH/DELETE alike, so "may modify but not delete" was inexpressible
// — the exact thing a self-issued API token has to be able to say. The split
// only holds if every route lands on the RIGHT verb, and the failure mode is
// silent: a route mapped to `create` instead of `update` hands a create-only
// token the ability to overwrite existing resources.
//
// Every row here is one line of the design's mapping table. If you add a route
// whose verb is not the naive method mapping, add it to VERB_OVERRIDES *and*
// add a row here — the pair is the contract.

import { describe, expect, test } from 'bun:test'
import { verbForRoute } from '@/auth/permissions'

type Verb = ReturnType<typeof verbForRoute>

describe('RFC-247 verbForRoute — naive method mapping', () => {
  const cases: ReadonlyArray<[string, string, Verb]> = [
    ['GET', '/api/agents', 'read'],
    ['GET', '/api/agents/abc', 'read'],
    ['HEAD', '/api/agents', 'read'],
    ['POST', '/api/agents', 'create'],
    ['PUT', '/api/agents/abc', 'update'],
    ['PATCH', '/api/memories/abc', 'update'],
    ['DELETE', '/api/agents/abc', 'delete'],
    // rule ①: DELETE stays `delete` even for a nested, "edit-ish" target.
    // Deleting one file out of a skill is still a DELETE — the design keeps the
    // rule mechanically checkable rather than arguing about intent per route.
    ['DELETE', '/api/skills/abc/file', 'delete'],
  ]
  for (const [method, path, expected] of cases) {
    test(`${method} ${path} → ${expected}`, () => {
      expect(verbForRoute(method, path)).toBe(expected)
    })
  }
})

describe('RFC-247 verbForRoute — rule ②: side-effect-free POSTs', () => {
  // No persisted write. `read` when nothing external is consumed, `execute`
  // when real work runs (network / subprocess / model). The distinction matters:
  // a read-only token may preview, but must not make the daemon do work.
  const readish: ReadonlyArray<string> = [
    '/api/agents/import-resolve',
    '/api/agents/closure-preview',
    '/api/skills/import-zip/parse',
  ]
  for (const path of readish) {
    test(`POST ${path} → read (pure resolve, nothing external)`, () => {
      expect(verbForRoute('POST', path)).toBe('read')
    })
  }

  const executish: ReadonlyArray<string> = [
    '/api/workflows/wf1/validate',
    '/api/workflows/wf1/validate-draft',
    '/api/plugins/p1/check-update',
    '/api/mcps/m1/probe',
    '/api/mcps/m1/runtime-test-sessions',
    '/api/mcps/m1/runtime-test-sessions/s1/messages',
  ]
  for (const path of executish) {
    test(`POST ${path} → execute (runs real work)`, () => {
      expect(verbForRoute('POST', path)).toBe('execute')
    })
  }
})

describe('RFC-247 verbForRoute — rule ③: POSTs that are not creates', () => {
  const updates: ReadonlyArray<string> = [
    '/api/agents/a1/rename',
    '/api/mcps/m1/rename',
    '/api/plugins/p1/rename',
    '/api/workgroups/g1/rename',
    '/api/plugins/p1/upgrade',
    '/api/skills/s1/save',
    '/api/skills/s1/versions/3/restore',
  ]
  for (const path of updates) {
    test(`POST ${path} → update (mutates an existing resource)`, () => {
      expect(verbForRoute('POST', path)).toBe('update')
    })
  }

  const creates: ReadonlyArray<string> = [
    '/api/skills/import-zip/commit',
    '/api/workflows/import',
    '/api/workflows/wf1/copy',
    '/api/workgroups/g1/copy',
  ]
  for (const path of creates) {
    test(`POST ${path} → create (really produces a new resource)`, () => {
      expect(verbForRoute('POST', path)).toBe('create')
    })
  }
})

describe('RFC-247 verbForRoute — the traps', () => {
  test('rename is NOT create — a create-only token must not be able to rename', () => {
    // Naive `POST → create` would hand a create-only token the ability to
    // rename every agent it can see, which is a modification.
    expect(verbForRoute('POST', '/api/agents/a1/rename')).not.toBe('create')
  })

  test('copy IS create — it produces a new owned resource, not an edit', () => {
    expect(verbForRoute('POST', '/api/workflows/wf1/copy')).toBe('create')
  })

  test('validate is NOT read — it makes the daemon run a pipeline', () => {
    expect(verbForRoute('POST', '/api/workflows/wf1/validate')).toBe('execute')
  })

  test('closure-preview IS read — pure in-memory graph resolution', () => {
    expect(verbForRoute('POST', '/api/agents/closure-preview')).toBe('read')
  })

  test('an override never leaks across resources with a similar path shape', () => {
    // `/api/skills/:id/save` is an update; there is no such route on agents, and
    // the override must not fire for it.
    expect(verbForRoute('POST', '/api/agents/a1/save')).toBe('create')
  })

  test('unknown nested POSTs fall through to create rather than throwing', () => {
    expect(verbForRoute('POST', '/api/agents/a1/some-future-action')).toBe('create')
  })
})
