// RFC-054 W2-1 — real-opencode integration tests.
//
// These are LIVE LLM tests: they spawn the real `opencode` binary against a
// real LLM provider and assert the framework's parser still understands its
// output. The point is to catch DRIFT between opencode releases — when a new
// opencode version subtly changes its JSON event shape, our envelope, or
// CLI semantics, this suite fails fast in the dedicated nightly workflow
// (see `.github/workflows/integration-opencode.yml`).
//
// Gating: these tests do NOT run during normal `bun test`. They require
//   * RUN_OPENCODE_INTEGRATION=1 in the environment (opt-in flag), AND
//   * a working opencode auth context — either ANTHROPIC_API_KEY /
//     OPENAI_API_KEY in the env, or OPENCODE_AUTH_CONTENT pointing at a
//     pre-built auth.json, or a local `~/.config/opencode/auth.json` already
//     created by `opencode auth login`.
//
// If those are not set, every test below is `skipIf`'d (one-time skip per
// describe — the env probe happens at module load). Locally, run with:
//
//   RUN_OPENCODE_INTEGRATION=1 bun test \
//     packages/backend/tests/integration-opencode/
//
// Matrix: the workflow runs each test against a historical behavior fixture
// and `latest`. Neither entry is an allowlist or admission boundary. The
// historical leg catches framework regressions against an older executable;
// the latest leg catches upstream behavior drift.
//
// Cost / flakiness: each LIVE case spends ~3-15s in a real LLM call. Total
// suite wall-clock ~30-60s. `retries: 1` (in playwright/integration profile)
// absorbs transient LLM 429 / network blips.

import { describe, expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectEnvelopeKind, extractLastEnvelope, parseEnvelope } from '@/services/envelope'
import { accumulateTokens, extractTextFromEvent, inferEventKind } from '@/services/runner'
import { resolveAutoApproveFlag } from '@/services/runtime/opencode/spawn'
import { probeOpencode } from '@/util/opencode'

const RUN_INTEGRATION = process.env.RUN_OPENCODE_INTEGRATION === '1'

function detectAuthAvailable(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) return true
  if (process.env.OPENCODE_AUTH_CONTENT) return true
  try {
    const localAuth = join(homedir(), '.config', 'opencode', 'auth.json')
    return existsSync(localAuth)
  } catch {
    return false
  }
}

const AUTH_AVAILABLE = detectAuthAvailable()
const SKIP = !RUN_INTEGRATION || !AUTH_AVAILABLE

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? 'opencode'

// 2026-07-21: opencode ≥1.18 renamed `--dangerously-skip-permissions` →
// `--auto`; this suite drives the REAL local binary, so probe once and pick
// the spelling the same way the production driver does.
let autoFlagPromise: Promise<string> | null = null
function liveAutoApproveFlag(): Promise<string> {
  autoFlagPromise ??= probeOpencode(OPENCODE_BIN).then((p) => resolveAutoApproveFlag(p.version))
  return autoFlagPromise
}

interface RunResult {
  exitCode: number
  events: Array<Record<string, unknown>>
  stdoutLines: string[]
  stderrTail: string
  durationMs: number
}

function ensureGitRepo(): string {
  // opencode --format json behaves identically only when cwd is a non-empty
  // git repo (same constraint the daemon enforces via per-task worktrees).
  // Spin up a throwaway repo per test so isolation is clean.
  const dir = mkdtempSync(join(tmpdir(), 'aw-it-opencode-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'it@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'it'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# integration fixture\n', 'utf-8')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

async function runOpencode(
  prompt: string,
  opts: {
    cwd?: string
    extraArgs?: string[]
    timeoutMs?: number
  } = {},
): Promise<RunResult> {
  const cwd = opts.cwd ?? ensureGitRepo()
  const timeoutMs = opts.timeoutMs ?? 90_000
  const argv = [
    'run',
    prompt,
    '--format',
    'json',
    await liveAutoApproveFlag(),
    ...(opts.extraArgs ?? []),
  ]
  const t0 = Date.now()
  return new Promise<RunResult>((resolveP, rejectP) => {
    const child = spawn(OPENCODE_BIN, argv, {
      cwd,
      env: { ...process.env, PWD: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdoutBuf = ''
    const stdoutLines: string[] = []
    const events: Array<Record<string, unknown>> = []
    let stderrBuf = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      rejectP(
        new Error(`opencode timed out after ${timeoutMs}ms; stderr=${stderrBuf.slice(0, 300)}`),
      )
    }, timeoutMs)
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trimEnd()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (line.length === 0) continue
        stdoutLines.push(line)
        try {
          const evt = JSON.parse(line) as Record<string, unknown>
          events.push(evt)
        } catch {
          // Some opencode versions print non-JSON banners before the stream
          // starts. Tolerate it — we only care about parseable events for
          // the framework path.
        }
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      rejectP(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (stdoutBuf.trim().length > 0) {
        stdoutLines.push(stdoutBuf.trim())
        try {
          events.push(JSON.parse(stdoutBuf.trim()) as Record<string, unknown>)
        } catch {
          /* ignore */
        }
      }
      resolveP({
        exitCode: code ?? -1,
        events,
        stdoutLines,
        stderrTail: stderrBuf.slice(-1000),
        durationMs: Date.now() - t0,
      })
    })
  })
}

function joinStdoutText(events: Array<Record<string, unknown>>): string {
  return events
    .map((e) => extractTextFromEvent(e))
    .filter((s): s is string => s !== null && s.length > 0)
    .join('')
}

describe.skipIf(SKIP)('RFC-054 W2-1 — real opencode integration', () => {
  // Case 1: opencode --version smoke. No LLM call. Locks "the CLI is on PATH
  // and exposes optional version telemetry in the familiar semver form."
  // Admission never compares this value; loss of the command is still useful
  // diagnostic drift for the dedicated integration workflow.
  test('opencode --version emits a parseable semver', () => {
    const raw = execFileSync(OPENCODE_BIN, ['--version'], { encoding: 'utf-8' }).trim()
    expect(raw).toMatch(/^\d+\.\d+\.\d+/)
  })

  // Case 2: JSON event stream shape. Locks the event kinds the framework's
  // inferEventKind() switch depends on (step_start / text / step_finish /
  // session.idle). If opencode adds a new event kind we DON'T need to
  // handle, this still passes — we only assert presence of known-good
  // kinds. If opencode RENAMES one (e.g. step_start → run.step.start),
  // every assertion below fires.
  test('--format json stream contains step_start, text, and a session-idle terminal event', async () => {
    const res = await runOpencode(
      'Reply with the single English word "ack" and nothing else. No tools, no markdown.',
    )
    expect(res.exitCode).toBe(0)
    expect(res.events.length).toBeGreaterThan(0)

    const kinds = new Set<string>()
    for (const e of res.events) {
      kinds.add(inferEventKind(e))
    }
    // step_start fires before tool / text segments begin.
    expect(kinds.has('step_start')).toBe(true)
    // At least one text chunk arrives.
    expect(kinds.has('text')).toBe(true)
    // Terminal: either step_finish or session.idle (depending on opencode
    // version's emit cadence). Both signal "we're done"; framework's runner
    // listens for either.
    expect(kinds.has('step_finish') || kinds.has('session.idle')).toBe(true)
  }, 120_000)

  // Case 3: text accumulation. Drives joinStdoutText (the helper the runner
  // uses to assemble final agent output). Locks "every text-bearing event
  // shape the framework recognises is in fact accumulating text". An
  // opencode change that moves text into a sub-field would surface as an
  // empty accumulator here.
  test('accumulated text from text events is non-empty and contains the requested token', async () => {
    const res = await runOpencode(
      'Reply with the single English word "pingpong42" and nothing else.',
    )
    expect(res.exitCode).toBe(0)
    const text = joinStdoutText(res.events)
    expect(text.length).toBeGreaterThan(0)
    // Loose match — LLM may wrap in punctuation. We just need the token
    // to surface anywhere in the accumulated stream.
    expect(text.toLowerCase()).toContain('pingpong42')
  }, 120_000)

  // Case 4: envelope round-trip. Locks "opencode passes through our
  // protocol's XML envelope without mangling". Prompt embeds the literal
  // envelope text and asks the LLM to echo it. The parser then runs
  // exactly as the daemon would: extractLastEnvelope + parseEnvelope with
  // declaredOutputs=['answer']. If opencode strips XML, re-encodes <, or
  // splits the envelope across tool boundaries, both extract and parse
  // fail to recognise the port.
  test('parseEnvelope round-trips a <workflow-output>/<port> sequence from a real LLM', async () => {
    const envelopeLiteral =
      '<workflow-output><port name="answer">forty-two</port></workflow-output>'
    const res = await runOpencode(
      `End your reply with this exact XML, with no surrounding code fence: ${envelopeLiteral}`,
    )
    expect(res.exitCode).toBe(0)
    const text = joinStdoutText(res.events)
    expect(text.length).toBeGreaterThan(0)

    const kind = detectEnvelopeKind(text)
    expect(kind).toBe('output')

    const xml = extractLastEnvelope(text)
    expect(xml).not.toBeNull()
    const parsed = parseEnvelope(xml!, ['answer'])
    expect(parsed.ports.get('answer')).toBe('forty-two')
    expect(parsed.missingDeclared).toEqual([])
    expect(parsed.undeclared).toEqual([])
  }, 120_000)

  // Case 5: token accumulation. accumulateTokens() is the framework's
  // billing path — it reads step_finish events and adds up input / output
  // / cache tokens into RunResult.tokenUsage. Lock that the shape on the
  // current opencode build still feeds the accumulator (non-zero output
  // after a real call). If opencode renames `tokens.input` / `tokens.output`
  // / `tokens.cache`, the daemon's per-task billing silently zeros out
  // until someone notices — this test catches that.
  test('accumulateTokens collects non-zero usage from a real opencode run', async () => {
    const res = await runOpencode('Reply with the single English word "tok" and nothing else.')
    expect(res.exitCode).toBe(0)
    // Shape matches packages/backend/src/services/runner.ts RunResult.tokenUsage.
    const usage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 }
    for (const e of res.events) accumulateTokens(e, usage)
    // input + output must both be positive — a real LLM call always consumes
    // some prompt tokens and emits some response tokens. Cache fields stay
    // 0 unless the provider supports prompt caching, so don't gate on those.
    expect(usage.input + usage.output).toBeGreaterThan(0)
    expect(usage.output).toBeGreaterThan(0)
    expect(usage.total).toBeGreaterThanOrEqual(usage.input + usage.output)
  }, 120_000)
})

// Module-level sanity for local devs: when the integration suite is gated
// off, surface ONE non-LLM check so the file isn't dead weight in normal
// `bun test`. This case loads the W2-1 file but only verifies the gating
// logic itself (no opencode spawn, no API key needed).
describe('RFC-054 W2-1 — integration gate (always runs)', () => {
  test('SKIP flag is true iff RUN_OPENCODE_INTEGRATION!=1 OR no auth available', () => {
    const expectedSkip = !(process.env.RUN_OPENCODE_INTEGRATION === '1' && AUTH_AVAILABLE)
    expect(SKIP).toBe(expectedSkip)
  })

  // Read the README beside this file — if it's been deleted, the workflow
  // wiring is incomplete. The README documents how to populate auth + run
  // the suite, so the on-call shouldn't need to grep this test file to
  // figure out the gate semantics.
  test('integration-opencode/README.md exists and documents the env gate', () => {
    const readmePath = join(import.meta.dir, 'README.md')
    expect(existsSync(readmePath)).toBe(true)
    const body = readFileSync(readmePath, 'utf-8')
    expect(body).toContain('RUN_OPENCODE_INTEGRATION')
    expect(body).toContain('OPENCODE_AUTH_CONTENT')
  })
})
