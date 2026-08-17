// RFC-304 T17a/T17b — the two capability template layers in a config package.
//
// The RFC's own risk table flagged this as a cross-subsystem project that
// should be accepted independently before anything depending on it started —
// it touches the type enum, the payloads, the BundleOp union, closure
// resolution, serialization, preview, the commit provider and the importer.
// This file is the acceptance for the parts a compiler cannot check.
//
// Two properties carry most of the weight:
//
//   the CLOSURE. A binding references its framework and the agents filling its
//   slots. The extractor's default is an empty list rather than a missing case,
//   so a forgotten arm produces an export whose binding points at a framework
//   that is not in the package — and the failure surfaces on IMPORT, on
//   somebody else's instance.
//
//   the PERMISSION. Importing a framework writes script bodies that later run
//   as the daemon. The package path never passes through the HTTP route, so a
//   rule enforced only there would make a package a way AROUND the permission
//   model rather than another way to use it.

import { describe, expect, test } from 'bun:test'
import {
  BUNDLE_RESOURCE_TYPES,
  BundleOpSchema,
  BUNDLE_OP_KINDS,
  INTENT_RESOURCE_TYPES,
  asIntentResourceType,
  type Permission,
} from '@agent-workflow/shared'
import { requiredImportPermissions } from '../src/services/resourcePackage/importPermissions'
import { resourceTypeOfOp } from '../src/services/bundle/provider'

const frameworkCreate = {
  opId: 'op-1',
  kind: 'capability-framework-create' as const,
  slug: 'gitlab-standard',
  payload: {
    name: 'gitlab standard',
    capability: 'mr-review',
    scripts: { collect: { language: 'node', script: 'console.log(1)' } },
  },
}

const bindingCreate = {
  opId: 'op-2',
  kind: 'capability-binding-create' as const,
  slug: 'team-review',
  payload: {
    name: 'team review',
    frameworkRef: 'local:gitlab-standard',
    agentBySlot: { reviewer: 'local:auditor' },
  },
}

describe('RFC-304 T17a — the bundle union admits both layers', () => {
  test('all four op kinds parse', () => {
    expect(BundleOpSchema.safeParse(frameworkCreate).success).toBe(true)
    expect(BundleOpSchema.safeParse(bindingCreate).success).toBe(true)
    expect(BUNDLE_OP_KINDS).toContain('capability-framework-update')
    expect(BUNDLE_OP_KINDS).toContain('capability-binding-update')
  })

  test('a binding payload carrying `scripts` is REJECTED', () => {
    // The layer boundary, restated on the package path. A package that could
    // smuggle scripts into the group layer would be a way around the permission
    // model rather than another way to use it — and `.strict()` is what makes
    // that structural rather than a check somebody must remember.
    const smuggled = {
      ...bindingCreate,
      payload: { ...bindingCreate.payload, scripts: { collect: {} } },
    }
    expect(BundleOpSchema.safeParse(smuggled).success).toBe(false)
  })

  test('a binding payload carrying `hooks` is rejected too', () => {
    const smuggled = {
      ...bindingCreate,
      payload: { ...bindingCreate.payload, hooks: [{ stage: 'publish' }] },
    }
    expect(BundleOpSchema.safeParse(smuggled).success).toBe(false)
  })

  test('op kinds map to the right resource types', () => {
    expect(resourceTypeOfOp(BundleOpSchema.parse(frameworkCreate))).toBe('capability_template')
    expect(resourceTypeOfOp(BundleOpSchema.parse(bindingCreate))).toBe('capability_template')
  })
})

describe('RFC-304 T17a — the two type sets have genuinely diverged', () => {
  test('packages carry the template layers', () => {
    expect(BUNDLE_RESOURCE_TYPES).toContain('capability_template')
    expect(BUNDLE_RESOURCE_TYPES).toContain('capability_template')
  })

  test('Intent sessions still cannot create them', () => {
    // The reason the two constants were separated in the first place. They were
    // the same six until now; `asIntentResourceType` used to be a plain alias
    // of the bundle guard, with a note saying it would become a real function
    // the day they diverged. This is that day, and it was a one-line change
    // rather than a hunt through every "bundle" call that meant "intent".
    expect(INTENT_RESOURCE_TYPES).not.toContain('capability_template')
    expect(INTENT_RESOURCE_TYPES).not.toContain('capability_template')
    expect(asIntentResourceType('capability_template')).toBeNull()
    expect(asIntentResourceType('agent')).toBe('agent')
  })
})

describe('RFC-304 T17b — importing a framework needs scripts:author', () => {
  const has = (points: Permission[], want: Permission): boolean => points.includes(want)

  test('a framework create requires BOTH the create point and scripts:author', () => {
    // The package path never passes through the HTTP route, so leaving the
    // two-factor rule to the route would make an import a way around it.
    const required = requiredImportPermissions(BundleOpSchema.parse(frameworkCreate), 'new')
    expect(has(required, 'capability-templates:create')).toBe(true)
    expect(has(required, 'scripts:author')).toBe(true)
  })

  test('a framework UPDATE requires it too', () => {
    const op = BundleOpSchema.parse({
      opId: 'op-1',
      kind: 'capability-framework-update',
      target: 'external:fw-1',
      expect: { expectedUpdatedAt: 1, expectedAclRevision: 0 },
      payload: frameworkCreate.payload,
    })
    const required = requiredImportPermissions(op, 'overwrite')
    expect(has(required, 'capability-templates:update')).toBe(true)
    expect(has(required, 'scripts:author')).toBe(true)
  })

  test('a BINDING needs no script authority — that is the point of the split', () => {
    // A group lead must be able to import a team template without being handed
    // the daemon's credential surface, or the two layers collapse into one.
    const required = requiredImportPermissions(BundleOpSchema.parse(bindingCreate), 'new')
    expect(has(required, 'capability-templates:create')).toBe(true)
    expect(has(required, 'scripts:author')).toBe(false)
  })

  test('reuse requires nothing at all', () => {
    // Reuse writes no bytes; requiring a write point for it would block an
    // import that changes nothing.
    expect(requiredImportPermissions(BundleOpSchema.parse(frameworkCreate), 'reuse')).toEqual([])
  })
})
