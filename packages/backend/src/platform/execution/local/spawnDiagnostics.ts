// 2026-08-04 incident — spawn-failure diagnosis helpers.
//
// Bun's `Bun.spawn` reports posix_spawn ENOENT with argv[0] in the message even
// when the missing path is actually the WORKING DIRECTORY (measured on Bun:
// `Bun.spawn({cmd:['/bin/echo'], cwd:'/nonexistent'})` throws
// `ENOENT: no such file or directory, posix_spawn '/bin/echo'`). These helpers
// distinguish a missing cwd from a missing command and name the right object.

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export interface SpawnEnoentContext {
  /** The exact argv[0] handed to Bun.spawn (absolute path or bare name). */
  argv0: string | undefined
  /** The cwd handed to Bun.spawn, if any. */
  cwd: string | undefined
}

export interface SpawnEnoentProbes {
  exists?: (path: string) => boolean
  which?: (bin: string) => string | null
}

/**
 * Append a diagnosis to a spawn error message when it carries ENOENT: probe the
 * cwd and argv[0] and say which one is actually missing. Non-ENOENT messages
 * (including Bun's self-explanatory `Executable not found in $PATH`) and
 * messages where neither probe finds a missing path pass through unchanged.
 */
export function explainSpawnEnoent(
  rawMessage: string,
  ctx: SpawnEnoentContext,
  probes: SpawnEnoentProbes = {},
): string {
  if (!rawMessage.includes('ENOENT')) return rawMessage
  const exists = probes.exists ?? existsSync
  const which = probes.which ?? ((bin: string) => Bun.which(bin))
  const findings: string[] = []
  const cwdMissing = ctx.cwd !== undefined && ctx.cwd.length > 0 && !exists(ctx.cwd)
  if (cwdMissing) findings.push(`working directory does not exist: '${ctx.cwd}'`)
  if (ctx.argv0 !== undefined && ctx.argv0.length > 0) {
    const argv0Missing = isAbsolute(ctx.argv0) ? !exists(ctx.argv0) : which(ctx.argv0) === null
    if (argv0Missing) {
      findings.push(`executable not found: '${ctx.argv0}'`)
    } else if (cwdMissing) {
      // The raw message names argv[0]; state explicitly that it is innocent.
      findings.push(
        `executable '${ctx.argv0}' exists — Bun names argv[0] in ENOENT even when the cwd is the missing path`,
      )
    }
  }
  if (findings.length === 0) return rawMessage
  return `${rawMessage} [${findings.join('; ')}]`
}

const ANSI_ESCAPES = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g')

/**
 * Compress a captured stream into a single-line tail (errors come LAST) capped
 * at `cap` characters, ANSI escapes stripped, whitespace runs collapsed.
 */
export function outputTail(text: string, cap = 300): string {
  const collapsed = text.replace(ANSI_ESCAPES, '').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= cap) return collapsed
  return `…${collapsed.slice(-cap)}`
}
