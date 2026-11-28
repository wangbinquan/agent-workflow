// RFC-611: incomplete timing artifacts must never silently remove or misweight test coverage.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ALL_BACKEND_TIMING_SOURCES,
  CORE_CI_TIMING_SOURCES,
  E2E_CI_TIMING_SOURCES,
  assertSuccessfulTimingSource,
  assertSafeBackendTimingUploads,
  mergeBackendTimings,
  parseRefreshBackendTimingsArgs,
  projectBackendTimings,
  readBackendTimingSource,
  type BackendTimingSourceReader,
  type BackendTimingTier,
  type BackendTimings,
} from '../../../scripts/ci/refresh-backend-timings'
import {
  composeBackendTimings,
  parseBackendTimingCompositionArgs,
} from '../../../scripts/ci/compose-backend-timings'
import {
  BACKEND_FULL_NIGHTLY_PATH,
  CI_WORKFLOW_PATH,
  CI_WORK_JOB_IDS,
} from '../../../scripts/ci/workflow-source'

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
      resolve(import.meta.dir, '../../../.github/workflows/ci-work.yml'),
      'utf8',
    )
    expect(() => assertSafeBackendTimingUploads(workflow, 2)).not.toThrow()
    const nightly = readFileSync(
      resolve(import.meta.dir, '../../../.github/workflows/backend-full-nightly.yml'),
      'utf8',
    )
    expect(() => assertSafeBackendTimingUploads(nightly, 2, 'test-backend-full')).not.toThrow()
    expect(() =>
      assertSafeBackendTimingUploads(
        nightly.replace('if: success()', 'if: always()'),
        2,
        'test-backend-full',
      ),
    ).toThrow('failed samples')
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

    // RFC-627: per-consumer allowlists isolate workflow/event pairs strictly.
    expect(
      assertSuccessfulTimingSource(
        { ...source, event: 'workflow_dispatch' },
        'owner/repo',
        42,
        CORE_CI_TIMING_SOURCES,
      ),
    ).toBe('a'.repeat(40))
    expect(() =>
      assertSuccessfulTimingSource(
        { ...source, name: 'backend-full-nightly', event: 'schedule' },
        'owner/repo',
        42,
        CORE_CI_TIMING_SOURCES,
      ),
    ).toThrow('successful complete')
    expect(
      assertSuccessfulTimingSource(
        { ...source, name: 'backend-full-nightly', event: 'schedule' },
        'owner/repo',
        42,
        ALL_BACKEND_TIMING_SOURCES,
      ),
    ).toBe('a'.repeat(40))
    expect(
      assertSuccessfulTimingSource(
        { ...source, name: 'backend-full-nightly', event: 'workflow_dispatch' },
        'owner/repo',
        42,
        ALL_BACKEND_TIMING_SOURCES,
      ),
    ).toBe('a'.repeat(40))
    expect(assertSuccessfulTimingSource(source, 'owner/repo', 42, ALL_BACKEND_TIMING_SOURCES)).toBe(
      'a'.repeat(40),
    )
    for (const badAll of [
      { name: 'CI', event: 'schedule' },
      { name: 'CI', event: 'workflow_dispatch' },
      { name: 'backend-full-nightly', event: 'push' },
    ]) {
      expect(() =>
        assertSuccessfulTimingSource(
          { ...source, ...badAll },
          'owner/repo',
          42,
          ALL_BACKEND_TIMING_SOURCES,
        ),
      ).toThrow('successful complete')
    }
    expect(
      assertSuccessfulTimingSource(
        { ...source, event: 'workflow_dispatch' },
        'owner/repo',
        42,
        E2E_CI_TIMING_SOURCES,
      ),
    ).toBe('a'.repeat(40))
  })
})

// RFC-623: the manual composer must read each complete source through the same
// collector, then retain an actual observed value and its precise attribution.
function sourceFixture(
  runId = 101,
  files: Record<string, number> = { [a]: 0, [b]: 23 },
  shardCount = 44,
) {
  const sourceSha = runId.toString(16).padStart(40, '0')
  const workflow = `jobs:
  test-backend:
    strategy:
      matrix:
        os: [ubuntu-latest]
        shard: [${Array.from({ length: shardCount }, (_, index) => index + 1).join(', ')}]
        shards: [${shardCount}]
    steps:
      - name: Upload measured backend test timings (ubuntu shards)
        if: success() && matrix.os == 'ubuntu-latest'
        uses: actions/upload-artifact@v6
        with:
          name: backend-test-timings-\${{ matrix.shard }}
  test-backend-postgresql: {}
`
  const state = {
    run: {
      id: runId,
      name: 'CI',
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      head_branch: 'main',
      head_sha: sourceSha,
      head_repository: { full_name: 'owner/repo' },
      run_attempt: 1,
    },
    workflowFiles: { '.github/workflows/ci.yml': workflow } as Record<string, string>,
    expectedFiles: Object.keys(files),
    shards: Array.from({ length: shardCount }, (_, index) =>
      shard(
        index + 1,
        Object.fromEntries(
          Object.entries(files).filter((_, position) => position % shardCount === index),
        ),
      ),
    ),
  }
  const reads: { operation: string; arguments: (string | number)[] }[] = []
  const reader: BackendTimingSourceReader = {
    readRun: (repository, id) => {
      reads.push({ operation: 'run', arguments: [repository, id] })
      return state.run
    },
    readSourceFile: (sha, path) => {
      reads.push({ operation: 'workflow', arguments: [sha, path] })
      const content = state.workflowFiles[path]
      if (content === undefined) throw new Error('Missing source workflow')
      return content
    },
    readSourceTests: (sha) => {
      reads.push({ operation: 'tree', arguments: [sha] })
      return state.expectedFiles
    },
    readShards: (directory) => {
      reads.push({ operation: 'artifacts', arguments: [directory] })
      return state.shards
    },
  }
  const request = { artifactsDirectory: `/raw source/${runId}`, runId, repository: 'owner/repo' }
  return { state, reads, reader, request, read: () => readBackendTimingSource(request, reader) }
}

describe('complete backend timing source reader', () => {
  test('uses the successful source SHA for workflow and tree, preserving single-source metadata', () => {
    const fixture = sourceFixture()
    const source = fixture.read()
    expect(source.timings).toEqual({ version: 1, files: { [a]: 0, [b]: 23 } })
    expect(source.expectedFiles).toEqual([a, b])
    expect(source.provenance).toEqual({
      tier: 'all',
      sourceRun: 101,
      sourceSha: '65'.padStart(40, '0'),
      sourceRepository: 'owner/repo',
      sourceWorkflowPath: '.github/workflows/ci.yml',
      finalRunAttempt: 1,
      sourceShards: 44,
      sourceFiles: 2,
      measuredMilliseconds: 23,
    })
    expect(fixture.reads).toContainEqual({ operation: 'run', arguments: ['owner/repo', 101] })
    expect(fixture.reads).toContainEqual({
      operation: 'tree',
      arguments: [fixture.state.run.head_sha],
    })
    expect(fixture.reads).toContainEqual({
      operation: 'workflow',
      arguments: [fixture.state.run.head_sha, '.github/workflows/ci.yml'],
    })
    expect(fixture.reads).toContainEqual({ operation: 'artifacts', arguments: ['/raw source/101'] })
    fixture.state.expectedFiles.push(c)
    expect(source.expectedFiles).toEqual([a, b])
  })

  test('resolves reusable source workflows and retains legacy single-source shard-count support', () => {
    const fixture = sourceFixture(101, { [a]: 12, [b]: 34 }, 2)
    fixture.state.workflowFiles[CI_WORKFLOW_PATH] =
      'on:\n  workflow_call:\n' +
      fixture.state.workflowFiles['.github/workflows/ci.yml'] +
      CI_WORK_JOB_IDS.filter((id) => !['test-backend', 'test-backend-postgresql'].includes(id))
        .map((id) => `  ${id}: {}\n`)
        .join('')
    fixture.state.workflowFiles['.github/workflows/ci.yml'] =
      `jobs:\n  full-ci:\n    uses: ./${CI_WORKFLOW_PATH}\n`
    const source = fixture.read()
    expect(source.provenance.sourceWorkflowPath).toBe(CI_WORKFLOW_PATH)
    expect(source.provenance.sourceShards).toBe(2)
    expect(source.provenance.measuredMilliseconds).toBe(46)
    expect(projectBackendTimings(source.timings, [a, c])).toEqual({
      timings: { version: 1, files: { [a]: 12 } },
      unmeasured: [c],
      removed: [b],
    })
    expect(fixture.reads).toContainEqual({
      operation: 'workflow',
      arguments: [fixture.state.run.head_sha, CI_WORKFLOW_PATH],
    })
  })

  test('failed, partial, foreign and wrong-identity runs fail before workflow or artifact reads', () => {
    for (const change of [
      { id: 999 },
      { name: 'CI feedback' },
      { status: 'in_progress' },
      { conclusion: 'failure' },
      { conclusion: 'cancelled' },
      { event: 'pull_request' },
      { head_branch: 'feature' },
      { head_sha: 'short' },
      { head_repository: { full_name: 'other/repo' } },
    ]) {
      const fixture = sourceFixture()
      Object.assign(fixture.state.run, change)
      expect(() => fixture.read()).toThrow('successful complete')
      expect(fixture.reads.map((read) => read.operation)).toEqual(['run'])
    }
    for (const runId of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const fixture = sourceFixture()
      fixture.request.runId = runId
      expect(() => fixture.read()).toThrow('run ID')
      expect(fixture.reads).toEqual([])
    }
  })

  test('reuses rerun upload rules and never falls back from an unknown source workflow', () => {
    const fixture = sourceFixture()
    fixture.state.run.run_attempt = 2
    expect(fixture.read().provenance.finalRunAttempt).toBe(2)
    fixture.state.workflowFiles['.github/workflows/ci.yml'] = fixture.state.workflowFiles[
      '.github/workflows/ci.yml'
    ]!.replace('if: success()', 'if: (success() || failure())')
    expect(() => fixture.read()).toThrow('failed samples')
    fixture.state.run.run_attempt = 1
    expect(fixture.read().provenance.finalRunAttempt).toBe(1)
    fixture.state.workflowFiles = { '.github/workflows/ci.yml': 'jobs: {}' }
    expect(() => fixture.read()).toThrow('Unknown source')
    fixture.state.workflowFiles = {}
    expect(() => fixture.read()).toThrow('Missing source')
  })

  test('tier=core enforces 12-shard (or historical 16-shard) SQLite ci-work.yml and filters expectedFiles to core; tier=all accepts 44-shard nightly and rejects SQLite', () => {
    const migrationFile =
      'packages/backend/tests/rfc398-auto-upgrade-resume-postgresql-phase-frozen.test.ts'
    const makeCoreWorkYaml = (shardCount: number) =>
      [
        'on:',
        '  workflow_call:',
        'jobs:',
        '  test-backend:',
        '    env:',
        '      AW_TEST_PROVIDERS: sqlite',
        '    strategy:',
        '      matrix:',
        '        os: [ubuntu-latest]',
        `        shard: [${Array.from({ length: shardCount }, (_, i) => i + 1).join(', ')}]`,
        `        shards: [${shardCount}]`,
        '    steps:',
        '      - name: Upload measured backend test timings (ubuntu shards)',
        "        if: success() && matrix.os == 'ubuntu-latest'",
        '        uses: actions/upload-artifact@v6',
        '        with:',
        '          name: backend-core-timings-${{ matrix.shard }}',
        ...CI_WORK_JOB_IDS.filter((id) => id !== 'test-backend').map((id) => `  ${id}: {}`),
      ].join('\n')

    for (const shardCount of [12, 16]) {
      const coreFixture = sourceFixture(300 + shardCount, { [a]: 15, [b]: 25 }, shardCount)
      coreFixture.state.workflowFiles['.github/workflows/ci.yml'] =
        `jobs:\n  full-ci:\n    uses: ./${CI_WORKFLOW_PATH}\n`
      coreFixture.state.workflowFiles[CI_WORKFLOW_PATH] = makeCoreWorkYaml(shardCount)
      coreFixture.state.expectedFiles = [a, b, migrationFile]
      coreFixture.state.run.event = 'workflow_dispatch'

      const coreSource = readBackendTimingSource(
        { ...coreFixture.request, tier: 'core' },
        coreFixture.reader,
      )
      expect(coreSource.provenance).toMatchObject({
        tier: 'core',
        sourceWorkflowPath: CI_WORKFLOW_PATH,
        sourceShards: shardCount,
        sourceFiles: 2,
        measuredMilliseconds: 40,
      })
      expect(coreSource.expectedFiles).toEqual([a, b])

      // Reading a SQLite core run under tier=all must fail closed.
      coreFixture.state.run.event = 'push'
      expect(() =>
        readBackendTimingSource({ ...coreFixture.request, tier: 'all' }, coreFixture.reader),
      ).toThrow('must not narrow AW_TEST_PROVIDERS to sqlite')
    }

    // Reading a 44-shard dual-engine run under tier=core must fail closed.
    const dualFixture = sourceFixture(302, { [a]: 10, [b]: 20 }, 44)
    expect(() =>
      readBackendTimingSource({ ...dualFixture.request, tier: 'core' }, dualFixture.reader),
    ).toThrow('12 (or historical 16) SQLite shards')

    // Reading a 44-shard backend-full-nightly run under tier=all succeeds.
    const nightlyFixture = sourceFixture(303, { [a]: 11, [b]: 22, [migrationFile]: 33 }, 44)
    nightlyFixture.state.run.name = 'backend-full-nightly'
    nightlyFixture.state.run.event = 'schedule'
    nightlyFixture.state.workflowFiles[BACKEND_FULL_NIGHTLY_PATH] = [
      'on:',
      '  schedule:',
      "    - cron: '0 2 * * *'",
      '  workflow_dispatch:',
      'jobs:',
      '  test-backend-full:',
      '    strategy:',
      '      matrix:',
      `        shard: [${Array.from({ length: 44 }, (_, i) => i + 1).join(', ')}]`,
      '        shards: [44]',
      '    steps:',
      '      - name: Upload measured backend test timings (nightly full shards)',
      '        if: success()',
      '        uses: actions/upload-artifact@v6',
      '        with:',
      '          name: backend-full-timings-${{ matrix.shard }}',
    ].join('\n')
    const nightlySource = readBackendTimingSource(
      { ...nightlyFixture.request, tier: 'all' },
      nightlyFixture.reader,
    )
    expect(nightlySource.provenance).toMatchObject({
      tier: 'all',
      sourceWorkflowPath: BACKEND_FULL_NIGHTLY_PATH,
      sourceShards: 44,
      sourceFiles: 3,
      measuredMilliseconds: 66,
    })
  })

  test('refresh CLI argument parser supports --tier core/all and rejects invalid tiers', () => {
    expect(parseRefreshBackendTimingsArgs(['dir', '123', 'out.json'])).toEqual({
      tier: 'all',
      artifacts: 'dir',
      runId: 123,
      output: 'out.json',
    })
    expect(parseRefreshBackendTimingsArgs(['--tier', 'core', 'dir', '123', 'out.json'])).toEqual({
      tier: 'core',
      artifacts: 'dir',
      runId: 123,
      output: 'out.json',
    })
    expect(parseRefreshBackendTimingsArgs(['--tier=all', 'dir', '123', 'out.json'])).toEqual({
      tier: 'all',
      artifacts: 'dir',
      runId: 123,
      output: 'out.json',
    })
    for (const args of [
      ['--tier', 'migration', 'dir', '123', 'out.json'],
      ['--tier=invalid', 'dir', '123', 'out.json'],
      ['--tier'],
      ['dir', 'abc', 'out.json'],
    ]) {
      expect(() => parseRefreshBackendTimingsArgs(args)).toThrow()
    }
  })

  test('every raw shard and the entire source population are checked before returning a source', () => {
    for (const mutation of [
      'missing-shard',
      'duplicate-shard',
      'duplicate-file',
      'missing-file',
      'foreign-file',
      'invalid-duration',
      'invalid-format',
      'duplicate-tree',
      'missing-matrix',
    ]) {
      const fixture = sourceFixture()
      if (mutation === 'missing-shard') fixture.state.shards.pop()
      if (mutation === 'duplicate-shard') fixture.state.shards[1]!.shard = 1
      if (mutation === 'duplicate-file') fixture.state.shards[1]!.data.files[a] = 1
      if (mutation === 'missing-file') delete fixture.state.shards[1]!.data.files[b]
      if (mutation === 'foreign-file') fixture.state.shards[1]!.data.files[c] = 10
      if (mutation === 'invalid-duration') fixture.state.shards[0]!.data.files[a] = NaN
      if (mutation === 'invalid-format') fixture.state.shards[0]!.data.version = 2
      if (mutation === 'duplicate-tree') fixture.state.expectedFiles.push(a)
      if (mutation === 'missing-matrix')
        fixture.state.workflowFiles['.github/workflows/ci.yml'] = 'jobs:\n  test-backend: {}\n'
      expect(() => fixture.read()).toThrow()
    }
  })
})

describe('composition of complete backend timing sources', () => {
  const targetSha = 'c'.repeat(40)
  const removedFile = 'packages/backend/tests/removed.test.ts'
  const unmeasuredFile = 'packages/backend/tests/not-yet-measured.test.ts'

  test('uses exact observed maxima with per-file attribution, without adding a multiplier', () => {
    const older = sourceFixture(101, { [a]: 10, [b]: 30 }).read()
    const newer = sourceFixture(202, { [a]: 20, [b]: 25 }).read()
    const result = composeBackendTimings([older, newer], { targetSha, files: [b, a] })
    expect(result.timings).toEqual({ version: 1, files: { [a]: 20, [b]: 30 } })
    expect(result.provenance).toMatchObject({
      aggregation: 'per-file-maximum',
      targetSha,
      sourceRepository: 'owner/repo',
      targetFiles: 2,
      measuredFiles: 2,
      aggregatedMilliseconds: 50,
      unmeasured: [],
      removed: [],
      selectedSources: {
        [a]: { sourceRun: 202, sourceSha: newer.provenance.sourceSha, milliseconds: 20 },
        [b]: { sourceRun: 101, sourceSha: older.provenance.sourceSha, milliseconds: 30 },
      },
    })
    expect(result.provenance.sources).toEqual([
      { ...older.provenance, complete: true },
      { ...newer.provenance, complete: true },
    ])
    expect(result.provenance).not.toHaveProperty('sourceRun')
    expect(result.provenance).not.toHaveProperty('measuredMilliseconds')
    for (const [file, chosen] of Object.entries(result.provenance.selectedSources)) {
      const original = [older, newer].find(
        (source) => source.provenance.sourceRun === chosen.sourceRun,
      )!
      expect(chosen.milliseconds).toBe(original.timings.files[file]!)
      expect(result.timings.files[file]).toBe(chosen.milliseconds)
    }
  })

  test('input order is irrelevant, equal values select the larger run ID, and zero stays measured', () => {
    const older = sourceFixture(101, { [b]: 0, [a]: 20 }).read()
    const newer = sourceFixture(202, { [a]: 20, [b]: 0 }).read()
    const third = sourceFixture(303, { [b]: 0, [a]: 5 }).read()
    const target = { targetSha, files: [b, a] }
    const expected = composeBackendTimings([older, newer, third], target)
    expect(composeBackendTimings([third, newer, older], target)).toEqual(expected)
    expect(composeBackendTimings([newer, older, third], { targetSha, files: [a, b] })).toEqual(
      expected,
    )
    expect(expected.provenance.selectedSources[a]!.sourceRun).toBe(202)
    expect(expected.provenance.selectedSources[b]!.sourceRun).toBe(303)
    expect(expected.timings.files[b]).toBe(0)
  })

  test('projects different source populations without inventing new values or reviving removed tests', () => {
    const older = sourceFixture(101, { [a]: 10, [b]: 30, [removedFile]: 1000 }).read()
    const newer = sourceFixture(202, { [a]: 20, [c]: 12 }).read()
    const result = composeBackendTimings([older, newer], {
      targetSha,
      files: [a, b, c, unmeasuredFile],
    })
    expect(result.timings.files).toEqual({ [a]: 20, [b]: 30, [c]: 12 })
    expect(result.provenance.targetFiles).toBe(4)
    expect(result.provenance.measuredFiles).toBe(3)
    expect(result.provenance.unmeasured).toEqual([unmeasuredFile])
    expect(result.provenance.removed).toEqual([removedFile])
    expect(result.provenance.aggregatedMilliseconds).toBe(62)
    expect(result.provenance.sources.map((source) => source.sourceFiles)).toEqual([3, 2])
    expect(older.timings.files[removedFile]).toBe(1000)
    expect(newer.timings.files[c]).toBe(12)
  })

  test('rejects too few sources, repeated runs, mixed repositories and non-44 source matrices', () => {
    const source = sourceFixture().read()
    const target = { targetSha, files: [a, b] }
    expect(() => composeBackendTimings([], target)).toThrow('at least two')
    expect(() => composeBackendTimings([source], target)).toThrow('at least two')
    expect(() => composeBackendTimings([source, structuredClone(source)], target)).toThrow(
      'distinct',
    )
    const foreign = sourceFixture(202).read()
    foreign.provenance.sourceRepository = 'other/repo'
    expect(() => composeBackendTimings([source, foreign], target)).toThrow('same repository')
    const twoShards = sourceFixture(202, { [a]: 1 }, 2).read()
    expect(() => composeBackendTimings([source, twoShards], target)).toThrow('44-shard')
  })

  test('revalidates source metadata and the full source map before projecting away old files', () => {
    const good = sourceFixture().read()
    const target = { targetSha, files: [a, b] }
    const badMetadata: Record<string, unknown>[] = [
      { sourceRun: 0 },
      { sourceRun: 1.5 },
      { sourceSha: 'short' },
      { sourceRepository: '' },
      { sourceWorkflowPath: '.github/workflows/unknown.yml' },
      { finalRunAttempt: 0 },
      { sourceShards: 43 },
      { sourceFiles: 1 },
      { measuredMilliseconds: NaN },
      { measuredMilliseconds: 999 },
    ]
    for (const change of badMetadata) {
      const broken = sourceFixture(202).read()
      Object.assign(broken.provenance, change)
      expect(() => composeBackendTimings([good, broken], target)).toThrow()
    }
    for (const mutation of [
      'missing-file',
      'extra-file',
      'missing-tree',
      'duplicate-tree',
      'invalid-map',
      'invalid-version',
      'negative',
      'infinite',
      'string',
      'corrupt-removed',
    ]) {
      const broken = sourceFixture(202, { [a]: 0, [b]: 23, [removedFile]: 10 }).read()
      if (mutation === 'missing-file') delete broken.timings.files[b]
      if (mutation === 'extra-file') broken.timings.files[c] = 12
      if (mutation === 'missing-tree') broken.expectedFiles = [a, removedFile]
      if (mutation === 'duplicate-tree') broken.expectedFiles = [a, b, removedFile, a]
      if (mutation === 'invalid-map')
        broken.timings = { version: 1, files: [] } as unknown as BackendTimings
      if (mutation === 'invalid-version') Object.assign(broken.timings, { version: 2 })
      if (mutation === 'negative') broken.timings.files[a] = -1
      if (mutation === 'infinite') broken.timings.files[a] = Infinity
      if (mutation === 'string') Object.assign(broken.timings.files, { [a]: '1' })
      if (mutation === 'corrupt-removed') broken.timings.files[removedFile] = NaN
      expect(() => composeBackendTimings([good, broken], target)).toThrow()
    }
  })

  test('requires a fixed valid target SHA and a complete distinct target file population', () => {
    const sources = [sourceFixture(101).read(), sourceFixture(202).read()]
    expect(() => composeBackendTimings(sources, { targetSha: 'HEAD', files: [a] })).toThrow(
      'target SHA',
    )
    for (const files of [[], [a, a], ['packages/backend/src/example.ts'], ['../a.test.ts']])
      expect(() => composeBackendTimings(sources, { targetSha, files })).toThrow()
  })

  test('CLI arguments support --tier core/all and require at least two explicit distinct raw artifact sources', () => {
    expect(
      parseBackendTimingCompositionArgs([
        'review/output.json',
        'first raw directory',
        '101',
        'second raw directory',
        '202',
      ]),
    ).toEqual({
      tier: 'all',
      output: 'review/output.json',
      sources: [
        { artifactsDirectory: 'first raw directory', runId: 101 },
        { artifactsDirectory: 'second raw directory', runId: 202 },
      ],
    })
    expect(
      parseBackendTimingCompositionArgs([
        '--tier',
        'core',
        'review/core.json',
        'first',
        '101',
        'second',
        '202',
      ]),
    ).toEqual({
      tier: 'core',
      output: 'review/core.json',
      sources: [
        { artifactsDirectory: 'first', runId: 101 },
        { artifactsDirectory: 'second', runId: 202 },
      ],
    })
    expect(
      parseBackendTimingCompositionArgs([
        '--tier=core',
        'review/core.json',
        'first',
        '101',
        'second',
        '202',
      ]).tier,
    ).toBe('core')
    for (const args of [
      [],
      ['out'],
      ['out', 'a', '1'],
      ['out', 'a', '1', 'b'],
      ['', 'a', '1', 'b', '2'],
      ['out', '', '1', 'b', '2'],
      ['out', 'a', '1', 'b', '1'],
      ['out', 'a', '1', 'b', '0'],
      ['out', 'a', '1', 'b', '-2'],
      ['out', 'a', '1', 'b', '1.5'],
      ['out', 'a', '1', 'b', '1e2'],
      ['out', 'a', '1', 'b', '9007199254740992'],
      ['--tier', 'migration', 'out', 'a', '1', 'b', '2'],
      ['--tier=bad', 'out', 'a', '1', 'b', '2'],
    ])
      expect(() => parseBackendTimingCompositionArgs(args)).toThrow()
  })

  test('tier-aware composition locks 12/16-shard core vs 44-shard all and forbids cross-tier mixing', () => {
    const makeCoreSource = (runId: number, files: Record<string, number>, shardCount = 12) => {
      const f = sourceFixture(runId, files, shardCount)
      f.state.workflowFiles['.github/workflows/ci.yml'] =
        `jobs:\n  full-ci:\n    uses: ./${CI_WORKFLOW_PATH}\n`
      f.state.workflowFiles[CI_WORKFLOW_PATH] = [
        'on:',
        '  workflow_call:',
        'jobs:',
        '  test-backend:',
        '    env:',
        '      AW_TEST_PROVIDERS: sqlite',
        '    strategy:',
        '      matrix:',
        '        os: [ubuntu-latest]',
        `        shard: [${Array.from({ length: shardCount }, (_, i) => i + 1).join(', ')}]`,
        `        shards: [${shardCount}]`,
        '    steps:',
        '      - name: Upload measured backend test timings (ubuntu shards)',
        "        if: success() && matrix.os == 'ubuntu-latest'",
        '        uses: actions/upload-artifact@v6',
        '        with:',
        '          name: backend-core-timings-${{ matrix.shard }}',
        ...CI_WORK_JOB_IDS.filter((id) => id !== 'test-backend').map((id) => `  ${id}: {}`),
      ].join('\n')
      return readBackendTimingSource({ ...f.request, tier: 'core' }, f.reader)
    }

    const core1 = makeCoreSource(401, { [a]: 10, [b]: 30 }, 12)
    const core2 = makeCoreSource(402, { [a]: 25, [b]: 20 }, 16)
    const full1 = sourceFixture(403, { [a]: 100, [b]: 200 }, 44).read()
    const target = { targetSha, files: [a, b] }

    const composedCore = composeBackendTimings([core1, core2], target, 'core')
    expect(composedCore.provenance.tier).toBe('core')
    expect(composedCore.timings).toEqual({ version: 1, files: { [a]: 25, [b]: 30 } })

    // Cross-tier mixing must fail closed in both directions.
    expect(() => composeBackendTimings([core1, full1], target, 'core')).toThrow('12/16-shard core')
    expect(() => composeBackendTimings([core1, full1], target, 'all')).toThrow('44-shard all')
    expect(() => composeBackendTimings([core1, core2], target, 'all')).toThrow('44-shard all')
    expect(() =>
      composeBackendTimings([core1, core2], target, 'migration' as unknown as BackendTimingTier),
    ).toThrow('Invalid backend timing composition tier')
  })
})
