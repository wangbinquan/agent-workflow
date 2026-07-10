// RFC-159 (edit-config) — `bodyToRepoSources` reverses a stored StartTask launch
// body back into the launcher's `RepoSource[]` so the scheduled-task edit-config
// form can pre-fill the repo picker. This is the assertable seam behind the launch
// form's edit mode; if it goes red the edit form will mis-seed the repo rows.
//
// The round-trip cases (forward via buildLaunchBody* then inverse) are the load
// bearing guard: a schedule's payload was ORIGINALLY built by those helpers, so
// inverse(forward(x)) must equal x for the repo shape.
//
// RFC-165: sources are URL-only. A legacy path-mode payload (only reachable on
// a schedule the boot healer disabled) degrades to a blank URL row for repair.

import { describe, expect, test } from 'vitest'
import {
  bodyToRepoSources,
  buildLaunchBody,
  buildLaunchBodyMultiRepo,
  defaultRepoSource,
  type RepoSource,
} from '@/lib/launch-repo-source'

describe('bodyToRepoSources — legacy single-repo bodies', () => {
  test('url body → one url source, ref defaults to empty', () => {
    expect(bodyToRepoSources({ repoUrl: 'git@h:o/r.git' })).toEqual([
      { kind: 'url', repoUrl: 'git@h:o/r.git', ref: '' },
    ])
  })

  test('url body with ref preserves ref', () => {
    expect(bodyToRepoSources({ repoUrl: 'git@h:o/r.git', ref: 'v1.2' })).toEqual([
      { kind: 'url', repoUrl: 'git@h:o/r.git', ref: 'v1.2' },
    ])
  })

  test('RFC-165: retired path body → blank URL row for repair', () => {
    expect(bodyToRepoSources({ repoPath: '/r', baseBranch: 'main' })).toEqual([defaultRepoSource()])
  })
})

describe('bodyToRepoSources — multi-repo bodies', () => {
  test('repos[] → one source per entry', () => {
    expect(
      bodyToRepoSources({
        repos: [{ repoUrl: 'git@h:o/b.git', ref: 'dev' }, { repoUrl: 'git@h:o/c.git' }],
      }),
    ).toEqual([
      { kind: 'url', repoUrl: 'git@h:o/b.git', ref: 'dev' },
      { kind: 'url', repoUrl: 'git@h:o/c.git', ref: '' },
    ])
  })

  test('RFC-165: retired path entry degrades to a blank URL row (position kept)', () => {
    expect(
      bodyToRepoSources({
        repos: [{ repoPath: '/a', baseBranch: 'main' }, { repoUrl: 'git@h:o/b.git' }],
      }),
    ).toEqual([defaultRepoSource(), { kind: 'url', repoUrl: 'git@h:o/b.git', ref: '' }])
  })
})

describe('bodyToRepoSources — fallback', () => {
  test('empty / unrecognized body → one default empty URL row (fresh form)', () => {
    expect(bodyToRepoSources({})).toEqual([defaultRepoSource()])
  })
})

describe('bodyToRepoSources — round-trips through the forward builders', () => {
  test('single url: inverse(buildLaunchBody(src)) === [src]', () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@h:o/r.git', ref: 'main' }
    const body = buildLaunchBody(src, { workflowId: 'wf', name: 'n', inputs: {} })
    expect(bodyToRepoSources(body)).toEqual([src])
  })

  test('multi-repo: inverse(buildLaunchBodyMultiRepo(repos)) === repos', () => {
    const repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'git@h:o/a.git', ref: 'main' },
      { kind: 'url', repoUrl: 'git@h:o/b.git', ref: 'dev' },
    ]
    const body = buildLaunchBodyMultiRepo(repos, { workflowId: 'wf', name: 'n', inputs: {} })
    expect(bodyToRepoSources(body)).toEqual(repos)
  })
})
