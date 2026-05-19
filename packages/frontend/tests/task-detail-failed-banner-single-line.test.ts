// Locks in single-line truncation for the "task failed" banner on the task
// detail page. A very long `errorSummary` (multi-line stack trace) used to
// wrap inside the banner and the banner could occupy half the viewport,
// covering downstream content. The summary line is now clipped to one line
// via `.task-error-banner__summary` (nowrap + ellipsis) with the full text
// preserved in a `title` tooltip; the optional `<details>` block below still
// expands to the full `errorMessage`.
//
// Source-text assertions per CLAUDE.md's test-with-every-change rule.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
  'utf-8',
)
const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')

describe('routes/tasks.detail.tsx — failed banner single-line summary', () => {
  test('summary line is wrapped in `.task-error-banner__summary` with hover title', () => {
    expect(SRC).toMatch(/<div className="task-error-banner__summary" title=\{tk\.errorSummary\}>/)
  })

  test('banner uses a `__body` wrapper that can shrink (min-width:0) inside the flex row', () => {
    // Without the wrapper or without `min-width: 0`, the flex item would grow
    // to fit the longest line — the whole point of this refactor is gone.
    expect(SRC).toMatch(/<div className="task-error-banner__body">/)
    expect(CSS).toMatch(/\.task-error-banner__body\s*\{[^}]*min-width:\s*0/)
  })

  test('summary span clips with white-space:nowrap + overflow:hidden + ellipsis', () => {
    expect(CSS).toMatch(
      /\.task-error-banner__summary\s*\{[^}]*white-space:\s*nowrap[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/,
    )
  })

  test('the `<details>` block (full errorMessage) is preserved for click-to-expand', () => {
    // We only clip the one-line summary; users can still expand the full
    // stack trace below. Locking this so a future "simplify" pass doesn't
    // accidentally rip out the details panel along with the wrapper.
    expect(SRC).toMatch(/<details className="task-error-banner__details">/)
    expect(SRC).toMatch(/<pre>\{tk\.errorMessage\}<\/pre>/)
  })
})
