// RFC-105 — source-level guards.
//
// Pin the wiring so a future refactor that silently drops the preview route,
// re-forks the worktree fetch, reintroduces the dead /api/config-for-plantuml
// chain, or stops routing PlantUML through the proxy shows up as a red test.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

describe('RFC-105 WP-A — preview route + wiring', () => {
  test('router registers tasks.preview BEFORE taskDetail', () => {
    const r = read('src/router.tsx')
    expect(r).toContain('tasks.preview')
    const prev = r.indexOf('taskPreviewRoute')
    const detail = r.indexOf('taskDetailRoute,')
    expect(prev).toBeGreaterThan(-1)
    expect(detail).toBeGreaterThan(prev)
  })

  test('preview route reuses Prose, not a second markdown renderer', () => {
    const route = read('src/routes/tasks.preview.tsx')
    expect(route).toContain("from '@/components/prose/Prose'")
    expect(route).toContain('<PageHeader')
    expect(route).toContain('<Prose')
    expect(route).toContain('<RetryAction onRetry={() => void q.refetch()} />')
    expect(route).not.toContain('<div className="error-box" data-testid="md-preview-invalid">')
    // No bespoke react-markdown instance in the preview route.
    expect(route).not.toContain('react-markdown')
  })

  test('worktree fetch is single-sourced in api/worktreeFiles', () => {
    expect(read('src/routes/tasks.preview.tsx')).toContain("from '@/api/worktreeFiles'")
    expect(read('src/components/WorktreeFilesPanel.tsx')).toContain("from '@/api/worktreeFiles'")
    expect(read('src/api/worktreeFiles.ts')).toContain('worktreeFileResponseSchema')
  })

  test('both wiring points use buildPreviewTarget with a testid', () => {
    const out = read('src/components/TaskOutputPanel.tsx')
    expect(out).toContain('buildPreviewTarget')
    expect(out).toContain('task-output-preview')
    const wt = read('src/components/WorktreeFilesPanel.tsx')
    expect(wt).toContain('buildPreviewTarget')
    expect(wt).toContain('worktree-files-preview-btn')
  })
})

describe('RFC-105 WP-B — PlantUML proxy + dead config chain removed', () => {
  test('PlantUmlBlock exposes renderViaProxy and CodeBlock uses it', () => {
    expect(read('src/components/review/PlantUmlBlock.tsx')).toContain('renderViaProxy')
    expect(read('src/components/prose/CodeBlock.tsx')).toContain('PlantUmlBlock.renderViaProxy')
  })

  test('Prose / makeCode no longer thread plantuml endpoint + auth', () => {
    expect(read('src/components/prose/Prose.tsx')).not.toContain('plantumlEndpoint')
    expect(read('src/components/prose/Prose.tsx')).not.toContain('plantumlAuthHeader')
    const code = read('src/components/prose/CodeBlock.tsx')
    expect(code).not.toContain('plantumlEndpoint')
    expect(code).not.toContain('plantumlAuthHeader')
  })

  test('review surfaces no longer fetch /api/config solely for plantuml', () => {
    for (const f of [
      'src/components/review/ReviewDocPane.tsx',
      'src/components/review/MultiDocReviewView.tsx',
      'src/routes/reviews.detail.tsx',
    ]) {
      const src = read(f)
      expect(src).not.toContain('plantumlEndpoint')
      expect(src).not.toContain('plantumlAuthHeader')
    }
    // The config query (only ever for plantuml) is gone from both review hosts.
    expect(read('src/components/review/MultiDocReviewView.tsx')).not.toContain(
      "queryKey: ['config']",
    )
    expect(read('src/routes/reviews.detail.tsx')).not.toContain("queryKey: ['config']")
  })
})
