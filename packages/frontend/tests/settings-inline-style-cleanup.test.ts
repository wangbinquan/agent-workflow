// RFC-035 PR3 — source-level guard. settings.tsx had six inline
// `style={{ marginTop|fontSize }}` attributes; the cleanup moves them
// to className utilities (stack-top--sm/md + settings-hint). Going
// forward, any new inline style attribute in this file must be a
// deliberate dynamic value, not a static spacing override.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const body = readFileSync(path.resolve(here, '../src/routes/settings.tsx'), 'utf8')

describe('RFC-035 settings.tsx inline-style cleanup', () => {
  test('no `style={{` JSX expressions survive', () => {
    expect(/style=\{\{/.test(body)).toBe(false)
  })

  test('settings-hint utility class is used instead', () => {
    expect(body.includes('settings-hint')).toBe(true)
  })

  test('stack-top--sm / --md utility classes are used', () => {
    expect(/stack-top--(sm|md)/.test(body)).toBe(true)
  })
})
