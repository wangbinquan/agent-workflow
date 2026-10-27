// RFC-395 CIP-A: page commits keep every byte/index and roll back a failed page.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStagingStore } from '@/platform/persistence/migration/conversion/staging'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'

const source = (id: string, group: string): SourceRow => {
  const key = [canonicalValue(id)]
  return {
    table: 'fixture',
    phase: 'current',
    key,
    encodedKey: encodeMigrationKey('fixture', key),
    canonical: {
      key,
      values: [canonicalValue(' original\r\n'), canonicalValue(9007199254740993n)],
    },
    values: { id, group, bytes: new Uint8Array([0, 255]), integer: 9007199254740993n, value: -0 },
  }
}
test('page insertion equals sequential insertion and failed pages retain neither rows nor group entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-r395-staging-page-'))
  const batch = createStagingStore(root),
    sequential = createStagingStore(root)
  try {
    const retained = source('retained', 'old')
    batch.put(retained)
    sequential.put(retained)
    expect(batch.groupKeys('fixture', 'group')).toEqual(['old'])
    const rows = Array.from({ length: 1000 }, (_, index) =>
      source(String(index), index % 2 ? 'é' : '中'),
    )
    batch.putMany(rows)
    for (const row of rows) sequential.put(row)
    expect(batch.digest()).toBe(sequential.digest())
    expect([...batch.rows('fixture')]).toEqual([...sequential.rows('fixture')])
    expect(batch.group('fixture', 'group', 'é')).toHaveLength(500)
    expect(batch.group('fixture', 'group', '中')).toHaveLength(500)
    const before = batch.digest()
    expect(() => batch.putMany([source('new', 'discarded'), retained])).toThrow()
    expect(batch.digest()).toBe(before)
    expect(batch.count('fixture')).toBe(1001)
    expect(batch.group('fixture', 'group', 'discarded')).toEqual([])
    expect(batch.get('fixture', source('new', '').encodedKey)).toBeUndefined()
    batch.putMany([])
    expect(batch.digest()).toBe(before)
    batch.putMany([{ ...source('next', 'later'), phase: 'pre-upgrade' }])
    expect(batch.group('fixture', 'group', 'later', 'pre-upgrade')).toHaveLength(1)
    expect(batch.count('fixture')).toBe(1001)
  } finally {
    batch.close()
    sequential.close()
    rmSync(root, { recursive: true, force: true })
  }
})
