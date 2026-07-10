// RFC-066 — locks the StartTaskSchema extension that accepts a `repos: [...]`
// array as an alternative to the legacy top-level `repoPath` / `repoUrl`
// fields. Legacy body parsing must stay byte-for-byte equivalent (RFC-024
// baseline). Mixing legacy fields with `repos[]` is rejected with the stable
// `start-task-source-conflict` code so the route can branch on it.

import { describe, expect, test } from 'bun:test'
import { MULTI_REPO_MAX, StartTaskRepoSchema, StartTaskSchema } from '../src/schemas/task'

describe('StartTaskSchema multi-repo (RFC-066)', () => {
  // S1: legacy body still parses (byte-baseline guard for RFC-024 callers).
  test('S1 legacy single-repo body via top-level repoPath parses', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      inputs: {},
    })
    expect(r.success).toBe(true)
  })

  // S2: v2 body with a single repo entry parses.
  test('S2 v2 single-entry repos[] parses', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repos: [{ repoPath: '/tmp/repo', baseBranch: 'main' }],
      inputs: {},
    })
    expect(r.success).toBe(true)
  })

  test('S2b v2 multi-entry repos[] parses', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repos: [
        { repoPath: '/tmp/repo-a', baseBranch: 'main' },
        { repoPath: '/tmp/repo-b', baseBranch: 'main' },
        { repoUrl: 'git@github.com:foo/bar.git', ref: 'develop' },
      ],
      inputs: {},
    })
    expect(r.success).toBe(true)
  })

  // S3: mixing legacy + v2 → reject with stable code.
  test('S3 rejects legacy repoPath alongside repos[]', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      repos: [{ repoPath: '/tmp/repo-b', baseBranch: 'main' }],
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message === 'start-task-source-conflict')).toBe(true)
    }
  })

  test('S3b rejects legacy repoUrl alongside repos[]', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repoUrl: 'git@github.com:foo/bar.git',
      repos: [{ repoPath: '/tmp/repo', baseBranch: 'main' }],
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message === 'start-task-source-conflict')).toBe(true)
    }
  })

  // S4: each v2 entry must obey path/url mutex (delegated to StartTaskRepoSchema).
  test('S4 rejects v2 entry with both repoPath and repoUrl', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repos: [
        {
          repoPath: '/tmp/repo',
          baseBranch: 'main',
          repoUrl: 'git@github.com:foo/bar.git',
        },
      ],
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => /mutually exclusive/.test(i.message))).toBe(true)
    }
  })

  test('S4b rejects v2 entry missing both repoPath and repoUrl', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repos: [{ baseBranch: 'main' }],
      inputs: {},
    })
    expect(r.success).toBe(false)
  })

  test('S4c rejects v2 path-mode entry missing baseBranch', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repos: [{ repoPath: '/tmp/repo' }],
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /baseBranch is required in path mode/.test(i.message)),
      ).toBe(true)
    }
  })

  // S5: empty repos[] also rejected (min(1) Zod constraint).
  test('S5 rejects empty repos[]', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repos: [],
      inputs: {},
    })
    expect(r.success).toBe(false)
  })

  // S6: more than MULTI_REPO_MAX entries → reject.
  test('S6 rejects repos[] longer than MULTI_REPO_MAX', () => {
    const repos = Array.from({ length: MULTI_REPO_MAX + 1 }, (_, i) => ({
      repoPath: `/tmp/repo-${i}`,
      baseBranch: 'main',
    }))
    const r = StartTaskSchema.safeParse({ workflowId: 'wf-1', name: 'task', repos, inputs: {} })
    expect(r.success).toBe(false)
  })

  test('S6b accepts repos[] of exactly MULTI_REPO_MAX', () => {
    const repos = Array.from({ length: MULTI_REPO_MAX }, (_, i) => ({
      repoPath: `/tmp/repo-${i}`,
      baseBranch: 'main',
    }))
    const r = StartTaskSchema.safeParse({ workflowId: 'wf-1', name: 'task', repos, inputs: {} })
    expect(r.success).toBe(true)
  })

  // S7: literal constant lock — guards against silent budget changes.
  test('S7 MULTI_REPO_MAX is exactly 8', () => {
    expect(MULTI_REPO_MAX).toBe(8)
  })

  // S8: bare StartTaskRepoSchema parses standalone entries (consumers / tests).
  test('S8 StartTaskRepoSchema accepts a single valid path entry', () => {
    const r = StartTaskRepoSchema.safeParse({ repoPath: '/tmp/repo', baseBranch: 'main' })
    expect(r.success).toBe(true)
  })

  test('S8b StartTaskRepoSchema accepts a valid url entry without ref', () => {
    const r = StartTaskRepoSchema.safeParse({ repoUrl: 'git@github.com:foo/bar.git' })
    expect(r.success).toBe(true)
  })

  // S9: missing both repos[] and legacy fields → reject (still required to source somewhere).
  test('S9 rejects body without legacy fields and without repos[]', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      // RFC-165: message unified to the machine code `start-task-source-required`
      // (scratch joined the source union; prose message retired with path mode).
      expect(r.error.issues.some((i) => i.message === 'start-task-source-required')).toBe(true)
    }
  })
})
