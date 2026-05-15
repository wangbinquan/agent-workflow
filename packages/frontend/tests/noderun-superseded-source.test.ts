// Source-level guard: if anyone reverts the noderun status display sites
// to render `{run.status}` / `{r.status}` directly, this test goes red.
// Locks the RFC-011 文案修正 from this commit — the status chip / Stats
// dd MUST go through `displayNoderunStatusKey` so a 'canceled' row
// produced by review iterate is rendered as "Superseded" instead of
// "Canceled" (when the worktree was kept).
//
// We assert at the source level rather than via render snapshots because
// these components have heavy props / React-Query dependencies that the
// drawer test infra doesn't yet stub out — a textual lock is the cheapest
// regression net per CLAUDE.md test-with-every-change.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const here = (p: string) => resolve(import.meta.dirname, '..', p)

describe('NodeDetailDrawer.tsx renders status through displayNoderunStatusKey', () => {
  const src = readFileSync(here('src/components/NodeDetailDrawer.tsx'), 'utf8')

  test('imports the helper', () => {
    expect(src).toContain("from '@/lib/noderun-status'")
    expect(src).toContain('displayNoderunStatusKey')
  })

  test('Stats tab dd uses displayNoderunStatusKey, not raw run.status', () => {
    // The friendly call must be present.
    expect(src).toContain('t(displayNoderunStatusKey(run))')
    // And the raw `<dd>{run.status}</dd>` site must be gone.
    expect(src).not.toContain('<dd>{run.status}</dd>')
  })

  test('retries history chip uses displayNoderunStatusKey, not raw r.status', () => {
    expect(src).toContain('t(displayNoderunStatusKey(r))')
    // The retries list rendered `{r.status}` inside a `<span class=status-chip>`
    // — that text must be gone.
    expect(src).not.toMatch(/status-chip[^>]*>\s*\{r\.status\}/)
  })
})

describe('tasks.detail.tsx NodeRunsTable renders status through displayNoderunStatusKey', () => {
  const src = readFileSync(here('src/routes/tasks.detail.tsx'), 'utf8')

  test('imports the helper', () => {
    expect(src).toContain("from '@/lib/noderun-status'")
    expect(src).toContain('displayNoderunStatusKey')
  })

  test('status column uses displayNoderunStatusKey, not raw r.status', () => {
    expect(src).toContain('t(displayNoderunStatusKey(r))')
    expect(src).not.toMatch(/status-chip[^>]*>\s*\{r\.status\}/)
  })

  test('error column hides raw errorMessage when row is supersede/rollback', () => {
    expect(src).toContain("classifyCanceled(r) === 'manual'")
  })
})
