// Guard: every e2e call of the shipped binary's CLI carries RELEASE_CLI_TIMEOUT_MS.
//
// WHY THIS EXISTS
// ---------------
// `runCommandResult` kills a child at the generic 15 s fixture fence. A call of the
// release binary boots it, resolves the embedded migrations and opens an isolated
// SQLite home first; on a saturated macOS runner that alone can take longer, and the
// killed call returns no output at all. CI 38601555205 (macOS e2e shard 1): OPS-022
// in e2e/ops-local-recovery.spec.ts read an empty `auth password-login status` and
// failed, then passed on retry. The CLI suites now share one sized budget
// (e2e/command.ts); a new spec that drops it would reintroduce the same flake.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const E2E_DIR = resolve(import.meta.dir, '..', '..', '..', 'e2e')

/** Each `runCommandResult(defaultBinaryPath(), …)` call with its options text. */
function releaseCliCalls(source: string): string[] {
  const calls: string[] = []
  const opener = /runCommandResult\(\s*defaultBinaryPath\(\)/g
  for (const match of source.matchAll(opener)) {
    let depth = 0
    let end = match.index
    for (let i = match.index; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1
      if (source[i] === ')') depth -= 1
      if (depth === 0 && source[i] === ')') {
        end = i + 1
        break
      }
    }
    calls.push(source.slice(match.index, end))
  }
  return calls
}

describe('e2e calls of the shipped CLI are budgeted for a cold release binary', () => {
  test('every call passes RELEASE_CLI_TIMEOUT_MS', () => {
    const calls = readdirSync(E2E_DIR)
      .filter((name) => name.endsWith('.ts'))
      .sort()
      .flatMap((name) =>
        releaseCliCalls(readFileSync(join(E2E_DIR, name), 'utf8')).map((call) => ({
          name,
          call,
        })),
      )
    expect(calls.length).toBeGreaterThanOrEqual(5)
    expect(
      calls
        .filter(({ call }) => !/timeoutMs:\s*RELEASE_CLI_TIMEOUT_MS\b/.test(call))
        .map(({ name }) => name),
      'pass `timeoutMs: RELEASE_CLI_TIMEOUT_MS` (e2e/command.ts)',
    ).toEqual([])
  })

  test('the scan finds a whole call, including a nested options object', () => {
    const source = [
      'const a = runCommandResult(defaultBinaryPath(), args, {',
      '  env: { AGENT_WORKFLOW_HOME: home, ...f(x) },',
      '  timeoutMs: RELEASE_CLI_TIMEOUT_MS,',
      '})',
      'const b = runCommandResult(defaultBinaryPath(), args, { env: {} })',
    ].join('\n')
    const calls = releaseCliCalls(source)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('timeoutMs: RELEASE_CLI_TIMEOUT_MS')
    expect(calls[1]).toBe('runCommandResult(defaultBinaryPath(), args, { env: {} })')
  })
})
