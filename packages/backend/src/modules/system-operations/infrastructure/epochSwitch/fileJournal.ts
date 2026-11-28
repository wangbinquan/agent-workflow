import {
  closeSync,
  copyFileSync,
  constants,
  writeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  type BigIntStats,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { EpochSwitchArtifactPort } from '@/platform/persistence/migration/run/types'
import { epochArtifactFileName } from '@/platform/persistence/migration/artifactFileName'
import { dirname, join, resolve } from 'node:path'
import { acquireLock } from '@/platform/execution/local/daemonLock'
import { assertSameFileIdentity } from '@/platform/execution/local/fileTrust'
import { createFileDigestInput } from '@/platform/persistence/migration/fileDigestInput'
import { sha256Hex, createSha256DigestBuilder } from '@/platform/contracts/hash'
const bytesDigest = (bytes: Uint8Array) => `sha256:${sha256Hex(bytes)}`
import type { EpochSwitchJournalPort } from '../../application/ports/epochSwitch'
import {
  EpochOperationIdSchema,
  EpochSwitchError,
  parseEpochSwitchJournal,
  type EpochSwitchJournal,
} from '../../domain/epochSwitch/model'
import { assertJournalSuccessor } from '../../domain/epochSwitch/transitions'

/**
 * RFC-398: FlushFileBuffers on Windows needs a write-capable handle, so a read-only handle fails
 * fsync with EPERM there (release-upgrade nightly 41287876705). POSIX keeps the read-only
 * descriptor. A Windows copy that cannot be opened for writing (read-only attribute carried over
 * by the copy) cannot be flushed; the rename that publishes it remains the authority.
 */
export function flushEpochFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
  openFile: (path: string, flags: 'r' | 'r+') => number = openSync,
): void {
  let fd: number
  try {
    fd = openFile(path, platform === 'win32' ? 'r+' : 'r')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) return
    throw error
  }
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function syncEpochDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch (error) {
    if (process.platform !== 'win32') throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** A named artifact becomes visible only after its complete bytes have been flushed. */
export function writeEpochFile(path: string, bytes: Uint8Array, once: boolean): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx')
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    if (once) {
      try {
        linkSync(temporary, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!readFileSync(path).equals(Buffer.from(bytes)))
          throw new EpochSwitchError('v3-write-once-conflict', { category: 'receipt-conflict' })
      }
    } else renameSync(temporary, path)
    syncEpochDirectory(dirname(path))
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function createFileEpochSwitchJournal(input: {
  root: string
  prunePlanContent?: EpochSwitchJournalPort['prunePlanContent']
  /** File-name rules for artifact names (see `epochArtifactFileName`); tests pass `win32`. */
  platform?: NodeJS.Platform
}): EpochSwitchJournalPort {
  const platform = input.platform ?? process.platform
  const operationRoot = (op: string) => join(input.root, EpochOperationIdSchema.parse(op))
  const artifactPath = (op: string, name: string) =>
    join(operationRoot(op), epochArtifactFileName(platform, name))
  const path = (op: string) => join(operationRoot(op), 'epoch-switch.json')
  const read = async (op: string): Promise<EpochSwitchJournal | null> =>
    existsSync(path(op)) ? parseEpochSwitchJournal(readFileSync(path(op), 'utf8')) : null
  // One store per operation for the life of this journal: a store remembers which working
  // files it registered or materialised, and that is only worth something while it is kept.
  const stores = new Map<string, EpochSwitchArtifactPort>()
  return {
    operationRoot,
    prunePlanContent: input.prunePlanContent
      ? (op, references) => input.prunePlanContent!(operationRoot(op), references)
      : undefined,
    artifacts: (op) => {
      const root = operationRoot(op)
      let store = stores.get(root)
      if (!store) {
        store = createLocalEpochArtifacts(root, platform)
        stores.set(root, store)
      }
      return store
    },
    read,
    async create(journal) {
      const parsed = parseEpochSwitchJournal(JSON.stringify(journal))
      if (parsed.payload.revision !== 0 || parsed.payload.previousDigest !== null)
        throw new EpochSwitchError('v3-initial-journal-revision')
      writeEpochFile(path(parsed.payload.operationId), Buffer.from(JSON.stringify(parsed)), true)
      return parsed
    },
    async list() {
      if (!existsSync(input.root)) return []
      const entries = readdirSync(input.root, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && EpochOperationIdSchema.safeParse(entry.name).success,
      )
      const journals = await Promise.all(entries.map((entry) => read(entry.name)))
      return journals
        .filter((journal): journal is EpochSwitchJournal => journal !== null)
        .sort((a, b) => a.payload.createdAt - b.payload.createdAt)
    },
    async compareAndSwap(expected, next) {
      const lock = acquireLock(join(operationRoot(expected.operationId), '.cas.lock'))
      try {
        const current = await read(expected.operationId)
        if (
          !current ||
          current.payload.revision !== expected.revision ||
          current.digest !== expected.digest
        )
          throw new EpochSwitchError('v3-journal-stale-revision-or-owner', {
            category: 'owner-conflict',
          })
        assertJournalSuccessor(current, next)
        writeEpochFile(path(expected.operationId), Buffer.from(JSON.stringify(next)), false)
        return parseEpochSwitchJournal(readFileSync(path(expected.operationId), 'utf8'))
      } finally {
        lock.release()
      }
    },
    async writeOnce(op, name, bytes) {
      const destination = artifactPath(op, name)
      writeEpochFile(destination, bytes, true)
      return { path: destination, digest: bytesDigest(bytes) }
    },
    async readArtifact(op, name) {
      const source = artifactPath(op, name)
      return existsSync(source) ? readFileSync(source) : null
    },
    async lockOperation(op) {
      try {
        return acquireLock(join(operationRoot(op), '.lock'))
      } catch {
        throw new EpochSwitchError('v3-operation-locked', {
          category: 'owner-conflict',
          retryable: true,
        })
      }
    },
  }
}

/** `stat` of a working file; null when it is not a file that can be read. */
function workingFileStat(path: string): BigIntStats | null {
  try {
    const stat = statSync(path, { bigint: true })
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}
/**
 * Whether `opened` is the file `before` was. Identity is judged by the platform's own rule
 * (`assertSameFileIdentity`): a filesystem that reports no file index proves nothing, on any
 * platform, and never makes two files "the same".
 */
function isSameFile(before: BigIntStats, opened: BigIntStats, platform: NodeJS.Platform): boolean {
  if (BigInt(before.ino) === 0n || BigInt(opened.ino) === 0n) return false
  return assertSameFileIdentity(before, opened, platform).trusted
}
/** Two names of one file: the same device and inode, which only a hard link gives. */
function sameFile(first: string, second: string, platform: NodeJS.Platform): boolean {
  const a = workingFileStat(first)
  const b = workingFileStat(second)
  return a !== null && b !== null && isSameFile(a, b, platform)
}

/**
 * Content-addressed versions survive a later put under the same artifact name.
 *
 * RFC-626 §4.5: a registered file enters the store as a hard link, not a copy. The store and
 * the working files live under one operation root, and a registered file is written once —
 * a document that changes is replaced by rename, which gives the new version a new inode and
 * leaves the registered one as it was. On a filesystem without copy-on-write this is what
 * keeps a database-sized artifact from being copied, and from occupying its size twice.
 *
 * macOS is the exception: its system SQLite fails every connection that is open on a database
 * once that file's link count changes, and the work copy is registered while it is being read.
 * There the store takes a copy-on-write clone instead — as cheap on APFS, and a file of its
 * own — and remembers which working files it registered so that it does not read them again.
 *
 * `link` and `clone` are replaceable so tests can stand in for a filesystem that refuses
 * hard links or cannot clone.
 */
export function createLocalEpochArtifacts(
  root: string,
  platform: NodeJS.Platform = process.platform,
  link: (existingPath: string, newPath: string) => void = linkSync,
  clone: (existingPath: string, newPath: string) => void = (existingPath, newPath) =>
    copyFileSync(existingPath, newPath, constants.COPYFILE_FICLONE_FORCE),
): EpochSwitchArtifactPort {
  const stored = (name: string, digest: string) =>
    join(root, '.artifacts', digest.slice(7), epochArtifactFileName(platform, name))
  const publish = (temporary: string, name: string, digest: string) => {
    const destination = stored(name, digest)
    mkdirSync(dirname(destination), { recursive: true })
    try {
      linkSync(temporary, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      unlinkSync(temporary)
    }
    syncEpochDirectory(dirname(destination))
    return digest
  }
  // One buffer for every file this store hashes (RFC-626 §4.7, see `createFileDigestInput`).
  const digestInput = createFileDigestInput()
  const fileDigest = async (path: string) => {
    const hash = createSha256DigestBuilder()
    await digestInput.update(hash, path)
    return `sha256:${hash.digestHex()}`
  }
  /**
   * Working files this store registered or materialised, with the digest they had and what
   * `stat` said then. A file that still has that size, modification time and inode is the
   * registered content: artifacts are written once, and only this operation writes its
   * directory. Nothing here outlives the store, so a resumed upgrade verifies every artifact
   * once more.
   */
  const materialized = new Map<string, { readonly digest: string; readonly stat: BigIntStats }>()
  const rememberMaterialized = (path: string, digest: string): void => {
    const stat = workingFileStat(path)
    if (stat) materialized.set(resolve(path), { digest, stat })
    else materialized.delete(resolve(path))
  }
  const isMaterialized = (path: string, digest: string): boolean => {
    const known = materialized.get(resolve(path))
    const stat = workingFileStat(path)
    return (
      known !== undefined &&
      stat !== null &&
      known.digest === digest &&
      known.stat.size === stat.size &&
      known.stat.mtimeNs === stat.mtimeNs &&
      isSameFile(known.stat, stat, platform)
    )
  }
  return {
    async putFile(name, path) {
      mkdirSync(join(root, '.artifacts'), { recursive: true })
      const digest = await fileDigest(path)
      const destination = stored(name, digest)
      const working = join(root, epochArtifactFileName(platform, name))
      const remember = (registered: string): string => {
        if (resolve(path) === resolve(working)) rememberMaterialized(working, registered)
        return registered
      }
      if (sameFile(path, destination, platform)) return remember(digest)
      mkdirSync(dirname(destination), { recursive: true })
      // On macOS a hard link to a database this process has open makes the system SQLite fail
      // every later read of it (`SQLITE_IOERR_VNODE`, see `shareFile`), and what is registered
      // here includes the work copy while its reader is open. There the store gets a clone.
      if (platform !== 'darwin')
        try {
          // Durable before it becomes visible under its digest, as the copy was.
          flushEpochFile(path)
          link(path, destination)
          syncEpochDirectory(dirname(destination))
          return remember(digest)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return remember(digest)
          // Another filesystem, or one without hard links: keep a copy of the bytes instead.
        }
      const temporary = join(root, '.artifacts', `${crypto.randomUUID()}.tmp`)
      try {
        // A copy-on-write clone is the registered bytes by construction, exactly as a link
        // is; only an ordinary copy has to be read once more to prove what it holds.
        let copied: string | null = null
        if (platform === 'darwin')
          try {
            clone(path, temporary)
            copied = digest
          } catch {
            rmSync(temporary, { force: true })
          }
        if (copied === null) {
          copyFileSync(path, temporary, constants.COPYFILE_FICLONE)
          copied = await fileDigest(temporary)
        }
        flushEpochFile(temporary)
        return remember(publish(temporary, name, copied))
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary)
      }
    },
    async put(name, input) {
      mkdirSync(join(root, '.artifacts'), { recursive: true })
      const temporary = join(root, '.artifacts', `${crypto.randomUUID()}.tmp`)
      const fd = openSync(temporary, 'wx')
      const hash = createSha256DigestBuilder()
      try {
        for await (const bytes of input instanceof Uint8Array ? [input] : input) {
          hash.update(bytes)
          let offset = 0
          while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
        }
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      const digest = `sha256:${hash.digestHex()}`
      return publish(temporary, name, digest)
    },
    async get(name, digest) {
      const source = stored(name, digest)
      const destination = join(root, epochArtifactFileName(platform, name))
      // The working file is the registered file: there is nothing to verify against and
      // nothing to copy. Every session opens by materialising all of its artifacts, so without
      // this each of them would be read and written once more per session.
      if (sameFile(source, destination, platform)) return destination
      // A clone has its own inode, so the check above cannot recognise it; what this process
      // itself registered or materialised under this digest, and has not changed since, can.
      if (isMaterialized(destination, digest)) return destination
      if ((await fileDigest(source)) !== digest)
        throw new EpochSwitchError('v3-artifact-digest-mismatch', { category: 'receipt-conflict' })
      mkdirSync(dirname(destination), { recursive: true })
      const temporary = `${destination}.${crypto.randomUUID()}.tmp`
      copyFileSync(source, temporary, constants.COPYFILE_FICLONE)
      flushEpochFile(temporary)
      renameSync(temporary, destination)
      syncEpochDirectory(dirname(destination))
      rememberMaterialized(destination, digest)
      return destination
    },
  }
}
