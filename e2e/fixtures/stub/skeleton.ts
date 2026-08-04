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
 * The prompt is read as the single positional after the `--` end-of-options
 * separator — NEVER as `$*`/`argv.join(' ')`. Reading everything would fold
 * flags into the prompt and make the stub blind to an argv-layout regression,
 * which is precisely what `e2e-shell-stub-argv-contract.test.ts` locks.
 */
export function parseInvocation(argv: readonly string[]): StubInvocation {
  const first = argv[0] ?? ''
  if (first === '--version' || first === '-v' || first === 'version') {
    return { kind: 'version', prompt: '', argv: [...argv] }
  }
  if (first !== 'run') {
    process.stderr.write(
      `${stubName()}: unsupported mode: ${argv.length > 0 ? argv.join(' ') : '<no args>'}\n`,
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

function stubName(): string {
  return `stub-opencode${process.env.AW_STUB_MODE ? `-${process.env.AW_STUB_MODE}` : ''}`
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
  Bun.write(target, prompt)
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
export function requireOutputOpen(prompt: string): string {
  const nonce = envelopeNonce(prompt)
  if (nonce === null || nonce.length === 0) {
    process.stderr.write(`${stubName()}: prompt is missing the RFC-200 envelope nonce\n`)
    process.exit(3)
  }
  return `<workflow-output nonce="${nonce}">`
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

/** Build an envelope from `<port>` entries, matching the shell stubs' layout. */
export function envelope(outputOpen: string, ports: Array<[string, string]>): string {
  const body = ports.map(([name, value]) => `  <port name="${name}">${value}</port>`).join('\n')
  return `${outputOpen}\n${body}\n</workflow-output>`
}

/**
 * RFC-029: simulate what the real `aw-inventory-dump` plugin would have
 * written, but only when the framework actually asked for a drop.
 */
export function writeInventoryIfRequested(payload: unknown): void {
  const target = process.env.OPENCODE_AW_INVENTORY_OUT
  if (target === undefined || target.length === 0) return
  Bun.write(target, `${JSON.stringify(payload, null, 2)}\n`)
}
