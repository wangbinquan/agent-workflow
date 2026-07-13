// RFC-151 PR-1 — skillCapabilities capability-table lock.
// RFC-170 (G5-P2) — re-keyed off `authorityKind` (three-state) so the two
// external flavours are no longer conflated. This test locks the FULL table so
// a future authority (or a capability split, e.g. external skills becoming
// fusable) is a deliberate edit here — not an accidental drift at one of the
// consumption sites.
//
// The three-state contract (design.md:40, :183):
//   authorityKind    | content | description | delete | transferOwner
//   managed          |   ✓     |     ✓       |   ✓    |      ✓
//   source-external  |   ✗     |     ✗       |   ✓    |      ✗
//   hand-external    |   ✗     |     ✓       |   ✓    |      ✗

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  authorityKindOf,
  skillCapabilities,
  skillCapabilitiesOf,
} from '../src/lib/skill-capabilities'

describe('skillCapabilities — three-state table lock', () => {
  test('managed → every capability granted', () => {
    expect(skillCapabilities('managed')).toEqual({
      canFuse: true,
      canEditContent: true,
      canBrowseFilesWritable: true,
      showManagedHint: true,
      showVersionHistory: true,
      canEditDescription: true,
      canDelete: true,
      canTransferOwner: true,
    })
  })

  test('source-external → read-only content AND description, no owner transfer', () => {
    expect(skillCapabilities('source-external')).toEqual({
      canFuse: false,
      canEditContent: false,
      canBrowseFilesWritable: false,
      showManagedHint: false,
      showVersionHistory: false,
      canEditDescription: false, // the source dir owns the metadata
      canDelete: true,
      canTransferOwner: false,
    })
  })

  test('hand-external → DB description editable, but no content/fuse/transfer', () => {
    expect(skillCapabilities('hand-external')).toEqual({
      canFuse: false,
      canEditContent: false,
      canBrowseFilesWritable: false,
      showManagedHint: false,
      showVersionHistory: false,
      canEditDescription: true, // DB metadata IS editable for hand-imported
      canDelete: true,
      canTransferOwner: false, // the importer controls on-disk content
    })
  })

  test('owner transfer is a managed-only privilege (both external flavours blocked)', () => {
    expect(skillCapabilities('managed').canTransferOwner).toBe(true)
    expect(skillCapabilities('source-external').canTransferOwner).toBe(false)
    expect(skillCapabilities('hand-external').canTransferOwner).toBe(false)
  })
})

describe('authorityKindOf — bridges pre-RFC-170 sourceKind-only payloads', () => {
  test('an explicit authorityKind wins', () => {
    expect(authorityKindOf({ sourceKind: 'external', authorityKind: 'source-external' })).toBe(
      'source-external',
    )
    expect(authorityKindOf({ sourceKind: 'managed', authorityKind: 'managed' })).toBe('managed')
  })

  test('absent authorityKind falls back: managed→managed, external→hand-external', () => {
    expect(authorityKindOf({ sourceKind: 'managed' })).toBe('managed')
    // hand-external is the more-permissive external fallback (description stays
    // editable); owner transfer is blocked for both external flavours regardless.
    expect(authorityKindOf({ sourceKind: 'external' })).toBe('hand-external')
  })

  test('skillCapabilitiesOf composes the resolver + table', () => {
    const managed = skillCapabilitiesOf({
      id: 'x',
      name: 'x',
      description: '',
      sourceKind: 'managed',
      authorityKind: 'managed',
      schemaVersion: 1,
      contentVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    })
    expect(managed.canTransferOwner).toBe(true)
    expect(managed.canEditContent).toBe(true)
  })
})

describe('skills.detail consumes capability bits, not a scattered isManaged flag', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'skills.detail.tsx'), 'utf8')

  test('imports the capability helpers and reads caps.*', () => {
    expect(src).toContain('skillCapabilitiesOf')
    expect(src).toContain("from '@/lib/skill-capabilities'")
    for (const bit of [
      'caps.canFuse',
      'caps.canEditContent',
      'caps.canBrowseFilesWritable',
      'caps.showManagedHint',
      'caps.showVersionHistory',
      // RFC-170 three-state additions consumed by the page:
      'caps.canEditDescription', // description field disabled gate
      'caps.canTransferOwner', // AclDialogButton transfer control gate
    ]) {
      expect(src.includes(bit), `skills.detail.tsx must read ${bit}`).toBe(true)
    }
  })

  test('the local isManaged alias is gone', () => {
    // The header chip may still *display* the raw sourceKind (that is data,
    // not a capability gate); what must not come back is the derived boolean.
    expect(src.includes('isManaged')).toBe(false)
  })
})
