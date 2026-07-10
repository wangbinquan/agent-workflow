// RFC-066 PR-C — pure-function coverage for the body builders that emit
// the v1 (legacy single-repo) vs v2 (multi-repo) launch shapes. Locks the
// wire contract:
//   - length 1 of `repos` semantically equivalent to legacy single-repo body
//   - length > 1 emits the v2 `repos: [...]` shape
//   - git identity helpers carry through the same pair-check semantics
//
// RFC-165: rows are URL-only — the path-mode fixtures and the RFC-068
// fetchBeforeLaunch carry-through went away with the local-path launch mode.

import { describe, expect, test } from 'vitest'
import {
  buildLaunchBody,
  buildLaunchBodyMultiRepo,
  computePreviewDirNames,
  defaultRepoSource,
  type RepoSource,
} from '@/lib/launch-repo-source'

describe('buildLaunchBodyMultiRepo (RFC-066)', () => {
  // F7: 1 row in v2 shape parses to repos:[{...}], NOT legacy top-level
  // repoUrl. Confirms the byte-distinct envelope.
  test('F7 single-entry v2 emits `repos:[...]` (NOT top-level repoUrl)', () => {
    const repos: RepoSource[] = [{ kind: 'url', repoUrl: 'git@h:o/r.git', ref: 'main' }]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
    })
    expect(body.repos).toEqual([{ repoUrl: 'git@h:o/r.git', ref: 'main' }])
    // The launch route ROUTES via buildLaunchBody (legacy) for length 1,
    // but builders themselves remain orthogonal; v2 wins when explicitly
    // called.
    expect('repoUrl' in body).toBe(false)
  })

  // F8: 2 rows → repos:[{...},{...}], legacy top-level fields absent.
  test('F8 multi-entry v2 emits `repos:[{}, {}]` with no legacy top-level fields', () => {
    const repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'git@github.com:org/a.git', ref: 'main' },
      { kind: 'url', repoUrl: 'git@github.com:org/b.git', ref: 'develop' },
    ]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
    })
    expect(body.repos).toEqual([
      { repoUrl: 'git@github.com:org/a.git', ref: 'main' },
      { repoUrl: 'git@github.com:org/b.git', ref: 'develop' },
    ])
    expect('repoUrl' in body).toBe(false)
    expect('ref' in body).toBe(false)
  })

  test('F8c url row with empty ref drops the `ref` key (mirrors single-repo helper)', () => {
    const repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'git@h:o/r.git', ref: '   ' },
      { kind: 'url', repoUrl: 'git@h:o/r2.git', ref: '' },
    ]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
    })
    const out = body.repos as Array<Record<string, unknown>>
    expect('ref' in out[0]!).toBe(false)
    expect('ref' in out[1]!).toBe(false)
  })

  // RFC-165: the retired path-mode keys must never appear — neither on the
  // top level nor inside rows.
  test('F8d v2 body carries none of the retired path-mode keys', () => {
    const repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'git@h:o/a.git', ref: '' },
      { kind: 'url', repoUrl: 'git@h:o/b.git', ref: 'main' },
    ]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
    })
    expect('fetchBeforeLaunch' in body).toBe(false)
    expect('repoPath' in body).toBe(false)
    expect('baseBranch' in body).toBe(false)
    for (const row of body.repos as Array<Record<string, unknown>>) {
      expect('repoPath' in row).toBe(false)
      expect('baseBranch' in row).toBe(false)
      expect('fetchBeforeLaunch' in row).toBe(false)
    }
  })

  // RFC-067: identity pair-check echoes single-repo helper.
  test('F8f both git identity fields set → carried through verbatim', () => {
    const repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'git@h:o/a.git', ref: '' },
      { kind: 'url', repoUrl: 'git@h:o/b.git', ref: '' },
    ]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
      gitUserName: 'AI Bot',
      gitUserEmail: 'bot@workflow.local',
    })
    expect(body.gitUserName).toBe('AI Bot')
    expect(body.gitUserEmail).toBe('bot@workflow.local')
  })

  test('F8g half-set git identity → both keys dropped (defense in depth)', () => {
    const repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'git@h:o/a.git', ref: '' },
      { kind: 'url', repoUrl: 'git@h:o/b.git', ref: '' },
    ]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
      gitUserName: 'Lonely',
      gitUserEmail: '',
    })
    expect('gitUserName' in body).toBe(false)
    expect('gitUserEmail' in body).toBe(false)
  })
})

describe('buildLaunchBody RFC-066 single-repo byte-baseline (regression lock)', () => {
  test('legacy url body unchanged', () => {
    const body = buildLaunchBody(
      { kind: 'url', repoUrl: 'git@h:o/r.git', ref: 'feature/x' },
      { workflowId: 'wf-1', name: 't', inputs: {} },
    )
    expect(body).toEqual({
      workflowId: 'wf-1',
      name: 't',
      repoUrl: 'git@h:o/r.git',
      inputs: {},
      ref: 'feature/x',
    })
    expect('repos' in body).toBe(false)
  })
})

describe('computePreviewDirNames (RFC-066)', () => {
  // F6: basename collision resolution mirrors backend resolveMultiRepoDirName.
  test('F6 same basename → -2 / -3 suffix', () => {
    const names = computePreviewDirNames([
      { kind: 'url', repoUrl: 'git@github.com:a/utils.git', ref: '' },
      { kind: 'url', repoUrl: 'git@github.com:b/utils.git', ref: '' },
      { kind: 'url', repoUrl: 'https://github.com/c/utils', ref: '' },
    ])
    expect(names).toEqual(['utils', 'utils-2', 'utils-3'])
  })

  test('F6b length 1 always returns [""] (no preview in single-repo mode)', () => {
    const names = computePreviewDirNames([
      { kind: 'url', repoUrl: 'git@github.com:a/utils.git', ref: '' },
    ])
    expect(names).toEqual([''])
  })

  test('F6c URL mode basename strips .git suffix', () => {
    const names = computePreviewDirNames([
      { kind: 'url', repoUrl: 'git@github.com:org/repo-a.git', ref: '' },
      { kind: 'url', repoUrl: 'https://github.com/org/repo-b', ref: '' },
    ])
    expect(names).toEqual(['repo-a', 'repo-b'])
  })

  test('F6d empty row → empty preview slot (UI suppresses chip)', () => {
    const names = computePreviewDirNames([
      { kind: 'url', repoUrl: 'git@github.com:a/utils.git', ref: '' },
      defaultRepoSource(),
    ])
    expect(names).toEqual(['utils', ''])
  })
})
