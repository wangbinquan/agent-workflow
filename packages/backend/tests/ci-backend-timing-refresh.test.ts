// RFC-611: incomplete timing artifacts must never silently remove or misweight test coverage.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assertSuccessfulTimingSource,
  assertSafeBackendTimingUploads,
  mergeBackendTimings,
  projectBackendTimings,
} from '../../../scripts/ci/refresh-backend-timings'

const a = 'packages/backend/tests/a.test.ts'
const b = 'packages/backend/tests/helpers/model/b.spec.ts'
const c = 'packages/backend/tests/new.test.ts'
const shard = (index: number, files: Record<string, number>) => ({
  shard: index,
  data: { version: 1, files },
})

describe('measured backend timing refresh', () => {
  test('a green rerun cannot reuse legacy failed timing uploads', () => {
    const legacy = `\n  test-backend:\n      - name: Upload measured backend test timings (ubuntu shards)\n        if: (success() || failure()) && matrix.os == 'ubuntu-latest'\n        uses: actions/upload-artifact@v6\n`
    expect(() => assertSafeBackendTimingUploads(legacy, 1)).not.toThrow()
    expect(() => assertSafeBackendTimingUploads(legacy, 2)).toThrow('failed samples')
    const safe = legacy.replace('(success() || failure())', 'success()')
    expect(() => assertSafeBackendTimingUploads(safe, 2)).not.toThrow()
    for (const attempt of [0, -1, NaN, 1.5])
      expect(() => assertSafeBackendTimingUploads(safe, attempt)).toThrow('run attempt')
    expect(() => assertSafeBackendTimingUploads('', 2)).toThrow('failed samples')
    const workflow = readFileSync(
      resolve(import.meta.dir, '../../../.github/workflows/ci.yml'),
      'utf8',
    )
    expect(() => assertSafeBackendTimingUploads(workflow, 2)).not.toThrow()
  })

  test('merges complete whole-file measurements in stable path order, including spec files', () => {
    expect(mergeBackendTimings([shard(2, { [b]: 23 }), shard(1, { [a]: 0 })], [b, a], 2)).toEqual({
      version: 1,
      files: { [a]: 0, [b]: 23 },
    })
  })

  test('rejects absent shards, duplicate shards, duplicate files and missing source tests', () => {
    expect(() => mergeBackendTimings([shard(1, { [a]: 1 })], [a], 2)).toThrow('Expected 2')
    expect(() =>
      mergeBackendTimings([shard(1, { [a]: 1 }), shard(1, { [b]: 2 })], [a, b], 2),
    ).toThrow('duplicate shard')
    expect(() => mergeBackendTimings([shard(1, { [a]: 1 }), shard(2, { [a]: 2 })], [a], 2)).toThrow(
      'Duplicate measured',
    )
    expect(() => mergeBackendTimings([shard(1, { [a]: 1 })], [a, b], 1)).toThrow('Missing source')
  })

  test('rejects malformed documents, nonfinite/negative durations and unrelated paths', () => {
    for (const data of [null, [], { version: 2, files: {} }, { version: 1, files: [] }])
      expect(() => mergeBackendTimings([{ shard: 1, data }], [a], 1)).toThrow()
    for (const ms of [NaN, Infinity, -1])
      expect(() => mergeBackendTimings([shard(1, { [a]: ms })], [a], 1)).toThrow('Invalid duration')
    for (const path of [
      c,
      '../a.test.ts',
      'packages/backend/tests/../a.test.ts',
      'packages/backend/tests/a\\b.test.ts',
    ])
      expect(() => mergeBackendTimings([shard(1, { [path]: 1 })], [a], 1)).toThrow('Unexpected')
    expect(() => mergeBackendTimings([shard(1, { [a]: 1 })], [], 1)).toThrow('population')
    expect(() => mergeBackendTimings([shard(1, { [a]: 1 })], [a, a], 1)).toThrow('population')
  })

  test('projects onto the new tree without resurrecting removed files or inventing new timings', () => {
    expect(projectBackendTimings({ version: 1, files: { [a]: 12, [b]: 34 } }, [a, c])).toEqual({
      timings: { version: 1, files: { [a]: 12 } },
      unmeasured: [c],
      removed: [b],
    })
  })

  test('accepts only the exact successful main push CI source, not a partial/fork/other workflow', () => {
    const source = {
      id: 42,
      name: 'CI',
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      head_branch: 'main',
      head_sha: 'a'.repeat(40),
      head_repository: { full_name: 'owner/repo' },
    }
    expect(assertSuccessfulTimingSource(source, 'owner/repo', 42)).toBe('a'.repeat(40))
    for (const change of [
      { id: 43 },
      { name: 'CI feedback' },
      { status: 'in_progress' },
      { conclusion: 'failure' },
      { event: 'pull_request' },
      { head_branch: 'feature' },
      { head_sha: 'short' },
      { head_repository: { full_name: 'fork/repo' } },
    ])
      expect(() =>
        assertSuccessfulTimingSource({ ...source, ...change }, 'owner/repo', 42),
      ).toThrow('successful complete')
  })
})
