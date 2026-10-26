// RFC-395 II-b W0: X implements; T/N/C/H/P consume. Locks policy and column boundary.
import { describe, expect, expectTypeOf, test } from 'bun:test'
import type { ContentRef } from '@/platform/content/contentRef'
import {
  decodeContentRefColumns,
  encodeContentRefColumns,
} from '@/platform/content/contentRefCodec'
import {
  contentRefColumns,
  contentStorageKind,
  type ContentPublication,
  type ContentStoragePolicy,
  type SkillContentLocationQuery,
  type SkillContentPublicationLocation,
  type SkillContentTree,
} from '@/platform/content/contentStore'
import { sha256Hex } from '@/util/hash'

describe('RFC-395 W0 content contracts', () => {
  test.each(['local-file', 'database-bytes', 'object'] as const)(
    'single inline boundary and shared content use the %s profile correctly',
    (externalKind) => {
      const policy: ContentStoragePolicy = { inlineMaxBytes: 4, externalKind }
      expect(contentStorageKind(policy, { size: 0, references: 'single' })).toBe('inline')
      expect(contentStorageKind(policy, { size: 4, references: 'single' })).toBe('inline')
      expect(contentStorageKind(policy, { size: 5, references: 'single' })).toBe(externalKind)
      expect(contentStorageKind(policy, { size: 0, references: 'shared' })).toBe(externalKind)
      expect(contentStorageKind(policy, { size: 4, references: 'shared' })).toBe(externalKind)
      expect(
        contentStorageKind({ ...policy, inlineMaxBytes: 0 }, { size: 1, references: 'single' }),
      ).toBe(externalKind)
    },
  )

  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'invalid byte counts are not silently routed: %s',
    (value) => {
      expect(() =>
        contentStorageKind(
          { inlineMaxBytes: value, externalKind: 'object' },
          { size: 0, references: 'single' },
        ),
      ).toThrow('content-inline-limit-invalid')
      expect(() =>
        contentStorageKind(
          { inlineMaxBytes: 8, externalKind: 'object' },
          { size: value, references: 'shared' },
        ),
      ).toThrow('content-size-invalid')
    },
  )

  test('the store column boundary uses the existing codec without replacing bytes with text', () => {
    expect(contentRefColumns.encode).toBe(encodeContentRefColumns)
    expect(contentRefColumns.decode).toBe(decodeContentRefColumns)
    for (const bytes of [new Uint8Array(), new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0x00])]) {
      const ref: ContentRef = {
        version: 1,
        kind: 'inline',
        location: { codec: 'inline-bytes', value: null },
        contentId: null,
        contentVersion: 1,
        sha256: sha256Hex(bytes),
        size: bytes.byteLength,
        mediaType: null,
        bytes,
      }
      const columns = contentRefColumns.encode(ref)
      const decoded = contentRefColumns.decode(columns.json, columns.inlineBytes)
      expect(decoded).toEqual(ref)
      expect(columns.inlineBytes).not.toBe(bytes)
    }
    expect(contentRefColumns.decode(null, null)).toBeNull()
    expect(() => contentRefColumns.decode(null, new Uint8Array())).toThrow(
      'content-ref-bytes-without-reference',
    )
  })

  test('publication states and skill recovery locations remain closed and distinguish missing snapshots', () => {
    expectTypeOf<ContentPublication['state']>().toEqualTypeOf<
      'pending' | 'ready' | 'releasing' | 'released'
    >()
    expectTypeOf<
      Extract<ContentPublication, { state: 'ready' }>['contentId']
    >().toEqualTypeOf<string>()
    expectTypeOf<SkillContentTree['kind']>().toEqualTypeOf<
      'live' | 'version' | 'staging' | 'candidate' | 'trash'
    >()
    expectTypeOf<
      Awaited<ReturnType<SkillContentLocationQuery['publication']>>
    >().toEqualTypeOf<SkillContentPublicationLocation | null>()
    expectTypeOf<SkillContentPublicationLocation['snapshot']>().toEqualTypeOf<{
      readonly version: number
      readonly content: ContentRef
      readonly contentHash: string | null
    } | null>()
  })
})
