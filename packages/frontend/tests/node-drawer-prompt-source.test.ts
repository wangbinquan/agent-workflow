// RFC-011 source-level safety net. Component-render tests catch most
// regressions, but jsdom doesn't run layout and the i18n provider can
// race on first paint — so we also lock the contract at the file level
// (per the feedback_post_commit_ci_check convention).
//
// 2026-07-07 flag-audit W0 update: the drawer's dead 'prompt' tab (unreachable
// since SessionTab took over — the tab button was never rendered) was deleted.
// The "attempts switcher + capability gate" contract this file locks lives in
// SessionTab.tsx now, so the source assertions point there; the drawer gets a
// deletion lock instead so the dead tab can't silently come back.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const DRAWER = join(__dirname, '..', 'src', 'components', 'NodeDetailDrawer.tsx')
const SESSION_TAB = join(__dirname, '..', 'src', 'components', 'node-session', 'SessionTab.tsx')
const HELPER = join(__dirname, '..', 'src', 'lib', 'node-prompt.ts')

describe('RFC-011 prompt/attempts source contract (now hosted by SessionTab)', () => {
  test('drawer no longer hosts the dead prompt tab (flag-audit W0 deletion lock)', () => {
    const src = readFileSync(DRAWER, 'utf8')
    expect(src).not.toContain("'prompt'")
    expect(src).not.toContain('PromptTab')
    // The old PromptTab body said `if (run.promptText === null)`; nothing in
    // the drawer should read promptText directly any more.
    expect(src).not.toMatch(/promptText/)
  })

  test('SessionTab renders the attempts switcher + uses the capability gate', () => {
    const src = readFileSync(SESSION_TAB, 'utf8')
    // RFC-146: the capability gate is the shared agent-kind predicate now
    // (isPromptCapableKind was a local copy of it and is gone).
    expect(src).toContain('isAgentNodeKind(')
    expect(src).toContain('sortNodeRunsForPromptHistory')
    expect(src).toContain('isFanoutParentRun')
  })

  test('helper module exports the three pure functions the session tab relies on', () => {
    // RFC-146: isPromptCapableKind left this module for shared
    // isAgentNodeKind (NODE_KIND_BEHAVIORS.isAgent), so the helper surface
    // is three functions now.
    const src = readFileSync(HELPER, 'utf8')
    expect(src).toMatch(/export function sortNodeRunsForPromptHistory/)
    expect(src).toMatch(/export function isFanoutParentRun/)
    expect(src).toMatch(/export function formatAttemptLabel/)
  })
})
