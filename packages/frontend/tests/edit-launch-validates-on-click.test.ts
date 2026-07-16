// Locks in the UX decision from the 2026-05-17 conversation: clicking
// "启动任务 / Launch task" in the workflow editor must run the same
// static validation the backend performs in services/task.ts §startTask
// BEFORE navigating to the launcher form. Previously the button was a
// plain `<Link>`, so users had to fill in repo/inputs and click Start
// before the backend rejected a structurally invalid workflow with
// `workflow-invalid`. Surfacing the issues on the canvas they're
// already on saves that round-trip.
//
// Source-layer assertions: the runtime editor is heavy to JSDOM-render
// (TanStack Router + React Query + xyflow + many child components),
// so we pin the contract by reading the file and asserting on the
// structure that implements it. If any of these checks go red, either
// the contract changed intentionally (update this test + leave a note)
// or someone quietly reverted the launch-validates-on-click behavior.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const editPath = resolve(__dirname, '../src/routes/workflows.edit.tsx')

describe('workflows.edit launch button validates first (source layer)', () => {
  const src = readFileSync(editPath, 'utf-8')

  test('Launch is a <button>, not a <Link to="/workflows/$id/launch">', () => {
    // Old behavior was `<Link to="/workflows/$id/launch" ...>{t('editor.launch')}</Link>`.
    // Refuse the pure-link form: it skips validation entirely.
    expect(src).not.toMatch(/<Link\s+to="\/workflows\/\$id\/launch"/)
  })

  test('Launch button delegates to the exact save/validate handoff', () => {
    const block = extractLaunchButtonBlock(src)
    expect(block).toContain('handleLaunch()')
    expect(block).toMatch(/t\('editor\.launch'\)/)

    const handler = extractLaunchHandler(src)
    expect(handler).toContain('exactActionRef.current !== null')
    expect(handler).toContain('controller.ensureSaved({ signal: abort.signal })')
    expect(handler).toContain('runExactValidation(saved, abort.signal)')
    expect(handler).toContain('exactActionAbortRef.current?.abort()')
    expect(handler).toContain("to: '/workflows/$id/launch'")
    expect(handler).toContain('search: { version: saved.server.version }')
  })

  test('blocking-issue gate uses error-severity semantics (default error)', () => {
    // The launch click handler must treat issues with severity 'error'
    // (or undefined, since the schema defaults missing severity to
    // 'error' — see partitionIssues) as blocking. Warnings pass.
    const handler = extractLaunchHandler(src)
    expect(handler).toMatch(/severity\s*\?\?\s*'error'/)
    expect(handler).toMatch(/===\s*'error'/)
  })
})

/**
 * Find the <button> JSX block whose visible label is `t('editor.launch')`.
 * Returns the substring from the opening `<button` to the matching
 * `</button>` so callers can assert on its onClick body.
 */
function extractLaunchButtonBlock(src: string): string {
  const labelIdx = src.indexOf("t('editor.launch')")
  if (labelIdx === -1) throw new Error("could not find t('editor.launch') usage")
  // Walk backwards to the nearest `<button` opening tag.
  const start = src.lastIndexOf('<button', labelIdx)
  if (start === -1) throw new Error('could not find <button preceding editor.launch label')
  const end = src.indexOf('</button>', labelIdx)
  if (end === -1) throw new Error('could not find </button> after editor.launch label')
  return src.slice(start, end + '</button>'.length)
}

function extractLaunchHandler(src: string): string {
  const start = src.indexOf('const handleLaunch = async')
  if (start === -1) throw new Error('could not find handleLaunch')
  const end = src.indexOf('\n  // Conflict/terminal save-copy', start)
  if (end === -1) throw new Error('could not find end of handleLaunch')
  return src.slice(start, end)
}
