// Locks the RFC-099 audit (2026-07-15) fix: logout must wipe client-side
// private state so a SHARED browser doesn't leak the previous account's data
// to the next person who logs in. React Query caches (resource lists/details,
// ACL member lists, task data) and the IDB answer drafts are keyed WITHOUT the
// account id, so with stale-while-revalidate the next login briefly renders the
// prior user's private data before the refetch 403s. logout() must clear both.
// If this goes red, logout stopped clearing the cache / drafts.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const src = readFileSync(resolve(__dirname, '..', 'src/components/UserMenu.tsx'), 'utf8')

describe('logout clears client-side private state', () => {
  test('clears the React Query cache', () => {
    expect(src).toMatch(/queryClient\.clear\(\)/)
  })

  test('clears the IDB clarify + review answer drafts', () => {
    expect(src).toContain('clearAllClarifyDrafts')
    expect(src).toContain('clearAllReviewDrafts')
  })
})
