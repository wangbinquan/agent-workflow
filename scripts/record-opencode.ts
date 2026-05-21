#!/usr/bin/env bun
// RFC-054 W1-1 — Record a real opencode --format json session to a ndjson
// fixture for the parser-guard test (see
// packages/backend/tests/opencode-recording-parser.test.ts).
//
// Usage:
//   bun run scripts/record-opencode.ts \
//     --prompt "Reply with exactly: hello" \
//     --out   packages/backend/tests/fixtures/opencode-recordings/1.15.5-text-only.ndjson \
//     --id    text-only \
//     [--expected-envelope '<workflow-output><port name="answer">42</port></workflow-output>'] \
//     [--cwd  /tmp/some-git-repo] \
//     [--opencode-bin /opt/homebrew/bin/opencode] \
//     [--extra-args ...]
//
// Produces a ndjson file whose first line is a magic recording header
// `{"__recording__":{...}}` followed by one JSON line per opencode stdout
// event. The parser-guard test ingests this file and replays the lines
// through `accumulateTokens` / `extractTextFromEvent` / `inferEventKind`
// (from runner.ts) and `extractLastEnvelope` / `parseEnvelope` (from
// envelope.ts) to assert the protocol shape still parses cleanly.
//
// CI does NOT run this script — fixtures are committed pre-built. Maintainers
// only re-run it when bumping the pinned opencode version, and the resulting
// fixture diff requires a commit message containing `[recording-refresh]`
// (see scripts/git-hooks/pre-commit-recording.sh).

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { execSync } from 'node:child_process'

interface RecordingHeader {
  opencodeVersion: string
  capturedAt: string
  recordingId: string
  prompt: string
  expectedEnvelope: string | null
  cwd: string
  agent: string
}

interface CliArgs {
  prompt: string
  out: string
  id: string
  expectedEnvelope: string | null
  cwd: string | null
  opencodeBin: string
  extraArgs: string[]
  agent: string
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {
    expectedEnvelope: null,
    cwd: null,
    opencodeBin: 'opencode',
    extraArgs: [],
    agent: '<default>',
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`Missing value for ${k}`)
      return v
    }
    switch (k) {
      case '--prompt':
        out.prompt = next()
        break
      case '--out':
        out.out = next()
        break
      case '--id':
        out.id = next()
        break
      case '--expected-envelope':
        out.expectedEnvelope = next()
        break
      case '--cwd':
        out.cwd = next()
        break
      case '--opencode-bin':
        out.opencodeBin = next()
        break
      case '--agent':
        out.agent = next()
        break
      case '--extra-arg':
        out.extraArgs!.push(next())
        break
      default:
        throw new Error(`Unknown flag: ${k}`)
    }
  }
  if (!out.prompt || !out.out || !out.id) {
    throw new Error('Required: --prompt, --out, --id')
  }
  return out as CliArgs
}

function probeOpencodeVersion(bin: string): string {
  try {
    const raw = execSync(`${bin} --version`, { encoding: 'utf-8' }).trim()
    if (!/^\d+\.\d+\.\d+/.test(raw)) {
      throw new Error(`unexpected --version output: ${raw}`)
    }
    return raw
  } catch (err) {
    throw new Error(
      `opencode binary not runnable at ${bin}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function ensureGitRepo(): string {
  // opencode --format json needs a non-empty git repo cwd to behave
  // identically to how the daemon spawns it. Caller can pass --cwd to
  // point at a real repo; otherwise we create a throwaway one.
  const tmp = mkdtempSync(`${tmpdir()}/aw-rec-`)
  execSync('git init -q -b main', { cwd: tmp })
  execSync('git config user.email rec@local', { cwd: tmp })
  execSync('git config user.name rec', { cwd: tmp })
  writeFileSync(`${tmp}/README.md`, '# recording fixture\n')
  execSync('git add . && git commit -qm init', { cwd: tmp })
  return tmp
}

async function runOpencode(args: CliArgs, cwd: string): Promise<string[]> {
  return new Promise((resolveP, rejectP) => {
    const argv = [
      'run',
      args.prompt,
      '--format',
      'json',
      '--dangerously-skip-permissions',
      ...args.extraArgs,
    ]
    const child = spawn(args.opencodeBin, argv, {
      cwd,
      env: { ...process.env, PWD: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutLines: string[] = []
    let buf = ''
    let stderrBuf = ''
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trimEnd()
        buf = buf.slice(nl + 1)
        if (line.length > 0) stdoutLines.push(line)
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk
    })
    child.on('error', rejectP)
    child.on('exit', (code) => {
      if (buf.trim().length > 0) stdoutLines.push(buf.trim())
      if (code !== 0) {
        rejectP(new Error(`opencode exited ${code}; stderr=${stderrBuf.slice(0, 500)}`))
        return
      }
      resolveP(stdoutLines)
    })
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const version = probeOpencodeVersion(args.opencodeBin)
  const cwd = args.cwd ?? ensureGitRepo()
  if (!existsSync(cwd)) {
    throw new Error(`cwd does not exist: ${cwd}`)
  }
  process.stderr.write(`[record-opencode] opencode=${version} cwd=${cwd}\n`)
  process.stderr.write(`[record-opencode] prompt=${JSON.stringify(args.prompt)}\n`)

  const t0 = Date.now()
  const lines = await runOpencode(args, cwd)
  process.stderr.write(`[record-opencode] captured ${lines.length} stdout lines in ${Date.now() - t0}ms\n`)

  // Magic header — first line of the recording, identifies what was captured.
  const header: RecordingHeader = {
    opencodeVersion: version,
    capturedAt: new Date().toISOString().slice(0, 10),
    recordingId: args.id,
    prompt: args.prompt,
    expectedEnvelope: args.expectedEnvelope,
    cwd,
    agent: args.agent,
  }
  const headerLine = JSON.stringify({ __recording__: header })

  const outAbs = resolve(args.out)
  mkdirSync(dirname(outAbs), { recursive: true })
  const content = [headerLine, ...lines].join('\n') + '\n'
  writeFileSync(outAbs, content, 'utf-8')
  process.stderr.write(`[record-opencode] wrote ${outAbs} (${content.length} bytes)\n`)
}

main().catch((err) => {
  process.stderr.write(`[record-opencode] error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
