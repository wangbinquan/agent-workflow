// Regression lock for macOS WebKit nightly 31877441033: after moving a repo,
// the 350 ms preview debounce left Save briefly enabled against stale data.
// The preview refresh could then disable it between mousedown and click, so no
// POST was sent and the editor stayed open without an error.

import { describe, expect, test } from 'vitest'

import { isRepoGroupPreviewPending } from '@/components/repos/repoGroupPreviewState'

describe('repo-group preview freshness', () => {
  test('the debounce window is pending before the query starts fetching', () => {
    expect(isRepoGroupPreviewPending('current-nodes', 'previous-nodes', false)).toBe(true)
  })

  test('the matching preview remains pending while its request is in flight', () => {
    expect(isRepoGroupPreviewPending('current-nodes', 'current-nodes', true)).toBe(true)
  })

  test('only a settled preview for the exact current nodes is ready', () => {
    expect(isRepoGroupPreviewPending('current-nodes', 'current-nodes', false)).toBe(false)
  })
})
