// RFC-198 — the fusion approval flow keeps its mutation/dialog semantics while
// adopting the shared page/state chrome. This source-level lock is intentional:
// the route's behavior is covered by backend fusion tests and rendering the
// full detail requires the production router plus DiffViewer environment.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SOURCE = readFileSync(
  resolve(import.meta.dirname, '../src/routes/fusions.detail.tsx'),
  'utf8',
)

describe('RFC-198 fusion detail UX', () => {
  test('uses shared header, loading/error retry, and running feedback', () => {
    expect(SOURCE).toContain("<PageHeader title={t('fusion.detailTitle')} />")
    expect(SOURCE).toContain("title={t('fusion.detailTitle')}")
    expect(SOURCE).toContain('error={fusion.error}')
    expect(SOURCE).toContain('fusion.refetch()')
    expect(SOURCE).toContain('fusion.data === undefined && fusion.error')
    expect(SOURCE).toContain('<LoadingState />')
    expect(SOURCE).toContain('<NoticeBanner')
    expect(SOURCE).toContain('tone="info"')
    expect(SOURCE).not.toContain('<header className="page__header')
  })

  test('preserves approval, rejection, cancel, and diff ownership', () => {
    expect(SOURCE).toContain('approve.mutate()')
    expect(SOURCE).toContain('reject.mutate()')
    expect(SOURCE).toContain('cancel.mutateAsync()')
    expect(SOURCE).toContain('<DiffViewer')
    expect(SOURCE).toContain('<Dialog')
  })

  test('historical provenance never links a reused name to a current same-name skill', () => {
    expect(SOURCE).toContain('<span>{f.skillName}</span>')
    expect(SOURCE).not.toContain('to="/skills/$name"')
  })
})
