// RFC-214 PR-5 — 防漂移 source guards for the three-state primitives
// (<QueryState> + ErrorBanner.onRetry). See design/RFC-214-async-state-gate/
// and design.md §5.2. These are the RFC's "防未来不一致" ratchet, not a
// code-size measure: once the sweep收编 the hand-written retry buttons and
// muted empties, the guards keep a NEW one from silently reappearing.
//
// Impl-gate P3 (2026-07-22, Codex re-review) — the allowlists now pin an EXACT
// per-file OCCURRENCE COUNT, not a whole-file boolean. The prior boolean form let
// a grandfathered file grow a SECOND violation and stay green; a count that drifts
// UP (new violation in a listed file) OR DOWN (the listed one was removed — stale
// entry) now reds. Both locks carry a two-way honesty check.
//
// HONEST COVERAGE (documented blind spots — do not pretend otherwise):
//   * Lock A is a STRUCTURAL signal — it catches a hand-written `<button>`
//     whose onClick calls `refetch(` (member `x.refetch()` AND destructured bare
//     `refetch()`, impl-gate P1-1) or passes a refetch reference. It does NOT
//     catch icon-only retries, <Trans>-wrapped retries, a brand-new i18n key,
//     NAMED-HANDLER indirection (`onClick={doRetry}` where doRetry calls refetch),
//     `invalidateQueries`-style retries, or `mutation.mutate()` retries. Catching
//     those needs AST/data-flow, deferred to a "guard AST-ification" pass; the
//     enforced contract stays narrow-but-real: "no new hand-written refetch
//     <button>". (A retry CALLBACK passed as a prop — e.g. InboxDrawer's
//     `retry*={() => void x.refetch()}` feeding a child's ErrorBanner.onRetry —
//     is the SANCTIONED shape, not an escapee: it is the onRetry data source.)
//   * Lock B is a snapshot ratchet over hand-written `<div className="muted…">`
//     query-empties. Impl-gate P3: the regex now also fires on COMBINED classes
//     (`className="muted inventory-section__empty"`), not just the exact `"muted"`
//     — closing the escape Codex found (7 files). It still only fires on the
//     listed key vocabulary, so a brand-new key word stays a documented blind
//     spot. The allowlist grandfathers the bespoke/inline empties (dialog
//     pickers, side panels, tree stubs, in-data empty sections, wizard branches,
//     table empties) and forbids growth: a NEW clean list page must express its
//     empty via QueryState.emptyText / empty.
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

/** Count non-overlapping matches of a pattern's source in a file. */
function occurrences(content: string, source: string): number {
  return (content.match(new RegExp(source, 'g')) || []).length
}

// ---------------------------------------------------------------------------
// Lock A: hand-written refetch <button>. EXACT per-file occurrence allowlist.
//   - tasks.detail.tsx  — the room banner's compound "Details + retry" action.
//   - CapabilityGrid.tsx — the low-key `.home-cap__error muted` inline strip.
//   - reviews.tsx — the two bespoke `reviews-version-error` inline strips.
// ---------------------------------------------------------------------------
const ALLOW_RETRY = new Map<string, number>([
  ['routes/tasks.detail.tsx', 1],
  ['components/home/CapabilityGrid.tsx', 1],
  ['routes/reviews.tsx', 2],
])
// P1-1: member `x.refetch(` OR destructured bare `refetch(` / `refetch}` reference.
// `\b` cannot fire inside `prefetch` (`p` is a word char), so no false hit.
const RETRY_BUTTON = String.raw`onClick=\{[^}]*\brefetch\(|onClick=\{(?:[A-Za-z0-9_$]+\.)?refetch\}`

// ---------------------------------------------------------------------------
// Lock B: hand-written muted query-empties. EXACT per-file occurrence allowlist.
// The combined-className regex (P3) sees `className="muted …"` too, so the seven
// former escapees join the grandfather set with their real counts.
// ---------------------------------------------------------------------------
const ALLOW_EMPTY = new Map<string, number>([
  ['components/AclPanel.tsx', 1],
  ['components/WorktreeFilesPanel.tsx', 1],
  ['components/agents/NodeDependencyTreeSection.tsx', 1],
  ['components/fusion/FuseDialog.tsx', 2],
  ['components/mcps/McpInventoryPanel.tsx', 4],
  ['components/memory/distill-job-detail/SourceEventsList.tsx', 1],
  ['components/repos/BatchImportDialog.tsx', 1],
  ['components/tasks/TaskMembersPanel.tsx', 1],
  ['components/tasks/TaskDiagnosePanel.tsx', 1],
  ['components/tasks/RepairChoiceDialog.tsx', 1],
  ['routes/tasks.new.tsx', 1],
  // P3 (Codex re-review): combined-className escapees the exact-`"muted"` regex missed.
  ['components/agents/DependencyTreePreview.tsx', 3],
  ['components/inventory/AgentsTable.tsx', 1],
  ['components/inventory/McpsTable.tsx', 1],
  ['components/inventory/PluginsTable.tsx', 1],
  ['components/inventory/SkillsTable.tsx', 1],
  ['components/node-session/ConversationFlow.tsx', 1],
  ['components/structure/StructuralGraph.tsx', 1],
])
// P3: `"muted"` OR `"muted <extra classes>"` — combined className no longer dodges.
const MUTED_EMPTY = String.raw`className="muted(?: [^"]*)?"[^>]*>\s*\{t\('(?!common\.empty')[^']*(?:[Ee]mpty|noMembers|noUsers|noEvents|noManaged|noSelectable|outputNone|noPorts|sourceDeleted)`

describe('RFC-214 async-state-gate source guards', () => {
  // Shared: a lock's offenders are files whose occurrence count EXCEEDS the
  // allowlisted count (a fresh violation, or a second one in a listed file).
  function offendersOver(source: string, allow: Map<string, number>): string[] {
    return FILES.filter(
      (f) => occurrences(readFileSync(f.abs, 'utf8'), source) > (allow.get(f.rel) ?? 0),
    ).map(
      (f) =>
        `${f.rel} (${occurrences(readFileSync(f.abs, 'utf8'), source)} > ${allow.get(f.rel) ?? 0} allowed)`,
    )
  }
  // Shared honesty: every listed file STILL carries EXACTLY its allowlisted count
  // — a drift down means the entry is stale (remove it); up is caught above too.
  function assertHonest(source: string, allow: Map<string, number>): void {
    for (const [f, expected] of allow) {
      expect(
        occurrences(readFileSync(path.join(SRC, f), 'utf8'), source),
        `${f} occurrence count drifted from ${expected}`,
      ).toBe(expected)
    }
  }

  test('Lock A — no hand-written refetch <button> beyond the grandfathered exact counts', () => {
    expect(
      offendersOver(RETRY_BUTTON, ALLOW_RETRY),
      'New/extra hand-written retry button(s). Route retry through ErrorBanner.onRetry / QueryState.',
    ).toEqual([])
  })

  test('Lock A honesty — every allowlist entry still carries EXACTLY its count', () => {
    assertHonest(RETRY_BUTTON, ALLOW_RETRY)
  })

  test('Lock B — no hand-written muted query-empty beyond the grandfathered exact counts', () => {
    expect(
      offendersOver(MUTED_EMPTY, ALLOW_EMPTY),
      'New/extra hand-written muted empty. Express query empties through QueryState.emptyText / empty.',
    ).toEqual([])
  })

  test('Lock B honesty — every allowlist entry still carries EXACTLY its count', () => {
    assertHonest(MUTED_EMPTY, ALLOW_EMPTY)
  })

  test('the sanctioned homes exist and stay clean', () => {
    const errorBanner = readFileSync(path.join(SRC, 'components/ErrorBanner.tsx'), 'utf8')
    const queryState = readFileSync(path.join(SRC, 'components/QueryState.tsx'), 'utf8')
    expect(errorBanner).toContain('onRetry')
    expect(queryState).toContain('export function QueryState')
    // The primitives must NOT themselves contain a hand-written refetch button.
    expect(occurrences(errorBanner, RETRY_BUTTON)).toBe(0)
  })
})
