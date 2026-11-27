// RFC-616 §11.3 — shared oracle for the two heat locks
// (rfc616-canvas-node-heat.test.tsx and rfc616-employee-panorama-heat.test.tsx).
//
// The canvas and the duty map both colour by `data-heat`, and the design fixes
// one rule for both: heat styles reference the `--viz-heat-*` tokens and nothing
// else, and a render without heat is unchanged. This module states those two
// rules once — what a declaration in a heat rule may contain, and what "the same
// markup minus heat" means — so the two test files cannot drift into two
// different readings of them.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const HEAT_LEVELS = [1, 2, 3, 4, 5] as const

export interface StyleDeclaration {
  property: string
  value: string
}

export interface StyleRule {
  /** Selector with every run of whitespace collapsed to one space. */
  selector: string
  declarations: StyleDeclaration[]
}

/** styles.css without comments (a comment may name any token or literal). */
export function readStyles(): string {
  return readFileSync(path.resolve(here, '../src/styles.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )
}

/**
 * Splits CSS into its innermost `selector { declarations }` rules. An at-rule
 * prelude (`@media …`) is not a rule of its own: the rules inside it are
 * returned with their own selectors.
 */
export function parseRules(css: string): StyleRule[] {
  const rules: StyleRule[] = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ')
    const declarations: StyleDeclaration[] = []
    for (const chunk of (match[2] ?? '').split(';')) {
      const colon = chunk.indexOf(':')
      if (colon < 0) continue
      declarations.push({
        property: chunk.slice(0, colon).trim(),
        value: chunk
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, ' '),
      })
    }
    rules.push({ selector, declarations })
  }
  return rules
}

/**
 * The rules that style heat for one component: the selector names `owner` and
 * either a `data-heat` attribute or the `__heat` label element. Scoping by owner
 * keeps each lock on the component it belongs to.
 */
export function heatRules(css: string, owner: string): StyleRule[] {
  return parseRules(css).filter(
    (rule) => rule.selector.includes(owner) && /\[data-heat\b|__heat(?![\w-])/.test(rule.selector),
  )
}

const HEAT_TOKEN = /^--viz-heat-[1-5](?:-ink)?$/
const COLOUR_LITERAL =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i
/** Properties whose value is, or carries, a colour (custom properties included). */
const COLOUR_PROPERTY =
  /^(?:color|background|background-color|border-color|outline-color|fill|stroke|box-shadow)$|^--/
/** Words a colour-bearing value may contain besides a heat token. */
const NEUTRAL_WORDS: ReadonlySet<string> = new Set([
  'inherit',
  'initial',
  'unset',
  'none',
  'transparent',
  'currentColor',
  'inset',
  'px',
])

/**
 * Why a set of heat rules is not "heat tokens only". Three things are reported:
 * a `var()` that is not a `--viz-heat-*` token, a colour literal (hex or a
 * colour function), and — in a colour-bearing property — any word that is not a
 * neutral keyword, which is how a named colour shows up. Empty ⇒ tokens only.
 */
export function heatColourViolations(rules: readonly StyleRule[]): string[] {
  const violations: string[] = []
  for (const { selector, declarations } of rules) {
    for (const { property, value } of declarations) {
      const where = `${selector} { ${property}: ${value} }`
      for (const reference of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const token = reference[1] ?? ''
        if (!HEAT_TOKEN.test(token)) violations.push(`${where} — foreign token ${token}`)
      }
      if (COLOUR_LITERAL.test(value)) violations.push(`${where} — colour literal`)
      if (!COLOUR_PROPERTY.test(property)) continue
      const words = value.replace(/var\([^)]*\)/g, ' ').match(/[A-Za-z][\w-]*/g) ?? []
      for (const word of words) {
        if (!NEUTRAL_WORDS.has(word)) violations.push(`${where} — colour keyword ${word}`)
      }
    }
  }
  return violations
}

/**
 * The container's markup with the heat additions taken out again: every
 * `data-heat` attribute and every `.canvas-node__heat` label. A render WITHOUT
 * heat must produce exactly this string — heat adds those two things and
 * changes nothing else. Callers pass BOTH renders through it (for the plain
 * one it removes nothing), so the two strings come out of the same
 * clone-and-serialise step.
 */
export function markupWithoutHeat(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement
  for (const label of Array.from(clone.querySelectorAll('.canvas-node__heat'))) label.remove()
  for (const element of Array.from(clone.querySelectorAll('[data-heat]'))) {
    element.removeAttribute('data-heat')
  }
  return clone.innerHTML
}
