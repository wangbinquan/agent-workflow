// RFC-201 T10.2 — Plugin full-row exact operation revision golden lock.

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { Plugin } from '../src/schemas/plugin'
import {
  pluginOperationConfigHashWith,
  projectPluginOperationConfigV1,
  serializePluginOperationConfigV1,
} from '../src/plugin-operation'

function fixture(): Plugin {
  return {
    id: '01PLUGIN',
    name: 'example',
    spec: 'example@1',
    options: { nested: { z: 2, a: 1 } },
    description: 'example plugin',
    ownerUserId: 'u1',
    visibility: 'private',
    aclRevision: 3,
    enabled: true,
    sourceKind: 'npm',
    cachedPath: '/plugins/01PLUGIN/generations/01OP/node_modules/example',
    resolvedVersion: '1.0.0',
    installedAt: 100,
    schemaVersion: 1,
    createdAt: 90,
    updatedAt: 110,
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

describe('RFC-201 Plugin exact operation revision', () => {
  test('projector explicitly locks every persisted Plugin row field', () => {
    expect(Object.keys(projectPluginOperationConfigV1(fixture())).sort()).toEqual(
      [
        'id',
        'name',
        'spec',
        'options',
        'description',
        'ownerUserId',
        'visibility',
        'aclRevision',
        'enabled',
        'sourceKind',
        'cachedPath',
        'resolvedVersion',
        'installedAt',
        'schemaVersion',
        'createdAt',
        'updatedAt',
      ].sort(),
    )
  })

  test('canonicalizes options and domain-separates the digest', () => {
    const a = fixture()
    const b = { ...a, options: { nested: { a: 1, z: 2 } } }
    expect(serializePluginOperationConfigV1(a)).toBe(serializePluginOperationConfigV1(b))
    expect(pluginOperationConfigHashWith(a, sha256)).toMatch(/^[a-f0-9]{64}$/)
  })

  test('every mutable row dimension changes the revision', () => {
    const base = fixture()
    const hash = pluginOperationConfigHashWith(base, sha256)
    const variants: Plugin[] = [
      { ...base, id: '01OTHER' },
      { ...base, name: 'renamed' },
      { ...base, spec: 'example@2' },
      { ...base, options: { other: true } },
      { ...base, description: 'changed' },
      { ...base, ownerUserId: 'u2' },
      { ...base, visibility: 'public' },
      { ...base, aclRevision: 4 },
      { ...base, enabled: false },
      { ...base, sourceKind: 'git' },
      { ...base, cachedPath: '/another-generation' },
      { ...base, resolvedVersion: '2.0.0' },
      { ...base, installedAt: 101 },
      { ...base, schemaVersion: 2 },
      { ...base, createdAt: 91 },
      { ...base, updatedAt: 111 },
    ]
    for (const variant of variants) {
      expect(pluginOperationConfigHashWith(variant, sha256)).not.toBe(hash)
    }
  })
})
