// RFC-304 — one `GitPort` double, so adding a verb costs one edit.
//
// Seven test files had grown their own inline fake. That is fine until the port
// gains a method, at which point all seven fail to compile at once and the
// temptation is to paste four no-op stubs into each — which is how a fake drifts
// from the interface it is standing in for. Here the defaults live in one place
// and a test overrides only the verb it cares about.
//
// The defaults are deliberately SUCCESSFUL and inert: a test that does not
// mention git is not testing git, and should not have to say so.

import type { GitPort } from '../../src/modules/code-capability/ports/gitPort'

export interface GitFakeOptions {
  /** What `fetchRef` resolves to; every test that anchors to a head sets this. */
  resolvedSha?: string
  /** What `commitWorktree` freezes to. */
  commitSha?: string
  /** What `readCommitDiff` returns. */
  diff?: string
}

export function createGitPortFake(
  options: GitFakeOptions = {},
  overrides: Partial<GitPort> = {},
): GitPort {
  const resolvedSha = options.resolvedSha ?? 'a'.repeat(40)
  const commitSha = options.commitSha ?? 'c'.repeat(40)

  const base: GitPort = {
    async fetchRef() {
      return { ok: true, resolvedSha }
    },
    async checkoutDetached() {
      return { ok: true }
    },
    async addDisposableWorktree() {
      return { ok: true }
    },
    async removeDisposableWorktree() {
      return { ok: true }
    },
    async commitWorktree() {
      return { ok: true, commitSha }
    },
    async readCommitDiff() {
      return { ok: true, diff: options.diff ?? '' }
    },
    async readWorktreeDiff() {
      return { ok: true, diff: options.diff ?? '' }
    },
    async pushCommit() {
      return { ok: true }
    },
    async deleteRef() {
      return { ok: true }
    },
  }

  return { ...base, ...overrides }
}
