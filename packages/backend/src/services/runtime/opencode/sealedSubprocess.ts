// RFC-224 — the only shell/local-MCP subprocess boundary admitted by the
// verified OpenCode launcher. The tiny on-disk wrapper re-enters this binary;
// this module then constructs bwrap argv directly (no model-controlled shell
// interpolation) and rebuilds the child environment from an allowlist.

import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { IS_EMBEDDED } from '@/embed'
import { executionIdentityFailure } from './failure'

const SAFE_ENV_NAME =
  /^(?:LANG|LC_ALL|LC_CTYPE|TERM|TZ|GIT_AUTHOR_NAME|GIT_AUTHOR_EMAIL|GIT_COMMITTER_NAME|GIT_COMMITTER_EMAIL|[A-Z][A-Z0-9_]{0,127})$/
const DANGEROUS_ENV_NAME =
  /^(?:OPENCODE_|NODE_OPTIONS$|NODE_PATH$|BUN_|DENO_|PYTHON|RUBY|PERL|LD_|DYLD_|BASH_ENV$|ENV$|ZDOTDIR$|GIT_CONFIG|GIT_EXEC|GIT_SSH|SSH_AUTH_SOCK$|DISPLAY$|WAYLAND_DISPLAY$|ELECTRON_RUN_AS_NODE$|NPM_CONFIG_SCRIPT_SHELL$|COREPACK_|EDITOR$|VISUAL$|PAGER$)/i

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && !value.includes('\0') && resolve(value) === value)

export const NetlessSubprocessManifestSchema = z
  .object({
    codec: z.literal(1),
    mode: z.enum(['shell', 'mcp']),
    bwrapPath: AbsolutePathSchema,
    worktreePath: AbsolutePathSchema,
    scratchPath: AbsolutePathSchema,
    appHome: AbsolutePathSchema,
    realHome: AbsolutePathSchema,
    bindReadOnly: z.array(AbsolutePathSchema).max(256),
    env: z.record(z.string()),
    command: z.array(z.string()).min(1).max(256),
  })
  .strict()

export type NetlessSubprocessManifest = z.infer<typeof NetlessSubprocessManifestSchema>

function shellQuote(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function verifiedSelfCommand(subcommand: string, args: readonly string[]): string[] {
  if (!/^__[a-z0-9-]+$/.test(subcommand)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  if (IS_EMBEDDED) return [process.execPath, subcommand, ...args]
  const mainPath = resolve(import.meta.dir, '../../../main.ts')
  return [process.execPath, 'run', mainPath, subcommand, ...args]
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function writeExclusiveRegular(path: string, contents: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0),
    mode,
  )
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
  } finally {
    await handle.close()
  }
  await chmod(path, mode)
}

export function sanitizeNetlessEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    if (
      typeof value !== 'string' ||
      value.includes('\0') ||
      !SAFE_ENV_NAME.test(name) ||
      DANGEROUS_ENV_NAME.test(name)
    ) {
      if (value !== undefined && DANGEROUS_ENV_NAME.test(name)) {
        return executionIdentityFailure('execution-identity-mismatch')
      }
      continue
    }
    output[name] = value
  }
  return output
}

export async function requireRootOwnedBwrap(path = Bun.which('bwrap')): Promise<string> {
  if (path === null || !isAbsolute(path)) {
    return executionIdentityFailure('execution-identity-sandbox-required')
  }
  const resolved = await realpath(path)
  const before = await lstat(resolved)
  const metadata = await stat(resolved)
  if (
    before.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0 ||
    (metadata.mode & 0o111) === 0
  ) {
    return executionIdentityFailure('execution-identity-sandbox-required')
  }
  return resolved
}

export interface MaterializeNetlessWrapperInput {
  wrapperPath: string
  manifestPath: string
  manifest: NetlessSubprocessManifest
}

export async function materializeNetlessWrapper(
  input: MaterializeNetlessWrapperInput,
): Promise<void> {
  const manifest = NetlessSubprocessManifestSchema.parse(input.manifest)
  if (!contained(dirname(input.wrapperPath), input.manifestPath)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  await writeExclusiveRegular(input.manifestPath, JSON.stringify(manifest), 0o400)
  const command = verifiedSelfCommand('__opencode-netless-subprocess', [
    '--manifest',
    input.manifestPath,
  ])
  const script = `#!/bin/sh\nexec ${command.map(shellQuote).join(' ')} "$@"\n`
  await writeExclusiveRegular(input.wrapperPath, script, 0o500)
}

async function readManifest(path: string): Promise<NetlessSubprocessManifest> {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile() || before.size > 1024 * 1024) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0),
  )
  try {
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    const value = JSON.parse(await handle.readFile('utf8')) as unknown
    return NetlessSubprocessManifestSchema.parse(value)
  } catch {
    return executionIdentityFailure('execution-identity-store-unsafe')
  } finally {
    await handle.close()
  }
}

function uniqueMaskRoots(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length)
  return sorted.filter((candidate, index) =>
    sorted.slice(0, index).every((parent) => !contained(parent, candidate)),
  )
}

function parentDirs(maskRoot: string, target: string): string[] {
  if (!contained(maskRoot, target) || target === maskRoot) return []
  const result: string[] = []
  let cursor = dirname(target)
  while (cursor !== maskRoot && contained(maskRoot, cursor)) {
    result.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return result.reverse()
}

export function renderNetlessBwrapArgs(
  manifest: NetlessSubprocessManifest,
  passthroughArgs: readonly string[],
): string[] {
  const parsed = NetlessSubprocessManifestSchema.parse(manifest)
  if (passthroughArgs.some((entry) => entry.includes('\0'))) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  const masks = uniqueMaskRoots([parsed.realHome, parsed.appHome, '/tmp', '/var/tmp'])
  const writable = [parsed.worktreePath, parsed.scratchPath]
  for (const target of [...writable, ...parsed.bindReadOnly]) {
    // A later bind of an ancestor would hide an earlier tmpfs mask and
    // re-expose the secret tree wholesale. Descendants are intentional:
    // parentDirs recreates only their path and the final bind exposes exactly
    // that file/tree (for example one frozen skill or one MCP executable).
    if (masks.some((mask) => contained(target, mask))) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
  }
  for (const target of parsed.bindReadOnly) {
    // RO overlays are applied after RW worktree/scratch allow-backs. Never let
    // a broad read-only target replace either writable root; an exact child
    // file remains admissible.
    if (writable.some((root) => contained(target, root))) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
  }
  const args = [
    '--die-with-parent',
    '--unshare-net',
    '--unshare-pid',
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
  ]
  for (const mask of masks) args.push('--tmpfs', mask)
  for (const target of [...writable, ...parsed.bindReadOnly]) {
    for (const dir of masks.flatMap((mask) => parentDirs(mask, target))) {
      args.push('--dir', dir)
    }
  }
  for (const target of writable) args.push('--bind', target, target)
  for (const target of parsed.bindReadOnly) args.push('--ro-bind', target, target)
  args.push('--chdir', parsed.worktreePath)
  for (const [name, value] of Object.entries(parsed.env).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    args.push('--setenv', name, value)
  }
  args.push('--')
  if (parsed.mode === 'shell') {
    args.push(...parsed.command, ...passthroughArgs)
  } else {
    if (passthroughArgs.length > 0) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    args.push(...parsed.command)
  }
  return args
}

export async function runNetlessSubprocess(
  manifestPath: string,
  passthroughArgs: readonly string[],
): Promise<number> {
  const manifest = await readManifest(manifestPath)
  const cmd = [manifest.bwrapPath, ...renderNetlessBwrapArgs(manifest, passthroughArgs)]
  const child = Bun.spawn({
    cmd,
    cwd: manifest.worktreePath,
    env: {},
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return child.exited
}
