// RFC-626 §4.1 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md, "源身份与轻量核对"),
// §4.2 "冻结记录" as far as the reader goes, and §3.3 "旧库里本来就悬空的行".
//
// What this file locks:
//   * The content identity of a SQLite source is computed once per freeze, from the frozen copy.
//     Before RFC-626 a preflight computed it three times and every later check twice, which is
//     where most of an upgrade's time went. A counting observer handed to every reader here
//     (`onMeasure`) is the guard: a change that reintroduces a whole-database digest fails here
//     by number.
//   * "Has the source changed" is answered by `PRAGMA data_version` of a connection that stays
//     open. A commit by another connection or another process is found, and only then is the
//     content identity recomputed: the same content continues, another content is reported.
//   * A `SourceWatch` carries that knowledge from one reader to the next and is never closed by
//     a reader; without one nothing carries over.
//   * A check the version cannot answer — the version is unreadable, the held connection stopped
//     reading, or the path names another file than the one it holds — falls back to the content
//     identity, and the watch replaces a connection that stopped reading or reads a replaced
//     file (implementation gate G3-1 / G3-2).
//   * A copy this operation owns is read in place and recognised by its size; a recorded frozen
//     copy is taken over without copying or measuring, and never overwritten by the reader.
//   * With automatic resolution rows whose foreign key dangles are counted, not refused; a
//     database that fails quick_check is refused either way.
import { setDefaultTimeout, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeV1Providers } from './helpers/rfc395V1Harness'
import { openSqliteForRead } from '@/platform/persistence/sqlite/openForRead'
import {
  FrozenCopyStaleError,
  openEpoch1SqliteSource,
} from '@/platform/persistence/migration/sqliteSourceReader'
import { assertSqliteIntegrity } from '@/platform/persistence/migration/rawSourceReader'
import {
  createSourceWatch,
  type SourceWatch,
} from '@/platform/persistence/migration/freeze/sourceWatch'
import { vacuumSqliteInto } from '@/platform/persistence/migration/legacy/sqliteSnapshot'
import {
  SourceBlockedError,
  type SourceMeasurementObserver,
} from '@/platform/persistence/migration/sourceTypes'

// Installing the frozen head and freezing it takes a few seconds per case on CI; allow 60 s.
setDefaultTimeout(60_000)

/** RFC-626 §7: every reader below is handed this; it counts whole-database digests. */
const digests = { count: 0 }
const onMeasure: SourceMeasurementObserver = (kind) => {
  if (kind === 'sqlite-content') digests.count += 1
}
/** Runs `work` and returns how many whole-database digests it computed. */
async function digestsDuring(work: () => Promise<unknown> | unknown): Promise<number> {
  const before = digests.count
  await work()
  return digests.count - before
}
const SEEDED = '{ "original": 1 }\n'
function setValue(database: Database, value: string): void {
  database.query("UPDATE maintenance_state SET value=? WHERE key='v1-a'").run(value)
}
/** Commits from a process of its own, the way a tool outside the upgrade would. */
async function commitFromAnotherProcess(path: string, statements: readonly string[]) {
  const script = `import { Database } from 'bun:sqlite'; const db = new Database(process.argv[1]); db.exec('PRAGMA busy_timeout=30000'); for (const sql of JSON.parse(process.argv[2])) db.exec(sql); db.close()`
  const child = Bun.spawn([process.execPath, '-e', script, path, JSON.stringify(statements)], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
}
/** A row whose foreign key points at nothing, as an old release could leave behind. */
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
  // The fixture must really be what the test is about.
  expect(database.query('PRAGMA foreign_key_check').all()).toHaveLength(1)
}

describeV1Providers('RFC-626 SQLite source identity', (h) => {
  if (h.provider !== 'sqlite') return
  const open = async (extra: Partial<Parameters<typeof openEpoch1SqliteSource>[0]> = {}) =>
    openEpoch1SqliteSource({
      path: h.sqlitePath,
      manifest: await h.manifest(),
      operationRoot: join(h.operationRoot, 'reader'),
      onMeasure,
      ...extra,
    })

  test('a freeze computes the content identity once and later checks compute none', async () => {
    await h.install()
    await h.seed()
    const reader = await open()
    try {
      let preflight!: Awaited<ReturnType<typeof reader.preflight>>
      expect(
        await digestsDuring(async () => {
          preflight = await reader.preflight()
        }),
      ).toBe(1)
      const state = reader.copyState()
      expect(state).toMatchObject({ reused: false, foreignKeyViolations: 0 })
      expect(state.content).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(state.bytes).toBe(statSync(reader.offlinePath()).size)
      // The reader's own reads, a repeated preflight and repeated checks leave the identity alone.
      expect(
        await digestsDuring(async () => {
          await reader.assertUnchanged(preflight)
          await reader.assertUnchanged(structuredClone(preflight))
          expect(await reader.preflight()).toBe(preflight)
          await reader.readChunk('maintenance_state', null, 10)
          await reader.readRawChunk('__drizzle_migrations', null, 10)
          await reader.assertUnchanged(preflight)
        }),
      ).toBe(0)
    } finally {
      await reader.close()
    }
  })

  test('the watermark is the one the frozen copy has always had: a reader of a relocated copy agrees', async () => {
    await h.install()
    await h.seed()
    const live = await open()
    const relocated = join(h.operationRoot, 'relocated.sqlite')
    vacuumSqliteInto({ dbPath: h.sqlitePath, dest: relocated })
    const other = await open({ path: relocated })
    try {
      expect((await other.preflight()).watermark).toBe((await live.preflight()).watermark)
    } finally {
      await live.close()
      await other.close()
    }
  })

  for (const journal of ['delete', 'wal'] as const)
    test(`a commit by another connection is found by the version and decided by the content (${journal})`, async () => {
      await h.install()
      await h.seed()
      if (journal === 'wal') h.sqlite.exec('PRAGMA journal_mode=WAL')
      const reader = await open()
      try {
        const preflight = await reader.preflight()
        // Changed and changed back: the version moved, the content did not.
        setValue(h.sqlite, 'in between')
        setValue(h.sqlite, SEEDED)
        expect(await digestsDuring(() => reader.assertUnchanged(preflight))).toBe(1)
        // The re-measured version is the new baseline: nothing is computed again.
        expect(await digestsDuring(() => reader.assertUnchanged(preflight))).toBe(0)
        setValue(h.sqlite, 'changed for good')
        await expect(reader.assertUnchanged(preflight)).rejects.toBeInstanceOf(SourceBlockedError)
        await expect(reader.assertUnchanged(preflight)).rejects.toThrow('Source changed')
        // The frozen copy still serves the rows it was frozen with.
        expect(
          (await reader.readChunk('maintenance_state', null, 10)).decodedRows.find(
            (row) => row.key === 'v1-a',
          )?.value,
        ).toBe(SEEDED)
      } finally {
        await reader.close()
      }
    })

  test('a commit by another process is found in rollback-journal mode', async () => {
    await h.install()
    await h.seed()
    const reader = await open()
    try {
      const preflight = await reader.preflight()
      await commitFromAnotherProcess(h.sqlitePath, [
        "UPDATE maintenance_state SET value='from another process' WHERE key='v1-a'",
      ])
      await expect(reader.assertUnchanged(preflight)).rejects.toBeInstanceOf(SourceBlockedError)
    } finally {
      await reader.close()
    }
  })

  test('a commit by another process is found in WAL mode even after a checkpoint absorbed it', async () => {
    await h.install()
    await h.seed()
    h.sqlite.exec('PRAGMA journal_mode=WAL')
    // A commit in WAL mode first, so the reader starts from a database that has its sidecars.
    setValue(h.sqlite, SEEDED)
    const reader = await open()
    try {
      const preflight = await reader.preflight()
      const walBefore = existsSync(`${h.sqlitePath}-wal`) ? statSync(`${h.sqlitePath}-wal`).size : 0
      // File size, file header and -wal can all look as they did once the checkpoint has run
      // (design §9.5 P0-1); the held connection still sees that something was committed.
      await commitFromAnotherProcess(h.sqlitePath, [
        "UPDATE maintenance_state SET value='absorbed by a checkpoint' WHERE key='v1-a'",
        'PRAGMA wal_checkpoint(TRUNCATE)',
      ])
      expect(
        existsSync(`${h.sqlitePath}-wal`) ? statSync(`${h.sqlitePath}-wal`).size : 0,
      ).toBeLessThanOrEqual(walBefore)
      await expect(reader.assertUnchanged(preflight)).rejects.toBeInstanceOf(SourceBlockedError)
    } finally {
      await reader.close()
    }
  })

  test('a commit while the copy is being taken makes the freeze start over', async () => {
    await h.install()
    await h.seed()
    const inner = createSourceWatch()
    let readings = 0
    const watch: SourceWatch = {
      ...inner,
      sqliteDataVersion(path) {
        readings += 1
        // The second reading closes the first attempt: a commit lands just before it.
        if (readings === 2) setValue(h.sqlite, 'committed during the freeze')
        return inner.sqliteDataVersion(path)
      },
    }
    const reader = await open({ watch })
    try {
      expect(await digestsDuring(() => reader.preflight())).toBe(1)
      // Two attempts, each bracketed by two readings.
      expect(readings).toBe(4)
      expect(
        (await reader.readChunk('maintenance_state', null, 10)).decodedRows.find(
          (row) => row.key === 'v1-a',
        )?.value,
      ).toBe('committed during the freeze')
    } finally {
      await reader.close()
      inner.close()
    }
  })

  test('a source that never holds still is refused instead of frozen in an unknown state', async () => {
    await h.install()
    await h.seed()
    const inner = createSourceWatch()
    let commits = 0
    const watch: SourceWatch = {
      ...inner,
      sqliteDataVersion(path) {
        setValue(h.sqlite, `commit ${(commits += 1)}`)
        return inner.sqliteDataVersion(path)
      },
    }
    const reader = await open({ watch })
    try {
      await expect(reader.preflight()).rejects.toThrow(
        'Source changed while taking the final SQLite snapshot',
      )
      // The copy of the failed freeze is not left behind.
      expect(
        readdirSync(join(h.operationRoot, 'reader')).flatMap((entry) =>
          readdirSync(join(h.operationRoot, 'reader', entry)),
        ),
      ).toEqual([])
    } finally {
      await reader.close()
      inner.close()
    }
  })

  // RFC-626 implementation gate G3-2: a version that could not be read used to count as a change
  // outright. Design §4.1 says a check that does not pass falls back to the content identity.
  test('a version that cannot be read is answered by the content identity', async () => {
    await h.install()
    await h.seed()
    const inner = createSourceWatch()
    let broken = false
    const watch: SourceWatch = {
      ...inner,
      sqliteDataVersion(path) {
        if (broken) throw new Error('data version unavailable')
        return inner.sqliteDataVersion(path)
      },
    }
    const reader = await open({ watch })
    try {
      const preflight = await reader.preflight()
      broken = true
      // Nothing cheap vouches for the source now: every check measures it, and the same
      // content continues.
      expect(await digestsDuring(() => reader.assertUnchanged(preflight))).toBe(1)
      expect(await digestsDuring(() => reader.assertUnchanged(preflight))).toBe(1)
      setValue(h.sqlite, 'changed while the version is unreadable')
      await expect(reader.assertUnchanged(preflight)).rejects.toBeInstanceOf(SourceBlockedError)
      setValue(h.sqlite, SEEDED)
      broken = false
      // Readable again: measured once more to have a baseline, then nothing.
      expect(await digestsDuring(() => reader.assertUnchanged(preflight))).toBe(1)
      expect(await digestsDuring(() => reader.assertUnchanged(preflight))).toBe(0)
    } finally {
      await reader.close()
      inner.close()
    }
  })

  // RFC-626 implementation gate G3-1: the held connection keeps reading the file it was opened
  // on. A database replaced whole under its path (another file renamed over it) kept the old
  // `data_version` on Linux, so a replacement with other content went unnoticed.
  test('a database replaced whole by an identical copy is measured again and continues', async () => {
    await h.install()
    await h.seed()
    const live = join(h.operationRoot, 'live.sqlite')
    vacuumSqliteInto({ dbPath: h.sqlitePath, dest: live })
    const watch = createSourceWatch()
    const reader = await open({ path: live, watch })
    try {
      const preflight = await reader.preflight()
      const before = watch.sqliteDataVersion(live)
      const replacement = join(h.operationRoot, 'replacement.sqlite')
      vacuumSqliteInto({ dbPath: live, dest: replacement })
      renameSync(replacement, live)
      expect(await digestsDuring(() => reader.assertUnchanged(preflight))).toBe(1)
      // The measurement is the new baseline, on a connection to the file the path names now.
      expect(await digestsDuring(() => reader.assertUnchanged(preflight))).toBe(0)
      expect(watch.sqliteDataVersion(live)).not.toBe(before)
    } finally {
      await reader.close()
      watch.close()
    }
  })

  test('a database replaced whole by one with other content is reported', async () => {
    await h.install()
    await h.seed()
    const live = join(h.operationRoot, 'live.sqlite')
    vacuumSqliteInto({ dbPath: h.sqlitePath, dest: live })
    const watch = createSourceWatch()
    const reader = await open({ path: live, watch })
    try {
      const preflight = await reader.preflight()
      const replacement = join(h.operationRoot, 'replacement.sqlite')
      vacuumSqliteInto({ dbPath: live, dest: replacement })
      await commitFromAnotherProcess(replacement, [
        "UPDATE maintenance_state SET value='another database' WHERE key='v1-a'",
      ])
      // Nothing was committed to the file the watch holds: only its name moved.
      renameSync(replacement, live)
      await expect(reader.assertUnchanged(preflight)).rejects.toThrow('Source changed')
      // The frozen copy still serves the rows it was frozen with.
      expect(
        (await reader.readChunk('maintenance_state', null, 10)).decodedRows.find(
          (row) => row.key === 'v1-a',
        )?.value,
      ).toBe(SEEDED)
    } finally {
      await reader.close()
      watch.close()
    }
  })

  // RFC-626 implementation gate G3-2: a held connection that stopped reading (macOS SQLite fails
  // every read once the file gains or loses a name) stayed in the watch, so every later freeze of
  // the process — a new run — failed on its first version reading.
  test('a held connection that stops reading is replaced: checks measure once and a new freeze succeeds', async () => {
    await h.install()
    await h.seed()
    const opened: Database[] = []
    const watch = createSourceWatch({
      openForRead(path) {
        const connection = openSqliteForRead(path)
        opened.push(connection)
        return connection
      },
    })
    try {
      const first = await open({ watch })
      let planned!: Awaited<ReturnType<typeof first.preflight>>
      try {
        planned = await first.preflight()
        expect(opened).toHaveLength(1)
        opened[0]!.close()
        // The check falls back to the content identity, on a new connection, and settles there.
        expect(await digestsDuring(() => first.assertUnchanged(planned))).toBe(1)
        expect(opened).toHaveLength(2)
        expect(await digestsDuring(() => first.assertUnchanged(planned))).toBe(0)
      } finally {
        await first.close()
      }
      opened[1]!.close()
      const second = await open({ watch })
      try {
        // The freeze reads its versions on a third connection; the identity of the copy is
        // measured, because no version of the new connection was ever remembered.
        expect(await digestsDuring(() => second.preflight())).toBe(1)
        expect(opened).toHaveLength(3)
        const again = await second.preflight()
        expect(again.watermark).toBe(planned.watermark)
        setValue(h.sqlite, 'changed after the connection was replaced')
        await expect(second.assertUnchanged(again)).rejects.toBeInstanceOf(SourceBlockedError)
      } finally {
        await second.close()
      }
    } finally {
      watch.close()
    }
  })

  // The real trigger of G3-2 on macOS: another name for the file. Elsewhere the held connection
  // keeps reading and nothing is measured; on macOS it is replaced and the content decides.
  test('another name for the source does not stop the checks or the next freeze', async () => {
    await h.install()
    await h.seed()
    const live = join(h.operationRoot, 'live.sqlite')
    vacuumSqliteInto({ dbPath: h.sqlitePath, dest: live })
    const watch = createSourceWatch()
    try {
      const first = await open({ path: live, watch })
      try {
        const preflight = await first.preflight()
        linkSync(live, join(h.operationRoot, 'another-name.sqlite'))
        expect(await digestsDuring(() => first.assertUnchanged(preflight))).toBeLessThanOrEqual(1)
      } finally {
        await first.close()
      }
      const second = await open({ path: live, watch })
      try {
        await second.preflight()
        expect(second.copyState().reused).toBe(false)
      } finally {
        await second.close()
      }
    } finally {
      watch.close()
    }
  })

  test('a watch carries the identity to the next reader and no reader closes it', async () => {
    await h.install()
    await h.seed()
    const watch = createSourceWatch()
    try {
      const first = await open({ watch })
      const before = await first.preflight()
      await first.close()
      // The connection the watch holds outlives the handle that used it.
      const version = watch.sqliteDataVersion(h.sqlitePath)
      const second = await open({ watch })
      try {
        // A new copy is taken, but nobody committed since the identity was confirmed.
        let after!: typeof before
        expect(
          await digestsDuring(async () => {
            after = await second.preflight()
          }),
        ).toBe(0)
        expect(after.watermark).toBe(before.watermark)
        expect(second.copyState()).toMatchObject({ reused: false, foreignKeyViolations: 0 })
        // The upgrade's own reads and copies are not commits: the version has not moved.
        expect(watch.sqliteDataVersion(h.sqlitePath)).toBe(version)
      } finally {
        await second.close()
      }
      // After a commit the next reader measures its copy and remembers the new identity.
      setValue(h.sqlite, 'next identity')
      const third = await open({ watch })
      try {
        let changed!: typeof before
        expect(
          await digestsDuring(async () => {
            changed = await third.preflight()
          }),
        ).toBe(1)
        expect(changed.watermark).not.toBe(before.watermark)
      } finally {
        await third.close()
      }
    } finally {
      watch.close()
    }
    expect(() => watch.sqliteDataVersion(h.sqlitePath)).toThrow('source-watch-closed')
  })

  test('without a watch every reader confirms the identity for itself', async () => {
    await h.install()
    await h.seed()
    for (let round = 0; round < 2; round += 1) {
      const reader = await open()
      try {
        expect(await digestsDuring(() => reader.preflight())).toBe(1)
      } finally {
        await reader.close()
      }
    }
    // A closed reader left no temporary copy behind.
    expect(readdirSync(join(h.operationRoot, 'reader'))).toEqual([])
  })

  test('a private copy is read in place, identified once and recognised by its size', async () => {
    await h.install()
    await h.seed()
    const path = join(h.operationRoot, 'private.sqlite')
    vacuumSqliteInto({ dbPath: h.sqlitePath, dest: path })
    const root = join(h.operationRoot, 'private-reader')
    const reader = await open({ path, operationRoot: root, privateCopy: true })
    const reference = await open()
    try {
      let preflight!: Awaited<ReturnType<typeof reader.preflight>>
      expect(
        await digestsDuring(async () => {
          preflight = await reader.preflight()
        }),
      ).toBe(1)
      // No second copy anywhere: the reader reads the file it was given.
      expect(reader.offlinePath()).toBe(path)
      expect(existsSync(root)).toBe(false)
      expect(preflight.watermark).toBe((await reference.preflight()).watermark)
      // The old database changing is no concern of a private copy.
      setValue(h.sqlite, 'the source moved on')
      expect(await digestsDuring(() => reader.assertUnchanged(preflight))).toBe(0)
      appendFileSync(path, Buffer.alloc(4096))
      await expect(reader.assertUnchanged(preflight)).rejects.toBeInstanceOf(SourceBlockedError)
    } finally {
      await reader.close()
      await reference.close()
    }
    expect(existsSync(path)).toBe(true)
  })

  test('a private copy with a matching record is taken over without being read through', async () => {
    await h.install()
    await h.seed()
    const path = join(h.operationRoot, 'private.sqlite')
    vacuumSqliteInto({ dbPath: h.sqlitePath, dest: path })
    const measured = await open({ path, privateCopy: true })
    const expected = await measured.preflight()
    const record = { content: measured.copyState().content, bytes: measured.copyState().bytes }
    await measured.close()
    const adopted = await open({ path, privateCopy: true, recorded: record })
    try {
      let preflight!: typeof expected
      expect(
        await digestsDuring(async () => {
          preflight = await adopted.preflight()
        }),
      ).toBe(0)
      expect(preflight).toEqual(expected)
      expect(adopted.copyState()).toEqual({ ...record, reused: true, foreignKeyViolations: null })
    } finally {
      await adopted.close()
    }
    // A record of another size does not describe this file: it is measured.
    const mismatched = await open({
      path,
      privateCopy: true,
      recorded: { content: `sha256:${'0'.repeat(64)}`, bytes: record.bytes + 1 },
    })
    try {
      let preflight!: typeof expected
      expect(
        await digestsDuring(async () => {
          preflight = await mismatched.preflight()
        }),
      ).toBe(1)
      expect(preflight.watermark).toBe(expected.watermark)
      expect(mismatched.copyState().reused).toBe(false)
    } finally {
      await mismatched.close()
    }
  })

  test('a frozen copy stays after close and is taken over while the source is unchanged', async () => {
    await h.install()
    await h.seed()
    const frozenCopy = join(h.operationRoot, 'frozen/original.sqlite')
    const watch = createSourceWatch()
    try {
      const first = await open({ watch, frozenCopy })
      const frozen = await first.preflight()
      expect(first.offlinePath()).toBe(frozenCopy)
      const record = { content: first.copyState().content, bytes: first.copyState().bytes }
      await first.close()
      expect(existsSync(frozenCopy)).toBe(true)
      // No temporary directory was made for a copy that has a place of its own.
      expect(existsSync(join(h.operationRoot, 'reader'))).toBe(false)
      const file = statSync(frozenCopy)

      // Same process: the version has not moved, so nothing is copied and nothing is measured.
      const second = await open({ watch, frozenCopy, recorded: record })
      try {
        let preflight!: typeof frozen
        expect(
          await digestsDuring(async () => {
            preflight = await second.preflight()
          }),
        ).toBe(0)
        expect(preflight).toEqual(frozen)
        expect(second.copyState()).toEqual({ ...record, reused: true, foreignKeyViolations: null })
        expect(await digestsDuring(() => second.assertUnchanged(preflight))).toBe(0)
      } finally {
        await second.close()
      }
      expect(statSync(frozenCopy).ino).toBe(file.ino)
      expect(statSync(frozenCopy).mtimeMs).toBe(file.mtimeMs)

      // After a restart nothing is remembered: the source is measured exactly once.
      const restarted = createSourceWatch()
      const third = await open({ watch: restarted, frozenCopy, recorded: record })
      try {
        let preflight!: typeof frozen
        expect(
          await digestsDuring(async () => {
            preflight = await third.preflight()
          }),
        ).toBe(1)
        expect(preflight).toEqual(frozen)
        expect(third.copyState().reused).toBe(true)
        // ...and that measurement is the baseline for the rest of the process.
        expect(await digestsDuring(() => third.assertUnchanged(preflight))).toBe(0)
      } finally {
        await third.close()
        restarted.close()
      }
      expect(statSync(frozenCopy).ino).toBe(file.ino)
    } finally {
      watch.close()
    }
  })

  test('a recorded frozen copy is never overwritten: a changed source or a changed file is reported', async () => {
    await h.install()
    await h.seed()
    const frozenCopy = join(h.operationRoot, 'frozen/original.sqlite')
    const watch = createSourceWatch()
    try {
      const first = await open({ watch, frozenCopy })
      await first.preflight()
      const record = { content: first.copyState().content, bytes: first.copyState().bytes }
      await first.close()
      const file = statSync(frozenCopy)

      setValue(h.sqlite, 'changed after the freeze')
      const stale = await open({ watch, frozenCopy, recorded: record })
      let failure: unknown
      // The version moved, so the source is measured once to learn that it really changed.
      expect(
        await digestsDuring(async () => {
          failure = await stale.preflight().catch((error: unknown) => error)
        }),
      ).toBe(1)
      await stale.close()
      expect(failure).toBeInstanceOf(FrozenCopyStaleError)
      expect((failure as FrozenCopyStaleError).reason).toBe('source')
      expect(statSync(frozenCopy).ino).toBe(file.ino)
      expect(statSync(frozenCopy).size).toBe(record.bytes)

      // What was measured is remembered: asking again costs nothing, and neither does the
      // freeze that replaces the copy.
      const again = await open({ watch, frozenCopy, recorded: record })
      expect(
        await digestsDuring(async () => {
          failure = await again.preflight().catch((error: unknown) => error)
        }),
      ).toBe(0)
      await again.close()
      expect((failure as FrozenCopyStaleError).reason).toBe('source')
      const refrozen = await open({ watch, frozenCopy })
      try {
        expect(await digestsDuring(() => refrozen.preflight())).toBe(0)
        expect(refrozen.copyState()).toMatchObject({ reused: false, foreignKeyViolations: 0 })
        expect(refrozen.copyState().content).not.toBe(record.content)
        expect(
          (await refrozen.readChunk('maintenance_state', null, 10)).decodedRows.find(
            (row) => row.key === 'v1-a',
          )?.value,
        ).toBe('changed after the freeze')
      } finally {
        await refrozen.close()
      }

      // A file that is not the recorded one is a different matter from a changed source.
      const fresh = { content: record.content, bytes: statSync(frozenCopy).size + 1 }
      const damaged = await open({ watch, frozenCopy, recorded: fresh })
      failure = await damaged.preflight().catch((error: unknown) => error)
      await damaged.close()
      expect(failure).toBeInstanceOf(FrozenCopyStaleError)
      expect((failure as FrozenCopyStaleError).reason).toBe('copy')
      expect(existsSync(frozenCopy)).toBe(true)
    } finally {
      watch.close()
    }
  })

  test('rows whose foreign key dangles stop an operator freeze and are counted by an automatic one', async () => {
    await h.install()
    await h.seed()
    addDanglingUser(h.sqlite)
    const manual = await open()
    try {
      await expect(manual.preflight()).rejects.toThrow('SQLite source has 1 foreign-key violation')
    } finally {
      await manual.close()
    }
    const operator = await open({ resolution: 'operator' })
    try {
      await expect(operator.preflight()).rejects.toBeInstanceOf(SourceBlockedError)
    } finally {
      await operator.close()
    }
    const automatic = await open({ resolution: 'automatic' })
    try {
      const preflight = await automatic.preflight()
      expect(automatic.copyState().foreignKeyViolations).toBe(1)
      // The row is still there for the conversion to decide about.
      expect(preflight.fingerprint.tableRows.users).toBeGreaterThanOrEqual(2)
      await automatic.assertUnchanged(preflight)
    } finally {
      await automatic.close()
    }
  })
})

describe('RFC-626 source watch', () => {
  test('one held connection per file sees the commits of others, however the path is spelled', () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc626-watch-'))
    const path = join(root, 'watched.sqlite')
    const writer = new Database(path)
    const watch = createSourceWatch()
    try {
      writer.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)')
      const first = watch.sqliteDataVersion(path)
      // Reading it is not a change, and neither is another connection that only reads.
      expect(watch.sqliteDataVersion(path)).toBe(first)
      writer.query('SELECT count(*) FROM notes').get()
      expect(watch.sqliteDataVersion(path)).toBe(first)
      writer.exec("INSERT INTO notes (body) VALUES ('committed elsewhere')")
      // Another spelling of the same file must not open a second connection: a connection
      // opened now would know nothing of the commit before it.
      const second = watch.sqliteDataVersion(`${root}/./watched.sqlite`)
      expect(second).not.toBe(first)
      expect(watch.sqliteDataVersion(path)).toBe(second)

      // RFC-626 implementation gate G3-1: another file renamed over the path. The held
      // connection still reads the old file; the watch reads the new one through a connection
      // of its own, whose versions are above every version an earlier connection gave — a
      // fresh connection's own count would start where the replaced one may still stand.
      const replacement = join(root, 'replacement.sqlite')
      vacuumSqliteInto({ dbPath: path, dest: replacement })
      renameSync(replacement, path)
      const replaced = watch.sqliteDataVersion(path)
      expect(replaced).toBeGreaterThan(second)
      expect(watch.sqliteDataVersion(path)).toBe(replaced)

      const baseline = { identity: { content: 'sha256:content' }, evidence: String(second) }
      expect(watch.baseline('sqlite:watched')).toBeUndefined()
      watch.remember('sqlite:watched', baseline)
      expect(watch.baseline('sqlite:watched')).toEqual(baseline)
      watch.forget('sqlite:watched')
      expect(watch.baseline('sqlite:watched')).toBeUndefined()

      // A file that is not there cannot be watched, and is not created by trying.
      const absent = join(root, 'absent.sqlite')
      expect(() => watch.sqliteDataVersion(absent)).toThrow()
      expect(existsSync(absent)).toBe(false)

      watch.remember('sqlite:watched', baseline)
      watch.close()
      // Closed for good: no version, and nothing remembered.
      expect(() => watch.sqliteDataVersion(path)).toThrow('source-watch-closed')
      expect(watch.baseline('sqlite:watched')).toBeUndefined()
      watch.close()
    } finally {
      watch.close()
      writer.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('RFC-626 SQLite integrity check', () => {
  const database = (quickCheck: string[], violations: number) =>
    ({
      query(sql: string) {
        if (sql === 'PRAGMA quick_check')
          return { all: () => quickCheck.map((value) => ({ quick_check: value })) }
        if (sql === 'PRAGMA foreign_key_check')
          return { iterate: () => Array.from({ length: violations }, (_, rowid) => ({ rowid })) }
        throw new Error(`unexpected statement: ${sql}`)
      },
    }) as unknown as Database

  test('reports the number of dangling rows and refuses them unless told to tolerate them', () => {
    expect(assertSqliteIntegrity(database(['ok'], 0))).toEqual({ foreignKeyViolations: 0 })
    expect(() => assertSqliteIntegrity(database(['ok'], 3))).toThrow(
      'SQLite source has 3 foreign-key violation(s)',
    )
    expect(() =>
      assertSqliteIntegrity(database(['ok'], 3), { tolerateForeignKeys: false }),
    ).toThrow(SourceBlockedError)
    expect(assertSqliteIntegrity(database(['ok'], 3), { tolerateForeignKeys: true })).toEqual({
      foreignKeyViolations: 3,
    })
  })

  test('a failed quick_check is damage and is refused whatever is tolerated', () => {
    for (const result of [['row 4 missing from index idx'], [], ['ok', 'ok']])
      for (const tolerateForeignKeys of [false, true])
        expect(() => assertSqliteIntegrity(database(result, 0), { tolerateForeignKeys })).toThrow(
          'SQLite source failed quick_check',
        )
  })
})
