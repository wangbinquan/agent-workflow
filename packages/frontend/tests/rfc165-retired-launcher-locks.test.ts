// LOCKS: RFC-165 §11.26 (PR-3期) — the legacy launcher surfaces stay retired.
//
//   1. The two standalone launcher pages must NOT exist — /tasks/new is the
//      only launch surface; their URLs live on solely as router redirects.
//   2. The wizard's request-building layer never re-introduces the three
//      retired wire keys (repoPath / baseBranch / fetchBeforeLaunch). Scoped
//      to the builder modules, mirroring the backend's allowlist philosophy
//      (rfc165-banned-locks.test.ts) — display-only i18n copy is out of scope.
//   3. The router carries both redirects (old bookmarks keep working).

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = (rel: string) => resolve(import.meta.dirname, '..', 'src', rel)
const read = (rel: string) => readFileSync(SRC(rel), 'utf-8')

describe('RFC-165 §11.26 — retired launcher locks', () => {
  test('the standalone launcher pages are deleted', () => {
    expect(existsSync(SRC('routes/workflows.launch.tsx'))).toBe(false)
    expect(existsSync(SRC('routes/workgroups.launch.tsx'))).toBe(false)
  })

  test('wizard request builders never stamp the retired wire keys', () => {
    for (const rel of ['lib/task-wizard.ts', 'lib/launch-repo-source.ts', 'routes/tasks.new.tsx']) {
      const src = read(rel)
      // Allowed only inside comments describing the retirement — never as an
      // object key being stamped onto a body.
      expect(src).not.toMatch(/\brepoPath:\s/)
      expect(src).not.toMatch(/\bbaseBranch:\s/)
      expect(src).not.toMatch(/\bfetchBeforeLaunch\b/)
    }
  })

  test('router redirects both legacy URLs into the wizard', () => {
    const router = read('router.tsx')
    expect(router).toContain("path: '/workflows/$id/launch'")
    expect(router).toContain("path: '/workgroups/launch'")
    expect(router).toMatch(/redirect\(\{\s*\n?\s*to: '\/tasks\/new'/)
  })
})
