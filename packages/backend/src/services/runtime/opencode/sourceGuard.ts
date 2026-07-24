import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path'
import { identityDigest } from './executionIdentity'
import { executionIdentityFailure } from './failure'

const FORBIDDEN_AT_EACH_LEVEL = [
  'opencode.json',
  'opencode.jsonc',
  '.opencode',
  'reference',
  'references',
  join('.agents', 'skills'),
  join('.claude', 'skills'),
] as const

interface DirectoryFence {
  path: string
  dev: string
  ino: string
  mode: number
}

export interface OpencodeSourceFingerprint {
  canonicalWorktree: string
  digest: string
  directories: readonly DirectoryFence[]
}

export interface FrozenInstruction {
  path: string
  digest: string
  bytes: Uint8Array
  text: string
}

function contained(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function existsUnsafe(path: string): Promise<boolean> {
  try {
    await lstat(path)
    // Every kind is forbidden, including symlink, socket and custom surfaces.
    // We intentionally do not parse or execute it.
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return executionIdentityFailure('execution-identity-source-changed')
  }
}

/**
 * Apply the behavior codec's frozen discovery search domain without ever
 * importing or parsing a project-owned file. Presence alone is unsupported.
 */
export async function scanOpencodeProjectSurface(
  worktreePath: string,
): Promise<OpencodeSourceFingerprint> {
  if (!isAbsolute(worktreePath)) {
    return executionIdentityFailure('execution-identity-project-config-unsupported')
  }
  const inputMetadata = await lstat(worktreePath).catch(() => null)
  if (inputMetadata === null || inputMetadata.isSymbolicLink() || !inputMetadata.isDirectory()) {
    return executionIdentityFailure('execution-identity-project-config-unsupported')
  }
  const canonicalWorktree = await realpath(worktreePath)
  const filesystemRoot = parse(canonicalWorktree).root
  const directories: DirectoryFence[] = []
  let cursor = canonicalWorktree

  for (;;) {
    const metadata = await lstat(cursor, { bigint: true }).catch(() => null)
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    directories.push({
      path: cursor,
      dev: metadata.dev.toString(),
      ino: metadata.ino.toString(),
      mode: Number(metadata.mode & 0o7777n),
    })
    for (const candidate of FORBIDDEN_AT_EACH_LEVEL) {
      if (await existsUnsafe(join(cursor, candidate))) {
        return executionIdentityFailure(
          'execution-identity-project-config-unsupported',
          `/${candidate.split(sep).join('/')}`,
        )
      }
    }
    if (cursor === filesystemRoot) break
    const parent = dirname(cursor)
    if (parent === cursor) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    cursor = parent
  }

  return {
    canonicalWorktree,
    digest: identityDigest({ canonicalWorktree, directories }),
    directories,
  }
}

export function assertSourceFingerprintUnchanged(
  expected: OpencodeSourceFingerprint,
  actual: OpencodeSourceFingerprint,
): void {
  if (
    expected.canonicalWorktree !== actual.canonicalWorktree ||
    expected.digest !== actual.digest
  ) {
    return executionIdentityFailure('execution-identity-source-changed')
  }
}

/**
 * Freeze one explicitly selected AGENTS.md without following links. The
 * returned bytes are what the prompt builder must use; callers must not reopen
 * the live path.
 */
export async function readFrozenInstruction(
  worktreeRoot: string,
  instructionPath: string,
  maxBytes = 1024 * 1024,
): Promise<FrozenInstruction> {
  const canonicalRoot = await realpath(worktreeRoot)
  const absolute = isAbsolute(instructionPath)
    ? instructionPath
    : join(canonicalRoot, instructionPath)
  if (!contained(canonicalRoot, absolute)) {
    return executionIdentityFailure('execution-identity-source-changed')
  }
  const before = await lstat(absolute)
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
    return executionIdentityFailure('execution-identity-source-changed')
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Uint8Array
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    bytes = await handle.readFile()
    if (bytes.byteLength > maxBytes) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
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
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return executionIdentityFailure('execution-identity-source-changed')
  }
  return {
    path: absolute,
    digest: createHash('sha256').update(bytes).digest('hex'),
    bytes,
    text,
  }
}
