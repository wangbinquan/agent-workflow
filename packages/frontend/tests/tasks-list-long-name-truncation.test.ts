// Locks in the long-task-name visual fix: a 100+ char task name must not
// stretch the name column or balloon the row height. The contract is:
//
//   1. `.task-name-cell` carries a `max-width` so the column can't be sized
//      to the longest name in the table.
//   2. `.task-name-cell__name` truncates to a single line with ellipsis
//      (white-space: nowrap + overflow: hidden + text-overflow: ellipsis).
//   3. `routes/tasks.tsx` puts `title={row.name}` on the name link, so
//      hovering still surfaces the full string.
//
// Before this fix a 192-char "长任务名长任务名…" entry pushed the name
// column to 735px and the row to 122px high, squeezing the Repo / Error
// columns. Don't loosen these checks without an alternative layout that
// keeps the column width bounded.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
const TASKS_TSX = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'),
  'utf-8',
)

function ruleBody(css: string, selector: string): string {
  // Grabs the first `{...}` block following `selector`. Naive but the
  // styles.css file has no nested rules at this layer, so it's safe.
  const idx = css.indexOf(selector)
  if (idx < 0) throw new Error(`selector not found: ${selector}`)
  const open = css.indexOf('{', idx)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('tasks list — long task name does not blow up the row', () => {
  test('.task-name-cell caps its width so the column cannot autosize to the longest name', () => {
    const body = ruleBody(CSS, '.task-name-cell ')
    expect(body).toMatch(/max-width:\s*\d+px/)
  })

  test('.task-name-cell__name truncates to a single line with ellipsis', () => {
    const body = ruleBody(CSS, '.task-name-cell__name ')
    expect(body).toMatch(/white-space:\s*nowrap/)
    expect(body).toMatch(/overflow:\s*hidden/)
    expect(body).toMatch(/text-overflow:\s*ellipsis/)
    // The previous behavior — word-break / line-clamp wrap — must not creep
    // back, otherwise the row height regression returns.
    expect(body).not.toMatch(/word-break:\s*break-word/)
    expect(body).not.toMatch(/-webkit-line-clamp/)
  })

  test('.task-name-cell__id shrinks to its content (does not stretch to full cell width)', () => {
    // Parent is `display: flex; flex-direction: column`, so a plain `display: block`
    // child stretches across the column. We use `align-self: flex-start` to make
    // the ULID chip hug its content instead of leaving a wide empty bar below
    // short task names.
    const body = ruleBody(CSS, '.task-name-cell__id ')
    expect(body).toMatch(/align-self:\s*flex-start/)
  })

  test('routes/tasks.tsx sets title={row.name} on the name link for hover-to-see-full-name', () => {
    // Match the Link block that renders task-name-cell__name and check that
    // a `title={row.name}` prop sits inside it.
    const linkBlock = TASKS_TSX.match(
      /<Link[\s\S]*?task-name-cell__name[\s\S]*?>[\s\S]*?{row\.name}[\s\S]*?<\/Link>/,
    )
    expect(linkBlock).not.toBeNull()
    expect(linkBlock?.[0]).toMatch(/title=\{row\.name\}/)
  })
})
