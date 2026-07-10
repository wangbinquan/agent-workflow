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
    ['scratch + repos[]', { scratch: true, repos: [{ repoUrl: 'https://example.com/a.git' }] }],
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

  test('scratch coexists with git identity / collaborators / limits', () => {
    const r = StartTaskSchema.safeParse({
      ...BASE,
      scratch: true,
      gitUserName: 'Alice',
      gitUserEmail: 'a@example.com',
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
    expect(rejectRetiredStartTaskKeys({ ...BASE, repos: [{ repoUrl: 'x' }] })).toBe(null)
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
    expect(
      rejectRetiredStartTaskKeys({
        ...BASE,
        repos: [{ repoUrl: 'x' }, { repoUrl: 'y', repoPath: '/tmp/y' }],
      }),
    ).toBe('repos[1].repoPath')
    expect(
      rejectRetiredStartTaskKeys({ ...BASE, repos: [{ repoUrl: 'x', baseBranch: 'dev' }] }),
    ).toBe('repos[0].baseBranch')
  })

  test('key presence alone triggers (even undefined/null values)', () => {
    expect(rejectRetiredStartTaskKeys({ repoPath: undefined })).toBe('repoPath')
    expect(rejectRetiredStartTaskKeys({ repos: [{ baseBranch: null }] })).toBe(
      'repos[0].baseBranch',
    )
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
      { scratch: true, repoUrl: undefined, ref: undefined, repos: undefined },
    )
    expect(out).toEqual({ workflowId: 'w', name: 'n', scratch: true })
    const out2 = applySpaceFields(
      { workflowId: 'w' },
      { repoUrl: 'https://example.com/a.git', ref: 'dev', repos: [{ repoUrl: 'x' }] },
    )
    expect(out2.repoUrl).toBe('https://example.com/a.git')
    expect(out2.ref).toBe('dev')
    expect(out2.repos).toEqual([{ repoUrl: 'x' }])
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
      join(import.meta.dir, '..', 'src', 'services', 'workgroupLaunch.ts'),
      'utf8',
    )
    expect(src.includes('applySpaceFields(')).toBe(true)
    expect(src.includes('...(input.repoUrl !== undefined ? { repoUrl: input.repoUrl } : {})')).toBe(
      false,
    )
  })
})
