// RFC-083 PR-F regression: the graph cards must (a) keep long class/member names
// inside the box (ellipsis / overflow hidden) and (b) use real theme vars only
// (an earlier version referenced non-existent --diff-* vars → unreadable colors).

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

// the card rules region
const cardCss = css.slice(css.indexOf('.sg-card {'), css.indexOf('.structure-graph-wrap {'))
// the graph container rule
const graphCss = css.slice(
  css.indexOf('.structure-graph {'),
  css.indexOf('.structure-graph .react-flow__node'),
)

describe('structure-graph container height', () => {
  // regression: the graph is inside a flex column the (tall) impact panel can
  // collapse to 0 — a shrinkable flex child got crushed to ~2px and vanished.
  test('has a fixed height and is non-shrinkable (flex: none)', () => {
    expect(graphCss).toMatch(/height:\s*\d{3}px/)
    expect(graphCss).toMatch(/flex:\s*none/)
  })
})

describe('structure-graph card styling', () => {
  test('card title + members clip long names (no overflow outside the box)', () => {
    expect(cardCss).toMatch(/\.sg-card__title[^}]*overflow:\s*hidden/)
    expect(cardCss).toMatch(/\.sg-card__title[^}]*text-overflow:\s*ellipsis/)
    expect(cardCss).toMatch(/\.sg-card__member-name[^}]*text-overflow:\s*ellipsis/)
  })

  test('uses real theme vars, not the non-existent --diff-* fallbacks', () => {
    expect(cardCss).not.toMatch(/--diff-add-bg|--diff-add-fg|--surface-2|--text-muted/)
    expect(cardCss).toMatch(/var\(--panel\)/)
    expect(cardCss).toMatch(/var\(--border\)/)
  })

  test('change-type accents are defined for cards + members', () => {
    expect(cardCss).toMatch(/\.sg-card--ct-added/)
    expect(cardCss).toMatch(/\.sg-card__member--ct-removed/)
  })
})
