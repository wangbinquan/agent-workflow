// RFC-061 PR-B partial-24 — runOpencodeAttempt with stub opencode subprocess.
//
// Real subprocess test using a bash stub that emits a known opencode
// envelope. Verifies the full runOpencodeAttempt path:
// prepare → spawn → pumpLines → aggregateStdout → outcome.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runOpencodeAttempt } from '../src/scheduler-v2/runnerV2'
import type { Agent } from '@agent-workflow/shared'

function makeStubOpencode(dir: string): string {
  const path = join(dir, 'stub-opencode.sh')
  // Emit a single text event whose JSON string contains the envelope.
  // Note: BSD date (macOS) doesn't support %N for nanoseconds; use plain
  // %s so the ts is always a valid JSON integer.
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then echo 'stub-opencode 1.14.99'; exit 0; fi
if [[ "$1" == "run" ]]; then
  TS=$(date +%s)
  ENV='<workflow-output><port name=\\"out\\">hello</port></workflow-output>'
  printf '{"type":"text","ts":%s,"part":{"type":"text","text":"%s"}}\\n' "$TS" "$ENV"
  exit 0
fi
exit 1
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

function fakeAgent(name = 'echoer'): Agent {
  return {
    name,
    description: '',
    outputs: ['out'],
  } as unknown as Agent
}

describe('runOpencodeAttempt — real subprocess with stub opencode', () => {
  test('clean success: parses output envelope from stdout', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rfc061-rv2-'))
    const stub = makeStubOpencode(tmp)

    const result = await runOpencodeAttempt({
      appHome: tmp,
      taskId: 't1',
      attemptId: 'att_x',
      scope: { nodeId: 'echoer', loopIter: 0, shardKey: '', iter: 0 },
      worktreePath: tmp,
      agent: fakeAgent(),
      prompt: 'do thing',
      opencodeCmd: [stub],
    })

    expect(result.outcome).toBe('success')
    expect(result.exitCode).toBe(0)
    expect(result.outputs.out).toBe('hello')
    rmSync(tmp, { recursive: true, force: true })
  })

  // Regression: when no skills are declared, runOpencodeAttempt used
  // to skip creating the per-attempt `.opencode` configDir entirely
  // (prepareSkills early-returns on empty skills). Real opencode then
  // crashed on startup trying to write `<configDir>/.gitignore`, the
  // actor saw a crash, auto-retried via bump-iter, and burned the full
  // retry budget in seconds (task 01KSENXYB9ZZCAJZSR6BKM4ZYK, 4
  // attempts in 5s — see /Users/wangbinquan/Documents/proj/agent-workflow/STATE.md
  // session log for the incident). configDir must exist before spawn
  // regardless of skills.
  test('configDir exists before spawn even when no skills declared', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rfc061-rv2-cfgdir-'))
    const stubDir = mkdtempSync(join(tmpdir(), 'rfc061-rv2-stub-'))
    const stubPath = join(stubDir, 'stub-opencode.sh')
    // Stub mimics real opencode bootstrap: write `.gitignore` into
    // $OPENCODE_CONFIG_DIR. With `set -e`, this fails the whole
    // script (non-zero exit → runner-v2 reports crash) when the
    // configDir is missing — exactly reproducing the ENOENT bug.
    const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then echo 'stub-opencode 1.14.99'; exit 0; fi
if [[ "$1" == "run" ]]; then
  echo 'node_modules' > "$OPENCODE_CONFIG_DIR/.gitignore"
  TS=$(date +%s)
  ENV='<workflow-output><port name=\\"out\\">ok</port></workflow-output>'
  printf '{"type":"text","ts":%s,"part":{"type":"text","text":"%s"}}\\n' "$TS" "$ENV"
  exit 0
fi
exit 1
`
    writeFileSync(stubPath, script)
    chmodSync(stubPath, 0o755)

    const taskId = 'task_cfgdir'
    const attemptId = 'att_cfgdir'
    const result = await runOpencodeAttempt({
      appHome: tmp,
      taskId,
      attemptId,
      scope: { nodeId: 'echoer', loopIter: 0, shardKey: '', iter: 0 },
      worktreePath: tmp,
      agent: fakeAgent(),
      // No `skills` field — exactly the production shape that
      // triggered the bug.
      prompt: 'go',
      opencodeCmd: [stubPath],
    })

    expect(result.outcome).toBe('success')
    expect(result.outputs.out).toBe('ok')
    const expectedConfigDir = join(tmp, 'runs', taskId, attemptId, '.opencode')
    expect(existsSync(expectedConfigDir)).toBe(true)
    expect(existsSync(join(expectedConfigDir, '.gitignore'))).toBe(true)
    rmSync(tmp, { recursive: true, force: true })
    rmSync(stubDir, { recursive: true, force: true })
  })

  test('missing opencode binary → crash outcome (no hang)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rfc061-rv2-no-'))
    const result = await runOpencodeAttempt({
      appHome: tmp,
      taskId: 't1',
      attemptId: 'att_x',
      scope: { nodeId: 'echoer', loopIter: 0, shardKey: '', iter: 0 },
      worktreePath: tmp,
      agent: fakeAgent(),
      prompt: 'go',
      opencodeCmd: ['/nonexistent/path/to/opencode'],
      timeoutMs: 3000,
    })
    expect(result.outcome).toBe('crash')
    rmSync(tmp, { recursive: true, force: true })
  })
})
