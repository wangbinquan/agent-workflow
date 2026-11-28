// RFC-626 §4.2 "冻结记录" and the first two rows of its table "中途崩溃的各个窗口"
// (design/RFC-626-upgrade-no-refusal-minimal-time/design.md), with §4.1 and §3.3 as they show
// at the level of the source access.
//
// Before RFC-626 the frozen copy of the old database lived in a temporary directory and went
// with the source handle, so the plan step and the run step of one upgrade each copied and
// measured the whole database. An automatic upgrade now keeps its freeze in the run directory:
//
//   <operation root>/source-access/frozen/original.sqlite   the frozen copy (SQLite sources)
//   <operation root>/source-access/frozen/freeze.json       its record
//
// What this file locks:
//   * publication order — copy, then record, then work copy, then binding — and what each
//     half-finished state means on the next entry;
//   * taking a freeze over: nothing copied and nothing measured within one process, the old
//     database measured exactly once after a restart;
//   * a changed old database: frozen again in the same directory while the plan is not pinned,
//     reported as `source-changed` once it is (the caller says so with `expected`);
//   * an operator's handles keep nothing and behave as before;
//   * rows whose foreign key dangles no longer fail an automatic freeze (§3.3).
import { setDefaultTimeout, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import {
  appendFileSync,
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
import { join } from 'node:path'
import { describeV1Providers, installFrozenSqlite } from './helpers/rfc395V1Harness'
import {
  frozenSourceDetails,
  openFrozenSource,
  openLiveSnapshotSource,
  type SourceAccessInput,
} from '@/platform/persistence/migration/freeze/sourceAccess'
import {
  FREEZE_RECORD_FILE,
  FROZEN_COPY_FILE,
  describesFreeze,
  discardFreezeRecord,
  freezeIdentity,
  publishFreezeRecord,
  readFreezeRecord,
  type FileFreeze,
} from '@/platform/persistence/migration/freeze/freezeRecord'
import { createSourceWatch } from '@/platform/persistence/migration/freeze/sourceWatch'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import type {
  SourceMeasurementObserver,
  SourcePreflight,
} from '@/platform/persistence/migration/sourceTypes'
import type { MigrationProgress } from '@/platform/persistence/migration/run/progress'
import type { FrozenSourceHandle } from '@/platform/persistence/migration/run/types'
import { createEpochSourceAdapter } from '@/modules/system-operations/infrastructure/epochSwitch/sourceAdapter'

// A freeze of the frozen head takes a few seconds on CI; allow 90 s. Cases that upgrade an old
// prefix offline set their own, longer limit.
setDefaultTimeout(90_000)
const OFFLINE_UPGRADE_MS = 300_000

/** RFC-626 §7: every source access below is handed this; it counts whole-database digests. */
const digests = { count: 0 }
const onMeasure: SourceMeasurementObserver = (kind) => {
  if (kind === 'sqlite-content') digests.count += 1
}
async function digestsDuring(work: () => Promise<unknown> | unknown): Promise<number> {
  const before = digests.count
  await work()
  return digests.count - before
}
function addDanglingUser(database: Database): void {
  const columns = (database.query('PRAGMA table_info(users)').all() as { name: string }[]).map(
    (column) => column.name,
  )
  const values = columns.map((name) =>
    name === 'id' || name === 'username'
      ? "'rfc626-dangling'"
      : name === 'created_by'
        ? "'rfc626-missing-user'"
        : `"${name}"`,
  )
  database.exec('PRAGMA foreign_keys=OFF')
  database.exec(
    `INSERT INTO users (${columns.map((name) => `"${name}"`).join(', ')}) SELECT ${values.join(', ')} FROM users WHERE id='__system__'`,
  )
  expect(database.query('PRAGMA foreign_key_check').all()).toHaveLength(1)
}
const expectedOf = (source: FrozenSourceHandle) => ({
  watermark: source.watermark,
  preUpgradeWatermark: source.preUpgrade?.preflight.watermark ?? null,
  sourceGenerationId: source.preflight.sourceGenerationId,
})

describeV1Providers('RFC-626 freeze record', (h) => {
  const work = () => join(h.operationRoot, 'access/source-access')
  const frozenRoot = () => join(work(), 'frozen')
  const frozenCopy = () => join(frozenRoot(), FROZEN_COPY_FILE)
  const recordText = () => readFileSync(join(frozenRoot(), FREEZE_RECORD_FILE), 'utf8')

  if (h.provider === 'sqlite') {
    const input = async (extra: Partial<SourceAccessInput> = {}): Promise<SourceAccessInput> => ({
      manifest: await h.manifest(),
      emptyTables: [],
      operationRoot: join(h.operationRoot, 'access'),
      location: {
        kind: 'sqlite-file',
        path: h.sqlitePath,
        pointerPath: join(h.operationRoot, 'missing-pointer.json'),
      },
      onMeasure,
      ...extra,
    })
    const value = async (source: FrozenSourceHandle) =>
      (await source.reader.readChunk('maintenance_state', null, 10)).decodedRows.find(
        (row) => row.key === 'v1-a',
      )?.value
    const change = (text: string) =>
      h.sqlite.query("UPDATE maintenance_state SET value=? WHERE key='v1-a'").run(text)

    test('an automatic freeze publishes the copy and its record, and both outlive the handle', async () => {
      await h.install()
      await h.seed()
      const watch = createSourceWatch()
      try {
        let source!: FrozenSourceHandle
        expect(
          await digestsDuring(async () => {
            source = await openFrozenSource(await input({ resolution: 'automatic', watch }))
          }),
        ).toBe(1)
        // The backup and the offline upgrade read this very file.
        expect(frozenSourceDetails(source).sqlitePath).toBe(frozenCopy())
        const record = readFreezeRecord(frozenRoot())
        expect(record).toMatchObject({
          version: 1,
          provider: 'sqlite',
          watermark: source.watermark,
          sourceGenerationId: source.preflight.sourceGenerationId,
          fingerprintDigest: source.preflight.fingerprint.digest,
          catalogDigest: source.preflight.fingerprint.catalogDigest,
          // The frozen head needs no work copy.
          bindingDigest: null,
          copy: { file: FROZEN_COPY_FILE, bytes: statSync(frozenCopy()).size },
          foreignKeyViolations: 0,
        })
        expect((record as FileFreeze).content).toMatch(/^sha256:[a-f0-9]{64}$/)
        expect(recordText()).toBe(canonicalSchemaJson(record))
        // No temporary reader copy next to the durable one.
        expect(readdirSync(work())).toEqual(['frozen'])
        await source.close()
        expect(existsSync(frozenCopy())).toBe(true)
        expect(readFreezeRecord(frozenRoot())).toEqual(record)
        // Closing the handle closed neither the watch nor its connection to the old database.
        expect(typeof watch.sqliteDataVersion(h.sqlitePath)).toBe('number')
      } finally {
        watch.close()
      }
    })

    test('a later handle of the same process takes the freeze over: nothing copied, nothing measured', async () => {
      await h.install()
      await h.seed()
      const watch = createSourceWatch()
      try {
        const request = await input({ resolution: 'automatic', watch })
        const first = await openFrozenSource(request)
        const expected = expectedOf(first)
        const preflight = first.preflight
        const rows = await first.reader.readChunk('maintenance_state', null, 100)
        await first.close()
        const file = statSync(frozenCopy())
        const text = recordText()
        // Re-planning (no `expected`) and the run step (with it) both reopen.
        for (const reopen of [request, { ...request, expected }]) {
          let again!: FrozenSourceHandle
          expect(
            await digestsDuring(async () => {
              again = await openFrozenSource(reopen)
            }),
          ).toBe(0)
          try {
            expect(again.watermark).toBe(expected.watermark)
            expect(again.preflight).toEqual(preflight)
            expect(await again.reader.readChunk('maintenance_state', null, 100)).toEqual(rows)
            // The handle's own checks and reads are not a reason to measure either.
            expect(
              await digestsDuring(async () => {
                await again.reader.assertUnchanged(again.preflight)
                await again.reader.preflight()
                await again.reader.assertUnchanged(structuredClone(again.preflight))
              }),
            ).toBe(0)
          } finally {
            await again.close()
          }
          expect(statSync(frozenCopy()).ino).toBe(file.ino)
          expect(statSync(frozenCopy()).mtimeMs).toBe(file.mtimeMs)
          expect(recordText()).toBe(text)
        }
      } finally {
        watch.close()
      }
    })

    test('after a restart the old database is measured exactly once and the freeze is still taken over', async () => {
      await h.install()
      await h.seed()
      const beforeRestart = createSourceWatch()
      const first = await openFrozenSource(
        await input({ resolution: 'automatic', watch: beforeRestart }),
      )
      const expected = expectedOf(first)
      await first.close()
      beforeRestart.close()
      const file = statSync(frozenCopy())
      // A new process has a new watch and remembers nothing.
      for (const watch of [createSourceWatch(), undefined]) {
        let again!: FrozenSourceHandle
        try {
          expect(
            await digestsDuring(async () => {
              again = await openFrozenSource({
                ...(await input({ resolution: 'automatic', watch })),
                expected,
              })
            }),
          ).toBe(1)
          expect(again.watermark).toBe(expected.watermark)
          expect(statSync(frozenCopy()).ino).toBe(file.ino)
          // The measurement is the baseline for the rest of this handle.
          expect(await digestsDuring(() => again.reader.assertUnchanged(again.preflight))).toBe(0)
        } finally {
          await again?.close()
          watch?.close()
        }
      }
    })

    test('a copy without a record is an unfinished freeze: it is cleared and the freeze is taken again', async () => {
      await h.install()
      await h.seed()
      // The process died after the copy was written and before its record was published.
      mkdirSync(frozenRoot(), { recursive: true })
      writeFileSync(frozenCopy(), 'half of a copy')
      writeFileSync(`${frozenCopy()}-journal`, 'leftover')
      writeFileSync(join(frozenRoot(), `${FREEZE_RECORD_FILE}.crashed.tmp`), '{')
      const source = await openFrozenSource(await input({ resolution: 'automatic' }))
      try {
        const record = readFreezeRecord(frozenRoot()) as FileFreeze
        expect(record.copy.bytes).toBe(statSync(frozenCopy()).size)
        expect(record.copy.bytes).toBeGreaterThan('half of a copy'.length)
        expect(readdirSync(frozenRoot()).sort()).toEqual([FREEZE_RECORD_FILE, FROZEN_COPY_FILE])
        expect(await value(source)).toBe('{ "original": 1 }\n')
      } finally {
        await source.close()
      }
    })

    test('the record is published before the work copy is attempted, and a failed work copy keeps the freeze', async () => {
      await h.install()
      await h.seed()
      const watch = createSourceWatch()
      try {
        const request = await input({ resolution: 'automatic', watch })
        // A head nobody can reach makes the offline upgrade fail after the freeze succeeded.
        const unreachable = { ...request.manifest, headDigest: `sha256:${'f'.repeat(64)}` }
        await expect(openFrozenSource({ ...request, manifest: unreachable })).rejects.toThrow(
          'did not reach the frozen head',
        )
        const record = readFreezeRecord(frozenRoot()) as FileFreeze
        expect(record.copy.bytes).toBe(statSync(frozenCopy()).size)
        // A source that needs a work copy records which binding that copy will have.
        expect(record.bindingDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
        expect(existsSync(join(work(), 'upgrade/binding.json'))).toBe(false)
        const file = statSync(frozenCopy())
        // The next entry takes the frozen copy over and only has the rest to do.
        let source!: FrozenSourceHandle
        expect(
          await digestsDuring(async () => {
            source = await openFrozenSource(request)
          }),
        ).toBe(0)
        try {
          expect(statSync(frozenCopy()).ino).toBe(file.ino)
          expect(source.watermark).toBe(record.watermark)
        } finally {
          await source.close()
        }
      } finally {
        watch.close()
      }
    })

    test('a record whose copy is no longer the recorded file is replaced, also for a pinned plan', async () => {
      await h.install()
      await h.seed()
      const watch = createSourceWatch()
      try {
        const request = await input({ resolution: 'automatic', watch })
        const first = await openFrozenSource(request)
        const expected = expectedOf(first)
        await first.close()
        appendFileSync(frozenCopy(), Buffer.alloc(8192))
        // The old database is what it was: the copy is simply made again, and the identity a
        // pinned plan expects still holds.
        const again = await openFrozenSource({ ...request, expected })
        try {
          expect(again.watermark).toBe(expected.watermark)
          expect((readFreezeRecord(frozenRoot()) as FileFreeze).copy.bytes).toBe(
            statSync(frozenCopy()).size,
          )
          expect(await value(again)).toBe('{ "original": 1 }\n')
        } finally {
          await again.close()
        }
      } finally {
        watch.close()
      }
    })

    test('a changed old database is frozen again in place before the plan is pinned and reported after', async () => {
      await h.install()
      await h.seed()
      const watch = createSourceWatch()
      try {
        const request = await input({ resolution: 'automatic', watch })
        const first = await openFrozenSource(request)
        const expected = expectedOf(first)
        await first.close()
        const text = recordText()
        const file = statSync(frozenCopy())
        change('written between plan and run')

        // Pinned: the caller has to start a new run, and this run's freeze stays as it is.
        await expect(openFrozenSource({ ...request, expected })).rejects.toThrow('source-changed')
        expect(recordText()).toBe(text)
        expect(statSync(frozenCopy()).ino).toBe(file.ino)
        expect(statSync(frozenCopy()).size).toBe(file.size)
        const adapter = createEpochSourceAdapter({
          async resolve() {
            return request
          },
        })
        await expect(adapter.freeze({ ...request, expected })).rejects.toMatchObject({
          category: 'source-changed',
        })
        expect(recordText()).toBe(text)

        // Not pinned: nothing depends on the earlier identity, so the same directory is reused.
        const again = await openFrozenSource(request)
        try {
          expect(again.watermark).not.toBe(expected.watermark)
          expect(await value(again)).toBe('written between plan and run')
          const record = readFreezeRecord(frozenRoot()) as FileFreeze
          expect(record.watermark).toBe(again.watermark)
          expect(record.copy.bytes).toBe(statSync(frozenCopy()).size)
          expect(frozenSourceDetails(again).sqlitePath).toBe(frozenCopy())
        } finally {
          await again.close()
        }
      } finally {
        watch.close()
      }
    })

    test('a commit that a checkpoint absorbed between two starts is still found', async () => {
      await h.install()
      await h.seed()
      h.sqlite.exec('PRAGMA journal_mode=WAL')
      change('{ "original": 1 }\n')
      const beforeRestart = createSourceWatch()
      const first = await openFrozenSource(
        await input({ resolution: 'automatic', watch: beforeRestart }),
      )
      const expected = expectedOf(first)
      await first.close()
      beforeRestart.close()
      // Between two starts nothing watches the file, and afterwards its size, its header and
      // its -wal can all look untouched. Only the content identity can tell.
      change('written while nobody was watching')
      h.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      await expect(
        openFrozenSource({ ...(await input({ resolution: 'automatic' })), expected }),
      ).rejects.toThrow('source-changed')
    })

    test('an operator freeze keeps nothing and writes no unread preflight file', async () => {
      await h.install()
      await h.seed()
      for (const resolution of [undefined, 'operator'] as const) {
        const request = await input(resolution ? { resolution } : {})
        const source = await openFrozenSource(request)
        const expected = expectedOf(source)
        try {
          expect(existsSync(frozenRoot())).toBe(false)
          // The frozen copy is the reader's temporary one, as it always was.
          expect(frozenSourceDetails(source).sqlitePath).toMatch(/epoch1-source-[^/\\]+/)
          expect(readdirSync(work()).filter((name) => name.startsWith('preflight-'))).toEqual([])
        } finally {
          await source.close()
        }
        expect(readdirSync(work())).toEqual([])
        // Each handle of an operator freezes for itself: one digest, not the earlier dozen.
        let again!: FrozenSourceHandle
        expect(
          await digestsDuring(async () => {
            again = await openFrozenSource({ ...request, expected })
          }),
        ).toBe(1)
        await again.close()
      }
    })

    test('a live plan snapshot is read in place and keeps no freeze, whatever the resolution', async () => {
      await h.install()
      await h.seed()
      for (const resolution of [undefined, 'automatic'] as const) {
        let source!: FrozenSourceHandle
        expect(
          await digestsDuring(async () => {
            source = await openLiveSnapshotSource(await input(resolution ? { resolution } : {}))
          }),
        ).toBe(1)
        try {
          // The snapshot the plan took is the copy the reader reads: no second copy of it.
          expect(frozenSourceDetails(source).sqlitePath).toMatch(/plan-snapshot-[^/\\]+/)
          expect(readdirSync(work()).filter((name) => name.startsWith('epoch1-source-'))).toEqual(
            [],
          )
          expect(existsSync(frozenRoot())).toBe(false)
          change(`advanced while planning ${resolution ?? 'operator'}`)
          expect(await digestsDuring(() => source.reader.assertUnchanged(source.preflight))).toBe(0)
        } finally {
          await source.close()
        }
      }
    })

    test('rows whose foreign key dangles are left to the conversion by an automatic freeze only', async () => {
      await h.install()
      await h.seed()
      addDanglingUser(h.sqlite)
      await expect(openFrozenSource(await input())).rejects.toThrow('foreign-key violation')
      const adapter = createEpochSourceAdapter({
        async resolve() {
          return input()
        },
      })
      await expect(adapter.freeze(await input())).rejects.toMatchObject({
        category: 'source-blocked',
      })
      const progress: MigrationProgress[] = []
      const source = await openFrozenSource(
        await input({ resolution: 'automatic', progress: (event) => progress.push(event) }),
      )
      try {
        expect((readFreezeRecord(frozenRoot()) as FileFreeze).foreignKeyViolations).toBe(1)
        expect(progress.map((event) => event.detail)).toContainEqual(
          expect.stringContaining('1 row(s) with a dangling foreign key'),
        )
        // The row itself is in the frozen copy, for the conversion to decide about.
        expect(source.preflight.fingerprint.tableRows.users).toBeGreaterThanOrEqual(2)
      } finally {
        await source.close()
      }
    })

    test(
      'with an offline upgrade the database is measured twice in all, and not at all when both copies are taken over',
      async () => {
        await installFrozenSqlite(h.sqlite, 120)
        const watch = createSourceWatch()
        try {
          const request = await input({ resolution: 'automatic', watch })
          let first!: FrozenSourceHandle
          // Once for the frozen copy (the identity of the old database) and once for the work
          // copy (the identity of what the conversion reads). Design §4.1, §7.
          expect(
            await digestsDuring(async () => {
              first = await openFrozenSource(request)
            }),
          ).toBe(2)
          const expected = expectedOf(first)
          const preflight = first.preflight
          const record = readFreezeRecord(frozenRoot()) as FileFreeze
          const bindingPath = join(work(), 'upgrade/binding.json')
          const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as {
            bindingDigest: string
            directory: string
            sqlitePath: string
            frozen: boolean
            copy?: { content: string; bytes: number }
          }
          // The record names the binding its work copy has.
          expect(record.bindingDigest).toBe(binding.bindingDigest)
          expect(binding.frozen).toBe(true)
          const workCopy = join(work(), 'upgrade', binding.sqlitePath)
          expect(binding.copy).toEqual({
            content: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            bytes: statSync(workCopy).size,
          })
          await first.close()
          // Both copies stay; the temporary directories of the upgrade do not.
          expect(readdirSync(work()).sort()).toEqual(['frozen', 'upgrade'])
          const files = [statSync(frozenCopy()), statSync(workCopy)]
          const unchanged = () => {
            expect(statSync(frozenCopy()).ino).toBe(files[0]!.ino)
            expect(statSync(workCopy).ino).toBe(files[1]!.ino)
            expect(statSync(workCopy).mtimeMs).toBe(files[1]!.mtimeMs)
            expect(JSON.parse(readFileSync(bindingPath, 'utf8'))).toEqual(binding)
          }

          let second!: FrozenSourceHandle
          expect(
            await digestsDuring(async () => {
              second = await openFrozenSource({ ...request, expected })
            }),
          ).toBe(0)
          try {
            expect(second.preflight).toEqual(preflight)
            expect<string | null | undefined>(second.preUpgrade?.preflight.watermark).toBe(
              expected.preUpgradeWatermark,
            )
            expect(await digestsDuring(() => second.reader.assertUnchanged(second.preflight))).toBe(
              0,
            )
          } finally {
            await second.close()
          }
          unchanged()

          // A new process: the old database once, neither copy.
          const restarted = createSourceWatch()
          let third!: FrozenSourceHandle
          try {
            expect(
              await digestsDuring(async () => {
                third = await openFrozenSource({ ...request, watch: restarted, expected })
              }),
            ).toBe(1)
            expect(third.preflight).toEqual(preflight)
          } finally {
            await third?.close()
            restarted.close()
          }
          unchanged()
        } finally {
          watch.close()
        }
      },
      OFFLINE_UPGRADE_MS,
    )

    test(
      'a record without a matching binding has only the work copy made again',
      async () => {
        await installFrozenSqlite(h.sqlite, 120)
        const watch = createSourceWatch()
        try {
          const request = await input({ resolution: 'automatic', watch })
          const first = await openFrozenSource(request)
          const frozenWatermark = first.preUpgrade?.preflight.watermark
          await first.close()
          const bindingPath = join(work(), 'upgrade/binding.json')
          const earlier = JSON.parse(readFileSync(bindingPath, 'utf8')) as { directory: string }
          // The process died after the work copy was written and before its binding was.
          rmSync(bindingPath)
          const file = statSync(frozenCopy())
          const text = recordText()
          let again!: FrozenSourceHandle
          // The frozen copy is taken over; only the new work copy is measured.
          expect(
            await digestsDuring(async () => {
              again = await openFrozenSource(request)
            }),
          ).toBe(1)
          try {
            expect(statSync(frozenCopy()).ino).toBe(file.ino)
            expect(recordText()).toBe(text)
            const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as { directory: string }
            expect(binding.directory).not.toBe(earlier.directory)
            // The orphaned copy went; exactly one work copy is left.
            expect(
              readdirSync(join(work(), 'upgrade')).filter((name) => name.startsWith('copy-')),
            ).toEqual([binding.directory])
            // The identity of the old database is the one that was frozen.
            expect(again.preUpgrade?.preflight.watermark).toBe(frozenWatermark)
          } finally {
            await again.close()
          }
        } finally {
          watch.close()
        }
      },
      OFFLINE_UPGRADE_MS,
    )

    test(
      'a freeze taken again before the plan is pinned replaces the work copy of the earlier one',
      async () => {
        await installFrozenSqlite(h.sqlite, 120)
        const watch = createSourceWatch()
        try {
          const request = await input({ resolution: 'automatic', watch })
          const first = await openFrozenSource(request)
          const expected = expectedOf(first)
          await first.close()
          const bindingPath = join(work(), 'upgrade/binding.json')
          const earlier = JSON.parse(readFileSync(bindingPath, 'utf8')) as { directory: string }
          h.sqlite.exec(
            "UPDATE users SET display_name='changed before pinning' WHERE id='__system__'",
          )

          // Pinned: reported, and the work copy of the pinned run is left alone.
          await expect(openFrozenSource({ ...request, expected })).rejects.toThrow('source-changed')
          expect(existsSync(join(work(), 'upgrade', earlier.directory))).toBe(true)

          const again = await openFrozenSource(request)
          try {
            expect(again.watermark).not.toBe(expected.watermark)
            const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as { directory: string }
            // Nothing depended on the earlier identity: its copy is gone, not retained.
            expect(
              readdirSync(join(work(), 'upgrade')).filter((name) => name.startsWith('copy-')),
            ).toEqual([binding.directory])
            expect<string | undefined>(
              (readFreezeRecord(frozenRoot()) as FileFreeze).watermark,
            ).toBe(again.preUpgrade?.preflight.watermark)
          } finally {
            await again.close()
          }
        } finally {
          watch.close()
        }
      },
      OFFLINE_UPGRADE_MS,
    )

    test(
      'an operator upgrade keeps its binding as it was and reads its work copy in place',
      async () => {
        await installFrozenSqlite(h.sqlite, 120)
        const request = await input()
        let first!: FrozenSourceHandle
        expect(
          await digestsDuring(async () => {
            first = await openFrozenSource(request)
          }),
        ).toBe(2)
        const expected = expectedOf(first)
        const preflight = first.preflight
        try {
          expect(existsSync(frozenRoot())).toBe(false)
          // The work copy is read where it lies: no reader copy of it next to the original's.
          expect(
            readdirSync(work()).filter((name) => name.startsWith('epoch1-source-')),
          ).toHaveLength(1)
        } finally {
          await first.close()
        }
        const binding = JSON.parse(readFileSync(join(work(), 'upgrade/binding.json'), 'utf8'))
        // No field an earlier release did not write.
        expect(Object.keys(binding).sort()).toEqual([
          'bindingDigest',
          'currentWatermark',
          'directory',
          'frozen',
          'generationId',
          'originalWatermark',
          'scratchFingerprint',
          'sqlitePath',
        ])
        // The next handle freezes the old database again and identifies the work copy once.
        let again!: FrozenSourceHandle
        expect(
          await digestsDuring(async () => {
            again = await openFrozenSource({ ...request, expected })
          }),
        ).toBe(2)
        try {
          expect(again.preflight).toEqual(preflight)
        } finally {
          await again.close()
        }
      },
      OFFLINE_UPGRADE_MS,
    )
  }

  if (h.provider === 'postgresql')
    test('a database source records identity, row counts and sequence values, and is compared on reopen', async () => {
      await h.install()
      await h.seed()
      const watch = createSourceWatch()
      const request: SourceAccessInput = {
        manifest: await h.manifest(),
        emptyTables: [],
        operationRoot: join(h.operationRoot, 'access'),
        location: { kind: 'postgresql-database', profileRef: 'env:RFC626_SOURCE' },
        postgresql: () => h.runtime,
        resolution: 'automatic',
        watch,
      }
      try {
        const first = await openFrozenSource(request)
        const original = frozenSourceDetails(first).originalPreflight
        const expected = expectedOf(first)
        await first.close()
        const record = readFreezeRecord(frozenRoot())
        expect(record).toMatchObject({
          version: 1,
          provider: 'postgresql',
          watermark: original.watermark,
          sourceGenerationId: original.sourceGenerationId,
          fingerprintDigest: original.fingerprint.digest,
          tableRows: original.fingerprint.tableRows,
          identityHighWater: original.identityHighWater,
          bindingDigest: null,
        })
        // The freeze of a database is a transaction, not a file.
        expect(readdirSync(frozenRoot())).toEqual([FREEZE_RECORD_FILE])
        const text = recordText()

        const again = await openFrozenSource({ ...request, expected })
        await again.close()
        expect(recordText()).toBe(text)

        // A change the cheap evidence can see: one more row.
        await h.native.execute(
          `INSERT INTO ${h.table('maintenance_state')} (key,value,updated_at) VALUES ($1,$2,$3)`,
          ['rfc626-new', 'x', 1],
        )
        await expect(openFrozenSource({ ...request, expected })).rejects.toThrow('source-changed')
        expect(recordText()).toBe(text)
        const replaced = await openFrozenSource(request)
        try {
          const now = frozenSourceDetails(replaced).originalPreflight
          expect(now.watermark).not.toBe(original.watermark)
          expect(readFreezeRecord(frozenRoot())).toMatchObject({
            provider: 'postgresql',
            watermark: now.watermark,
            tableRows: now.fingerprint.tableRows,
          })
        } finally {
          await replaced.close()
        }
      } finally {
        watch.close()
      }
    })
})

describe('RFC-626 freeze record file', () => {
  const preflight = {
    watermark: 'sha256:watermark',
    sourceGenerationId: 'dbg_rfc626_fixture',
    fingerprint: { digest: 'sha256:fingerprint', catalogDigest: 'sha256:catalog' },
  } as unknown as SourcePreflight
  const directory = () => mkdtempSync(join(tmpdir(), 'aw-rfc626-freeze-'))
  const fileFreeze = (root: string): FileFreeze => {
    writeFileSync(join(root, FROZEN_COPY_FILE), 'frozen bytes')
    return {
      ...freezeIdentity(preflight, 'sha256:binding'),
      provider: 'sqlite',
      content: 'sha256:content',
      copy: { file: FROZEN_COPY_FILE, bytes: 'frozen bytes'.length },
      foreignKeyViolations: 2,
    }
  }

  test('a published record reads back, describes its preflight and is canonical JSON with its own digest', async () => {
    const root = directory()
    try {
      expect(readFreezeRecord(root)).toBeNull()
      const published = await publishFreezeRecord(root, fileFreeze(root))
      expect(readFreezeRecord(root)).toEqual(published)
      expect(readFileSync(join(root, FREEZE_RECORD_FILE), 'utf8')).toBe(
        canonicalSchemaJson(published),
      )
      expect(published).toMatchObject({
        version: 1,
        watermark: 'sha256:watermark',
        sourceGenerationId: 'dbg_rfc626_fixture',
        fingerprintDigest: 'sha256:fingerprint',
        catalogDigest: 'sha256:catalog',
        bindingDigest: 'sha256:binding',
      })
      expect(describesFreeze(published, preflight)).toBe(true)
      for (const changed of [
        { ...preflight, watermark: 'sha256:other' },
        { ...preflight, sourceGenerationId: 'dbg_other_generation' },
        { ...preflight, fingerprint: { ...preflight.fingerprint, digest: 'sha256:other' } },
      ])
        expect(describesFreeze(published, changed as SourcePreflight)).toBe(false)
      // No temporary file is left next to the record.
      expect(readdirSync(root).sort()).toEqual([FREEZE_RECORD_FILE, FROZEN_COPY_FILE])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a database record needs no file and keeps the cheap evidence it was confirmed at', async () => {
    const root = directory()
    try {
      const published = await publishFreezeRecord(root, {
        ...freezeIdentity(preflight, null),
        provider: 'postgresql',
        tableRows: { 'agent_workflow.tasks': 3 },
        identityHighWater: [],
        evidence: 'sha256:evidence',
      })
      expect(readFreezeRecord(root)).toEqual(published)
      expect(readdirSync(root)).toEqual([FREEZE_RECORD_FILE])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('anything that is not a complete record of this build reads as no record', async () => {
    const root = directory()
    try {
      const published = (await publishFreezeRecord(root, fileFreeze(root))) as FileFreeze & {
        readonly digest: string
      }
      const path = join(root, FREEZE_RECORD_FILE)
      const write = (value: unknown) =>
        writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
      for (const broken of [
        '',
        '{',
        '[]',
        'null',
        // Edited after publication: the digest no longer covers the content.
        { ...published, content: 'sha256:edited' },
        { ...published, copy: { ...published.copy, bytes: 1 } },
        { ...published, version: 2 },
        { ...published, provider: 'mysql' },
      ]) {
        write(broken)
        expect(readFreezeRecord(root)).toBeNull()
      }
      write(published)
      expect(readFreezeRecord(root)).toEqual(published)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('discarding removes the record and every trace of the copy, and nothing else', async () => {
    const root = directory()
    try {
      await publishFreezeRecord(root, fileFreeze(root))
      writeFileSync(join(root, `${FROZEN_COPY_FILE}-journal`), 'journal')
      writeFileSync(join(root, `${FREEZE_RECORD_FILE}.crashed.tmp`), '{')
      // The locator an artifact store keeps in the same directory is not part of the freeze.
      writeFileSync(join(root, '.root'), 'locator')
      discardFreezeRecord(root)
      expect(readdirSync(root)).toEqual(['.root'])
      expect(readFreezeRecord(root)).toBeNull()
      // Discarding what is not there is not an error.
      discardFreezeRecord(root)
      discardFreezeRecord(join(root, 'never-created'))
      expect(existsSync(join(root, 'never-created'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
