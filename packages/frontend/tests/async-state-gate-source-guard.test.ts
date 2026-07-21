// RFC-214 PR-5 — 防漂移 source guards for the three-state primitives
// (<QueryState> + ErrorBanner.onRetry). See design/RFC-214-async-state-gate/
// and design.md §5.2. These are the RFC's "防未来不一致" ratchet, not a
// code-size measure: once the sweep收编 the hand-written retry buttons and
// muted empties, the guards keep a NEW one from silently reappearing.
//
// HONEST COVERAGE (documented blind spots — do not pretend otherwise):
//   * Lock A is a STRUCTURAL signal — it catches a hand-written `<button>`
//     whose onClick chains `.refetch()`. It does NOT catch icon-only retries,
//     <Trans>-wrapped retries, a brand-new i18n key, or `mutation.mutate()`
//     retries (those are a different affordance and out of scope). The
//     enforced contract is narrow but real: "no new hand-written refetch
//     <button>". Everything else routes through ErrorBanner.onRetry / QueryState.
//   * Lock B is a snapshot ratchet over hand-written `<div className="muted">`
//     query-empties. RFC-214 migrated the clean list-page cascades (home) and
//     收编 every retry button, but the remaining muted empties are bespoke /
//     inline (dialog pickers, side panels, tree stubs) that QueryState v1 does
//     not cleanly express. The allowlist grandfathers those and forbids growth:
//     a NEW clean list page must express its empty via QueryState.emptyText /
//     empty.
//   * canvas/** and NodeDetailDrawer.tsx are carved out (xyflow render
//     constraints / inline node-inspector placeholders), per design.md §5.2.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = path.resolve(import.meta.dirname, '../src')
const CARVE_OUT = /(^|\/)canvas\/|(^|\/)NodeDetailDrawer\.tsx$/

function walkTsx(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walkTsx(p))
    else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p)
  }
  return out
}
const rel = (p: string): string => path.relative(SRC, p).split(path.sep).join('/')
const FILES = walkTsx(SRC)
  .map((p) => ({ abs: p, rel: rel(p) }))
  .filter((f) => !CARVE_OUT.test(f.rel))

// Lock A: the only hand-written refetch buttons that survive by design.
//   - tasks.detail.tsx  — the room banner's compound "Details + retry" action
//     (two buttons, not a single retry → not an ErrorBanner.onRetry shape).
//   - CapabilityGrid.tsx — the deliberately low-key `.home-cap__error muted`
//     inline overlay strip (btn--xs, always-shown grid; not a三态 gate).
//   - reviews.tsx — the bespoke `reviews-version-error` inline strips.
const ALLOW_RETRY = new Set([
  'routes/tasks.detail.tsx',
  'components/home/CapabilityGrid.tsx',
  'routes/reviews.tsx',
])
const RETRY_BUTTON = /onClick=\{[^}]*\.refetch\(|onClick=\{[A-Za-z0-9_]+\.refetch\}/

// Lock B: grandfathered bespoke / inline muted query-empties (may shrink).
const ALLOW_EMPTY = new Set([
  'components/AclPanel.tsx',
  'components/WorktreeFilesPanel.tsx',
  'components/agents/NodeDependencyTreeSection.tsx',
  'components/fusion/FuseDialog.tsx',
  'components/mcps/McpInventoryPanel.tsx',
  'components/memory/distill-job-detail/SourceEventsList.tsx',
  'components/repos/BatchImportDialog.tsx',
  'components/tasks/TaskMembersPanel.tsx',
])
const MUTED_EMPTY =
  /className="muted">\{t\('(?!common\.empty')[^']*(?:[Ee]mpty|noMembers|noUsers|noEvents|noManaged|noSelectable|outputNone|noPorts|sourceDeleted)/

describe('RFC-214 async-state-gate source guards', () => {
  test('Lock A — a hand-written <button onClick refetch> lives only in the grandfathered bespoke banners', () => {
    const offenders = FILES.filter((f) => RETRY_BUTTON.test(readFileSync(f.abs, 'utf8')))
      .map((f) => f.rel)
      .filter((f) => !ALLOW_RETRY.has(f))
    expect(
      offenders,
      `New hand-written retry button(s). Route retry through ErrorBanner.onRetry / QueryState instead of a hand-written <button onClick={() => void x.refetch()}>:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  test('Lock A allowlist stays honest — every entry still carries the pattern', () => {
    for (const f of ALLOW_RETRY) {
      expect(
        RETRY_BUTTON.test(readFileSync(path.join(SRC, f), 'utf8')),
        `${f} no longer has a hand-written refetch button — remove it from ALLOW_RETRY.`,
      ).toBe(true)
    }
  })

  test('Lock B — a hand-written muted query-empty lives only in the grandfathered set', () => {
    const offenders = FILES.filter((f) => MUTED_EMPTY.test(readFileSync(f.abs, 'utf8')))
      .map((f) => f.rel)
      .filter((f) => !ALLOW_EMPTY.has(f))
    expect(
      offenders,
      `New hand-written muted empty. Express query empties through QueryState.emptyText / empty:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  test('the sanctioned homes exist and stay clean', () => {
    const errorBanner = readFileSync(path.join(SRC, 'components/ErrorBanner.tsx'), 'utf8')
    const queryState = readFileSync(path.join(SRC, 'components/QueryState.tsx'), 'utf8')
    expect(errorBanner).toContain('onRetry')
    expect(queryState).toContain('export function QueryState')
    // The primitives must NOT themselves contain a hand-written refetch button.
    expect(RETRY_BUTTON.test(errorBanner)).toBe(false)
  })
})
