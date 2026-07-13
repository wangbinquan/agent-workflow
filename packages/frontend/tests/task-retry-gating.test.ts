// Gating predicates for the M3 Resume / Retry-node buttons (P-3-08 /
// P-3-09 wired into the UI). Both helpers exist so we can pin the
// behavior without mounting the full task-detail route — the backend
// API contract is exercised by the resume/retry service tests
// already; here we just make sure the UI doesn't offer the user a
// button that the API will 409 on.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { canOfferResume, resumeStatus } from '../src/routes/tasks.detail'
import { canRetryNodeRun } from '../src/components/NodeDetailDrawer'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

// The task-detail route is a giant runtime component; per this repo's idiom
// (rfc164-workgroup-tabs.test.ts) we pin the JSX wiring with source-level text
// assertions rather than mounting it. The pure-function tests above lock the
// DECISION; these lock that the button/hint are actually WIRED to it.
const DETAIL_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src/routes/tasks.detail.tsx'),
  'utf8',
)

describe('resumeStatus', () => {
  test('failed task with a worktree → ready', () => {
    expect(resumeStatus('failed', '/tmp/wt')).toBe('ready')
  })

  test('interrupted task with a worktree → ready (daemon-restart case)', () => {
    expect(resumeStatus('interrupted', '/tmp/wt')).toBe('ready')
  })

  test('failed task with empty worktreePath → worktree-missing (resume cannot recover)', () => {
    // This is the exact shape the demo-repo / no-commits failure had:
    // `git worktree add` blew up so worktreePath was never persisted.
    // The backend `resumeTask` is documented to "kick the scheduler
    // without re-creating the worktree" — so re-running would just
    // fail the same way. The UI must surface the alternate path.
    expect(resumeStatus('failed', '')).toBe('worktree-missing')
  })

  test('interrupted task with empty worktreePath → worktree-missing', () => {
    expect(resumeStatus('interrupted', '')).toBe('worktree-missing')
  })

  test('done task → not-resumable (nothing to resume)', () => {
    expect(resumeStatus('done', '/tmp/wt')).toBe('not-resumable')
  })

  test('running task → not-resumable (would race the live scheduler)', () => {
    expect(resumeStatus('running', '/tmp/wt')).toBe('not-resumable')
  })

  test('pending task → not-resumable', () => {
    expect(resumeStatus('pending', '/tmp/wt')).toBe('not-resumable')
  })

  test('canceled task → not-resumable (no resume API endpoint for canceled)', () => {
    expect(resumeStatus('canceled', '/tmp/wt')).toBe('not-resumable')
  })
})

// Regression: a failed TURN-ENGINE workgroup task (leader_worker / free_collab)
// used to show the Resume button, but POST /api/tasks/:id/resume 403s them —
// the builtin __workgroup_host__ anchor is read-only (assertTaskWorkflowNotBuiltin,
// locked by backend rfc167-dynamic-workflow-engine.test.ts). Clicking Resume
// surfaced "workflow is a built-in read-only resource". canOfferResume must gate
// the button on the workgroup dispatch mode so the UI never offers what the API
// refuses (this file's whole purpose per the header comment). Recovery for
// turn-engine groups is relaunch (RFC-164 §4.3/§12).
describe('canOfferResume', () => {
  const base = { status: 'failed' as const, worktreePath: '/tmp/wt' }

  test('failed plain-workflow task (not a workgroup) → offer resume', () => {
    expect(canOfferResume({ ...base, isWorkgroup: false, isDynamicWorkgroup: false })).toBe(true)
  })

  test('failed dynamic_workflow workgroup → offer resume (RFC-167 executing recovery)', () => {
    expect(canOfferResume({ ...base, isWorkgroup: true, isDynamicWorkgroup: true })).toBe(true)
  })

  test('failed turn-engine workgroup → NO resume (endpoint 403s builtin-readonly)', () => {
    expect(canOfferResume({ ...base, isWorkgroup: true, isDynamicWorkgroup: false })).toBe(false)
  })

  test('interrupted turn-engine workgroup → NO resume', () => {
    expect(
      canOfferResume({
        status: 'interrupted',
        worktreePath: '/tmp/wt',
        isWorkgroup: true,
        isDynamicWorkgroup: false,
      }),
    ).toBe(false)
  })

  test('workgroup with mode still loading (isDynamicWorkgroup=false) → NO resume (fail-safe)', () => {
    // Until the room config arrives a workgroup reads as turn-engine; hide the
    // button rather than flash one the API might refuse. A dynamic group
    // self-corrects to `true` one query later.
    expect(canOfferResume({ ...base, isWorkgroup: true, isDynamicWorkgroup: false })).toBe(false)
  })

  test('non-ready status never offers resume, workgroup mode notwithstanding', () => {
    expect(
      canOfferResume({ ...base, status: 'done', isWorkgroup: false, isDynamicWorkgroup: false }),
    ).toBe(false)
    expect(
      canOfferResume({ ...base, status: 'running', isWorkgroup: true, isDynamicWorkgroup: true }),
    ).toBe(false)
  })

  test('worktree-missing failed task never offers the resume button (hint handles it)', () => {
    expect(
      canOfferResume({
        status: 'failed',
        worktreePath: '',
        isWorkgroup: false,
        isDynamicWorkgroup: false,
      }),
    ).toBe(false)
  })
})

// Source-level wiring lock for the RFC-164/167 fix. canOfferResume above locks
// the decision; these lock that tasks.detail.tsx actually gates the Resume
// button on it (not the bare resumeStatus) and wires the turn-engine relaunch
// hint. A revert to `{resumability === 'ready' && (<button…resume/>)}` — the
// original bug that showed Resume on a turn-engine group whose /resume 403s —
// reds here even though the pure tests stay green.
describe('tasks.detail.tsx — resume button/hint wiring (source locks)', () => {
  test('the Resume button is gated on showResume := canOfferResume(...) with the workgroup flags', () => {
    expect(DETAIL_SRC).toMatch(/const showResume = canOfferResume\(\{/)
    expect(DETAIL_SRC).toMatch(/isWorkgroup,\s*\n\s*isDynamicWorkgroup,/)
    expect(DETAIL_SRC).toMatch(/\{showResume && \(/)
  })

  test('the Resume button is NOT gated directly on resumability alone (the original bug)', () => {
    // The buggy gate rendered the button whenever resumability was 'ready',
    // ignoring workgroup mode. `resumability === 'ready'` still legitimately
    // appears in the hint gate — what must be gone is it directly fronting the
    // <button> that fires resume.mutate().
    expect(DETAIL_SRC).not.toMatch(/\{resumability === 'ready' && \([\s\n]*<button/)
  })

  test('the turn-engine workgroup relaunch hint is wired (showWorkgroupResumeHint → resumeUnavailableWorkgroup)', () => {
    expect(DETAIL_SRC).toMatch(/const showWorkgroupResumeHint =[\s\S]*?!isDynamicWorkgroup/)
    expect(DETAIL_SRC).toMatch(/\{showWorkgroupResumeHint && \(/)
    expect(DETAIL_SRC).toMatch(/tasks\.resumeUnavailableWorkgroup/)
  })

  test('resumeUnavailableWorkgroup copy exists in both i18n bundles', () => {
    expect(enUS.tasks.resumeUnavailableWorkgroup.length).toBeGreaterThan(0)
    expect(zhCN.tasks.resumeUnavailableWorkgroup.length).toBeGreaterThan(0)
  })
})

describe('canRetryNodeRun', () => {
  test('failed run on a failed task → true', () => {
    expect(canRetryNodeRun('failed', 'failed')).toBe(true)
  })

  test('interrupted run on an interrupted task → true', () => {
    expect(canRetryNodeRun('interrupted', 'interrupted')).toBe(true)
  })

  test('exhausted run on a failed task → true (retries blown, fresh attempt OK)', () => {
    expect(canRetryNodeRun('exhausted', 'failed')).toBe(true)
  })

  test('canceled run on a canceled task → true (cancel/resume cycle)', () => {
    expect(canRetryNodeRun('canceled', 'canceled')).toBe(true)
  })

  test('failed run on a STILL-running task → false (API would 409 task-still-running)', () => {
    expect(canRetryNodeRun('failed', 'running')).toBe(false)
  })

  test('failed run on a pending task → false (scheduler is alive, would race)', () => {
    expect(canRetryNodeRun('failed', 'pending')).toBe(false)
  })

  test('done run on a done task → false (would redo finished work)', () => {
    expect(canRetryNodeRun('done', 'done')).toBe(false)
  })

  test('skipped run → false', () => {
    expect(canRetryNodeRun('skipped', 'done')).toBe(false)
  })

  test('running run → false (scheduler still owns it)', () => {
    expect(canRetryNodeRun('running', 'running')).toBe(false)
  })

  test('pending run → false', () => {
    expect(canRetryNodeRun('pending', 'failed')).toBe(false)
  })

  test('missing taskStatus → still gates on run (defensive)', () => {
    expect(canRetryNodeRun('failed', undefined)).toBe(true)
  })
})
