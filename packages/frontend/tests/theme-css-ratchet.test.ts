import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const sources = ['../src/styles.css', '../src/components/prose/prose.css'].map((relativePath) => ({
  path: relativePath,
  css: readFileSync(path.resolve(here, relativePath), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
}))

// Shiki injects these inline custom properties on highlighted spans/pre nodes.
// They are runtime data, not missing theme declarations.
const RUNTIME_INJECTED_TOKENS = new Set([
  '--shiki-light',
  '--shiki-light-bg',
  '--shiki-dark',
  '--shiki-dark-bg',
])

function mediaBodies(css: string): string[] {
  const marker = '@media (prefers-color-scheme: dark)'
  const bodies: string[] = []
  let cursor = 0
  while ((cursor = css.indexOf(marker, cursor)) >= 0) {
    const start = css.indexOf('{', cursor + marker.length)
    let depth = 1
    let end = start + 1
    while (end < css.length && depth > 0) {
      if (css[end] === '{') depth += 1
      if (css[end] === '}') depth -= 1
      end += 1
    }
    bodies.push(css.slice(start + 1, end - 1))
    cursor = end
  }
  return bodies
}

function topLevelSelectors(body: string): string[] {
  const selectors: string[] = []
  let depth = 0
  let prelude = ''
  for (const character of body) {
    if (character === '{') {
      if (depth === 0) selectors.push(prelude.trim())
      prelude = ''
      depth += 1
    } else if (character === '}') {
      depth -= 1
    } else if (depth === 0) {
      prelude += character
    }
  }
  return selectors.filter(Boolean)
}

describe('RFC-198 theme source ratchets', () => {
  test('every system-dark fallback is scoped to roots without an explicit theme', () => {
    for (const source of sources) {
      const bodies = mediaBodies(source.css)
      expect(bodies.length, source.path).toBeGreaterThan(0)
      for (const body of bodies) {
        for (const selectorList of topLevelSelectors(body)) {
          for (const selector of selectorList.split(',')) {
            expect(selector.trim(), `${source.path}: ${selectorList}`).toMatch(
              /^:root:not\(\[data-theme\]\)/,
            )
          }
        }
      }
    }
  })

  test('no production CSS references an undefined token without a fallback', () => {
    const declared = new Set<string>()
    for (const source of sources) {
      for (const match of source.css.matchAll(/(--[\w-]+)\s*:/g)) {
        const name = match[1]
        if (name !== undefined) declared.add(name)
      }
    }

    const missing: string[] = []
    for (const source of sources) {
      for (const match of source.css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
        const name = match[1]
        if (name !== undefined && !declared.has(name) && !RUNTIME_INJECTED_TOKENS.has(name)) {
          missing.push(`${source.path}: ${name}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test('foreground compatibility aliases are never used as a solid background', () => {
    const violations: string[] = []
    const solidForeground =
      /background(?:-color)?:\s*var\(--(?:accent|success|warn|info|danger)\)\s*(?:!important)?;/g
    for (const source of sources) {
      for (const match of source.css.matchAll(solidForeground)) {
        violations.push(`${source.path}: ${match[0]}`)
      }
    }
    expect(violations).toEqual([])
  })
})
