// RFC-626 §4.5 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md, "备份与工件库") and
// the transport value rule of §3.3 as far as the backup manifest goes.
//
// Before RFC-626 a SQLite backup was a second `VACUUM INTO` of the frozen copy followed by a
// whole-database digest of both; the artifact store copied every registered file and, on each
// session, read every artifact again and copied it back; and a backup directory was read in
// full several times just to confirm it was still the backup. On a filesystem without
// copy-on-write that is the database copied and stored several times over.
//
// A write-once file is shared, not copied (`freeze/shareFile.ts`): by hard link, except on
// macOS. There the system SQLite fails every connection already open on a database once that
// file's link count changes (`SQLITE_IOERR_VNODE`, "disk I/O error"), and the files shared are
// databases the upgrade is reading at that moment, so macOS takes a copy-on-write clone. Each
// way is chosen by platform and is injectable (`platform`, `link`, `clone`), so every case below
// runs all three on any machine: linked (`platform: 'linux'`), cloned (`platform: 'darwin'` with
// a stand-in clone, since CI's Linux cannot clone; the real clone is checked on macOS only), and
// copied where neither works.
//
// What this file locks:
//   * an automatic SQLite backup is the frozen copy, linked or cloned and neither copied nor
//     measured; when it can be neither it is copied and proven by its bytes; an operator backup
//     is made exactly as before;
//   * on macOS writing the backup leaves the frozen copy readable (the first full run died here);
//   * the backup adapter does not read a backup again that it wrote in this process for an
//     automatic upgrade, and still verifies a receipt from an earlier process against the disk;
//   * the artifact store registers a file by hard link (a clone on macOS), hands back a working
//     file that is the registered file without reading or rewriting it, verifies it once in a
//     new store (a new process), and copies where it can neither link nor clone;
//   * re-materialising a directory leaves the time of a registered file alone;
//   * a logical PostgreSQL backup records the transport value rule in its manifest, and only then.
import { setDefaultTimeout, describe, expect, test } from 'bun:test'
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describeV1Providers } from './helpers/rfc395V1Harness'
import {
  frozenSourceDetails,
  openBackupSource,
  openFrozenSource,
  type SourceAccessInput,
} from '@/platform/persistence/migration/freeze/sourceAccess'
import {
  createSwitchBackup,
  switchBackupMatches,
} from '@/platform/persistence/migration/freeze/backup'
import {
  atomicSourceFile,
  materializedSourceDirectory,
  persistSourceDirectory,
  sourceArtifactRoot,
} from '@/platform/persistence/migration/freeze/artifacts'
import { createSourceWatch } from '@/platform/persistence/migration/freeze/sourceWatch'
import { readManifest } from '@/platform/persistence/migration/legacy/backupManifest'
import type { SourceMeasurementObserver } from '@/platform/persistence/migration/sourceTypes'
import type {
  EpochSwitchArtifactPort,
  FrozenSourceHandle,
  SwitchBackupReceipt,
} from '@/platform/persistence/migration/run/types'
import { sha256Hex } from '@/platform/contracts/hash'
import { createEpochBackupAdapter } from '@/modules/system-operations/infrastructure/epochSwitch/backupAdapter'
import { createLocalEpochArtifacts } from '@/modules/system-operations/infrastructure/epochSwitch/fileJournal'

// Freezing the frozen head and writing its backup takes a few seconds on CI; allow 60 s.
setDefaultTimeout(60_000)

/** RFC-626 §7: every source access and backup below is handed this; it counts whole-database digests. */
const digests = { count: 0 }
const onMeasure: SourceMeasurementObserver = (kind) => {
  if (kind === 'sqlite-content') digests.count += 1
}
async function digestsDuring(work: () => Promise<unknown> | unknown): Promise<number> {
  const before = digests.count
  await work()
  return digests.count - before
}
const refuseLinks = (refused: string[]) => (_existing: string, target: string) => {
  refused.push(target)
  throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
}
const refuseClones = (refused: string[]) => (_existing: string, target: string) => {
  refused.push(target)
  throw Object.assign(new Error('ENOTSUP: operation not supported'), { code: 'ENOTSUP' })
}
/**
 * Stands in for a copy-on-write clone on a filesystem that has none (CI's Linux): a file of its
 * own with the same bytes, which is all a clone is to its reader. It says where it went.
 */
const standInClone = (made: string[]) => (existing: string, target: string) => {
  made.push(target)
  copyFileSync(existing, target, constants.COPYFILE_EXCL)
}
/** A file of its own (another inode, one name each) with the bytes of `original`. */
function expectSeparateCopy(file: string, original: string): void {
  expect(statSync(file).ino).not.toBe(statSync(original).ino)
  expect(statSync(file).nlink).toBe(1)
  expect(statSync(original).nlink).toBe(1)
  expect(readFileSync(file).equals(readFileSync(original))).toBe(true)
}
/**
 * What sharing `frozenCopy` gave on this machine: one file under `names` names, or on macOS a
 * clone of it (RFC-626 §4.5).
 */
function expectSharedHere(file: string, frozenCopy: string, names: number): void {
  if (process.platform === 'darwin') expectSeparateCopy(file, frozenCopy)
  else {
    expect(statSync(file).ino).toBe(statSync(frozenCopy).ino)
    expect(statSync(frozenCopy).nlink).toBe(names)
  }
}

describeV1Providers('RFC-626 switch backup', (h) => {
  if (h.provider === 'sqlite') {
    const input = async (extra: Partial<SourceAccessInput> = {}): Promise<SourceAccessInput> => ({
      manifest: await h.manifest(),
      emptyTables: [],
      operationRoot: join(h.operationRoot, 'access'),
      location: {
        kind: 'sqlite-file',
        path: h.sqlitePath,
        pointerPath: join(h.operationRoot, 'pointer.json'),
      },
      onMeasure,
      ...extra,
    })
    /** The backup reopened as a backup source: the rows it holds. */
    const backupRows = async (
      receipt: SwitchBackupReceipt,
      manifest: SourceAccessInput['manifest'],
    ) => {
      const reader = openBackupSource({
        location: {
          kind: 'backup',
          sourceKind: 'sqlite-backup',
          artifact: receipt.path!,
          root: receipt.path!,
        },
        manifest,
        operationRoot: join(h.operationRoot, `verify-${receipt.id}`),
        emptyTables: [],
      })
      try {
        await reader.preflight()
        return (await reader.readChunk('maintenance_state', null, 100)).rows
      } finally {
        await reader.close()
      }
    }
    const frozenRows = async (source: FrozenSourceHandle) =>
      (await source.reader.readChunk('maintenance_state', null, 100)).rows

    test('an automatic backup is the frozen copy itself: linked, not copied and not measured', async () => {
      await h.install()
      await h.seed()
      const watch = createSourceWatch()
      const request = await input({ resolution: 'automatic', watch })
      const source = await openFrozenSource(request)
      try {
        const frozenCopy = frozenSourceDetails(source).sqlitePath!
        // Read before the link: on macOS a hard link fails the connection the handle holds on
        // the frozen copy — why macOS clones instead (next case). Elsewhere it reads on.
        const rows = await frozenRows(source)
        const destination = join(h.operationRoot, 'backups')
        const create = () =>
          createSwitchBackup({
            sourcePath: frozenCopy,
            destination,
            frozen: source,
            contentManifest: null,
            resolution: 'automatic',
            platform: 'linux',
            onMeasure,
          })
        let receipt!: SwitchBackupReceipt
        expect(
          await digestsDuring(async () => {
            receipt = await create()
          }),
        ).toBe(0)
        expect(receipt).toMatchObject({
          version: 1,
          kind: 'sqlite-vacuum',
          sourceWatermark: source.watermark,
          contentManifestDigest: null,
        })
        const backup = join(receipt.path!, 'db.sqlite')
        // One file under two names: the backup costs no space and no copy.
        expect(statSync(backup).ino).toBe(statSync(frozenCopy).ino)
        expect(statSync(backup).nlink).toBe(2)
        expect(readManifest(receipt.path!)).toMatchObject({
          manifestVersion: 1,
          kind: 'pre-migration',
        })
        expect(await switchBackupMatches(receipt, source.watermark)).toBe(true)
        // A second request finds the backup that is there.
        expect(await create()).toEqual(receipt)
        expect(readdirSync(destination)).toHaveLength(1)
        // It reopens as a backup source with the rows of the freeze.
        expect(await backupRows(receipt, request.manifest)).toEqual(rows)
        // Writing the backup and reading from it did not make the source look changed.
        expect(await digestsDuring(() => source.reader.assertUnchanged(source.preflight))).toBe(0)
      } finally {
        await source.close()
        watch.close()
      }
      // The frozen copy and the backup both outlive the handle.
      expect(existsSync(join(h.operationRoot, 'access/source-access/frozen/original.sqlite'))).toBe(
        true,
      )
    })

    test('on macOS the automatic backup is a clone of the frozen copy: not copied, not measured, and the frozen copy reads on', async () => {
      await h.install()
      await h.seed()
      const watch = createSourceWatch()
      const request = await input({ resolution: 'automatic', watch })
      const source = await openFrozenSource(request)
      try {
        const frozenCopy = frozenSourceDetails(source).sqlitePath!
        const clones: string[] = []
        const links: string[] = []
        const destination = join(h.operationRoot, 'backups')
        const create = () =>
          createSwitchBackup({
            sourcePath: frozenCopy,
            destination,
            frozen: source,
            contentManifest: null,
            resolution: 'automatic',
            platform: 'darwin',
            link: refuseLinks(links),
            clone: standInClone(clones),
            onMeasure,
          })
        let receipt!: SwitchBackupReceipt
        expect(
          await digestsDuring(async () => {
            receipt = await create()
          }),
        ).toBe(0)
        const backup = join(receipt.path!, 'db.sqlite')
        expect(clones).toEqual([backup])
        // macOS never links: a link would fail the connections open on the frozen copy.
        expect(links).toEqual([])
        expectSeparateCopy(backup, frozenCopy)
        expect(readManifest(receipt.path!)).toMatchObject({
          manifestVersion: 1,
          kind: 'pre-migration',
        })
        expect(await switchBackupMatches(receipt, source.watermark)).toBe(true)
        expect(await create()).toEqual(receipt)
        expect(clones).toHaveLength(1)
        expect(await backupRows(receipt, request.manifest)).toEqual(await frozenRows(source))
        expect(await digestsDuring(() => source.reader.assertUnchanged(source.preflight))).toBe(0)

        // The real clone, where there is one: the regression of the first full run, in which
        // the frozen copy could not be read once its backup existed ("disk I/O error").
        if (process.platform === 'darwin') {
          const real = await createSwitchBackup({
            sourcePath: frozenCopy,
            destination: join(h.operationRoot, 'real-backups'),
            frozen: source,
            contentManifest: null,
            resolution: 'automatic',
            onMeasure,
          })
          expectSeparateCopy(join(real.path!, 'db.sqlite'), frozenCopy)
          expect(await frozenRows(source)).toEqual(await backupRows(real, request.manifest))
          await source.reader.assertUnchanged(source.preflight)
        }
      } finally {
        await source.close()
        watch.close()
      }
    })

    test('where the frozen copy can be neither linked nor cloned the backup is a copy with the same bytes', async () => {
      await h.install()
      await h.seed()
      const source = await openFrozenSource(await input({ resolution: 'automatic' }))
      try {
        const frozenCopy = frozenSourceDetails(source).sqlitePath!
        for (const platform of ['linux', 'darwin'] as const) {
          const refused: string[] = []
          const receipt = await createSwitchBackup({
            sourcePath: frozenCopy,
            destination: join(h.operationRoot, `backups-${platform}`),
            frozen: source,
            contentManifest: null,
            resolution: 'automatic',
            platform,
            // Each platform tries one way of sharing the file; both are refused here.
            link: refuseLinks(refused),
            clone: refuseClones(refused),
          })
          const backup = join(receipt.path!, 'db.sqlite')
          expect(refused).toEqual([backup])
          expectSeparateCopy(backup, frozenCopy)
          expect(await switchBackupMatches(receipt, source.watermark)).toBe(true)
          expect(readManifest(receipt.path!)?.manifestVersion).toBe(1)
        }
        expect((await frozenRows(source)).length).toBeGreaterThan(0)
      } finally {
        await source.close()
      }
    })

    test('an operator backup is made as before: a VACUUM copy of its own, compared by content', async () => {
      await h.install()
      await h.seed()
      const source = await openFrozenSource(await input())
      try {
        const frozenCopy = frozenSourceDetails(source).sqlitePath!
        let receipt!: SwitchBackupReceipt
        // The two digests are the comparison of the backup with the frozen copy.
        expect(
          await digestsDuring(async () => {
            receipt = await createSwitchBackup({
              sourcePath: h.sqlitePath,
              destination: join(h.operationRoot, 'backups'),
              frozen: source,
              contentManifest: null,
              onMeasure,
            })
          }),
        ).toBe(2)
        const backup = join(receipt.path!, 'db.sqlite')
        expect(receipt.kind).toBe('sqlite-vacuum')
        expect(statSync(backup).ino).not.toBe(statSync(frozenCopy).ino)
        expect(statSync(backup).nlink).toBe(1)
        // Sharing the file is only ever tried in an automatic backup, on either platform.
        for (const platform of ['linux', 'darwin'] as const) {
          const refused: string[] = []
          await createSwitchBackup({
            sourcePath: h.sqlitePath,
            destination: join(h.operationRoot, `more-backups-${platform}`),
            frozen: source,
            contentManifest: null,
            resolution: 'operator',
            platform,
            link: refuseLinks(refused),
            clone: refuseClones(refused),
          })
          expect(refused).toEqual([])
        }
      } finally {
        await source.close()
      }
    })

    test('the adapter does not read its own automatic backup again, and a later process still verifies it', async () => {
      await h.install()
      await h.seed()
      const source = await openFrozenSource(await input({ resolution: 'automatic' }))
      try {
        const adapter = createEpochBackupAdapter()
        const receipt = await adapter.create({
          operationId: 'dbm_rfc626_backup',
          source,
          destination: join(h.operationRoot, 'backups'),
          resolution: 'automatic',
        })
        expectSharedHere(
          join(receipt.path!, 'db.sqlite'),
          frozenSourceDetails(source).sqlitePath!,
          2,
        )
        expect(await adapter.matches(receipt, source.watermark)).toBe(true)
        // The watermark is still compared.
        expect(await adapter.matches(receipt, 'sha256:another-freeze')).toBe(false)
        // The directory digest travels with the receipt: what is in the directory is not read
        // to answer. A file put there behind the upgrade's back shows that — the adapter that
        // wrote the backup does not see it, and a process that did not write it does.
        writeFileSync(join(receipt.path!, 'put-there-later'), 'x')
        expect(await adapter.matches(receipt, source.watermark)).toBe(true)
        expect(await createEpochBackupAdapter().matches(receipt, source.watermark)).toBe(false)
        expect(await switchBackupMatches(receipt, source.watermark)).toBe(false)
        // A receipt is only vouched for as it was written, and only while its directory exists.
        expect(
          await adapter.matches(
            { ...receipt, digest: `sha256:${'0'.repeat(64)}` },
            source.watermark,
          ),
        ).toBe(false)
        rmSync(receipt.path!, { recursive: true, force: true })
        expect(await adapter.matches(receipt, source.watermark)).toBe(false)
      } finally {
        await source.close()
      }
    })

    test('an operator backup is verified against the disk every time, as before', async () => {
      await h.install()
      await h.seed()
      const source = await openFrozenSource(await input())
      try {
        const adapter = createEpochBackupAdapter()
        const receipt = await adapter.create({
          operationId: 'dbm_rfc626_backup',
          source,
          destination: join(h.operationRoot, 'backups'),
        })
        expect(await adapter.matches(receipt, source.watermark)).toBe(true)
        writeFileSync(join(receipt.path!, 'put-there-later'), 'x')
        expect(await adapter.matches(receipt, source.watermark)).toBe(false)
      } finally {
        await source.close()
      }
    })

    test('a backup that fails reports what the failing party said, also when that is not an Error', async () => {
      await h.install()
      const source = await openFrozenSource(await input())
      try {
        // Database clients and object stores reject with plain objects (design §3.6).
        const adapter = createEpochBackupAdapter({
          async retained() {
            throw { message: 'could not write: No space left on device', code: '53100' }
          },
        })
        const error = await adapter
          .create({
            operationId: 'dbm_rfc626_backup',
            source,
            destination: join(h.operationRoot, 'backups'),
          })
          .catch((caught: unknown) => caught)
        expect(error).toMatchObject({
          category: 'backup-failed',
          message: 'could not write: No space left on device',
        })
      } finally {
        await source.close()
      }
    })

    test('a backup registered in the artifact store shares its database with the frozen copy', async () => {
      await h.install()
      await h.seed()
      const source = await openFrozenSource(await input({ resolution: 'automatic' }))
      const store = createLocalEpochArtifacts(join(h.operationRoot, 'operation'))
      const references = new Map<string, string>()
      const artifacts: EpochSwitchArtifactPort = {
        async put(name, bytes) {
          const digest = await store.put(name, bytes)
          references.set(name, digest)
          return digest
        },
        async putFile(name, path) {
          const digest = await store.putFile!(name, path)
          references.set(name, digest)
          return digest
        },
        get: (name, digest) => store.get(name, digest),
      }
      try {
        const adapter = createEpochBackupAdapter()
        const receipt = await adapter.create({
          operationId: 'dbm_rfc626_backup',
          source,
          destination: join(h.operationRoot, 'operation/backup/0/final'),
          artifacts,
          resolution: 'automatic',
        })
        const name = `switch-backups/${receipt.id}/payload/db.sqlite`
        const stored = join(
          h.operationRoot,
          'operation/.artifacts',
          references.get(name)!.slice(7),
          name,
        )
        // Frozen copy, backup and registered artifact are one file: three names, one database.
        // On macOS each is a clone of the one before.
        const frozenCopy = frozenSourceDetails(source).sqlitePath!
        expectSharedHere(stored, frozenCopy, 3)
        expect(await adapter.matches(receipt, source.watermark)).toBe(true)
        // Neither the backup nor its registration stopped the frozen copy from being read.
        expect((await frozenRows(source)).length).toBeGreaterThan(0)
      } finally {
        await source.close()
      }
    })
  }

  if (h.provider === 'postgresql')
    test('a logical backup names its value rule in the manifest only when it is not the strict one', async () => {
      await h.install()
      await h.seed()
      for (const resolution of [undefined, 'automatic'] as const) {
        const label = resolution ?? 'operator'
        const source = await openFrozenSource({
          manifest: await h.manifest(),
          emptyTables: [],
          operationRoot: join(h.operationRoot, `access-${label}`),
          location: { kind: 'postgresql-database', profileRef: 'env:RFC626_SOURCE' },
          postgresql: () => h.runtime,
          ...(resolution ? { resolution } : {}),
        })
        try {
          const receipt = await createSwitchBackup({
            source,
            destination: join(h.operationRoot, `backups-${label}`),
            operationId: 'dbm_rfc626_backup',
            chunkRows: 2,
            archive: { emptyArchive: { kind: 'born-hosted', async assertProvenance() {} } },
            ...(resolution ? { resolution } : {}),
          })
          expect(receipt.kind).toBe('postgresql-logical')
          const manifest = JSON.parse(
            readFileSync(join(receipt.path!, 'manifest.json'), 'utf8'),
          ) as { database: Record<string, unknown> }
          // A manifest without the field is read by the strict rule; an operator backup must
          // stay byte-compatible with what earlier releases wrote.
          if (resolution === 'automatic') expect(manifest.database.valueRule).toBe('transport')
          else expect(Object.hasOwn(manifest.database, 'valueRule')).toBe(false)
          expect(readManifest(receipt.path!)?.manifestVersion).toBe(2)
          expect(await switchBackupMatches(receipt, source.watermark)).toBe(true)
        } finally {
          await source.close()
        }
      }
    })
})

describe('RFC-626 local artifact store', () => {
  const bytes = Buffer.alloc(256 * 1024, 7)
  const digestOf = (value: Uint8Array) => `sha256:${sha256Hex(value)}`
  const withRoot = async (body: (root: string) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc626-artifacts-'))
    try {
      await body(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  const working = (root: string, name: string, content: Uint8Array | string = bytes) => {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return path
  }
  const storedPath = (root: string, name: string, digest: string) =>
    join(root, '.artifacts', digest.slice(7), name)
  const NAME = 'runs/run/source-access/upgrade/payload/copy-a/current.sqlite'
  /** The store as macOS has it, with a stand-in clone so that the case runs on any machine. */
  const cloningStore = (root: string, clones: string[] = [], links: string[] = []) =>
    createLocalEpochArtifacts(root, 'darwin', refuseLinks(links), standInClone(clones))
  /** Both ways a registered file enters the store; the cases below hold for each. */
  const SHARING = [
    { label: 'linked', nlink: 2, open: (root: string) => createLocalEpochArtifacts(root, 'linux') },
    { label: 'cloned', nlink: 1, open: (root: string) => cloningStore(root) },
  ] as const

  test('a file is registered as a hard link under its digest, once', () =>
    withRoot(async (root) => {
      const port = createLocalEpochArtifacts(root, 'linux')
      const file = working(root, NAME)
      const digest = await port.putFile!(NAME, file)
      expect(digest).toBe(digestOf(bytes))
      const stored = storedPath(root, NAME, digest)
      expect(statSync(stored).ino).toBe(statSync(file).ino)
      expect(statSync(file).nlink).toBe(2)
      expect(
        readdirSync(join(root, '.artifacts')).filter((entry) => entry.endsWith('.tmp')),
      ).toEqual([])
      // Registering what is already registered changes nothing.
      expect(await port.putFile!(NAME, file)).toBe(digest)
      expect(statSync(file).nlink).toBe(2)
      // Another file with the same bytes under the same name is the same artifact.
      const twin = working(root, 'elsewhere/twin.sqlite')
      expect(await port.putFile!(NAME, twin)).toBe(digest)
      expect(statSync(stored).ino).toBe(statSync(file).ino)
      expect(statSync(twin).nlink).toBe(1)
    }))

  test('on macOS a file is registered as a clone, never as a hard link', () =>
    withRoot(async (root) => {
      const clones: string[] = []
      const links: string[] = []
      const port = cloningStore(root, clones, links)
      const file = working(root, NAME)
      const digest = await port.putFile!(NAME, file)
      expect(digest).toBe(digestOf(bytes))
      const stored = storedPath(root, NAME, digest)
      // A link would change the link count of a database that may be open right now.
      expect(links).toEqual([])
      expect(clones).toHaveLength(1)
      expectSeparateCopy(stored, file)
      expect(
        readdirSync(join(root, '.artifacts')).filter((entry) => entry.endsWith('.tmp')),
      ).toEqual([])
      // Registering it again keeps the version that is stored.
      const storedFile = statSync(stored)
      expect(await port.putFile!(NAME, file)).toBe(digest)
      expect(statSync(stored).ino).toBe(storedFile.ino)
      expect(statSync(file).nlink).toBe(1)
      expect(links).toEqual([])

      // The real clone, where there is one.
      if (process.platform === 'darwin') {
        const real = createLocalEpochArtifacts(join(root, 'real'))
        const original = working(join(root, 'real'), NAME)
        const registered = await real.putFile!(NAME, original)
        expect(registered).toBe(digest)
        expectSeparateCopy(storedPath(join(root, 'real'), NAME, registered), original)
      }
    }))

  test('a working file that is the registered file is handed back without being read or rewritten', () =>
    withRoot(async (root) => {
      const port = createLocalEpochArtifacts(root, 'linux')
      const file = working(root, NAME)
      utimesSync(file, 1_700_000_000, 1_700_000_000)
      const digest = await port.putFile!(NAME, file)
      const before = statSync(file)
      for (let session = 0; session < 3; session += 1)
        expect(await port.get(NAME, digest)).toBe(file)
      const after = statSync(file)
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      // Not renamed over, not re-linked, not re-timed: its inode was not touched at all.
      expect(after.ctimeMs).toBe(before.ctimeMs)
      expect(readdirSync(dirname(file))).toEqual(['current.sqlite'])
      // That it is not read either shows on bytes changed in place — which nothing in an
      // upgrade does: registered files are written once and replaced by rename. The store
      // has no second copy to compare with, and does not look.
      writeFileSync(file, 'changed in place')
      expect(await port.get(NAME, digest)).toBe(file)
    }))

  test('on macOS the store that registered a clone hands its working file back without reading or rewriting it', () =>
    withRoot(async (root) => {
      const port = cloningStore(root)
      const file = working(root, NAME)
      utimesSync(file, 1_700_000_000, 1_700_000_000)
      const digest = await port.putFile!(NAME, file)
      const before = statSync(file)
      for (let session = 0; session < 3; session += 1)
        expect(await port.get(NAME, digest)).toBe(file)
      const after = statSync(file)
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(after.ctimeMs).toBe(before.ctimeMs)
      expect(readdirSync(dirname(file))).toEqual(['current.sqlite'])
      // A clone has an inode of its own, so the store recognises the file by what it noted
      // when it registered it. That it does not read the stored clone shows on damage to it:
      // the store that registered the file does not look, a new store (a new process) does.
      writeFileSync(storedPath(root, NAME, digest), 'damaged')
      expect(await port.get(NAME, digest)).toBe(file)
      expect(readFileSync(file)).toEqual(bytes)
      await expect(cloningStore(root).get(NAME, digest)).rejects.toMatchObject({
        code: 'v3-artifact-digest-mismatch',
      })
    }))

  test('on macOS a new store, as after a restart, verifies a registered clone once and then hands it back', () =>
    withRoot(async (root) => {
      const file = working(root, NAME)
      const digest = await cloningStore(root).putFile!(NAME, file)
      // Nothing of what the first store noted carries over.
      const restarted = cloningStore(root)
      expect(await restarted.get(NAME, digest)).toBe(file)
      expect(readFileSync(file)).toEqual(bytes)
      // Verified and put back once; from then on this store recognises it.
      const verified = statSync(file)
      for (let session = 0; session < 3; session += 1)
        expect(await restarted.get(NAME, digest)).toBe(file)
      expect(statSync(file).ino).toBe(verified.ino)
      expect(statSync(file).ctimeMs).toBe(verified.ctimeMs)
      expect(readdirSync(dirname(file))).toEqual(['current.sqlite'])
    }))

  for (const sharing of SHARING)
    test(`a file replaced by rename leaves its registered version as it was (${sharing.label})`, () =>
      withRoot(async (root) => {
        const port = sharing.open(root)
        const name = 'runs/run/source-access/upgrade/payload/binding.json'
        const file = join(root, name)
        await atomicSourceFile(file, 'first binding')
        const first = await port.putFile!(name, file)
        await atomicSourceFile(file, 'second binding')
        const second = await port.putFile!(name, file)
        expect(first).not.toBe(second)
        expect(readFileSync(storedPath(root, name, first), 'utf8')).toBe('first binding')
        expect(readFileSync(storedPath(root, name, second), 'utf8')).toBe('second binding')
        // The current version is the working file; the earlier one is fetched by copying.
        expect(await port.get(name, second)).toBe(file)
        expect(readFileSync(file, 'utf8')).toBe('second binding')
        expect(readFileSync(await port.get(name, first), 'utf8')).toBe('first binding')
        expect(readFileSync(storedPath(root, name, second), 'utf8')).toBe('second binding')
      }))

  for (const sharing of SHARING)
    test(`an artifact registered from elsewhere is verified and copied to its place as before (${sharing.label})`, () =>
      withRoot(async (root) => {
        const port = sharing.open(join(root, 'operation'))
        const file = working(root, 'backup/0/final/switch-a/payload/db.sqlite')
        const name = 'switch-backups/dbb_fixture/payload/db.sqlite'
        const digest = await port.putFile!(name, file)
        const materialised = await port.get(name, digest)
        expect(materialised).toBe(join(root, 'operation', name))
        expect(statSync(materialised).ino).not.toBe(statSync(file).ino)
        expect(readFileSync(materialised)).toEqual(bytes)
        // A materialised copy is no hard link, so the store still repairs it.
        writeFileSync(materialised, 'changed materialisation')
        expect(readFileSync(await port.get(name, digest))).toEqual(bytes)
        // A digest that was never stored is not found.
        await expect(port.get(name, digestOf(Buffer.from('never stored')))).rejects.toThrow()
      }))

  for (const platform of ['linux', 'darwin'] as const)
    test(`where a registered file can be neither linked nor cloned it is copied, and stays independent of its origin (${platform})`, () =>
      withRoot(async (root) => {
        const refused: string[] = []
        // Each platform tries one way of sharing the file; both are refused here.
        const port = createLocalEpochArtifacts(
          join(root, 'operation'),
          platform,
          platform === 'linux' ? refuseLinks(refused) : linkSync,
          platform === 'darwin' ? refuseClones(refused) : standInClone([]),
        )
        const file = working(join(root, 'operation'), NAME)
        const digest = await port.putFile!(NAME, file)
        const stored = storedPath(join(root, 'operation'), NAME, digest)
        expect(digest).toBe(digestOf(bytes))
        // A link is tried at the stored name, a clone at a temporary one next to it.
        if (platform === 'linux') expect(refused).toEqual([stored])
        else expect(refused).toEqual([expect.stringMatching(/\.tmp$/)])
        expectSeparateCopy(stored, file)
        expect(readFileSync(stored)).toEqual(bytes)
        expect(
          readdirSync(join(root, 'operation/.artifacts')).filter((entry) => entry.endsWith('.tmp')),
        ).toEqual([])
        // A copy is a snapshot: bytes changed at the origin do not reach it.
        writeFileSync(file, 'changed after registration')
        expect(readFileSync(await port.get(NAME, digest))).toEqual(bytes)
      }))

  test('bytes and streams are stored as before', () =>
    withRoot(async (root) => {
      const port = createLocalEpochArtifacts(root)
      const digest = await port.put('documents/plan.json', bytes)
      expect(digest).toBe(digestOf(bytes))
      expect(
        await port.put(
          'documents/streamed.json',
          (async function* () {
            yield bytes.subarray(0, 100)
            yield bytes.subarray(100)
          })(),
        ),
      ).toBe(digest)
      expect(readFileSync(await port.get('documents/plan.json', digest))).toEqual(bytes)
      expect(readFileSync(await port.get('documents/streamed.json', digest))).toEqual(bytes)
    }))

  for (const sharing of SHARING)
    test(`re-materialising a directory leaves a registered file alone and puts the time of a copy back (${sharing.label})`, () =>
      withRoot(async (root) => {
        const store = sharing.open(root)
        const references = new Map<string, string>()
        const port: EpochSwitchArtifactPort = {
          async put(name, value) {
            const digest = await store.put(name, value)
            references.set(name, digest)
            return digest
          },
          async putFile(name, path) {
            const digest = await store.putFile!(name, path)
            references.set(name, digest)
            return digest
          },
          get: (name, digest) => store.get(name, digest),
        }
        const artifact = 'runs/run/source-access/upgrade'
        const payload = join(await sourceArtifactRoot(port, artifact), 'payload')
        const file = working(payload, 'copy-a/current.sqlite')
        working(payload, 'owner.json', '{"owner":"fixture"}')
        utimesSync(file, 1_700_000_000, 1_700_000_000)
        await persistSourceDirectory(port, artifact, payload)
        const recorded = Math.trunc(statSync(file).mtimeMs)
        // What every session does first: fetch every artifact it references.
        const materialise = async () => {
          for (const [name, digest] of references) await port.get(name, digest)
          return materializedSourceDirectory(port, artifact)
        }
        const before = statSync(file)
        // A hard link is a second name of the file; a clone is a file of its own.
        expect(before.nlink).toBe(sharing.nlink)
        expect(await materialise()).toBe(payload)
        expect(await materialise()).toBe(payload)
        const after = statSync(file)
        expect(after.ino).toBe(before.ino)
        expect(after.ctimeMs).toBe(before.ctimeMs)
        expect(Math.trunc(after.mtimeMs)).toBe(recorded)

        // A file that reached its place as a copy carries the time of the copy until it is reset.
        rmSync(file)
        await port.get(
          `${artifact}/payload/copy-a/current.sqlite`,
          references.get(`${artifact}/payload/copy-a/current.sqlite`)!,
        )
        utimesSync(file, 1_800_000_000, 1_800_000_000)
        expect(await materializedSourceDirectory(port, artifact)).toBe(payload)
        expect(Math.trunc(statSync(file).mtimeMs)).toBe(recorded)
        // A listed file that is gone is still an error.
        rmSync(file)
        await expect(materializedSourceDirectory(port, artifact)).rejects.toThrow(
          'source-artifact-file-missing',
        )
      }))
})
