// RFC-395 T19 preparation for real instance migrations (`db migration`): one file for the four
// regressions so the backend shards stay balanced (four separate files shifted bun's round-robin
// shard assignment and overran one shard's 15-minute budget in runs 40513660126 and 40521324441).
import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { epochMigrationCommand } from '@/cli/epochMigration'
import { createEpochSwitchApplication } from '@/modules/system-operations/application/epochSwitch/application'
import { estimateEpochCapacity } from '@/modules/system-operations/domain/epochSwitch/capacity'
import { createMigrationPlanDocument } from '@/modules/system-operations/domain/epochSwitch/documents'
import { createDryRunSink } from '@/modules/system-operations/infrastructure/epochSwitch/dryRunSink'
import {
  createFileEpochSwitchJournal,
  createLocalEpochArtifacts,
} from '@/modules/system-operations/infrastructure/epochSwitch/fileJournal'
import {
  createMetaEpochSwitchJournal,
  type HostedEpochArtifacts,
} from '@/modules/system-operations/infrastructure/epochSwitch/metaJournal'
import { pruneEpochPlanContent } from '@/modules/system-operations/infrastructure/epochSwitch/planContent'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { columnLookup } from '@/platform/persistence/migration/conversion/lookups'
import { createStagingStore } from '@/platform/persistence/migration/conversion/staging'
import { persistSourceDirectory } from '@/platform/persistence/migration/freeze/artifacts'
import { measureMigrationCapacity } from '@/platform/persistence/migration/freeze/capacity'
import {
  createMigrationProgressReporter,
  type MigrationProgress,
} from '@/platform/persistence/migration/run/progress'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { describeV3Providers } from './helpers/rfc395V3Harness'
import { fixtureDigest, makeSwitchFixture } from './helpers/rfc395V3SwitchFixture'

// ------------------------------------------------------------------------------------------------
// Capacity estimate: budget measured staging and all run-only copies, including remote targets.
// ------------------------------------------------------------------------------------------------

for (const upgradeBytes of [0, 250])
  for (const targetOnOperationFilesystem of [true, false])
    test(`T19 estimate: offline upgrade ${upgradeBytes > 0}, local target ${targetOnOperationFilesystem}`, () => {
      const actual = estimateEpochCapacity({
        sourceBytes: 100,
        operationBytes: 25 + upgradeBytes,
        stagingPeakBytes: 2000,
        availableBytes: 800,
        targetOnOperationFilesystem,
        localArtifactMirrors: true,
      })
      expect(actual).toEqual({
        sourceBytes: 100,
        targetBytes: 150,
        backupBytes: 400,
        stagingBytes: 2000,
        requiredBytes: 2425 + upgradeBytes + (targetOnOperationFilesystem ? 150 : 0),
        availableBytes: 800,
        components: {
          operationBytes: 25 + upgradeBytes,
          runBackupBytes: 100,
          switchBackupBytes: 100,
          artifactMirrorBytes: 200,
          targetFilesystemBytes: targetOnOperationFilesystem ? 150 : 0,
        },
      })
    })

test('T19 does not invent unmeasured staging or source bytes, or budget absent mirrors', () => {
  const input = {
    sourceBytes: 100,
    operationBytes: 25,
    stagingPeakBytes: 2000,
    availableBytes: 800,
    targetOnOperationFilesystem: true,
    localArtifactMirrors: false,
  }
  expect(estimateEpochCapacity(input).backupBytes).toBe(200)
  expect(estimateEpochCapacity({ ...input, stagingPeakBytes: null }).requiredBytes).toBeNull()
  expect(estimateEpochCapacity({ ...input, sourceBytes: null }).requiredBytes).toBeNull()
})

test('T19 planner blocks the measured peak even when the old 4x check would pass', async () => {
  const f = makeSwitchFixture()
  const dryRun = f.deps.conversion.dryRun
  let measuredAfterDryRun = false
  let finished = false
  f.deps.conversion.dryRun = async (request) => {
    const result = await dryRun(request)
    finished = true
    return { ...result, stagingPeakBytes: 2000 }
  }
  f.deps.measureCapacity = async () => {
    measuredAfterDryRun = finished
    return { sourceBytes: 100, operationBytes: 250, availableBytes: 800 }
  }
  try {
    const plan = await f.app.plan({})
    expect(measuredAfterDryRun).toBe(true)
    expect(plan.plan.payload.estimates.requiredBytes).toBe(2800)
    expect(plan.plan.payload.blocks.map((entry) => entry.block)).toContainEqual(
      expect.objectContaining({
        code: 'v3-capacity',
        detail: { requiredBytes: 2800, availableBytes: 800 },
      }),
    )
    await expect(
      f.app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest }),
    ).rejects.toThrow('plan-blocked')
    expect(f.control.quiesceCalls).toBe(0)
  } finally {
    f.close()
  }
})

test('T19 restored backup capacity uses its rematerialized path after scratch replacement', async () => {
  const f = makeSwitchFixture()
  try {
    const current = join(f.root, 'materialized-backup')
    mkdirSync(current)
    writeFileSync(join(current, 'db.sqlite'), Buffer.alloc(789))
    f.deps.unpackBackup = async () => ({
      sourceKind: 'hosted-backup',
      root: join(f.root, 'previous-scratch'),
      digest: fixtureDigest,
    })
    f.deps.materializeBackup = async () => ({ root: current })
    f.deps.measureCapacity = async (source, operationRoot) => {
      expect(source).toMatchObject({ kind: 'backup', root: current })
      return measureMigrationCapacity(source, operationRoot)
    }
    const plan = await f.app.restoreBackup({ artifact: 'retained-backup' })
    expect(plan.plan.payload.estimates.sourceBytes).toBe(789)
  } finally {
    f.close()
  }
})

test('T19 numeric capacity and manifest path changes leave material approval unchanged', async () => {
  const f = makeSwitchFixture()
  try {
    const first = (await f.app.plan({})).plan
    const changed = createMigrationPlanDocument({
      ...first.payload,
      contentManifestPath: 'runs/later/plan-content/2.json',
      estimates: {
        ...first.payload.estimates,
        ...estimateEpochCapacity({
          sourceBytes: 999,
          operationBytes: 15000,
          stagingPeakBytes: 20000,
          availableBytes: 100000,
          targetOnOperationFilesystem: true,
          localArtifactMirrors: true,
        }),
      },
    })
    expect(changed.digest).not.toBe(first.digest)
    expect(changed.approvalDigest).toBe(first.approvalDigest)
    const app = createEpochSwitchApplication({ ...f.deps })
    expect(
      (await app.run({ operationId: f.operationId, approve: changed.approvalDigest })).phase,
    ).toBe('activated')
  } finally {
    f.close()
  }
})

describeV2Providers('T19 source and operation measurements', (h) => {
  test('measures the native source and retained files independently of target storage', async () => {
    await h.install()
    const root = join(h.sourceHarness.operationRoot, 't19-capacity')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'retained'), Buffer.alloc(789))
    const source =
      h.sourceHarness.provider === 'sqlite'
        ? {
            kind: 'sqlite-file' as const,
            path: h.sourceHarness.sqlitePath,
            pointerPath: join(root, 'pointer'),
          }
        : { kind: 'postgresql-database' as const, profileRef: 'env:T19_SOURCE' }
    const measured = await measureMigrationCapacity(source, root, async () => {
      const rows = await h.sourceHarness.runtime
        .providerPool('migration')
        .unsafe('SELECT pg_database_size(current_database()) AS bytes')
      return Number(rows[0]!.bytes)
    })
    expect(measured.sourceBytes).toBeGreaterThan(0)
    expect(measured.operationBytes).toBe(789)
    expect(measured.availableBytes).toBeGreaterThan(0)
    const local = estimateEpochCapacity({
      ...measured,
      operationBytes: measured.operationBytes!,
      stagingPeakBytes: 999,
      targetOnOperationFilesystem: true,
      localArtifactMirrors: true,
    })
    const remote = estimateEpochCapacity({
      ...measured,
      operationBytes: measured.operationBytes!,
      stagingPeakBytes: 999,
      targetOnOperationFilesystem: false,
      localArtifactMirrors: true,
    })
    expect(local.requiredBytes! - remote.requiredBytes!).toBe(local.targetBytes!)
    expect(remote.components!.targetFilesystemBytes).toBe(0)
  })
})

// ------------------------------------------------------------------------------------------------
// Disk hygiene: keep current/pending/approved manifests, clone immutable file artifacts.
// ------------------------------------------------------------------------------------------------

function retainedManifests(root: string) {
  const files = ['current', 'pending', 'approved', 'obsolete', 'duplicate']
  for (const file of files) {
    const path = join(root, `runs/run/plan-content/${file}.json`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ digest: file === 'duplicate' ? 'current' : file }))
  }
  return [
    { path: 'runs/run/plan-content/current.json', digest: 'current' },
    { path: 'runs/run/plan-content/pending.json', digest: 'pending' },
    // A retained plan written by the previous binary has only a digest.
    { digest: 'approved' },
  ]
}

test('T19 cleanup preserves pending paths, legacy approved digests and non-manifest files', () => {
  const root = mkdtempSync(join(tmpdir(), 't19p-manifests-'))
  try {
    const references = retainedManifests(root)
    writeFileSync(join(root, 'runs/run/plan-content/keep.tmp'), 'pending write')
    pruneEpochPlanContent(root, references)
    expect(readdirSync(join(root, 'runs/run/plan-content')).sort()).toEqual([
      'approved.json',
      'current.json',
      'keep.tmp',
      'pending.json',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T19 cleanup keeps an unreadable manifest instead of failing the already saved plan', () => {
  const root = mkdtempSync(join(tmpdir(), 't19p-manifests-'))
  try {
    const references = retainedManifests(root)
    // A crash during a previous plan can leave a truncated manifest behind.
    writeFileSync(join(root, 'runs/run/plan-content/truncated.json'), '{"digest":"obso')
    expect(() => pruneEpochPlanContent(root, references)).not.toThrow()
    expect(readdirSync(join(root, 'runs/run/plan-content')).sort()).toEqual([
      'approved.json',
      'current.json',
      'pending.json',
      'truncated.json',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T19 replans delete superseded manifests but retain the exact approved plan across interruption', async () => {
  const f = makeSwitchFixture()
  f.deps.journal = createFileEpochSwitchJournal({
    root: join(f.root, 'database-migrations'),
    async prunePlanContent(root, references) {
      pruneEpochPlanContent(root, references)
    },
  })
  const capture = f.deps.content.capture
  f.deps.content.capture = async (input) => {
    const manifest = await capture(input)
    mkdirSync(dirname(input.destination), { recursive: true })
    writeFileSync(input.destination, JSON.stringify(manifest))
    return manifest
  }
  try {
    const first = await f.app.plan({})
    const path = (plan: typeof first) =>
      join(f.deps.journal.operationRoot(f.operationId), plan.plan.payload.contentManifestPath!)
    expect(existsSync(path(first))).toBe(true)
    f.control.inject = (point) => {
      if (point === 'after-backup-file') throw new Error('T19 interrupted backup')
    }
    await expect(
      f.app.run({ operationId: f.operationId, approve: first.plan.approvalDigest }),
    ).rejects.toThrow('T19 interrupted backup')
    f.control.inject = undefined
    f.control.clock++
    const second = await f.app.plan({ operationId: f.operationId })
    f.control.clock++
    const third = await f.app.plan({ operationId: f.operationId })
    expect(existsSync(path(first))).toBe(true)
    expect(existsSync(path(second))).toBe(false)
    expect(existsSync(path(third))).toBe(true)
    expect((await f.deps.journal.read(f.operationId))!.payload.approvals).toHaveLength(1)
  } finally {
    f.close()
  }
})

test('T19 local clone-or-copy preserves bytes, digests and snapshot independence; streams still work', async () => {
  const root = mkdtempSync(join(tmpdir(), 't19p-clone-'))
  try {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 123)
    const source = join(root, 'source.sqlite')
    writeFileSync(source, bytes)
    const port = createLocalEpochArtifacts(join(root, 'operation'))
    const digest = await port.putFile!('backup/db.sqlite', source)
    expect(digest).toBe(bytesDigest(bytes))
    writeFileSync(source, 'changed after snapshot')
    const materialized = await port.get('backup/db.sqlite', digest)
    expect(readFileSync(materialized)).toEqual(bytes)
    writeFileSync(materialized, 'changed materialization')
    expect(readFileSync(await port.get('backup/db.sqlite', digest))).toEqual(bytes)
    const directory = join(root, 'input')
    mkdirSync(directory)
    writeFileSync(join(directory, 'db.sqlite'), bytes)
    let fileCalls = 0
    await persistSourceDirectory(
      {
        ...port,
        async putFile(name, path) {
          fileCalls++
          return port.putFile!(name, path)
        },
      },
      'directory',
      directory,
    )
    expect(fileCalls).toBe(1)
    const streamed = await port.put(
      'stream',
      (async function* () {
        yield bytes.subarray(0, 100)
        yield bytes.subarray(100)
      })(),
    )
    expect(streamed).toBe(digest)
    expect(readFileSync(await port.get('stream', streamed))).toEqual(bytes)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describeV3Providers('T19 durable journal hygiene and hosted file artifacts', (h) => {
  test('both journal providers prune local manifests and rematerialize unchanged hosted chunks', async () => {
    await h.installHead()
    const stored = new Map<string, Uint8Array>()
    const artifacts: HostedEpochArtifacts = {
      async writeOnce(_operation, name, bytes) {
        stored.set(name, bytes.slice())
        return { path: null, digest: bytesDigest(bytes) }
      },
      async read(_operation, name) {
        return stored.get(name) ?? null
      },
    }
    const makeJournal = () =>
      createMetaEpochSwitchJournal({
        connection: h.target,
        artifacts,
        scratchRoot: join(h.appHome, 't19-local'),
        async acquireOperationLock() {
          return { release() {} }
        },
      })
    const journal = makeJournal()
    const root = journal.operationRoot(h.operationId)
    await journal.prunePlanContent!(h.operationId, retainedManifests(root))
    expect(existsSync(join(root, 'runs/run/plan-content/obsolete.json'))).toBe(false)
    expect(existsSync(join(root, 'runs/run/plan-content/approved.json'))).toBe(true)
    const bytes = Buffer.alloc(1024 * 1024, 42)
    const source = join(h.appHome, 't19-source.sqlite')
    writeFileSync(source, bytes)
    const digest = await journal.artifacts!(h.operationId).putFile!(
      'backup/database.sqlite',
      source,
    )
    expect(digest).toBe(bytesDigest(bytes))
    rmSync(root, { recursive: true, force: true })
    expect(
      readFileSync(
        await makeJournal().artifacts!(h.operationId).get('backup/database.sqlite', digest),
      ),
    ).toEqual(bytes)
    expect([...stored.keys()].some((key) => key.endsWith('/manifest.json'))).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------
// Progress output: synchronous rate limiting and stderr must not alter CLI JSON.
// ------------------------------------------------------------------------------------------------

test('T19 reporter emits boundaries immediately and limits each phase independently without timers', () => {
  let now = 1000
  const lines: string[] = []
  const progress = createMigrationProgressReporter((line) => lines.push(line), { now: () => now })
  progress({ phase: 'conversion', detail: 'start', boundary: true })
  for (let i = 1; i <= 1000; i++)
    progress({ phase: 'conversion', detail: 'copy', completed: i, total: 1000 })
  expect(lines).toHaveLength(1)
  now += 3000
  progress({ phase: 'conversion', detail: 'copy', completed: 1000, total: 1000 })
  progress({ phase: 'load', detail: 'load', completed: 1 })
  progress({ phase: 'conversion', detail: 'done', boundary: true })
  expect(lines).toHaveLength(4)
  expect(lines[1]).toContain('1000/1000 units (3.0s elapsed)')
  expect(lines[2]).toContain('load: load 1 units')
  expect(lines.at(-1)).toContain('conversion: done')
})

test('T19 orchestration phases reach the callback; library callers stay silent by default', async () => {
  const f = makeSwitchFixture()
  const events: MigrationProgress[] = []
  const app = createEpochSwitchApplication({ ...f.deps, progress: (event) => events.push(event) })
  try {
    const plan = await app.plan({})
    await app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest })
    await app.verify({ operationId: f.operationId })
    const phases = events
      .filter((event) => event.boundary)
      .map((event) => `${event.phase}:${event.detail}`)
    expect(phases).toEqual([
      'backup:live backup',
      'backup:live backup complete',
      'freeze:quiesce writers',
      'load:start',
      'load:complete',
      'validation:constraints and content',
      'validation:complete',
      'activation:prepare',
      'activation:activated',
      'validation:verify target',
      'validation:verified',
    ])
    const count = events.length
    await f.app.verify({ operationId: f.operationId })
    expect(events).toHaveLength(count)
  } finally {
    f.close()
  }
})

test('T19 CLI JSON is byte-identical with a progress callback writing stderr', async () => {
  const f = makeSwitchFixture()
  try {
    const planned = await f.app.plan({})
    for (const verb of ['plan', 'run', 'verify'] as const) {
      const result = { ...planned, operationId: 't19-stable-output' }
      let stderr = ''
      const progress = createMigrationProgressReporter(
        (line) => {
          stderr += line
        },
        { now: () => 0 },
      )
      const application = { ...f.app, [verb]: async () => result }
      const argv = [verb, ...(verb === 'plan' ? [] : [f.operationId]), '--json']
      const silent = await epochMigrationCommand(argv, { application })
      const observed = await epochMigrationCommand(argv, {
        application: {
          ...application,
          [verb]: async () => {
            progress({
              phase: verb === 'verify' ? 'validation' : 'conversion',
              detail: verb,
              boundary: true,
            })
            return result
          },
        },
      })
      expect(observed).toEqual(silent)
      expect(observed.output).toBe(JSON.stringify(result))
      expect(stderr).toContain('[db migration]')
      expect(observed.output).not.toContain('[db migration]')
    }
    // Keep the actual entry-to-stderr wiring under regression coverage as well.
    for (const entry of ['epochMigrationEntry.ts', 'epochMigrationHostedEntry.ts']) {
      const text = readFileSync(join(import.meta.dir, '../src/bootstrap', entry), 'utf8')
      expect(text).toContain('progress: createMigrationProgressReporter(')
      expect(text).toContain('writeSync(2, line)')
    }
  } finally {
    f.close()
  }
})

test('T19 child CLI writes human progress only to fd 2; all three stdout JSON lines are byte-identical', async () => {
  const run = async (progress: boolean) => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'helpers/rfc395T19ProgressCli.ts'),
        ...(progress ? ['--progress'] : []),
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined },
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code).toBe(0)
    return { stdout, stderr }
  }
  const silent = await run(false)
  const observed = await run(true)
  expect(silent.stderr).toBe('')
  expect(observed.stdout).toBe(silent.stdout)
  expect(
    observed.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).method),
  ).toEqual(['plan', 'run', 'verify'])
  expect(observed.stderr.trim().split('\n')).toHaveLength(3)
  expect(observed.stderr).toContain('validation: verify 3 units (0.0s elapsed)')
})

// ------------------------------------------------------------------------------------------------
// Staging peak and conversion progress: staging peak survives close; conversion reports from synchronous loops.
// ------------------------------------------------------------------------------------------------

test('T19 staging peak includes lookup bytes and remains observable after deletion', () => {
  const root = mkdtempSync(join(tmpdir(), 't19p-staging-'))
  const store = createStagingStore(root)
  const initial = store.peakBytes
  try {
    store.putLookup('large', 'one', 'x'.repeat(2 * 1024 * 1024))
    const peak = store.peakBytes
    expect(peak).toBeGreaterThanOrEqual(initial + 2 * 1024 * 1024)
    expect(peak).toBeGreaterThanOrEqual(statSync(store.path).size)
    store.close()
    expect(existsSync(dirname(store.path))).toBe(false)
    expect(store.peakBytes).toBe(peak)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describeV2Providers('T19 measured staging and progress', (h) => {
  test('captures peak before close; pages, lookups and units report in order with unchanged results', async () => {
    await h.install()
    await h.write(
      'maintenance_state',
      Array.from({ length: 5 }, (_, i) => ({
        key: `t19-${i}`,
        value: 'x'.repeat(20000),
        updated_at: i,
      })),
    )
    const lookup = columnLookup('maintenance_state', ['key'], ['value'])
    const events: MigrationProgress[] = []
    const input = await h.input(
      [
        {
          rules: [
            {
              ref: { id: 't19/copy', version: 1 },
              owner: 'fixture',
              claims: ['maintenance_state'],
              produces: [{ table: 'maintenance_state' }],
              lookups: [lookup.key],
              unit: { kind: 'source-chunk', table: 'maintenance_state' },
              disposition: 'preserved',
              convert(unit, ctx) {
                for (const row of unit.rows.get('maintenance_state')!)
                  ctx.out.row('maintenance_state', row.values, row)
              },
            },
          ],
          lookups: [lookup],
          validators: [],
        },
      ],
      { chunkLimit: 2 },
    )
    let peak = 0
    try {
      const observed = await runConversion(
        {
          ...input,
          progress: (event) => events.push(event),
          onStagingPeak(bytes) {
            peak = bytes
            expect(
              readdirSync(input.scratchRoot).some((name) => name.startsWith('conversion-')),
            ).toBe(true)
          },
        },
        createDryRunSink(),
      )
      expect(peak).toBeGreaterThan(200000)
      expect(readdirSync(input.scratchRoot)).toEqual([])
      expect(events[0]).toMatchObject({ phase: 'conversion', detail: 'start', boundary: true })
      const pages = events.filter((event) => event.detail.startsWith('staging current/'))
      expect(pages.map((event) => event.completed)).toEqual([2, 4, 5])
      expect(events.some((event) => event.detail.startsWith('lookup '))).toBe(true)
      expect(
        events.filter((event) => event.detail === 't19/copy').map((event) => event.completed),
      ).toEqual([1, 2, 3])
      expect(events.at(-1)).toMatchObject({ detail: 'complete', completed: 3, boundary: true })
      const count = events.length
      expect(await runConversion(input, createDryRunSink())).toEqual(observed)
      expect(events).toHaveLength(count)
    } finally {
      await input.source.close()
    }
  })
})
