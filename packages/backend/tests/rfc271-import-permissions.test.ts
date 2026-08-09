// RFC-271 dynamic import permissions: preview and commit share this oracle.

import { describe, expect, test } from 'bun:test'
import type { BundleOp, Permission } from '@agent-workflow/shared'
import {
  missingImportPermissions,
  requiredImportPermissions,
} from '../src/services/resourcePackage/importPermissions'

const op = (kind: BundleOp['kind'], payload: Record<string, unknown> = {}): BundleOp =>
  ({ opId: 'op-1', kind, slug: 'entry', payload }) as BundleOp

describe('RFC271 import permission oracle', () => {
  const workflowPayload = {
    definition: {
      nodes: [
        { id: 'script', kind: 'script' },
        { id: 'host', kind: 'code-host-call' },
      ],
    },
  }

  const cases: Array<{
    type: string
    kind: BundleOp['kind']
    create: Permission
    update: Permission
    author?: Permission[]
    payload?: Record<string, unknown>
  }> = [
    { type: 'agent', kind: 'agent-create', create: 'agents:create', update: 'agents:update' },
    { type: 'skill', kind: 'skill-create', create: 'skills:create', update: 'skills:update' },
    { type: 'mcp', kind: 'mcp-create', create: 'mcps:create', update: 'mcps:update' },
    {
      type: 'plugin',
      kind: 'plugin-create',
      create: 'plugins:create',
      update: 'plugins:update',
    },
    {
      type: 'workflow',
      kind: 'workflow-create',
      create: 'workflows:create',
      update: 'workflows:update',
      author: ['scripts:author', 'code-host-calls:author'],
      payload: workflowPayload,
    },
    {
      type: 'workgroup',
      kind: 'workgroup-create',
      create: 'workgroups:create',
      update: 'workgroups:update',
    },
  ]

  for (const permissionCase of cases) {
    test(`${permissionCase.type} new/overwrite use the exact resource permission points`, () => {
      const resource = op(permissionCase.kind, permissionCase.payload)
      const author = permissionCase.author ?? []
      expect(requiredImportPermissions(resource, 'new')).toEqual([permissionCase.create, ...author])
      expect(requiredImportPermissions(resource, 'overwrite')).toEqual([
        permissionCase.update,
        ...author,
      ])
      expect(requiredImportPermissions(resource, 'reuse')).toEqual([])
    })
  }

  test('workflow executable content adds both independent author axes', () => {
    const workflow = op('workflow-create', workflowPayload)
    expect(
      missingImportPermissions(
        new Set<Permission>(['workflows:create', 'scripts:author']),
        workflow,
        'new',
      ),
    ).toEqual(['code-host-calls:author'])
    expect(
      missingImportPermissions(new Set<Permission>(['workflows:update']), workflow, 'overwrite'),
    ).toEqual(['scripts:author', 'code-host-calls:author'])
  })
})
