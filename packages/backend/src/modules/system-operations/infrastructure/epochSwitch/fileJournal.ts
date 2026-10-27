import {
  closeSync,
  createReadStream,
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
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { EpochSwitchArtifactPort } from '@/platform/persistence/migration/run/types'
import { dirname, join } from 'node:path'
import { acquireLock } from '@/util/lock'
import { sha256Hex, createSha256DigestBuilder } from '@/util/hash'
const bytesDigest = (bytes: Uint8Array) => `sha256:${sha256Hex(bytes)}`
import type { EpochSwitchJournalPort } from '../../application/ports/epochSwitch'
import {
  EpochOperationIdSchema,
  EpochSwitchError,
  parseEpochSwitchJournal,
  type EpochSwitchJournal,
} from '../../domain/epochSwitch/model'
import { assertJournalSuccessor } from '../../domain/epochSwitch/transitions'

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
}): EpochSwitchJournalPort {
  const operationRoot = (op: string) => join(input.root, EpochOperationIdSchema.parse(op))
  const path = (op: string) => join(operationRoot(op), 'epoch-switch.json')
  const read = async (op: string): Promise<EpochSwitchJournal | null> =>
    existsSync(path(op)) ? parseEpochSwitchJournal(readFileSync(path(op), 'utf8')) : null
  return {
    operationRoot,
    prunePlanContent: input.prunePlanContent
      ? (op, references) => input.prunePlanContent!(operationRoot(op), references)
      : undefined,
    artifacts: (op) => createLocalEpochArtifacts(operationRoot(op)),
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
      const destination = join(operationRoot(op), name)
      writeEpochFile(destination, bytes, true)
      return { path: destination, digest: bytesDigest(bytes) }
    },
    async readArtifact(op, name) {
      const source = join(operationRoot(op), name)
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

/** Content-addressed versions survive a later put under the same artifact name. */
export function createLocalEpochArtifacts(root: string): EpochSwitchArtifactPort {
  const stored = (name: string, digest: string) => join(root, '.artifacts', digest.slice(7), name)
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
  return {
    async putFile(name, path) {
      mkdirSync(join(root, '.artifacts'), { recursive: true })
      const temporary = join(root, '.artifacts', `${crypto.randomUUID()}.tmp`)
      try {
        copyFileSync(path, temporary, constants.COPYFILE_FICLONE)
        const hash = createSha256DigestBuilder()
        for await (const chunk of createReadStream(temporary)) hash.update(chunk)
        const fd = openSync(temporary, 'r')
        try {
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        return publish(temporary, name, `sha256:${hash.digestHex()}`)
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
      const hash = createSha256DigestBuilder()
      for await (const chunk of createReadStream(source)) hash.update(chunk)
      if (`sha256:${hash.digestHex()}` !== digest)
        throw new EpochSwitchError('v3-artifact-digest-mismatch', { category: 'receipt-conflict' })
      const destination = join(root, name)
      mkdirSync(dirname(destination), { recursive: true })
      const temporary = `${destination}.${crypto.randomUUID()}.tmp`
      copyFileSync(source, temporary, constants.COPYFILE_FICLONE)
      const fd = openSync(temporary, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, destination)
      syncEpochDirectory(dirname(destination))
      return destination
    },
  }
}
