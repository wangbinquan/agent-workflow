// RFC-035 PR3 — source-level guard for the EmptyState / LoadingState
// rollout. Each retrofitted route MUST import + render the shared
// primitives instead of the bare `<div className="muted">` pattern.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

const RETROFITTED_ROUTES = [
  'routes/agents.tsx',
  'routes/skills.tsx',
  'routes/mcps.tsx',
  'routes/plugins.tsx',
  'routes/workflows.tsx',
  'routes/tasks.tsx',
  'routes/reviews.tsx',
  'routes/repos.tsx',
] as const

describe('RFC-035 EmptyState / LoadingState rollout', () => {
  for (const rel of RETROFITTED_ROUTES) {
    test(`${rel} renders <LoadingState> + <EmptyState>`, () => {
      const body = readFileSync(path.resolve(SRC, rel), 'utf8')
      expect(/<LoadingState[\s/>]/.test(body), `${rel} <LoadingState>`).toBe(true)
      expect(/<EmptyState[\s/>]/.test(body), `${rel} <EmptyState>`).toBe(true)
    })
  }

  test('home/InboxPreviewList.tsx renders the compact <EmptyState>', () => {
    const body = readFileSync(path.resolve(SRC, 'components/home/InboxPreviewList.tsx'), 'utf8')
    expect(/<EmptyState[\s\S]+?size="compact"/.test(body)).toBe(true)
  })

  test('retrofitted routes no longer render <div className="muted">{t(\'common.loading\')}</div>', () => {
    for (const rel of RETROFITTED_ROUTES) {
      const body = readFileSync(path.resolve(SRC, rel), 'utf8')
      expect(
        /<div className="muted">\{t\('common\.loading'\)\}<\/div>/.test(body),
        `${rel} contains the old loading pattern`,
      ).toBe(false)
    }
  })
})
