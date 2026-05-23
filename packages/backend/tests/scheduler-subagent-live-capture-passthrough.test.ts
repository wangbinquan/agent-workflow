// RFC-048 — scheduler/runner passthrough source-level guard.
//
// Locks the data path that carries `config.subagentLiveCapture` from the
// HTTP / multipart route → StartTaskDeps → RunTaskOptions →
// runNode(opts.subagentLiveCapture). A runtime end-to-end already runs in
// runner-subagent-live-capture.test.ts; this file pins down the wire so a
// future refactor can't silently drop the field somewhere in the middle of
// the chain.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..', '..')

function read(p: string): string {
  return readFileSync(resolve(REPO, p), 'utf-8')
}

describe('RFC-048 subagentLiveCapture passthrough', () => {
  test('scheduler RunTaskOptions declares the field', () => {
    const src = read('packages/backend/src/services/scheduler.ts')
    expect(src).toContain(
      'subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }',
    )
  })

  test('scheduler forwards opts.subagentLiveCapture into runNode (every call site)', () => {
    const src = read('packages/backend/src/services/scheduler.ts')
    const matches = src.match(/subagentLiveCapture: opts\.subagentLiveCapture/g) ?? []
    // RFC-060 PR-D bumped this from 2 → 4: the existing agent-single +
    // agent-multi (fan-out) shard call sites remain, and the new
    // dispatchFanoutShard + dispatchFanoutAggregator call sites join the
    // forwarding chain. Future call sites should keep this lock in step.
    expect(matches.length).toBe(4)
  })

  test('StartTaskDeps declares the field and runTask receives it from every kick-off path', () => {
    const src = read('packages/backend/src/services/task.ts')
    expect(src).toContain(
      'subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }',
    )
    // Three runTask sites: startTask, resumeTask, retryNode — all must
    // forward the option (omitted when undefined so legacy callers keep
    // their existing behavior).
    const forwards = src.match(/subagentLiveCapture: deps\.subagentLiveCapture/g) ?? []
    const forwardsViaOpts = src.match(/subagentLiveCapture: opts\.deps\.subagentLiveCapture/g) ?? []
    expect(forwards.length + forwardsViaOpts.length).toBe(3)
  })

  test('routes/tasks.ts loads config.subagentLiveCapture and passes it to every startTask / resumeTask / retryNode call', () => {
    const src = read('packages/backend/src/routes/tasks.ts')
    expect(src).toContain('function resolveSubagentLiveCapture(')
    // Four call paths read the resolved value: POST /api/tasks JSON, POST
    // /api/tasks multipart (fallback + success), POST /api/tasks/:id/resume,
    // POST /api/tasks/:id/nodes/:nodeRunId/retry.
    const callCount = (src.match(/resolveSubagentLiveCapture\(deps\.configPath\)/g) ?? []).length
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  test('runner declares the option and falls back to compile-time defaults when omitted', () => {
    const src = read('packages/backend/src/services/runner.ts')
    expect(src).toContain(
      'subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }',
    )
    // The fallback chain — both literal defaults must be present so omitted
    // callers degrade to the same numbers the shared DEFAULT_SUBAGENT_LIVE_CAPTURE
    // const locks in.
    expect(src).toContain('opts.subagentLiveCapture?.pollMs ?? 1500')
    expect(src).toContain('opts.subagentLiveCapture?.consecutiveFailureLimit ?? 5')
  })
})
