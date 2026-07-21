// RFC-026 T4 — locks `buildCommand(opts, prompt)` argv assembly:
//   - When `opts.resumeSessionId` is a non-empty string, the opencode CLI
//     receives `--session <id>` in the parsed flag region (before the `--`
//     end-of-options separator that fronts the trailing prompt positional).
//   - When `opts.resumeSessionId` is undefined / empty, NO `--session` flag
//     is emitted — review reject / iterate / technical retry / loop paths
//     must never accidentally inherit a clarify-inline-only behavior.
//
// Also enforces a source-code-text invariant: the literal `cmd.push('--session'`
// only appears in the opencode spawn module (RFC-111 PR-A: runtime/opencode/
// spawn.ts, where the argv is constructed), NOT in scheduler.ts or any other
// service. Scheduler decides the resumeSessionId value; only the spawn module
// concatenates it into the CLI. See proposal §C2 + design §13 grep guards.
//
// If these fail, RFC-026's A12 / A13 / proposal §2.1 "review-reject MUST NOT
// resume sessions" claim is at risk — investigate before relaxing.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Agent } from '@agent-workflow/shared'
import { buildCommand, type RunNodeOptions } from '../src/services/runner'

const AGENT: Agent = {
  id: 'a',
  name: 'tester',
  description: '',
  outputs: ['design'],
  syncOutputsOnIterate: false,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: 'body',
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
}

function baseOpts(overrides: Partial<RunNodeOptions> = {}): RunNodeOptions {
  return {
    taskId: 't',
    nodeRunId: 'nr',
    nodeId: 'n',
    agent: AGENT,
    inputs: {},
    worktreePath: '/tmp/wt',
    templateMeta: { repoPath: '/tmp/wt', baseBranch: 'main', taskId: 't' },
    promptTemplate: 'go',
    skills: [],
    appHome: '/tmp/home',
    // db is a structural type we don't exercise here
    db: {} as unknown as RunNodeOptions['db'],
    ...overrides,
  }
}

describe('RFC-026 runner buildCommand — resumeSessionId', () => {
  test('non-empty resumeSessionId appends `--session <id>` at the tail', () => {
    const cmd = buildCommand(baseOpts({ resumeSessionId: 'opc_abc123' }), 'PROMPT')
    expect(cmd).toContain('--session')
    const flagIdx = cmd.indexOf('--session')
    expect(cmd[flagIdx + 1]).toBe('opc_abc123')
    // Head is `opencode run`; the prompt is the trailing positional after `--`
    // (opencode strict-parser safety for `-`-leading prompts). `--session <id>`
    // sits in the parsed flag region, i.e. before that `--` separator.
    expect(cmd[0]).toBe('opencode')
    expect(cmd[1]).toBe('run')
    expect(cmd[cmd.length - 1]).toBe('PROMPT')
    expect(cmd[cmd.length - 2]).toBe('--')
    expect(cmd.indexOf('--session')).toBeLessThan(cmd.lastIndexOf('--'))
  })

  test('undefined resumeSessionId does NOT emit `--session`', () => {
    const cmd = buildCommand(baseOpts({}), 'PROMPT')
    expect(cmd).not.toContain('--session')
  })

  test('empty-string resumeSessionId is treated like undefined (no `--session`)', () => {
    // Defensive: scheduler should never pass '' but be liberal in what we accept.
    const cmd = buildCommand(baseOpts({ resumeSessionId: '' }), 'PROMPT')
    expect(cmd).not.toContain('--session')
  })

  test('source-code-text grep: only the opencode spawn module constructs the `--session` CLI flag', () => {
    // Reading source files via fs keeps the test deterministic and immune to
    // refactors that might move the flag construction elsewhere. We match
    // `cmd.push('--session'` specifically — comments mentioning `--session`
    // for documentation are fine and expected (scheduler narrates which
    // sessionId it'll pass downstream). If a future refactor genuinely
    // needs scheduler to construct the CLI directly, update this test
    // deliberately — that's exactly when we want to re-think A12 / §C2.
    // RFC-111 PR-A: buildCommand moved out of runner.ts into the opencode
    // runtime driver — the argv-constructing module is now spawn.ts.
    const spawnSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runtime', 'opencode', 'spawn.ts'),
      'utf8',
    )
    const schedulerSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(spawnSrc).toMatch(/cmd\.push\(\s*['"]--session['"]/)
    expect(schedulerSrc).not.toMatch(/cmd\.push\(\s*['"]--session['"]/)
  })
})
