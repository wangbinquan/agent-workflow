// RFC-083 PR-E — SCIP indexer discovery (pure table + a real `--version` probe
// of a definitely-absent binary). No real indexer needed.

import { describe, expect, test } from 'bun:test'
import {
  INDEXER_SPECS,
  indexersForFiles,
  resolveIndexerBin,
} from '../src/modules/workspace-insight/domain/deep/indexers'
import { probeIndexer } from '../src/modules/workspace-insight/infrastructure/deep/indexerProbe'

describe('indexersForFiles (ext → indexer)', () => {
  test('maps each language to its indexer', () => {
    expect(indexersForFiles(['a.ts'])).toEqual(['scip-typescript'])
    expect(indexersForFiles(['a.tsx', 'b.js'])).toEqual(['scip-typescript'])
    expect(indexersForFiles(['a.py'])).toEqual(['scip-python'])
    expect(indexersForFiles(['a.go'])).toEqual(['scip-go'])
    expect(indexersForFiles(['a.rs'])).toEqual(['rust-analyzer'])
    expect(indexersForFiles(['a.cpp'])).toEqual(['scip-clang'])
    expect(indexersForFiles(['A.java'])).toEqual(['scip-java'])
    expect(indexersForFiles(['A.scala'])).toEqual(['scip-java'])
  })

  test('multiple languages → the full set', () => {
    expect(new Set(indexersForFiles(['a.ts', 'b.py']))).toEqual(
      new Set(['scip-typescript', 'scip-python']),
    )
  })

  test('unsupported / extensionless paths → nothing, no throw', () => {
    expect(indexersForFiles(['README', 'data.bin', 'Makefile'])).toEqual([])
  })
})

describe('resolveIndexerBin', () => {
  test('settings override wins over the default PATH binary', () => {
    const spec = INDEXER_SPECS['scip-typescript']
    expect(resolveIndexerBin(spec)).toBe('scip-typescript')
    expect(resolveIndexerBin(spec, { scipTypescript: '/opt/bin/scip-ts' })).toBe('/opt/bin/scip-ts')
    expect(resolveIndexerBin(spec, { scipTypescript: '' })).toBe('scip-typescript') // empty = ignore
  })
})

describe('probeIndexer', () => {
  test('a non-existent binary → available:false, version:null (never throws)', async () => {
    const spec = INDEXER_SPECS['scip-typescript']
    const probe = await probeIndexer(spec, { scipTypescript: '/nonexistent/scip-xyz-123' })
    expect(probe.available).toBe(false)
    expect(probe.version).toBeNull()
  })
})
