// RFC-223 PR-7 — frozen subject ids navigate directly to canonical id routes.
// The RFC-177 name resolver and redirect routes are intentionally gone: a
// mutable name must never participate in navigation after same-name resources
// become legal.

import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dirname, '..', 'src')

describe('task subject links are ID-only', () => {
  test('links workgroup and agent subjects directly by frozen id', () => {
    const source = readFileSync(resolve(SRC, 'components', 'TaskSubjectLink.tsx'), 'utf-8')
    expect(source).toContain('to="/workgroups/$id"')
    expect(source).toContain('params={{ id: task.workgroupId }}')
    expect(source).toContain('to="/agents/$id"')
    expect(source).toContain('params={{ id: task.sourceAgentId }}')
    expect(source).not.toContain('useResolveResourceName')
    expect(source).not.toContain('/by-id/')
  })

  test('legacy resolver hook and redirect routes remain deleted', () => {
    expect(existsSync(resolve(SRC, 'hooks', 'useResolveResourceName.ts'))).toBe(false)
    expect(existsSync(resolve(SRC, 'routes', 'workgroups.by-id.tsx'))).toBe(false)
    expect(existsSync(resolve(SRC, 'routes', 'agents.by-id.tsx'))).toBe(false)
  })

  test('router exposes only the canonical id detail routes', () => {
    const source = readFileSync(resolve(SRC, 'router.tsx'), 'utf-8')
    expect(source).toContain('agentDetailRoute')
    expect(source).toContain('workgroupDetailRoute')
    expect(source).not.toContain('AgentByIdRoute')
    expect(source).not.toContain('WorkgroupByIdRoute')
  })
})
