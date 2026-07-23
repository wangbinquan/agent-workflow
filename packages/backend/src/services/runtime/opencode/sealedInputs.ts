import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { identityDigest } from './executionIdentity'
import { executionIdentityFailure } from './failure'

const DEFAULT_MAX_FILES = 2_048
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_TREE_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_DEPTH = 32

interface FrozenTreeEntry {
  path: string
  type: 'directory' | 'file'
  mode: number
  sha256?: string
  bytes?: number
}

interface CapturedFile extends FrozenTreeEntry {
  type: 'file'
  contents: Uint8Array
  sha256: string
  bytes: number
}

interface CapturedDirectory extends FrozenTreeEntry {
  type: 'directory'
}

type CapturedEntry = CapturedFile | CapturedDirectory

export interface ManagedSkillTreeSnapshotOptions {
  sourcePath: string
  snapshotPath: string
  expectedContentVersion: number
  /**
   * Read from the owning skill row. It is intentionally injected so this leaf
   * module does not import DB services; production calls it before and after
   * the filesystem snapshot.
   */
  readContentVersion(): Promise<number>
  maxFiles?: number
  maxFileBytes?: number
  maxTreeBytes?: number
  maxDepth?: number
}

export interface ManagedSkillTreeSnapshot {
  path: string
  treeDigest: string
  contentVersion: number
  skillMarkdown: string
  entries: readonly FrozenTreeEntry[]
}

export type ManagedSkillTreeInspectionOptions = Omit<
  ManagedSkillTreeSnapshotOptions,
  'snapshotPath'
>

export interface ManagedSkillTreeInspection {
  treeDigest: string
  contentVersion: number
  skillMarkdown: string
  entries: readonly FrozenTreeEntry[]
}

/** Remove a tree we created even after its directories were sealed 0500. */
export async function removeSealedTree(path: string): Promise<void> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    await chmod(path, 0o600).catch(() => {})
    await rm(path, { force: true })
    return
  }
  await chmod(path, 0o700)
  for (const name of await readdir(path)) {
    await removeSealedTree(join(path, name))
  }
  await rmdir(path)
}

function safeRelativePath(path: string): boolean {
  if (path === '' || path === '.' || isAbsolute(path) || path.includes('\0')) return false
  const parts = path.split(/[\\/]/)
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

function childWithinRoot(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function treeProof(entries: readonly CapturedEntry[]): FrozenTreeEntry[] {
  return entries.map((entry) =>
    entry.type === 'directory'
      ? { path: entry.path, type: 'directory', mode: entry.mode }
      : {
          path: entry.path,
          type: 'file',
          mode: entry.mode,
          sha256: entry.sha256,
          bytes: entry.bytes,
        },
  )
}

async function captureTree(
  sourcePath: string,
  limits: {
    maxFiles: number
    maxFileBytes: number
    maxTreeBytes: number
    maxDepth: number
  },
): Promise<CapturedEntry[]> {
  const sourceRoot = await realpath(sourcePath)
  if (!isAbsolute(sourceRoot)) {
    return executionIdentityFailure('execution-identity-source-changed')
  }
  const sourceMetadata = await lstat(sourcePath)
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) {
    return executionIdentityFailure('execution-identity-source-changed')
  }

  const captured: CapturedEntry[] = []
  let fileCount = 0
  let treeBytes = 0

  const walk = async (absoluteDirectory: string, relativeDirectory: string, depth: number) => {
    if (depth > limits.maxDepth) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const directoryMetadata = await lstat(absoluteDirectory)
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const resolvedDirectory = await realpath(absoluteDirectory)
    if (!childWithinRoot(sourceRoot, resolvedDirectory)) {
      return executionIdentityFailure('execution-identity-source-changed')
    }

    if (relativeDirectory !== '') {
      captured.push({ path: relativeDirectory, type: 'directory', mode: 0o500 })
    }
    const names = await readdir(absoluteDirectory)
    names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    for (const name of names) {
      if (name.includes('\0') || name === '.' || name === '..') {
        return executionIdentityFailure('execution-identity-source-changed')
      }
      const relativePath = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`
      if (!safeRelativePath(relativePath)) {
        return executionIdentityFailure('execution-identity-source-changed')
      }
      const absolutePath = join(absoluteDirectory, name)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) {
        return executionIdentityFailure('execution-identity-source-changed')
      }
      if (metadata.isDirectory()) {
        await walk(absolutePath, relativePath, depth + 1)
        continue
      }
      if (!metadata.isFile()) {
        return executionIdentityFailure('execution-identity-source-changed')
      }
      fileCount += 1
      if (fileCount > limits.maxFiles || metadata.size > limits.maxFileBytes) {
        return executionIdentityFailure('execution-identity-source-changed')
      }

      // O_NOFOLLOW closes the lstat→open symlink swap. fstat then proves the
      // descriptor is the same ordinary file lstat observed.
      const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      let contents: Uint8Array
      try {
        const opened = await handle.stat()
        if (
          !opened.isFile() ||
          opened.dev !== metadata.dev ||
          opened.ino !== metadata.ino ||
          opened.size !== metadata.size
        ) {
          return executionIdentityFailure('execution-identity-source-changed')
        }
        contents = await handle.readFile()
        const after = await handle.stat()
        if (
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs
        ) {
          return executionIdentityFailure('execution-identity-source-changed')
        }
      } finally {
        await handle.close()
      }
      treeBytes += contents.byteLength
      if (treeBytes > limits.maxTreeBytes) {
        return executionIdentityFailure('execution-identity-source-changed')
      }
      captured.push({
        path: relativePath,
        type: 'file',
        mode: (metadata.mode & 0o111) === 0 ? 0o400 : 0o500,
        contents,
        sha256: sha256(contents),
        bytes: contents.byteLength,
      })
    }
  }

  await walk(sourceRoot, '', 0)
  if (!captured.some((entry) => entry.type === 'file' && entry.path === 'SKILL.md')) {
    return executionIdentityFailure('execution-identity-source-changed')
  }
  return captured
}

async function materializeTree(
  snapshotPath: string,
  entries: readonly CapturedEntry[],
  onRootCreated: () => void,
) {
  if (!isAbsolute(snapshotPath)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
  await mkdir(snapshotPath, { mode: 0o700 })
  // The caller owns cleanup only after this exclusive mkdir succeeds.
  onRootCreated()
  for (const entry of entries) {
    const destination = resolve(snapshotPath, entry.path)
    if (!childWithinRoot(snapshotPath, destination)) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    if (entry.type === 'directory') {
      await mkdir(destination, { mode: 0o700 })
      continue
    }
    await writeFile(destination, entry.contents, {
      flag: 'wx',
      mode: entry.mode,
    })
    await chmod(destination, entry.mode)
  }
  // Make directories immutable after all children exist, deepest first.
  const directories = entries
    .filter((entry): entry is CapturedDirectory => entry.type === 'directory')
    .sort((left, right) => right.path.length - left.path.length)
  for (const entry of directories) {
    await chmod(resolve(snapshotPath, entry.path), entry.mode)
  }
  await chmod(snapshotPath, 0o500)
}

async function verifyMaterializedTree(
  snapshotPath: string,
  expectedProof: readonly FrozenTreeEntry[],
): Promise<void> {
  const actual = await captureTree(snapshotPath, {
    maxFiles: DEFAULT_MAX_FILES,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxTreeBytes: DEFAULT_MAX_TREE_BYTES,
    maxDepth: DEFAULT_MAX_DEPTH,
  })
  const proof = treeProof(actual)
  if (identityDigest(proof) !== identityDigest(expectedProof)) {
    return executionIdentityFailure('execution-identity-source-changed')
  }
  const root = await stat(snapshotPath)
  if (!root.isDirectory() || (root.mode & 0o777) !== 0o500) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
}

/**
 * Compute the complete managed-skill identity without creating a seal. Resume
 * planning uses this read-only phase before comparing the existing owner's
 * immutable execution identity; the same source is snapshotted only after that
 * comparison succeeds.
 */
export async function inspectManagedSkillTree(
  options: ManagedSkillTreeInspectionOptions,
): Promise<ManagedSkillTreeInspection> {
  const limits = {
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxTreeBytes: options.maxTreeBytes ?? DEFAULT_MAX_TREE_BYTES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
  }
  if (!Number.isSafeInteger(options.expectedContentVersion) || options.expectedContentVersion < 0) {
    return executionIdentityFailure('execution-identity-source-changed')
  }
  try {
    if ((await options.readContentVersion()) !== options.expectedContentVersion) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const first = await captureTree(options.sourcePath, limits)
    const proof = treeProof(first)
    const treeDigest = identityDigest(proof)
    const second = await captureTree(options.sourcePath, limits)
    if (identityDigest(treeProof(second)) !== treeDigest) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    if ((await options.readContentVersion()) !== options.expectedContentVersion) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const finalSource = await captureTree(options.sourcePath, limits)
    if (identityDigest(treeProof(finalSource)) !== treeDigest) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const skillEntry = first.find(
      (entry): entry is CapturedFile => entry.type === 'file' && entry.path === 'SKILL.md',
    )
    if (skillEntry === undefined) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    return {
      treeDigest,
      contentVersion: options.expectedContentVersion,
      skillMarkdown: new TextDecoder('utf-8', { fatal: true }).decode(skillEntry.contents),
      entries: proof,
    }
  } catch (error) {
    if (error instanceof TypeError) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    throw error
  }
}

/**
 * Freeze one managed skill tree. A legitimate concurrent update is detected
 * twice: by source tree A/B digests and by the owning row's contentVersion.
 */
export async function snapshotManagedSkillTree(
  options: ManagedSkillTreeSnapshotOptions,
): Promise<ManagedSkillTreeSnapshot> {
  const limits = {
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxTreeBytes: options.maxTreeBytes ?? DEFAULT_MAX_TREE_BYTES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
  }
  if (!Number.isSafeInteger(options.expectedContentVersion) || options.expectedContentVersion < 0) {
    return executionIdentityFailure('execution-identity-source-changed')
  }
  let materialized = false
  let succeeded = false
  try {
    if ((await options.readContentVersion()) !== options.expectedContentVersion) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const first = await captureTree(options.sourcePath, limits)
    const proof = treeProof(first)
    const treeDigest = identityDigest(proof)
    await materializeTree(options.snapshotPath, first, () => {
      materialized = true
    })
    await verifyMaterializedTree(options.snapshotPath, proof)
    const second = await captureTree(options.sourcePath, limits)
    if (identityDigest(treeProof(second)) !== treeDigest) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    if ((await options.readContentVersion()) !== options.expectedContentVersion) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    // The version read itself may race a filesystem writer. One final scan
    // after the row fence closes that boundary for legitimate concurrent
    // updates (hostile same-uid A-B-A remains outside the RFC threat model).
    const finalSource = await captureTree(options.sourcePath, limits)
    if (identityDigest(treeProof(finalSource)) !== treeDigest) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const skillEntry = first.find(
      (entry): entry is CapturedFile => entry.type === 'file' && entry.path === 'SKILL.md',
    )
    if (skillEntry === undefined) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const result = {
      path: options.snapshotPath,
      treeDigest,
      contentVersion: options.expectedContentVersion,
      skillMarkdown: new TextDecoder('utf-8', { fatal: true }).decode(skillEntry.contents),
      entries: proof,
    }
    succeeded = true
    return result
  } catch (error) {
    if (error instanceof TypeError) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    throw error
  } finally {
    if (materialized && !succeeded) {
      await removeSealedTree(options.snapshotPath).catch(() => {})
    }
  }
}
