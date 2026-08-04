import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path'
import { identityDigest } from './executionIdentity'
import { executionIdentityFailure } from './failure'
import { assertSameFileIdentityForHost } from '@/util/fileTrust'

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
    // 2026-08-04 audit — the REJECTION applies to the worktree only; the walk
    // above it continues purely to fingerprint the ancestor chain.
    //
    // Rejecting at every ancestor was strictly broader than what OpenCode can
    // actually read, and the difference was not academic: worktrees live under
    // `~/.agent-workflow/`, so `$HOME` was ALWAYS scanned, and a daemon user who
    // had ever run opencode (`~/.opencode`) or installed Claude Code skills
    // (`~/.claude/skills`) failed EVERY verified node forever — under an error
    // that says "project config unsupported", which points nowhere near a home
    // directory.
    //
    // Verified in opencode v1.18.x source rather than assumed: BOTH upward walks
    // are bounded by the worktree —
    //   config/paths.ts:28-32   up({targets:['.opencode'], start: directory, stop: worktree})
    //   skill/index.ts:196-197  up({targets: externalDirs, start: directory, stop: worktree})
    // and `util/filesystem.ts:213-226` breaks the loop at `stop` (it only climbs
    // to `/` when `stop` never matches). The one unbounded read is
    // `path.join(global.home, dir)`, which follows `HOME` — and the controlled
    // config points `HOME` at the private hermetic home, so the daemon user's
    // real home is not on OpenCode's search domain at all.
    for (const candidate of cursor === canonicalWorktree ? FORBIDDEN_AT_EACH_LEVEL : []) {
      const hit = join(cursor, candidate)
      if (await existsUnsafe(hit)) {
        // Name the ABSOLUTE path: the old pointer was the bare relative name
        // (`/.opencode`), which tells an operator nothing about where to look.
        return executionIdentityFailure('execution-identity-project-config-unsupported', hit)
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
    if (!assertSameFileIdentityForHost(before, opened).trusted || opened.size !== before.size) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    bytes = await handle.readFile()
    if (bytes.byteLength > maxBytes) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const after = await handle.stat()
    if (
      // `after` fstats the SAME open handle, so its isFile() is necessarily
      // still true — the primitive's extra check is a no-op tightening here.
      !assertSameFileIdentityForHost(opened, after).trusted ||
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
