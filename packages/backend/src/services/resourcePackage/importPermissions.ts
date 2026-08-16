// RFC-271 — dynamic write capability projection shared by preview and commit.
//
// Route middleware cannot know which resource types a package touches. The
// package service therefore computes permissions per entry, and commit must run
// the exact same oracle again against its current Actor.

import type { BundleOp, BundleResourceType, Permission } from '@agent-workflow/shared'
import { resourceTypeOfOp } from '@/services/bundle/provider'

export type PackageWriteAction = 'new' | 'reuse' | 'overwrite'

export const RESOURCE_PACKAGE_WRITE_POINTS: Record<
  BundleResourceType,
  { create: Permission; update: Permission }
> = {
  agent: { create: 'agents:create', update: 'agents:update' },
  skill: { create: 'skills:create', update: 'skills:update' },
  mcp: { create: 'mcps:create', update: 'mcps:update' },
  plugin: { create: 'plugins:create', update: 'plugins:update' },
  workflow: { create: 'workflows:create', update: 'workflows:update' },
  workgroup: { create: 'workgroups:create', update: 'workgroups:update' },
}

export function requiredImportPermissions(op: BundleOp, action: PackageWriteAction): Permission[] {
  if (action === 'reuse') return []
  const type = resourceTypeOfOp(op)
  const required: Permission[] = [
    action === 'new'
      ? RESOURCE_PACKAGE_WRITE_POINTS[type].create
      : RESOURCE_PACKAGE_WRITE_POINTS[type].update,
  ]
  if (type !== 'workflow') return required

  const definition = (op.payload as { definition?: { nodes?: unknown } }).definition
  for (const raw of Array.isArray(definition?.nodes) ? definition.nodes : []) {
    const kind = (raw as { kind?: unknown }).kind
    if (kind === 'script' && !required.includes('scripts:author')) {
      required.push('scripts:author')
    }
    if (kind === 'code-host-call' && !required.includes('code-host-calls:author')) {
      required.push('code-host-calls:author')
    }
  }
  return required
}

export function missingImportPermissions(
  permissions: ReadonlySet<Permission>,
  op: BundleOp,
  action: PackageWriteAction,
): Permission[] {
  return requiredImportPermissions(op, action).filter((point) => !permissions.has(point))
}
