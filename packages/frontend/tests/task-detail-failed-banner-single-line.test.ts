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
    // RFC-203 T4: the summary line now renders LOCALIZED failure copy
    // (describeTaskFailure) while the raw machine token stays in the hover
    // title — the single-line clipping contract is unchanged.
    expect(SRC).toMatch(
      /<div className="task-error-banner__summary" title=\{tk\.errorSummary \?\? ''\}>/,
    )
    expect(SRC).toContain('describeTaskFailure({')
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
    // RFC-203 T4: the fold now carries BOTH the raw errorSummary token and
    // errorMessage (deduped) — the machine strings moved out of the summary
    // line into here.
    expect(SRC).toMatch(/\[tk\.errorSummary, tk\.errorMessage\]/)
  })

  test('long failed node ids keep the mobile close control reachable', () => {
    expect(SRC).toMatch(
      /className="btn btn--sm btn--danger task-error-banner__jump"\s+title=\{t\('tasks\.jumpToFailed'/,
    )
    expect(CSS).toMatch(
      /\.task-error-banner__jump\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*min\(32rem,\s*100%\)[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/,
    )
    expect(CSS).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*?\.task-error-banner\s*\{[^}]*flex-direction:\s*column[^}]*min-width:\s*0[^}]*\}[\s\S]*?\.task-error-banner__actions\s*\{[^}]*min-width:\s*0[^}]*width:\s*100%[^}]*\}[\s\S]*?\.task-error-banner__jump\s*\{[^}]*flex:\s*1 1 auto[^}]*max-width:\s*100%/,
    )
  })
})
