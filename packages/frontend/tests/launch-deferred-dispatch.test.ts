// RFC-125 — the launch-time "defer question dispatch" toggle was REMOVED; all
// UI-launched tasks now default to deferred dispatch (the launch payload always
// sends `deferredQuestionDispatch: true`). This source-layer guard locks that the
// toggle (state + Switch + i18n) is gone and the payload hardcodes true. It keeps
// the TaskQuestionList §18 batch-dispatch wiring + board i18n parity assertions —
// the board is UNCHANGED by RFC-125 (those remain golden-locks).
//
// Why source-grep (not DOM): the launch route is expensive to mount (TanStack
// Router + Query + i18n); matching launch-working-branch.test.ts we assert on the
// source wiring invariants + i18n value parity.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildLaunchBody, buildLaunchBodyMultiRepo } from '../src/lib/launch-repo-source'

const LAUNCH_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'workflows.launch.tsx'),
  'utf-8',
)
const BOARD_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'components', 'tasks', 'TaskQuestionList.tsx'),
  'utf-8',
)
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')

describe('workflows.launch.tsx — RFC-125 deferred dispatch default-on (toggle removed)', () => {
  test('the launch-time defer toggle (state + Switch + i18n) is gone', () => {
    expect(LAUNCH_SRC).not.toMatch(/setDeferredQuestionDispatch/)
    expect(LAUNCH_SRC).not.toContain("t('launch.deferredDispatch.label')")
    expect(LAUNCH_SRC).not.toContain("t('launch.deferredDispatch.hint')")
  })

  test('submit payload always sends deferredQuestionDispatch: true (not a conditional spread)', () => {
    expect(LAUNCH_SRC).toMatch(/deferredQuestionDispatch:\s*true,/)
    expect(LAUNCH_SRC).not.toMatch(
      /deferredQuestionDispatch\s*\?\s*\{ deferredQuestionDispatch: true \}/,
    )
  })

  test('the launch.deferredDispatch i18n keys are removed (zh + en)', () => {
    expect(ZH).not.toContain("label: '问题延迟下发（任务中心批量处理）'")
    expect(EN).not.toContain("label: 'Defer question dispatch (batch from the task center)'")
  })
})

describe('TaskQuestionList.tsx — RFC-120 §18 batch-dispatch wiring (unchanged by RFC-125)', () => {
  test('posts to the dispatch endpoint with { entryIds }', () => {
    expect(BOARD_SRC).toMatch(/questions\/dispatch`, \{ entryIds \}/)
  })

  // RFC-133 (推翻 RFC-128 §11.1，用户 2026-07-02 拍板) — per-card selection is BACK: staged
  // cards carry a tq-select-* checkbox (default all-selected via the `excluded` inverse set),
  // 「下发所选 (N)」posts the SELECTED subset of the current view. The golden-lock
  // (no staged ⇒ no bar) is retained.
  test('RFC-133: per-card checkbox restored; the bar dispatches the SELECTED staged subset', () => {
    expect(BOARD_SRC).toMatch(/type="checkbox"/)
    expect(BOARD_SRC).toContain('tq-select-')
    // 下发所选：只发未被排除的 staged 条目 id
    expect(BOARD_SRC).toMatch(/stagedSelected\.map\(\(e\) => e\.id\)/)
    expect(BOARD_SRC).toMatch(/stagedSelected\.length === 0/)
    // action bar still only renders when there is at least one staged card
    expect(BOARD_SRC).toMatch(/stagedShown\.length > 0 &&/)
  })

  test('invalidates the task + node-runs queries on a successful dispatch', () => {
    expect(BOARD_SRC).toMatch(/invalidateQueries\(\{ queryKey: \['tasks', taskId\] \}\)/)
    expect(BOARD_SRC).toMatch(
      /invalidateQueries\(\{ queryKey: \['tasks', taskId, 'node-runs'\] \}\)/,
    )
  })

  test('treats task-question-target-changed as retryable (re-fetch + retry notice)', () => {
    expect(BOARD_SRC).toContain("err.code === 'task-question-target-changed'")
    expect(BOARD_SRC).toContain("t('taskQuestions.dispatchTargetChanged')")
  })
})

describe('i18n — RFC-120 batch-dispatch keys parity (board unchanged)', () => {
  test('zh-CN type declares taskQuestions batch keys', () => {
    expect(ZH).toContain('batchDispatch: string')
    expect(ZH).toContain('dispatchInFlight: string')
    expect(ZH).toContain('dispatchTargetChanged: string')
  })

  test('zh-CN board values present', () => {
    expect(ZH).toContain("batchDispatch: '批量下发'")
    expect(ZH).toContain("dispatchTargetChanged: '目标已变，请重试'")
  })

  test('en-US board values present', () => {
    expect(EN).toContain("batchDispatch: 'Batch dispatch'")
    expect(EN).toContain("dispatchTargetChanged: 'Target changed, please retry'")
  })
})

// RFC-125 Codex impl-gate P1 lock — the body helpers whitelist fields and DROP
// extras, so `launchCommon.deferredQuestionDispatch` was silently lost on the
// common single-repo (buildLaunchBody) + url-upload (V2 → buildLaunchBody) +
// multi-repo (buildLaunchBodyMultiRepo) paths, making UI launches non-deferred
// despite the removed toggle. These assert the flag reaches the WIRE per path.
describe('launch body helpers — RFC-125 propagate deferredQuestionDispatch onto the wire', () => {
  const common = { workflowId: 'wf', name: 't', inputs: {}, deferredQuestionDispatch: true }
  const pathSource = { kind: 'path' as const, repoPath: '/r', baseBranch: 'main' }

  test('buildLaunchBody (path) emits deferredQuestionDispatch: true', () => {
    expect(buildLaunchBody(pathSource, common).deferredQuestionDispatch).toBe(true)
  })

  test('buildLaunchBody (url) emits deferredQuestionDispatch: true', () => {
    const body = buildLaunchBody({ kind: 'url', repoUrl: 'https://x/r.git', ref: '' }, common)
    expect(body.deferredQuestionDispatch).toBe(true)
  })

  test('buildLaunchBodyMultiRepo emits deferredQuestionDispatch: true', () => {
    expect(buildLaunchBodyMultiRepo([pathSource], common).deferredQuestionDispatch).toBe(true)
  })

  test('omitted when common lacks it (programmatic / legacy non-deferred caller)', () => {
    const body = buildLaunchBody(pathSource, { workflowId: 'wf', name: 't', inputs: {} })
    expect(body.deferredQuestionDispatch).toBeUndefined()
  })
})
