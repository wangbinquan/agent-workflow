// User-reported visual regression (2026-07-24): page tabs and compact actions
// looked too tall for their label size, while workflow autosave banners touched
// the status row. Keep the RFC-198 hit-target floors, but lock the typography,
// dense variants, action alignment, and banner rhythm that make those targets
// look proportionate.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  expect(match, `CSS rule not found: ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('shared control density and feedback rhythm', () => {
  test('page action rows center controls instead of stretching compact buttons', () => {
    expect(rule('.page__actions')).toContain('align-items: center')
  })

  test('page tabs pair the 36px target with readable type and tighter padding', () => {
    const tab = rule('.tabs__tab')
    expect(tab).toContain('font-size: var(--font-md)')
    expect(tab).toContain('line-height: 1.25')
    expect(tab).toContain('padding: 6px 12px')

    const sharedFloor = css.match(
      /\.btn,\s*\.nav-item,\s*\.sidebar__link,\s*\.tabs__tab,[^{]+\{([^}]*)\}/s,
    )
    expect(sharedFloor?.[1]).toContain('min-height: 36px')
  })

  test('inspector tabs use the intentional 32px dense-control tier', () => {
    const inspector = rule('.tabs--inspector .tabs__tab')
    expect(inspector).toContain('min-height: 32px')
    expect(inspector).toContain('font-size: 13px')
  })

  test('segmented options use readable control text without lowering the hit target', () => {
    const segmented = rule('.segmented__option')
    expect(segmented).toContain('font-size: var(--font-md)')
    expect(segmented).toContain('line-height: 1.25')
  })

  test('task filters use one balanced compact tier instead of mixing 21px and 36px controls', () => {
    const statuses = rule('.status-filter__statuses > .chip')
    expect(statuses).toContain('min-height: 28px')
    expect(statuses).toContain('border-radius: var(--radius-pill)')

    const subjects = rule('.tasks-toolbar .segmented__option')
    expect(subjects).toContain('min-height: 28px')
    expect(subjects).toContain('font-size: 13px')

    const search = rule('.tasks-toolbar .tasks-toolbar__search')
    expect(search).toContain('min-height: 32px')
  })

  test('mobile task status filters stay on one scrollable row with compact usable targets', () => {
    const statusRules = [...css.matchAll(/^\s*\.status-filter__statuses\s*\{([^}]*)\}/gm)].map(
      (match) => match[1] ?? '',
    )
    expect(
      statusRules.some(
        (body) =>
          body.includes('flex-wrap: nowrap') &&
          body.includes('overflow-x: auto') &&
          body.includes('max-width: 100%'),
      ),
    ).toBe(true)

    const chipRules = [
      ...css.matchAll(/^\s*\.status-filter__statuses > \.chip\s*\{([^}]*)\}/gm),
    ].map((match) => match[1] ?? '')
    expect(chipRules.some((body) => body.includes('min-height: 36px'))).toBe(true)

    const subjectRules = [
      ...css.matchAll(/^\s*\.tasks-toolbar \.segmented__option\s*\{([^}]*)\}/gm),
    ].map((match) => match[1] ?? '')
    expect(subjectRules.some((body) => body.includes('min-height: 36px'))).toBe(true)
  })

  test('desktop auth method tabs are compact while mobile restores the 44px touch floor', () => {
    const authTab = rule('.auth-page .tabs--segment .tabs__tab')
    expect(authTab).toContain('font-size: var(--font-md)')
    expect(authTab).toContain('min-height: 40px')

    const authRules = [
      ...css.matchAll(/^\s*\.auth-page \.tabs--segment \.tabs__tab\s*\{([^}]*)\}/gm),
    ].map((match) => match[1] ?? '')
    expect(authRules.some((body) => body.includes('min-height: 44px'))).toBe(true)
  })

  test('draft chips live in compact editor metadata while recovery banners keep their rhythm', () => {
    const meta = rule('.editor-resource-meta')
    expect(meta).toContain('display: flex')
    expect(meta).toContain('align-items: center')

    const revision = rule('.editor-resource-meta__revision')
    expect(revision).toContain('flex: 0 1 auto')
    expect(revision).toContain('min-width: 96px')

    const summary = rule('.editor-draft-status-summary')
    expect(summary).toContain('display: inline-flex')
    expect(summary).toContain('flex: 0 0 auto')

    const status = rule('.workflow-draft-status')
    expect(status).toContain('display: grid')
    expect(status).toContain('gap: var(--space-2)')
  })
})
