// RFC-253 — the `scripts:author` gate.
//
// Locks the two properties that make this gate meaningful rather than
// decorative:
//   1. it is keyed on the SENSITIVE PROJECTION, so ordinary editing of a
//      workflow that happens to contain a script stays open to everyone;
//   2. the point is a SYSTEM-domain point, so no PAT — however broadly
//      granted — can ever carry it (AC-26). A leaked token must not become
//      host code execution.

import { describe, expect, test } from 'bun:test'
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  SYSTEM_DOMAIN_POINTS,
  resolveTokenPermissions,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { assertScriptAuthorAllowed } from '@/services/scriptAuthorGate'
import { ForbiddenError } from '@/util/errors'

/** Minimal Actor shape the gate reads: nothing but the permission set. */
function principalWith(perms: readonly string[]) {
  return {
    kind: 'actor' as const,
    actor: { permissions: new Set(perms) } as never,
  }
}

function def(nodes: WorkflowNode[], edges: WorkflowDefinition['edges'] = []): WorkflowDefinition {
  return { $schema_version: 4, inputs: [], nodes, edges }
}

const scriptNode = { id: 's1', kind: 'script', language: 'bash', script: 'echo hi' } as WorkflowNode
const agentNode = { id: 'a1', kind: 'agent-single', agentId: 'AG1' } as WorkflowNode

describe('permission catalog placement', () => {
  test('scripts:author exists and is a system-domain point', () => {
    expect(PERMISSIONS).toContain('scripts:author')
    expect(SYSTEM_DOMAIN_POINTS).toContain('scripts:author')
  })

  test('admin and manager hold it; a plain user does not', () => {
    expect(ROLE_PERMISSIONS.admin).toContain('scripts:author')
    expect(ROLE_PERMISSIONS.manager).toContain('scripts:author')
    expect(ROLE_PERMISSIONS.user).not.toContain('scripts:author')
  })

  test('no token can carry it, even one granted every point (AC-26)', () => {
    for (const role of ['admin', 'manager', 'user'] as const) {
      const granted = resolveTokenPermissions({
        role,
        matrix: [...PERMISSIONS],
      })
      expect(granted.has('scripts:author')).toBe(false)
    }
  })

  test('system-domain does NOT imply admin-only — the orthogonality lock', () => {
    // `account:self` / `intent:*` are system-domain points that live in the USER
    // baseline. Anyone reading "system domain" as "admin only" and rewriting the
    // manager grant on that basis should go red here.
    expect(SYSTEM_DOMAIN_POINTS).toContain('account:self')
    expect(ROLE_PERMISSIONS.user).toContain('account:self')
  })
})

describe('gate decisions', () => {
  const withScript = def([scriptNode, agentNode])
  const noScript = def([agentNode])
  const unprivileged = principalWith(['workflows:update'])
  const privileged = principalWith(['workflows:update', 'scripts:author'])

  test('creating a definition containing a script requires the point', () => {
    expect(() => assertScriptAuthorAllowed({ next: withScript, principal: unprivileged })).toThrow(
      ForbiddenError,
    )
    expect(() =>
      assertScriptAuthorAllowed({ next: withScript, principal: privileged }),
    ).not.toThrow()
  })

  test('a definition with no script node never consults the point', () => {
    expect(() =>
      assertScriptAuthorAllowed({ next: noScript, principal: unprivileged }),
    ).not.toThrow()
  })

  test('changing the body requires the point', () => {
    const edited = def([
      {
        ...(scriptNode as unknown as Record<string, unknown>),
        script: 'rm -rf /',
      } as unknown as WorkflowNode,
      agentNode,
    ])
    expect(() =>
      assertScriptAuthorAllowed({ next: edited, previous: withScript, principal: unprivileged }),
    ).toThrow(ForbiddenError)
  })

  test('cosmetic edits do not require the point', () => {
    const moved = def([
      {
        ...(scriptNode as unknown as Record<string, unknown>),
        position: { x: 9, y: 9 },
        title: 'renamed',
      } as unknown as WorkflowNode,
      agentNode,
    ])
    expect(() =>
      assertScriptAuthorAllowed({ next: moved, previous: withScript, principal: unprivileged }),
    ).not.toThrow()
  })

  test('rewiring the script’s inbound edge requires the point', () => {
    const rewired = def(
      [scriptNode, agentNode],
      [
        {
          id: 'e1',
          source: { nodeId: 'a1', portName: 'out' },
          target: { nodeId: 's1', portName: 'data' },
        },
      ],
    )
    expect(() =>
      assertScriptAuthorAllowed({ next: rewired, previous: withScript, principal: unprivileged }),
    ).toThrow(ForbiddenError)
  })

  test('deleting the script node requires the point', () => {
    expect(() =>
      assertScriptAuthorAllowed({ next: noScript, previous: withScript, principal: unprivileged }),
    ).toThrow(ForbiddenError)
  })

  test('a verbatim copy is allowed without the point (D21)', () => {
    expect(() =>
      assertScriptAuthorAllowed({ next: withScript, principal: { kind: 'verbatim-copy' } }),
    ).not.toThrow()
  })

  test('the error names the permission so the 403 is actionable', () => {
    try {
      assertScriptAuthorAllowed({ next: withScript, principal: unprivileged })
      throw new Error('expected a ForbiddenError')
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError)
      expect((err as ForbiddenError).code).toBe('script-author-forbidden')
      expect((err as Error).message).toContain('scripts:author')
    }
  })
})
