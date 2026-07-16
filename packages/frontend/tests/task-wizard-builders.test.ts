// LOCKS: RFC-165 T13 (§11.23) — the /tasks/new wizard's three body builders,
// the scratch space stamping, the scheduled-payload envelope and the inverse
// seed mapping. Every wire field is asserted EXPLICITLY (RFC-125 lesson:
// whitelist builders silently drop what nobody asserts).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import type { Task } from '@agent-workflow/shared'
import {
  SPACE_KIND_LS_KEY,
  buildAgentStartBody,
  buildScheduledEnvelope,
  buildWorkflowStartBody,
  buildWorkflowStartFormData,
  buildWorkgroupStartBody,
  defaultWizardSpace,
  normalizeSeededInput,
  payloadToWizardSeed,
  snapshotClarifyState,
  taskToLaunchPayload,
  type WizardSpace,
} from '../src/lib/task-wizard'
import type { WorkflowInput } from '@agent-workflow/shared'

const REMOTE: WizardSpace = {
  kind: 'remote',
  repos: [{ kind: 'url', repoUrl: 'https://github.com/o/r.git', ref: 'dev' }],
}
const MULTI: WizardSpace = {
  kind: 'remote',
  repos: [
    { kind: 'url', repoUrl: 'https://github.com/o/a.git', ref: '' },
    { kind: 'url', repoUrl: 'https://github.com/o/b.git', ref: 'v2' },
  ],
}
const SCRATCH: WizardSpace = { kind: 'scratch' }

describe('buildWorkflowStartBody (RFC-165 T13)', () => {
  test('remote single repo: every field lands', () => {
    const body = buildWorkflowStartBody(REMOTE, {
      workflowId: 'wf1',
      name: 'T',
      inputs: { k: 'v' },
      gitUserName: 'bot',
      gitUserEmail: 'bot@x.io',
      workingBranch: 'feat/x',
      autoCommitPush: true,
      collaboratorUserIds: ['u1'],
      maxDurationMs: 60_000,
      maxTotalTokens: 5000,
    })
    expect(body).toEqual({
      workflowId: 'wf1',
      name: 'T',
      inputs: { k: 'v' },
      repoUrl: 'https://github.com/o/r.git',
      ref: 'dev',
      gitUserName: 'bot',
      gitUserEmail: 'bot@x.io',
      workingBranch: 'feat/x',
      autoCommitPush: true,
      collaboratorUserIds: ['u1'],
      maxDurationMs: 60_000,
      maxTotalTokens: 5000,
    })
  })

  test('remote multi repo: repos[] shape, no top-level repoUrl', () => {
    const body = buildWorkflowStartBody(MULTI, { workflowId: 'wf1', name: 'T', inputs: {} })
    expect(body.repos).toEqual([
      { repoUrl: 'https://github.com/o/a.git' },
      { repoUrl: 'https://github.com/o/b.git', ref: 'v2' },
    ])
    expect(body.repoUrl).toBeUndefined()
  })

  test('scratch: scratch=true, NO repo fields, strips workingBranch/autoCommitPush', () => {
    const body = buildWorkflowStartBody(SCRATCH, {
      workflowId: 'wf1',
      name: 'T',
      inputs: { k: 'v' },
      gitUserName: 'bot',
      gitUserEmail: 'bot@x.io',
      // Lingering remote-mode state — the builder must strip these (schema
      // rejects them with scratch: true).
      workingBranch: 'feat/x',
      autoCommitPush: true,
      collaboratorUserIds: ['u1'],
      maxTotalTokens: 42,
    })
    expect(body).toEqual({
      workflowId: 'wf1',
      name: 'T',
      inputs: { k: 'v' },
      scratch: true,
      gitUserName: 'bot',
      gitUserEmail: 'bot@x.io',
      collaboratorUserIds: ['u1'],
      maxTotalTokens: 42,
    })
  })

  test('blank optionals stay off the wire', () => {
    const body = buildWorkflowStartBody(REMOTE, { workflowId: 'wf1', name: 'T', inputs: {} })
    expect(body).toEqual({
      workflowId: 'wf1',
      name: 'T',
      inputs: {},
      repoUrl: 'https://github.com/o/r.git',
      ref: 'dev',
    })
  })
})

describe('buildWorkflowStartFormData', () => {
  test('scratch + uploads: payload blob carries scratch body, upload keys padded', async () => {
    const fd = buildWorkflowStartFormData(
      SCRATCH,
      { workflowId: 'wf1', name: 'T', inputs: {} },
      { report: [new File(['x'], 'r.txt')] },
    )
    const blob = fd.get('payload') as Blob
    const body = JSON.parse(await blob.text()) as Record<string, unknown>
    expect(body.scratch).toBe(true)
    expect(body.repoUrl).toBeUndefined()
    expect(body.inputs).toEqual({ report: '' })
    expect(fd.getAll('files[report][]')).toHaveLength(1)
  })

  // RFC-175 impl-gate F4: an upload-bearing workflow relaunch routes through the
  // multipart submit, which must still carry the expectedWorkflowVersion OCC
  // guard (the JSON path spreads it separately). The `extra` arg is merged into
  // the payload JSON AFTER the whitelisting builder, so it survives to the wire.
  test('extra guards are merged into the payload blob (survive the field whitelist)', async () => {
    const fd = buildWorkflowStartFormData(
      SCRATCH,
      { workflowId: 'wf1', name: 'T', inputs: {} },
      {},
      { expectedWorkflowVersion: 7 },
    )
    const body = JSON.parse(await (fd.get('payload') as Blob).text()) as Record<string, unknown>
    expect(body.expectedWorkflowVersion).toBe(7)
    expect(body.workflowId).toBe('wf1')
  })

  test('no extra arg → payload carries no guard key (JSON path / normal launch)', async () => {
    const fd = buildWorkflowStartFormData(SCRATCH, { workflowId: 'wf1', name: 'T', inputs: {} }, {})
    const body = JSON.parse(await (fd.get('payload') as Blob).text()) as Record<string, unknown>
    expect('expectedWorkflowVersion' in body).toBe(false)
  })
})

describe('buildAgentStartBody', () => {
  test('remote: description + optionals; workflowId/inputs never leak', () => {
    const body = buildAgentStartBody(REMOTE, {
      name: 'T',
      description: 'fix the bug',
      allowClarify: true,
      gitUserName: 'bot',
      gitUserEmail: 'bot@x.io',
      workingBranch: 'feat/x',
      autoCommitPush: true,
      collaboratorUserIds: ['u1'],
      maxDurationMs: 1000,
      maxTotalTokens: 2000,
    })
    expect(body).toEqual({
      name: 'T',
      description: 'fix the bug',
      repoUrl: 'https://github.com/o/r.git',
      ref: 'dev',
      gitUserName: 'bot',
      gitUserEmail: 'bot@x.io',
      workingBranch: 'feat/x',
      autoCommitPush: true,
      collaboratorUserIds: ['u1'],
      maxDurationMs: 1000,
      maxTotalTokens: 2000,
    })
  })

  test('allowClarify: true (schema default) stays off the wire; false is stamped', () => {
    const on = buildAgentStartBody(SCRATCH, { name: 'T', description: 'd', allowClarify: true })
    expect('allowClarify' in on).toBe(false)
    const off = buildAgentStartBody(SCRATCH, { name: 'T', description: 'd', allowClarify: false })
    expect(off.allowClarify).toBe(false)
  })

  test('scratch: scratch=true and no branch/auto-push', () => {
    const body = buildAgentStartBody(SCRATCH, {
      name: 'T',
      description: 'd',
      allowClarify: true,
      workingBranch: 'x',
      autoCommitPush: true,
    })
    expect(body).toEqual({ name: 'T', description: 'd', scratch: true })
  })
})

describe('buildWorkgroupStartBody', () => {
  test('remote multi: goal + repos + limits land; workflowId/inputs never leak', () => {
    const body = buildWorkgroupStartBody(MULTI, {
      name: 'T',
      goal: 'ship it',
      collaboratorUserIds: ['u1', 'u2'],
      maxDurationMs: 5,
      maxTotalTokens: 6,
    })
    expect(body).toEqual({
      name: 'T',
      goal: 'ship it',
      repos: [
        { repoUrl: 'https://github.com/o/a.git' },
        { repoUrl: 'https://github.com/o/b.git', ref: 'v2' },
      ],
      collaboratorUserIds: ['u1', 'u2'],
      maxDurationMs: 5,
      maxTotalTokens: 6,
    })
  })

  test('scratch: scratch=true only', () => {
    const body = buildWorkgroupStartBody(SCRATCH, { name: 'T', goal: 'g' })
    expect(body).toEqual({ name: 'T', goal: 'g', scratch: true })
  })
})

describe('buildScheduledEnvelope (RFC-165 §9b)', () => {
  test('workflow: body passes through (workflowId is the discriminant)', () => {
    const body = { workflowId: 'wf1', name: 'T' }
    expect(buildScheduledEnvelope('workflow', body, {})).toEqual(body)
  })
  test('agent: agentName is injected', () => {
    expect(buildScheduledEnvelope('agent', { name: 'T' }, { agentName: 'auditor' })).toEqual({
      agentName: 'auditor',
      name: 'T',
    })
  })
  test('workgroup: workgroupName is injected', () => {
    expect(buildScheduledEnvelope('workgroup', { name: 'T' }, { workgroupName: 'core' })).toEqual({
      workgroupName: 'core',
      name: 'T',
    })
  })

  test('RFC-199 T6.6: workflow schedules strip the point-in-time version guard', () => {
    expect(
      buildScheduledEnvelope(
        'workflow',
        { workflowId: 'wf1', name: 'T', expectedWorkflowVersion: 7 },
        {},
      ),
    ).toEqual({ workflowId: 'wf1', name: 'T' })
  })
})

describe('payloadToWizardSeed (editScheduled backfill)', () => {
  test('workflow payload round-trips through the builder', () => {
    const body = buildWorkflowStartBody(REMOTE, {
      workflowId: 'wf1',
      name: 'T',
      inputs: { k: 'v' },
      workingBranch: 'feat/x',
      autoCommitPush: true,
      maxDurationMs: 9,
    })
    const seed = payloadToWizardSeed('workflow', body)
    expect(seed).not.toBeNull()
    expect(seed?.workflowId).toBe('wf1')
    expect(seed?.taskName).toBe('T')
    expect(seed?.inputs).toEqual({ k: 'v' })
    expect(seed?.space).toEqual(REMOTE)
    expect(seed?.workingBranch).toBe('feat/x')
    expect(seed?.autoCommitPush).toBe(true)
    expect(seed?.maxDurationMs).toBe(9)
  })

  test('agent scratch payload round-trips (allowClarify=false preserved)', () => {
    const body = buildAgentStartBody(SCRATCH, { name: 'T', description: 'd', allowClarify: false })
    const seed = payloadToWizardSeed(
      'agent',
      buildScheduledEnvelope('agent', body, { agentName: 'a1' }),
    )
    expect(seed?.agentName).toBe('a1')
    expect(seed?.description).toBe('d')
    expect(seed?.allowClarify).toBe(false)
    expect(seed?.space).toEqual({ kind: 'scratch' })
  })

  test('workgroup payload round-trips', () => {
    const body = buildWorkgroupStartBody(REMOTE, { name: 'T', goal: 'g', maxTotalTokens: 7 })
    const seed = payloadToWizardSeed(
      'workgroup',
      buildScheduledEnvelope('workgroup', body, { workgroupName: 'core' }),
    )
    expect(seed?.workgroupName).toBe('core')
    expect(seed?.goal).toBe('g')
    expect(seed?.maxTotalTokens).toBe(7)
    expect(seed?.space).toEqual(REMOTE)
  })

  test('missing discriminant → null (degraded/legacy row renders blank for repair)', () => {
    expect(payloadToWizardSeed('workflow', { name: 'T' })).toBeNull()
    expect(payloadToWizardSeed('agent', { name: 'T', description: 'd' })).toBeNull()
    expect(payloadToWizardSeed('workgroup', { name: 'T', goal: 'g' })).toBeNull()
  })

  test('legacy path-only payload degrades to one blank URL row', () => {
    const seed = payloadToWizardSeed('workflow', { workflowId: 'wf1', name: 'T', repoPath: '/x' })
    expect(seed?.space).toEqual(defaultWizardSpace('remote'))
  })
})

describe('loadSpaceKindPref — default SCRATCH with sticky remote opt-in (用户 2026-07-11)', () => {
  test('unset preference defaults to scratch; explicit remote survives', async () => {
    const { loadSpaceKindPref, saveSpaceKindPref } = await import('../src/lib/task-wizard')
    window.localStorage.removeItem(SPACE_KIND_LS_KEY)
    expect(loadSpaceKindPref()).toBe('scratch')
    saveSpaceKindPref('remote')
    expect(loadSpaceKindPref()).toBe('remote')
    saveSpaceKindPref('scratch')
    expect(loadSpaceKindPref()).toBe('scratch')
  })
})

// LOCKS: RFC-175 §3 — the relaunch reconstruction: a terminal task's persisted
// fields → a payloadToWizardSeed-compatible launch payload, and the 3-state
// clarify inference. Every field asserted explicitly (RFC-125 lesson).
describe('RFC-175 §3 — snapshotClarifyState + taskToLaunchPayload', () => {
  const task = (o: Partial<Task>): Task =>
    ({
      name: 'my task',
      workflowId: 'wf-1',
      spaceKind: 'remote',
      repos: [],
      inputs: {},
      gitUserName: null,
      gitUserEmail: null,
      workingBranch: null,
      autoCommitPush: false,
      maxDurationMs: null,
      maxTotalTokens: null,
      sourceAgentName: null,
      sourceAgentId: null,
      workgroupId: null,
      workgroupName: null,
      goal: null,
      workflowSnapshot: null,
      ...o,
    }) as unknown as Task

  const repo = (repoUrl: string | null, baseBranch = 'main') =>
    ({ repoUrl, baseBranch, repoIndex: 0 }) as never

  test('snapshotClarifyState: true / false / unknown', () => {
    expect(snapshotClarifyState({ nodes: [{ kind: 'clarify' }] })).toBe(true)
    expect(snapshotClarifyState({ nodes: [{ kind: 'agent-single' }] })).toBe(false)
    expect(snapshotClarifyState({ nodes: [] })).toBe(false)
    expect(snapshotClarifyState(null)).toBe('unknown')
    expect(snapshotClarifyState({})).toBe('unknown') // no nodes array
    expect(snapshotClarifyState({ nodes: 'x' })).toBe('unknown')
    expect(snapshotClarifyState('not-an-object')).toBe('unknown')
  })

  test('workflow task → workflowId + inputs + remote repos', () => {
    const { payload, spaceResolvable } = taskToLaunchPayload(
      task({
        workflowId: 'wf-9',
        inputs: { topic: 'orders' },
        repos: [repo('https://x/r.git', 'dev')],
      }),
    )
    expect(spaceResolvable).toBe(true)
    expect(payload.workflowId).toBe('wf-9')
    expect(payload.name).toBe('my task')
    expect(payload.inputs).toEqual({ topic: 'orders' })
    expect(payload.repos).toEqual([{ repoUrl: 'https://x/r.git', ref: 'dev' }])
    expect(payload.agentName).toBeUndefined()
    expect(payload.workgroupName).toBeUndefined()
  })

  test('agent task → agentName + description(inputs.description) + 3-state allowClarify', () => {
    const withClarify = taskToLaunchPayload(
      task({
        sourceAgentName: 'auditor',
        inputs: { description: 'fix it' },
        spaceKind: 'scratch',
        workflowSnapshot: { nodes: [{ kind: 'clarify' }] },
      }),
    ).payload
    expect(withClarify.agentName).toBe('auditor')
    expect(withClarify.description).toBe('fix it')
    expect(withClarify.scratch).toBe(true)
    expect(withClarify.allowClarify).toBeUndefined() // present ⇒ omit (defaults true)

    const noClarify = taskToLaunchPayload(
      task({
        sourceAgentName: 'auditor',
        inputs: { description: 'x' },
        workflowSnapshot: { nodes: [{ kind: 'agent-single' }] },
      }),
    ).payload
    expect(noClarify.allowClarify).toBe(false) // provably absent ⇒ false

    const unknownClarify = taskToLaunchPayload(
      task({ sourceAgentName: 'a', inputs: { description: 'x' }, workflowSnapshot: null }),
    ).payload
    expect(unknownClarify.allowClarify).toBeUndefined() // broken ⇒ omit, not false
  })

  test('workgroup task → workgroupName + goal', () => {
    const { payload } = taskToLaunchPayload(
      task({ workgroupId: 'g-1', workgroupName: 'squad', goal: 'ship it' }),
    )
    expect(payload.workgroupName).toBe('squad')
    expect(payload.goal).toBe('ship it')
    expect(payload.workflowId).toBeUndefined()
  })

  test('advanced fields: git identity pair-gated, workingBranch, autoCommitPush, limits', () => {
    const { payload } = taskToLaunchPayload(
      task({
        gitUserName: 'A',
        gitUserEmail: 'a@b.c',
        workingBranch: 'feat/x',
        autoCommitPush: true,
        maxDurationMs: 60000,
        maxTotalTokens: 5000,
        repos: [repo('https://x/r.git')],
      }),
    )
    expect(payload.gitUserName).toBe('A')
    expect(payload.gitUserEmail).toBe('a@b.c')
    expect(payload.workingBranch).toBe('feat/x')
    expect(payload.autoCommitPush).toBe(true)
    expect(payload.maxDurationMs).toBe(60000)
    expect(payload.maxTotalTokens).toBe(5000)
    // Half-set git identity → neither field on the wire.
    expect(taskToLaunchPayload(task({ gitUserName: 'A' })).payload.gitUserName).toBeUndefined()
  })

  test('spaceResolvable: internal / empty-local false; scratch / url-local true', () => {
    expect(taskToLaunchPayload(task({ spaceKind: 'internal' })).spaceResolvable).toBe(false)
    expect(
      taskToLaunchPayload(task({ spaceKind: 'local', repos: [repo(null)] })).spaceResolvable,
    ).toBe(false)
    expect(taskToLaunchPayload(task({ spaceKind: 'scratch' })).spaceResolvable).toBe(true)
    expect(
      taskToLaunchPayload(task({ spaceKind: 'local', repos: [repo('file:///r')] })).spaceResolvable,
    ).toBe(true)
  })

  // RFC-175 §5/§6.10 — regression lock: the workgroup relaunch must NOT deep-link
  // a bare { kind: 'workgroup' } (which lands on an empty form). All three relaunch
  // entry links carry ?relaunchFrom=<taskId> for full-parameter pre-fill.
  test('tasks.detail relaunch links carry relaunchFrom, not bare kind:workgroup', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '../src/routes/tasks.detail.tsx'), 'utf-8')
    expect(src).not.toMatch(/search=\{\{\s*kind:\s*'workgroup'\s*\}\}/)
    expect(src).toContain('relaunchFrom: tk.id')
  })

  test('round-trip: taskToLaunchPayload → payloadToWizardSeed reconstructs wizard state', () => {
    const { payload } = taskToLaunchPayload(
      task({
        sourceAgentName: 'auditor',
        inputs: { description: 'do the thing' },
        spaceKind: 'remote',
        repos: [repo('https://x/r.git', 'dev')],
        workflowSnapshot: { nodes: [{ kind: 'agent-single' }] },
        maxDurationMs: 1000,
      }),
    )
    const seed = payloadToWizardSeed('agent', payload)
    expect(seed).not.toBeNull()
    expect(seed!.agentName).toBe('auditor')
    expect(seed!.description).toBe('do the thing')
    expect(seed!.allowClarify).toBe(false)
    expect(seed!.space).toEqual({
      kind: 'remote',
      repos: [{ kind: 'url', repoUrl: 'https://x/r.git', ref: 'dev' }],
    })
    expect(seed!.maxDurationMs).toBe(1000)
  })

  test('impl-gate F2 (re-review): only a worktree-creation failure → space unresolvable; scheduler failures stay resolvable', () => {
    const wtFail = 'worktree creation failed: repo[1] (b) failed: repo-clone-failed'
    // Materialize/worktree failure → repo list may be a truncated prefix; refuse replay.
    expect(
      taskToLaunchPayload(
        task({
          spaceKind: 'remote',
          repos: [repo('https://x/a.git')],
          status: 'failed',
          errorSummary: wtFail,
        }),
      ).spaceResolvable,
    ).toBe(false)
    // Scheduler failure (snapshot-invalid): failedNodeId null but COMPLETE space → resolvable.
    expect(
      taskToLaunchPayload(
        task({
          spaceKind: 'remote',
          repos: [repo('https://x/a.git')],
          status: 'failed',
          failedNodeId: null,
          errorSummary: 'snapshot-invalid',
        }),
      ).spaceResolvable,
    ).toBe(true)
    // Node failure (complete space) → resolvable.
    expect(
      taskToLaunchPayload(
        task({
          spaceKind: 'remote',
          repos: [repo('https://x/a.git')],
          status: 'failed',
          failedNodeId: 'node-7',
          errorSummary: 'boom',
        }),
      ).spaceResolvable,
    ).toBe(true)
    // Non-failed terminal (canceled) even with the marker → resolvable (it ran).
    expect(
      taskToLaunchPayload(
        task({
          spaceKind: 'remote',
          repos: [repo('https://x/a.git')],
          status: 'canceled',
          errorSummary: wtFail,
        }),
      ).spaceResolvable,
    ).toBe(true)
    // Scratch worktree failure has no repos to drop → still trivially resolvable.
    expect(
      taskToLaunchPayload(task({ spaceKind: 'scratch', status: 'failed', errorSummary: wtFail }))
        .spaceResolvable,
    ).toBe(true)
  })

  test('impl-gate F3: normalizeSeededInput validates enum values against current choices', () => {
    const en = (o: Record<string, unknown>): WorkflowInput =>
      ({ key: 'k', kind: 'enum', ...o }) as unknown as WorkflowInput
    // single-select: keep a live choice, drop a since-removed one
    expect(normalizeSeededInput(en({ choices: ['a', 'b'] }), 'a')).toBe('a')
    expect(normalizeSeededInput(en({ choices: ['a', 'b'] }), 'gone')).toBe('')
    // allowOther: any value survives
    expect(normalizeSeededInput(en({ choices: ['a'], allowOther: true }), 'freeform')).toBe(
      'freeform',
    )
    // multiSelect: keep live members, drop removed, re-serialize
    expect(
      normalizeSeededInput(en({ choices: ['a', 'b', 'c'], multiSelect: true }), '["a","x","c"]'),
    ).toBe('["a","c"]')
    // multiSelect all-removed → cleared; unparseable → cleared
    expect(normalizeSeededInput(en({ choices: ['a'], multiSelect: true }), '["x","y"]')).toBe('')
    expect(normalizeSeededInput(en({ choices: ['a'], multiSelect: true }), 'not-json')).toBe('')
    // re-review F3: multi + allowOther keeps arbitrary array members BUT still
    // enforces the array wire-format — a stale single-select scalar is cleared.
    expect(
      normalizeSeededInput(
        en({ multiSelect: true, allowOther: true, choices: ['a'] }),
        '["a","x"]',
      ),
    ).toBe('["a","x"]')
    expect(
      normalizeSeededInput(en({ multiSelect: true, allowOther: true, choices: ['a'] }), 'stale'),
    ).toBe('')
    // upload: always cleared (stale worktree path); text: passthrough
    expect(
      normalizeSeededInput({ key: 'k', kind: 'upload' } as unknown as WorkflowInput, '/wt/f.pdf'),
    ).toBe('')
    expect(normalizeSeededInput({ key: 'k', kind: 'text' } as unknown as WorkflowInput, 'hi')).toBe(
      'hi',
    )
  })

  // Source lock for the component-level impl-gate fixes (F1 fresh-fetch barrier,
  // F2 sourceReady non-empty gate + spaceResolvable consumption, F4 multipart guard).
  test('impl-gate F1/F2/F4 wiring locked in tasks.new.tsx', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '../src/routes/tasks.new.tsx'), 'utf-8')
    // F1: relaunch queries fetch fresh + barrier gates on this-mount SUCCESS
    // (re-review: isFetchedAfterMount alone accepts an errored refetch's stale data)
    expect(src).toContain("refetchOnMount: 'always'")
    expect(src).toContain('relaunchTaskQ.isFetchedAfterMount')
    expect(src).toContain('relaunchMembersQ.isFetchedAfterMount')
    expect(src).toContain('relaunchTaskQ.isSuccess')
    expect(src).toContain('relaunchMembersQ.isSuccess')
    // F1-followup: the members requirement is SOURCE-KIND-aware — a workgroup
    // relaunch (which never consumes members) must not block on a members fetch.
    expect(src).toContain('relaunchNeedsMembers')
    expect(src).toContain('taskExecutionKind(relaunchTaskQ.data)')
    // F1-followup-2: the SUBMIT gate keys off the reactive relaunchApplied flag
    // (set only after the seed effect passes its barrier), NOT relaunchTaskQ.isSuccess
    // — else a cached success opens a pre-seed submit window.
    expect(src).toContain('const relaunchReady = !isRelaunch || relaunchApplied')
    expect(src).toMatch(/relaunchSeededRef\.current = true[\s\S]{0,220}setRelaunchApplied\(true\)/)
    // F2: sourceReady requires a non-empty repo list (no vacuous `[].every()`)
    expect(src).toMatch(/space\.repos\.length > 0 &&[\s\S]*?space\.repos\.every/)
    // F2: the seed effect consumes spaceResolvable (does not discard it)
    expect(src).toContain('const { payload, spaceResolvable } = taskToLaunchPayload')
    // F4: the multipart submit threads immediateGuards() as the 4th arg
    expect(src).toMatch(/buildWorkflowStartFormData\([\s\S]*?immediateGuards\(\),/)
  })

  // Re-review F2: the space-unresolvable heuristic keys off the EXACT backend
  // errorSummary marker, so lock the two together — a change to the backend
  // emitter must red this test, not silently break the discriminator.
  test('impl-gate F2 marker is coupled to the backend worktree-creation errorSummary', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const backend = readFileSync(join(here, '../../backend/src/services/task.ts'), 'utf-8')
    expect(backend).toContain('worktree creation failed:')
    const wiz = readFileSync(join(here, '../src/lib/task-wizard.ts'), 'utf-8')
    expect(wiz).toContain("startsWith('worktree creation failed:')")
  })
})
