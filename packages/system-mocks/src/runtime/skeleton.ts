// RFC-254 T28b — the CLI skeleton every e2e opencode stub shares.
//
// WHY THIS EXISTS
// ---------------
// The stubs were nine `#!/bin/sh` scripts plus three TS files. Shell scripts
// are not executable on Windows (no shebang, and a `.cmd` shim would let
// cmd.exe re-tokenize the argv — the exact corruption RFC-254 D17 refuses), so
// the whole set has to become one COMPILED artifact.
//
// One artifact, not one file: `bun build --compile` embeds a full Bun runtime,
// measured at 123.9 MiB, so twelve separate binaries would be ~1.2 GB to build
// and upload on every CI run. The modes therefore live in their own modules and
// are bundled together by the dispatcher — each behaviour stays readable and
// independently reviewable, which is what the design gate (P1-5) asked for when
// it warned that "twelve files mapped to modes" is not a contract.
//
// This module holds only what the frozen contract says ALL stubs share; every
// per-stub difference stays in its own mode module.
//
// Every side effect below is written with the SYNCHRONOUS `node:fs` calls, not
// `Bun.write`. The stubs finish with `process.exit`, which does not wait on a
// pending promise, so an async write is a truncation waiting for a slow enough
// machine — and the shell originals used `printf >file`, which never had that
// hazard.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/** Parsed CLI invocation, in the shape the frozen contract describes. */
export interface StubInvocation {
  kind: 'version' | 'run'
  /** The prompt: the single positional AFTER `--`. */
  prompt: string
  argv: string[]
}

/**
 * Classify argv, or exit the way the contract demands.
 *
 * `name` is the diagnostic name the stub calls itself on stderr, and it is
 * passed EXPLICITLY rather than derived from `AW_STUB_MODE`: the mode key and
 * the old script's self-name agree for every stub except `basic`, whose script
 * was plain `stub-opencode.sh`. Deriving it would have silently renamed that
 * one, and stderr is compared byte-for-byte against the shell original.
 *
 * The prompt is read as the single positional after the `--` end-of-options
 * separator — NEVER as `$*`/`argv.join(' ')`. Reading everything would fold
 * flags into the prompt and make the stub blind to an argv-layout regression,
 * which is precisely what `e2e-shell-stub-argv-contract.test.ts` locks.
 */
export function parseInvocation(argv: readonly string[], name: string): StubInvocation {
  const first = argv[0] ?? ''
  if (first === '--version' || first === '-v' || first === 'version') {
    return { kind: 'version', prompt: '', argv: [...argv] }
  }
  if (first !== 'run') {
    process.stderr.write(
      `${name}: unsupported mode: ${argv.length > 0 ? argv.join(' ') : '<no args>'}\n`,
    )
    process.exit(2)
  }
  let seenSeparator = false
  let prompt = ''
  for (const arg of argv) {
    if (seenSeparator) {
      prompt = arg
      break
    }
    if (arg === '--') seenSeparator = true
  }
  return { kind: 'run', prompt, argv: [...argv] }
}

/**
 * Read repeated `--flag value` pairs the way the shell stubs' argv walk does.
 *
 * That walk CONSUMES the value (`shift` inside the case arm) and lets a later
 * occurrence overwrite an earlier one, so `--agent --agent x` yields the literal
 * `--agent`, not `x`. A naive "find the flag, take the next token" scan
 * disagrees on exactly that input, so the consuming walk is reproduced here.
 */
export function parseFlags(
  argv: readonly string[],
  names: readonly string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (!names.includes(arg)) continue
    i += 1
    out[arg] = argv[i]
  }
  return out
}

/**
 * Fold an agent name into a state-file name, replacing the clarify stubs'
 * `tr -c 'A-Za-z0-9._-' '_'`.
 *
 * ONE CODE POINT → ONE UNDERSCORE, which is a deliberate departure from `tr`
 * rather than an imitation of it. `tr`'s granularity is LOCALE-dependent: BSD
 * tr under a UTF-8 locale folds `设计者` to three underscores, the same tr under
 * `LC_ALL=C` — and GNU tr always — folds it to nine. The shell original
 * therefore disagrees with itself between a developer's macOS shell and Linux
 * CI, so there is no faithful behaviour to copy; there is only a choice.
 *
 * What actually has to hold is that the mapping is deterministic and stable
 * within a run, because it is the key a round counter lives under: if two calls
 * for one agent folded differently, round 2 would ask its question again
 * instead of finalising and the task would hang. That property is what
 * `rfc254-stub-differential.test.ts` asserts for a non-ASCII name.
 */
export function sanitizeStateKey(value: string): string {
  return [...value].map((char) => (/^[A-Za-z0-9._-]$/.test(char) ? char : '_')).join('')
}

/**
 * Contract-test hook: write the extracted prompt verbatim when asked.
 *
 * The guard reads this file back to prove the stub parsed the REAL prompt
 * rather than a flag or the whole argv — so it must be the parsed value, never
 * a reconstruction.
 */
export function emitPromptForContractTest(prompt: string): void {
  const target = process.env.AW_STUB_PROMPT_OUT
  if (target === undefined || target.length === 0) return
  writeFileSync(target, prompt)
}

/**
 * The RFC-200 envelope nonce carried by the prompt.
 *
 * LAST match wins: a prompt may quote upstream content that itself contains an
 * envelope, and the nonce that must be echoed is the one the framework appended
 * for THIS run.
 */
export function envelopeNonce(prompt: string): string | null {
  const matches = [...prompt.matchAll(/nonce="([^"]*)"/g)]
  const last = matches.at(-1)
  return last === undefined ? null : (last[1] ?? null)
}

/** `<workflow-output nonce="...">`, or exit 3 the way the contract says. */
export function requireOutputOpen(prompt: string, name: string): string {
  return requireEnvelopeOpen(prompt, name).output
}

/**
 * Both envelope openings for the clarify stubs, which choose between emitting a
 * question round and a final output round from the SAME nonce.
 */
export function requireEnvelopeOpen(
  prompt: string,
  name: string,
): { output: string; clarify: string } {
  const nonce = envelopeNonce(prompt)
  if (nonce === null || nonce.length === 0) {
    process.stderr.write(`${name}: prompt is missing the RFC-200 envelope nonce\n`)
    process.exit(3)
  }
  return {
    output: `<workflow-output nonce="${nonce}">`,
    clarify: `<workflow-clarify nonce="${nonce}">`,
  }
}

/**
 * Emit one `--format json` text event.
 *
 * The runner reads the stream line by line and concatenates `part.text` from
 * every `text` event, then extracts the LAST `<workflow-output>` envelope from
 * that buffer — so one event carrying the whole envelope is sufficient.
 */
export function emitTextEvent(text: string): void {
  process.stdout.write(
    `${JSON.stringify({ type: 'text', timestamp: 0, part: { type: 'text', text } })}\n`,
  )
}

/**
 * Emit a `<workflow-clarify>` round.
 *
 * The clarify payload is INLINE — no port indentation, no newlines — unlike the
 * output envelope built by `envelope()` below. The two layouts are not
 * interchangeable here: stdout is compared byte-for-byte against the shell
 * originals.
 */
export function emitClarifyEvent(clarifyOpen: string, body: string): void {
  emitTextEvent(`${clarifyOpen}${body}</workflow-clarify>`)
}

/** Build an envelope from `<port>` entries, matching the shell stubs' layout. */
export function envelope(outputOpen: string, ports: Array<[string, string]>): string {
  const body = ports.map(([name, value]) => `  <port name="${name}">${value}</port>`).join('\n')
  return `${outputOpen}\n${body}\n</workflow-output>`
}

/**
 * RFC-029: simulate what the real `aw-inventory-dump` plugin would have
 * written, but only when the framework actually asked for a drop.
 *
 * Takes the exact TEXT rather than an object to serialise. The originals wrote
 * a shell heredoc whose layout `JSON.stringify(x, null, 2)` does not reproduce
 * (their array elements sit on one line), so re-serialising made the ported
 * stub write different BYTES for the same inventory. That was invisible while
 * the comparison parsed both sides as JSON; it is not invisible now.
 */
export function writeInventoryIfRequested(text: string): void {
  const target = process.env.OPENCODE_AW_INVENTORY_OUT
  if (target === undefined || target.length === 0) return
  writeFileSync(target, text)
}

/**
 * `mkdir -p` a stub's state directory and hand back the path.
 *
 * The stubs create it themselves rather than trusting the harness: they are
 * launched by the runner under a task worktree, and a missing directory would
 * turn "round 2" into "round 1 forever" — a hang, not an error.
 */
export function ensureStateDir(configured: string | undefined, fallback: string): string {
  const dir = configured !== undefined && configured.length > 0 ? configured : fallback
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Presence-based round counter (`stub-opencode-clarify*.sh`).
 *
 * Returns whether this key had been seen BEFORE this call, then marks it. The
 * mark is the shell's `printf 'x' >> "$key"`, kept verbatim so a leftover state
 * directory from an old shell run is still readable by the ported stub.
 */
export function markCalled(keyPath: string): boolean {
  const already = existsSync(keyPath)
  appendFileSync(keyPath, 'x')
  return already
}

/**
 * Numeric round counter (`stub-opencode-cross-clarify.sh`): read, increment,
 * write back, return the new value. Starts at 1.
 */
export function bumpCounter(counterPath: string): number {
  let count = 1
  if (existsSync(counterPath)) count = Number(readFileSync(counterPath, 'utf8')) + 1
  writeFileSync(counterPath, String(count))
  return count
}

/** Append one newline-terminated line to a log file. */
export function appendLine(logPath: string, line: string): void {
  appendFileSync(logPath, `${line}\n`)
}
