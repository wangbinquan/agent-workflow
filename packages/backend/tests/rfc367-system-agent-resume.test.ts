// RFC-367 T2 — `runSystemAgent({ resumeSessionId })` reaches the spawned runtime.
//
// Why this file exists: RFC-367 answers a distiller protocol failure with an
// IN-SESSION follow-up — the agent already holds the whole batch of source
// events, so the corrective turn must continue the SAME native session instead
// of paying to rebuild that context. That only works if the option survives
// `runSystemAgent` → `driver.buildSpawn` → argv. It is asserted here at the
// subprocess boundary (`opencode run --session <id>`, verified against the
// opencode source at packages/opencode/src/cli/cmd/run.ts:152-156) rather than
// on an internal ctx object, so a refactor that drops the field mid-pipeline
// still goes red.
//
// The absence case is locked too: every pre-RFC-367 caller (intent builder,
// change narrative, MCP playground) passes no resumeSessionId and must keep
// spawning a fresh session.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runSystemAgent } from '../src/services/systemAgentRun'

const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const SET_ENV_KEYS = [
  'MOCK_OPENCODE_ECHO_PROMPT',
  'MOCK_OPENCODE_EMIT_SESSION_ID',
  'MOCK_OPENCODE_CAPTURE_ARGV_TO',
  'MOCK_OPENCODE_SESSION_ID_FOLLOWS_RESUME',
]

afterEach(() => {
  for (const k of SET_ENV_KEYS) delete process.env[k]
})

const baseOpts = (scratchParent: string) => ({
  feature: 'memory-distiller',
  agentName: 'aw-memory-distiller',
  systemPrompt: 'You are a test system agent.',
  prompt: 'emit the envelope',
  protocol: 'opencode' as const,
  binaryOverride: [process.execPath, 'run', MOCK_OPENCODE] as readonly string[],
  scratchParent,
  timeoutMs: 20_000,
})

function argvRows(path: string): Array<{ argv: string[] }> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { argv: string[] })
}

describe('RFC-367 — runSystemAgent resume pass-through', () => {
  test('no resumeSessionId → no --session flag (pre-RFC-367 callers unchanged)', async () => {
    const scratchParent = mkdtempSync(join(tmpdir(), 'aw-rfc367-noresume-'))
    const argvPath = join(scratchParent, 'argv.jsonl')
    process.env.MOCK_OPENCODE_CAPTURE_ARGV_TO = argvPath
    process.env.MOCK_OPENCODE_EMIT_SESSION_ID = 'ses_fresh'

    const r = await runSystemAgent({ ...baseOpts(scratchParent), scratchName: 'round-0' })

    expect(r.status).toBe('ok')
    expect(r.capturedSessionId).toBe('ses_fresh')
    const rows = argvRows(argvPath)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.argv).not.toContain('--session')
  })

  test('resumeSessionId reaches argv as `--session <id>`', async () => {
    const scratchParent = mkdtempSync(join(tmpdir(), 'aw-rfc367-resume-'))
    const argvPath = join(scratchParent, 'argv.jsonl')
    process.env.MOCK_OPENCODE_CAPTURE_ARGV_TO = argvPath
    process.env.MOCK_OPENCODE_EMIT_SESSION_ID = '1'
    // Make the mock behave like a real runtime: echo the resumed id back
    // instead of minting a new one.
    process.env.MOCK_OPENCODE_SESSION_ID_FOLLOWS_RESUME = '1'

    const r = await runSystemAgent({
      ...baseOpts(scratchParent),
      scratchName: 'round-1',
      resumeSessionId: 'ses_prev_round',
    })

    expect(r.status).toBe('ok')
    const rows = argvRows(argvPath)
    expect(rows).toHaveLength(1)
    const flagIdx = rows[0]!.argv.indexOf('--session')
    expect(flagIdx).toBeGreaterThanOrEqual(0)
    expect(rows[0]!.argv[flagIdx + 1]).toBe('ses_prev_round')
    // The follow-up round must stay on the SAME session — that identity is what
    // makes the corrective turn cheap (the agent still holds the batch).
    expect(r.capturedSessionId).toBe('ses_prev_round')
  })

  test('an empty resumeSessionId is treated as absent', async () => {
    const scratchParent = mkdtempSync(join(tmpdir(), 'aw-rfc367-empty-'))
    const argvPath = join(scratchParent, 'argv.jsonl')
    process.env.MOCK_OPENCODE_CAPTURE_ARGV_TO = argvPath
    process.env.MOCK_OPENCODE_EMIT_SESSION_ID = 'ses_fresh_2'

    const r = await runSystemAgent({
      ...baseOpts(scratchParent),
      scratchName: 'round-empty',
      resumeSessionId: '',
    })

    expect(r.status).toBe('ok')
    expect(argvRows(argvPath)[0]!.argv).not.toContain('--session')
  })
})
