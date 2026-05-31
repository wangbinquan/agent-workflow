// RFC-075: locks the optional `workingBranch` + `autoCommitPush` fields added
// to StartTaskSchema, the loose branch-name validator, the CommitPushMeta
// contract, and the NodeRun.commitPush / TaskRepo.workingBranch additions.
//
// Why this test exists: working branch + auto commit&push are two orthogonal,
// independently-toggled launch options. A regression that drops the validation
// or the wire contract would let a malformed branch name reach `git
// worktree add`, or silently disable the detail-page commit row.

import { describe, expect, test } from 'bun:test'
import {
  CommitPushMetaSchema,
  isLooseValidBranchName,
  NodeRunSchema,
  StartTaskSchema,
  TaskRepoSchema,
} from '../src/schemas/task'

const BASE = {
  workflowId: 'wf-1',
  name: 'fixture-task',
  repoPath: '/tmp/repo',
  baseBranch: 'main',
  inputs: {},
}

describe('StartTaskSchema RFC-075 workingBranch + autoCommitPush', () => {
  test('both omitted → ok, byte-identical to pre-RFC-075', () => {
    const r = StartTaskSchema.safeParse({ ...BASE })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.workingBranch).toBeUndefined()
      expect(r.data.autoCommitPush).toBeUndefined()
    }
  })

  test('valid working branch + autoCommitPush=true → ok, pass through', () => {
    const r = StartTaskSchema.safeParse({
      ...BASE,
      workingBranch: 'feature/refactor-auth',
      autoCommitPush: true,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.workingBranch).toBe('feature/refactor-auth')
      expect(r.data.autoCommitPush).toBe(true)
    }
  })

  test('autoCommitPush without a working branch → ok (independent toggles)', () => {
    const r = StartTaskSchema.safeParse({ ...BASE, autoCommitPush: true })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.autoCommitPush).toBe(true)
      expect(r.data.workingBranch).toBeUndefined()
    }
  })

  test('working branch without autoCommitPush → ok (independent toggles)', () => {
    const r = StartTaskSchema.safeParse({ ...BASE, workingBranch: 'wip/x' })
    expect(r.success).toBe(true)
  })

  const illegalBranches: Array<[string, string]> = [
    ['has space', 'feature/my branch'],
    ['double dot', 'feature/..hack'],
    ['leading slash', '/feature'],
    ['trailing slash', 'feature/'],
    ['double slash', 'feature//x'],
    ['tilde', 'feature~1'],
    ['caret', 'feature^'],
    ['colon', 'feat:x'],
    ['question mark', 'feat?'],
    ['ends with .lock', 'feature.lock'],
    ['leading dot', '.feature'],
    ['trailing dot', 'feature.'],
    ['just at-sign', '@'],
  ]
  for (const [label, branch] of illegalBranches) {
    test(`illegal working branch (${label}) → working-branch-invalid`, () => {
      const r = StartTaskSchema.safeParse({ ...BASE, workingBranch: branch })
      expect(r.success).toBe(false)
      if (!r.success) {
        const issue = r.error.issues.find((i) => i.message === 'working-branch-invalid')
        expect(issue).toBeDefined()
        expect(issue?.path).toEqual(['workingBranch'])
      }
    })
  }
})

describe('isLooseValidBranchName', () => {
  test('accepts ordinary names', () => {
    for (const ok of ['main', 'feature/x', 'release-1.2', 'a/b/c', 'fix_123']) {
      expect(isLooseValidBranchName(ok)).toBe(true)
    }
  })
  test('rejects illegal shapes', () => {
    for (const bad of ['a b', 'a..b', '/a', 'a/', 'a//b', 'a~', 'x.lock', '.x', 'x.', '@', '']) {
      expect(isLooseValidBranchName(bad)).toBe(false)
    }
  })
})

describe('CommitPushMetaSchema RFC-075', () => {
  const META = {
    repoPath: '/tmp/wt',
    repoBranch: 'feature/x',
    pushTarget: 'origin/feature/x',
    baseRef: 'main',
    commitSha: 'abc123',
    filesChanged: 3,
    insertions: 10,
    deletions: 2,
    messageSource: 'llm' as const,
    repairAttempts: 0,
    pushOutcome: 'pushed' as const,
    pushError: null,
  }

  test('round-trips a pushed commit row', () => {
    const r = CommitPushMetaSchema.safeParse(META)
    expect(r.success).toBe(true)
  })

  test('accepts every push outcome', () => {
    for (const outcome of [
      'pushed',
      'commit-local-auth',
      'commit-local-failed',
      'skipped-empty',
    ] as const) {
      expect(CommitPushMetaSchema.safeParse({ ...META, pushOutcome: outcome }).success).toBe(true)
    }
  })

  test('rejects an unknown push outcome', () => {
    expect(CommitPushMetaSchema.safeParse({ ...META, pushOutcome: 'bogus' }).success).toBe(false)
  })
})

describe('TaskRepoSchema.workingBranch default', () => {
  test('defaults to null when omitted', () => {
    const r = TaskRepoSchema.safeParse({
      repoIndex: 0,
      repoPath: '/tmp/repo',
      repoUrl: null,
      baseBranch: 'main',
      branch: 'agent-workflow/01ABC',
      baseCommit: null,
      worktreePath: '/tmp/wt',
      worktreeDirName: '',
      hasSubmodules: null,
      submoduleInitOk: null,
      submoduleInitError: null,
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.workingBranch).toBeNull()
  })
})

describe('NodeRunSchema.commitPush', () => {
  const RUN = {
    id: 'nr-1',
    taskId: 't-1',
    nodeId: '__commit_push__:agent-1',
    parentNodeRunId: 'nr-agent-1',
    iteration: 0,
    shardKey: null,
    retryIndex: 0,
    status: 'done' as const,
    startedAt: 1,
    finishedAt: 2,
    pid: null,
    exitCode: 0,
    errorMessage: null,
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokTotal: null,
    tokCacheCreate: null,
    tokCacheRead: null,
  }

  test('omitted commitPush parses (every regular node_run)', () => {
    const r = NodeRunSchema.safeParse({ ...RUN, nodeId: 'agent-1' })
    expect(r.success).toBe(true)
  })

  test('a commit node_run carries CommitPushMeta', () => {
    const r = NodeRunSchema.safeParse({
      ...RUN,
      commitPush: {
        repoPath: '/tmp/wt',
        repoBranch: 'agent-workflow/01ABC',
        pushTarget: 'origin/agent-workflow/01ABC',
        baseRef: 'main',
        commitSha: 'deadbeef',
        filesChanged: 1,
        insertions: 5,
        deletions: 0,
        messageSource: 'llm-repair',
        repairAttempts: 1,
        pushOutcome: 'pushed',
        pushError: null,
      },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.commitPush?.pushOutcome).toBe('pushed')
  })
})
