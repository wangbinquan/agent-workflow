// RFC-151 PR-1 — inline `t('common.loading')` ban (LoadingState convergence).
//
// ~24 call sites used to render the loading branch as bare text
// (`<div className="muted">{t('common.loading')}</div>` and friends) instead
// of the shared <LoadingState> primitive (RFC-035). RFC-151 converted every
// mechanical three-state shell; the survivors below are SEMANTIC exceptions
// where a block spinner would be wrong. Any new inline usage (or a stale
// allowlist entry after a cleanup) turns this red — extend LoadingState or
// justify a new exemption HERE, don't quietly fork loading text again.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

// Files allowed to reference common.loading, with why.
const ALLOWLIST = new Set<string>([
  // The primitive itself: default label + the header comment describing the
  // legacy pattern it replaces.
  'components/LoadingState.tsx',
  // Popover listbox empty-state: inline text ternary with `noResults` inside
  // the async-search combobox; a block spinner would blow up the popover.
  'components/UserPicker.tsx',
  // Row-title fallback chain (`title → loading → id`): inline text inside a
  // list row label, not a three-state shell.
  'components/fusion/MemoryReviewItem.tsx',
  // Inline <span> inside the diff-toolbar slot ternary (historical diff
  // loading); the slot expects inline content.
  'routes/reviews.detail.tsx',
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(abs)
  }
  return out
}

describe('inline common.loading ban', () => {
  test('only the allowlisted files may reference common.loading', () => {
    const offenders: string[] = []
    for (const abs of walk(SRC)) {
      const rel = path.relative(SRC, abs)
      // i18n bundles define the key itself (`loading: '…'`), they don't
      // reference it — and they never match the dotted form anyway.
      if (!readFileSync(abs, 'utf8').includes('common.loading')) continue
      if (!ALLOWLIST.has(rel)) offenders.push(rel)
    }
    expect(
      offenders,
      `inline t('common.loading') outside the allowlist — render <LoadingState> instead`,
    ).toEqual([])
  })

  test('allowlist stays honest: every entry still references common.loading', () => {
    for (const rel of ALLOWLIST) {
      const body = readFileSync(path.join(SRC, rel), 'utf8')
      expect(
        body.includes('common.loading'),
        `${rel} no longer references common.loading — prune it from the allowlist`,
      ).toBe(true)
    }
  })
})
