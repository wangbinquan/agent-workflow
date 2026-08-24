// RFC-165 T1 — shared launch-contract v2 locks.
//
// Locks in (design.md §11.1/.2/.13 + §2):
//   1. StartTaskSchema `scratch` superRefine matrix — scratch ⊕ every repo
//      source AND ⊕ workingBranch/autoCommitPush (schema layer of the
//      two-layer ban).
//   2. `rejectRetiredStartTaskKeys` raw-key rejection — non-strict zod
//      silently STRIPS unknown keys, so a mixed body like
//      `{scratch:true, repoPath}` would silently degrade to a scratch launch
//      without this pre-parse gate (design F1).
//   3. `taskExecutionKind` — the single derivation point for a task's
//      execution subject (workgroup > agent > workflow); route guards, list
//      badges and sync guards all call this (flag-audit kind-scatter lesson).
//   4. `applySpaceFields` — the single space-field assembly point for
//      service-level candidates (startWorkgroupTask / startAgentTask), so a
//      schema-only space change can never be silently dropped by a hand-rolled
//      spread again (design F2; RFC-125 lesson). A source-text lock pins
//      workgroupLaunch.ts to it.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applySpaceFields,
  rejectRetiredStartTaskKeys,
  StartTaskSchema,
  StartWorkgroupTaskSchema,
  taskExecutionKind,
} from '@agent-workflow/shared'

const BASE = { workflowId: 'wf-1', name: 'task', inputs: {} }

function firstMessage(body: Record<string, unknown>): string | null {
  const r = StartTaskSchema.safeParse(body)
  if (r.success) return null
  return r.error.issues[0]?.message ?? '(no issue)'
}

describe('RFC-165 T1 — StartTaskSchema scratch matrix', () => {
  test('scratch-only body is valid', () => {
    const r = StartTaskSchema.safeParse({ ...BASE, scratch: true })
    expect(r.success).toBe(true)
  })

  test('scratch:false behaves like absent (source still required)', () => {
    expect(firstMessage({ ...BASE, scratch: false })).toBe('start-task-source-required')
  })

  // NOTE: `scratch + repoPath` is NOT a schema-level conflict — repoPath left
  // the schema entirely in Phase C, so zod strips it before superRefine can
  // see it. Mixed retired-key bodies are caught BEFORE the schema by the
  // route-level rejectRetiredStartTaskKeys gate (covered below).
  const sourceConflicts: Array<[string, Record<string, unknown>]> = [
    ['scratch + repoUrl', { scratch: true, repoUrl: 'https://example.com/a.git' }],
    ['scratch + ref', { scratch: true, ref: 'main' }],
    // RFC-248 T32: `repos[]` 退役后，多仓侧的 scratch 冲突源变成 repoGroupId。
    ['scratch + repoGroupId', { scratch: true, repoGroupId: '01JQ0000000000000000000000' }],
  ]
  for (const [label, extra] of sourceConflicts) {
    test(`rejects ${label} → scratch-source-conflict`, () => {
      expect(firstMessage({ ...BASE, ...extra })).toBe('scratch-source-conflict')
    })
  }

  const remoteOnlyOptions: Array<[string, Record<string, unknown>]> = [
    ['scratch + workingBranch', { scratch: true, workingBranch: 'feat/x' }],
    ['scratch + autoCommitPush:true', { scratch: true, autoCommitPush: true }],
    // Explicit false still names the option — schema bans the KEY, the UI
    // hides the control entirely in scratch mode (two-layer ban).
    ['scratch + autoCommitPush:false', { scratch: true, autoCommitPush: false }],
  ]
  for (const [label, extra] of remoteOnlyOptions) {
    test(`rejects ${label} → scratch-remote-only-option`, () => {
      expect(firstMessage({ ...BASE, ...extra })).toBe('scratch-remote-only-option')
    })
  }

  test('scratch + retired git identity → client-owned field rejection', () => {
    const body = { ...BASE, scratch: true, gitUserName: 'Alice' }
    expect(rejectRetiredStartTaskKeys(body)).toBe('gitUserName')
    expect(firstMessage(body)).toBe('task-git-identity-client-owned')
  })

  test('scratch + retired git email is rejected regardless of value validity', () => {
    const body = { ...BASE, scratch: true, gitUserEmail: 'alice@example.test' }
    expect(rejectRetiredStartTaskKeys(body)).toBe('gitUserEmail')
    expect(firstMessage(body)).toBe('task-git-identity-client-owned')
  })

  test('scratch coexists with collaborators / limits', () => {
    const r = StartTaskSchema.safeParse({
      ...BASE,
      scratch: true,
      collaboratorUserIds: ['u1'],
      maxDurationMs: 60_000,
      maxTotalTokens: 1000,
    })
    expect(r.success).toBe(true)
  })

  test('empty body still fails with start-task-source-required', () => {
    expect(firstMessage({ ...BASE })).toBe('start-task-source-required')
  })

  test('url mode unaffected by scratch field addition', () => {
    const r = StartTaskSchema.safeParse({ ...BASE, repoUrl: 'https://example.com/a.git' })
    expect(r.success).toBe(true)
  })
})

describe('RFC-165 T1 — rejectRetiredStartTaskKeys (raw-key gate)', () => {
  test('clean v2 bodies pass', () => {
    expect(rejectRetiredStartTaskKeys({ ...BASE, scratch: true })).toBe(null)
    expect(rejectRetiredStartTaskKeys({ ...BASE, repoUrl: 'x', ref: 'main' })).toBe(null)
    // RFC-248 T32: 多仓的 clean 形态改成 repoGroupId——`repos[]` 自己退役了。
    expect(rejectRetiredStartTaskKeys({ ...BASE, repoGroupId: 'grp_1' })).toBe(null)
  })

  test('non-object inputs are ignored (route-level schema rejects them anyway)', () => {
    expect(rejectRetiredStartTaskKeys(null)).toBe(null)
    expect(rejectRetiredStartTaskKeys('repoPath')).toBe(null)
    expect(rejectRetiredStartTaskKeys(42)).toBe(null)
  })

  test('top-level retired keys are named', () => {
    expect(rejectRetiredStartTaskKeys({ repoPath: '/tmp/x' })).toBe('repoPath')
    expect(rejectRetiredStartTaskKeys({ baseBranch: 'main' })).toBe('baseBranch')
    expect(rejectRetiredStartTaskKeys({ fetchBeforeLaunch: true })).toBe('fetchBeforeLaunch')
    // RFC-248 T32: `repos[]` 加入退役名单。它曾是唯一的多仓入口，如果只是从
    // schema 里删掉（非 strict ⇒ 未知键静默丢弃），老调用方会「成功」启动一个
    // **单仓/scratch** 任务——正是 RFC-165 F1 要防的静默降级。
    expect(rejectRetiredStartTaskKeys({ repos: [{ repoUrl: 'x' }] })).toBe('repos')
  })

  test('MIXED bodies are caught — the silent-degrade shapes from design F1', () => {
    // Without the raw gate these all parse "successfully" with the retired
    // key stripped: {scratch,repoPath} → scratch launch, {repoUrl,baseBranch}
    // → default-ref URL launch, nested row repoPath → URL row.
    expect(rejectRetiredStartTaskKeys({ ...BASE, scratch: true, repoPath: '/tmp/x' })).toBe(
      'repoPath',
    )
    expect(rejectRetiredStartTaskKeys({ ...BASE, repoUrl: 'x', baseBranch: 'dev' })).toBe(
      'baseBranch',
    )
    // RFC-248 T32: 顶层 `repos` 先于任何行内键命中——嵌套扫描随 `repos[]` 一起
    // 删除了（整个数组都进不来，再逐行报 `repos[1].repoPath` 是死代码）。
    expect(
      rejectRetiredStartTaskKeys({
        ...BASE,
        repos: [{ repoUrl: 'x' }, { repoUrl: 'y', repoPath: '/tmp/y' }],
      }),
    ).toBe('repos')
    expect(
      rejectRetiredStartTaskKeys({ ...BASE, repoGroupId: 'g', repos: [{ repoUrl: 'x' }] }),
    ).toBe('repos')
  })

  test('key presence alone triggers (even undefined/null values)', () => {
    expect(rejectRetiredStartTaskKeys({ repoPath: undefined })).toBe('repoPath')
    expect(rejectRetiredStartTaskKeys({ repos: undefined })).toBe('repos')
    expect(rejectRetiredStartTaskKeys({ repos: null })).toBe('repos')
  })
})

describe('RFC-165 T1 — taskExecutionKind single derivation point', () => {
  const cases: Array<
    [
      string,
      { workgroupId?: string | null; sourceAgentName?: string | null },
      'workgroup' | 'agent' | 'workflow',
    ]
  > = [
    ['both null → workflow', { workgroupId: null, sourceAgentName: null }, 'workflow'],
    ['both absent → workflow', {}, 'workflow'],
    ['workgroupId set → workgroup', { workgroupId: 'wg1' }, 'workgroup'],
    ['sourceAgentName set → agent', { sourceAgentName: 'researcher' }, 'agent'],
    [
      'workgroup wins over agent (defensive precedence)',
      { workgroupId: 'wg1', sourceAgentName: 'researcher' },
      'workgroup',
    ],
    ['empty strings are not links', { workgroupId: '', sourceAgentName: '' }, 'workflow'],
  ]
  for (const [label, input, expected] of cases) {
    test(label, () => {
      expect(taskExecutionKind(input)).toBe(expected)
    })
  }
})

describe('RFC-165 T1 — applySpaceFields shared assembly point', () => {
  test('copies every present space field, skips absent ones', () => {
    const out = applySpaceFields(
      { workflowId: 'w', name: 'n' },
      { scratch: true, repoUrl: undefined, ref: undefined, repoGroupId: undefined },
    )
    expect(out).toEqual({ workflowId: 'w', name: 'n', scratch: true })
    const out2 = applySpaceFields(
      { workflowId: 'w' },
      // RFC-248: `repos[]` 已退役，多仓走 repoGroupId。
      { repoUrl: 'https://example.com/a.git', ref: 'dev', repoGroupId: 'g1' },
    )
    expect(out2.repoUrl).toBe('https://example.com/a.git')
    expect(out2.ref).toBe('dev')
    expect(out2.repoGroupId).toBe('g1')
    expect('scratch' in out2).toBe(false)
  })

  test('StartWorkgroupTaskSchema accepts scratch (shape-lenient passthrough)', () => {
    const r = StartWorkgroupTaskSchema.safeParse({
      name: 'wg task',
      goal: 'do the thing',
      scratch: true,
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.scratch).toBe(true)
  })

  test('source lock: workgroupLaunch composes its candidate via applySpaceFields', () => {
    // Anti-regression for design F2: a hand-rolled spread here is exactly how
    // RFC-125-style silent field drops happen. If this lock reds, wire the
    // candidate through applySpaceFields instead of deleting the assertion.
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'services', 'workgroup', 'launch.ts'),
      'utf8',
    )
    expect(src.includes('applySpaceFields(')).toBe(true)
    expect(src.includes('...(input.repoUrl !== undefined ? { repoUrl: input.repoUrl } : {})')).toBe(
      false,
    )
  })
})
