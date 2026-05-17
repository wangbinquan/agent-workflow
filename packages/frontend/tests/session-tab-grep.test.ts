// RFC-027 T5 — source-code-level guard rails. These tests don't render
// anything; they read the source of the drawer + Session tab and
// assert key wirings stay intact. If a future refactor removes the
// Session tab branch, drops the runner SQLite reader, or undoes the
// default-to-session tab, one of these flips red.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const DRAWER = readFileSync(
  join(REPO_ROOT, 'packages/frontend/src/components/NodeDetailDrawer.tsx'),
  'utf8',
)
const SESSION_TAB = readFileSync(
  join(REPO_ROOT, 'packages/frontend/src/components/node-session/SessionTab.tsx'),
  'utf8',
)
const RUNNER = readFileSync(join(REPO_ROOT, 'packages/backend/src/services/runner.ts'), 'utf8')

describe('RFC-027 source-code wiring', () => {
  test("NodeDetailDrawer still mounts the SessionTab on tab === 'session'", () => {
    expect(DRAWER).toContain("tab === 'session'")
    expect(DRAWER).toContain('<SessionTab')
  })

  test("NodeDetailDrawer defaults the active tab to 'session'", () => {
    expect(DRAWER).toContain("useState<Tab>('session')")
  })

  test('SessionTab uses ConversationFlow to render the tree', () => {
    expect(SESSION_TAB).toContain('ConversationFlow')
    // Single template literal split across two backtick chunks; assert
    // the static parts of the URL appear so a refactor of the path
    // doesn't silently break the route binding.
    expect(SESSION_TAB).toContain('/api/tasks/')
    expect(SESSION_TAB).toContain('/session')
    expect(SESSION_TAB).toContain('/node-runs/')
  })

  test('runner.ts invokes captureChildSessions after child.exited so subagent rows land in DB', () => {
    expect(RUNNER).toContain('captureChildSessions')
  })
})
