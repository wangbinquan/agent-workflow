// RFC-066 PR-C — supplementary edge coverage for `computePreviewDirNames`
// (src/lib/launch-repo-source.ts:158). Locks the collision-loop behavior when
// a LITERAL already-suffixed basename (e.g. `utils-2`) lands in the same list
// as a row whose auto-generated `-2` suffix already claimed that exact name.
//
// Why this file exists: the existing F6/F6b/F6c/F6d cases in
// launch-buildbody-multi-repo.test.ts only exercise auto-suffixing of
// identical raws ([utils,utils,utils] -> utils/utils-2/utils-3) and distinct
// URL names — none feeds a literal pre-suffixed name that collides with an
// auto-suffix, and none collides a path basename against a URL trailing
// segment. This function explicitly mirrors the backend's
// `resolveMultiRepoDirName` (services/task.ts ~L361); a divergence here would
// silently show the user a wrong "Will mount as" preview chip. These tests pin
// the exact escalation point so any future refactor that breaks parity goes
// red.

import { describe, expect, test } from 'vitest'
import { computePreviewDirNames, type RepoSource } from '@/lib/launch-repo-source'

describe('computePreviewDirNames — literal pre-suffixed collisions (RFC-066)', () => {
  test('literal `utils-2` escalates to `utils-2-2` when an auto-suffix already took `utils-2`', () => {
    const repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'git@github.com:a/utils.git', ref: '' },
      { kind: 'url', repoUrl: 'git@github.com:b/utils.git', ref: '' },
      { kind: 'url', repoUrl: 'git@github.com:c/utils-2.git', ref: '' },
    ]
    // row1 'utils' free -> 'utils'; row2 'utils' taken -> 'utils-2';
    // row3 raw 'utils-2' is already taken by row2's auto-suffix -> 'utils-2-2'.
    expect(computePreviewDirNames(repos)).toEqual(['utils', 'utils-2', 'utils-2-2'])
  })

  test('SSH short form and HTTPS trailing segment (.git stripped) collide; second row gets `-2`', () => {
    const repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'https://github.com/x/repo', ref: '' },
      { kind: 'url', repoUrl: 'git@github.com:org/repo.git', ref: '' },
    ]
    // row1 trailing segment 'repo'; row2 strips '.git' + trailing segment ->
    // 'repo', collides -> 'repo-2'.
    expect(computePreviewDirNames(repos)).toEqual(['repo', 'repo-2'])
  })
})
