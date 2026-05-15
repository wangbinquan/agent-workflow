// RFC-011 source-level safety net. Component-render tests catch most
// regressions, but jsdom doesn't run layout and the i18n provider can
// race on first paint — so we also lock the contract at the file level
// (per the feedback_post_commit_ci_check convention).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const DRAWER = join(__dirname, '..', 'src', 'components', 'NodeDetailDrawer.tsx')
const HELPER = join(__dirname, '..', 'src', 'lib', 'node-prompt.ts')

describe('RFC-011 NodeDetailDrawer source contract', () => {
  test('drawer no longer reads run.promptText directly in the old null-guard form', () => {
    const src = readFileSync(DRAWER, 'utf8')
    // The old PromptTab body said `if (run.promptText === null)`. New code
    // routes through the attempts helper and reads `picked.promptText`.
    expect(src).not.toMatch(/if\s*\(\s*run\.promptText\s*===\s*null\s*\)/)
  })

  test('drawer renders the attempts switcher class + uses the capability gate', () => {
    const src = readFileSync(DRAWER, 'utf8')
    expect(src).toContain('prompt-history__select')
    expect(src).toContain('isPromptCapableKind(')
    expect(src).toContain('sortNodeRunsForPromptHistory')
  })

  test('helper module exports the four pure functions the drawer relies on', () => {
    const src = readFileSync(HELPER, 'utf8')
    expect(src).toMatch(/export function sortNodeRunsForPromptHistory/)
    expect(src).toMatch(/export function isPromptCapableKind/)
    expect(src).toMatch(/export function isFanoutParentRun/)
    expect(src).toMatch(/export function formatAttemptLabel/)
  })
})
