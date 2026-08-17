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
  capability_template: {
    create: 'capability-templates:create',
    update: 'capability-templates:update',
  },
}

export function requiredImportPermissions(op: BundleOp, action: PackageWriteAction): Permission[] {
  if (action === 'reuse') return []
  const type = resourceTypeOfOp(op)
  const required: Permission[] = [
    action === 'new'
      ? RESOURCE_PACKAGE_WRITE_POINTS[type].create
      : RESOURCE_PACKAGE_WRITE_POINTS[type].update,
  ]
  // RFC-304 → RFC-309 — importing a template that CARRIES script or hook bodies
  // writes code that later runs as the daemon, so it needs `scripts:author` the
  // same way the HTTP route does: a package must not be a way around the
  // permission model, only another way to use it.
  //
  // Conditional on the payload, not on the type. Requiring it for every
  // template import would undo the merge's whole point — a template that is
  // just "which agent reviews" would need the daemon grant to import, and the
  // group that owns it could not move it between instances.
  if (type === 'capability_template' && !required.includes('scripts:author')) {
    const payload = op.payload as { scripts?: unknown; hooks?: unknown }
    const carriesScripts =
      (typeof payload.scripts === 'object' &&
        payload.scripts !== null &&
        Object.keys(payload.scripts as Record<string, unknown>).length > 0) ||
      (Array.isArray(payload.hooks) && payload.hooks.length > 0)
    if (carriesScripts) required.push('scripts:author')
  }
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
