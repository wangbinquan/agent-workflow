// Regression (2026-07-07): on the task-detail 问题 tab, a long handler/source node
// name used to shoot past the kanban card's right border (measured +315px on the
// read-only meta span and +421px on the reassign Select trigger vs the card edge),
// and the same name made the toolbar filter chip overflow the page. Root cause:
// `.task-questions__meta-pair` is `inline-flex; white-space: nowrap` with no
// shrink/truncation budget, so the value span / Select trigger sized to
// max-content. The fix is CSS truncation (ellipsis) + `title` hover fallbacks:
//   .task-questions__meta-pair       → min-width: 0 + max-width: 100%
//   .task-questions__meta-v          → overflow: hidden + text-overflow: ellipsis
//   .task-questions__meta-pair .select → min-width: 0 (lets .select__value ellipsis engage)
//   .task-questions__filter-chip     → inline-flex + max-width: 100%, label span
//                                      truncates, count span stays visible
//   .task-questions__answer          → overflow-wrap: anywhere (same family as the
//                                      earlier .task-questions .card__title fix)
// jsdom does no layout, so the pixel behavior is pinned two ways instead: DOM
// contracts (title attributes + the span/select structure the CSS selectors rely
// on) and a styles.css source lock (agents-list-cell-wrapping.test.ts pattern).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TaskQuestionList, type TaskQuestionEntry } from '../src/components/tasks/TaskQuestionList'
import '../src/i18n'

const STYLES_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/styles.css')
const LONG_NODE_ID = 'auditor-long'
const LONG_LABEL =
  '代码审计与修复建议汇总处理节点-auditor-shard-aggregator-with-a-very-long-name-20260707'

afterEach(() => cleanup())

const entry = (over: Partial<TaskQuestionEntry>): TaskQuestionEntry => ({
  id: 'e0',
  questionId: 'q1',
  questionTitle: 'Pick a strategy?',
  originNodeRunId: 'origin-1',
  sourceKind: 'self',
  roleKind: 'self',
  sourceNodeId: LONG_NODE_ID,
  defaultTargetNodeId: LONG_NODE_ID,
  overrideTargetNodeId: null,
  effectiveTargetNodeId: LONG_NODE_ID,
  phase: 'pending',
  confirmation: 'open',
  staged: false,
  autoDispatchDeferred: false,
  sealed: false,
  answerSummary: null,
  ...over,
})

async function wrap(entries: TaskQuestionEntry[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['task-questions', 'task-1'], entries)
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <QueryClientProvider client={qc}>
        <TaskQuestionList
          taskId="task-1"
          nodeOptions={[
            { id: LONG_NODE_ID, label: LONG_LABEL },
            { id: 'fixer', label: 'fixer' },
          ]}
        />
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return render(<RouterProvider router={router as never} />)
}

describe('问题 tab — long node names truncate instead of overflowing the card', () => {
  test('read-only source/target meta spans carry title so the full name survives ellipsis', async () => {
    // processing = dispatched → target renders as the read-only span (not the Select).
    await wrap([entry({ phase: 'processing' })])
    const card = screen.getByTestId('tq-card-e0')
    const values = card.querySelectorAll('.task-questions__meta-v')
    expect(values.length).toBe(2) // source + target
    for (const v of values) {
      expect(v.textContent).toBe(LONG_LABEL)
      expect(v.getAttribute('title')).toBe(LONG_LABEL)
    }
  })

  test('reassignable card keeps the Select inside the meta pair (the CSS shrink scope)', async () => {
    await wrap([entry({ phase: 'pending' })])
    const card = screen.getByTestId('tq-card-e0')
    // `.task-questions__meta-pair .select { min-width: 0 }` only bites if the Select
    // stays a direct descendant of the pair — lock that structure.
    expect(card.querySelector('.task-questions__meta-pair .select')).not.toBeNull()
  })

  test('node filter chip splits into truncating label + always-visible count, with title', async () => {
    await wrap([entry({ phase: 'processing' }), entry({ id: 'e1', questionId: 'q2' })])
    const chip = screen.getByTestId(`tq-node-filter-${LONG_NODE_ID}`)
    expect(chip.getAttribute('title')).toBe(LONG_LABEL)
    const label = chip.querySelector('.task-questions__filter-chip-label')
    const count = chip.querySelector('.task-questions__filter-chip-count')
    expect(label?.textContent).toBe(LONG_LABEL)
    expect(count?.textContent).toBe('(2)')
    // The chip must still be a real <button> (role lock from RFC-124).
    expect(within(chip).queryByRole('button')).toBeNull() // no nested button
    expect(chip.tagName).toBe('BUTTON')
  })
})

describe('styles.css — truncation rules that keep long names inside the card (source lock)', () => {
  test('meta pair / value / select shrink budget', async () => {
    const css = await fs.readFile(STYLES_SRC, 'utf8')

    const pair = css.match(/\.task-questions__meta-pair\s*\{([^}]*)\}/)
    expect(pair).not.toBeNull()
    expect(pair![1]).toMatch(/min-width:\s*0/)
    expect(pair![1]).toMatch(/max-width:\s*100%/)
    expect(pair![1]).toMatch(/white-space:\s*nowrap/) // ellipsis needs nowrap inherited

    const value = css.match(/\.task-questions__meta-v\s*\{([^}]*)\}/)
    expect(value).not.toBeNull()
    expect(value![1]).toMatch(/overflow:\s*hidden/)
    expect(value![1]).toMatch(/text-overflow:\s*ellipsis/)

    const label = css.match(/\.task-questions__meta-k\s*\{([^}]*)\}/)
    expect(label).not.toBeNull()
    expect(label![1]).toMatch(/flex-shrink:\s*0/)

    // Without this the reassign Select's flex min-size keeps the pair at
    // max-content and the trigger pokes out of the card again.
    const select = css.match(/\.task-questions__meta-pair\s+\.select\s*\{([^}]*)\}/)
    expect(select).not.toBeNull()
    expect(select![1]).toMatch(/min-width:\s*0/)
  })

  test('filter chip truncates its label but never its count', async () => {
    const css = await fs.readFile(STYLES_SRC, 'utf8')

    // Codex 实现门 finding: without a shrink budget on the filter GROUP, its flex
    // automatic minimum size sticks at the long chip's max-content width and the
    // chip's max-width:100% resolves against an already-overflowed parent
    // (measured +106px past the toolbar at a 520px viewport).
    const filter = css.match(/\.task-questions__filter\s*\{([^}]*)\}/)
    expect(filter).not.toBeNull()
    expect(filter![1]).toMatch(/min-width:\s*0/)

    const chip = css.match(/\.task-questions__filter-chip\s*\{([^}]*)\}/)
    expect(chip).not.toBeNull()
    expect(chip![1]).toMatch(/display:\s*inline-flex/)
    expect(chip![1]).toMatch(/max-width:\s*100%/)

    const label = css.match(/\.task-questions__filter-chip-label\s*\{([^}]*)\}/)
    expect(label).not.toBeNull()
    expect(label![1]).toMatch(/overflow:\s*hidden/)
    expect(label![1]).toMatch(/text-overflow:\s*ellipsis/)

    const count = css.match(/\.task-questions__filter-chip-count\s*\{([^}]*)\}/)
    expect(count).not.toBeNull()
    expect(count![1]).toMatch(/flex-shrink:\s*0/)
  })

  test('answer block wraps long unbroken tokens (same family as the card__title fix)', async () => {
    const css = await fs.readFile(STYLES_SRC, 'utf8')
    const answer = css.match(/\.task-questions__answer\s*\{([^}]*)\}/)
    expect(answer).not.toBeNull()
    expect(answer![1]).toMatch(/overflow-wrap:\s*anywhere/)
  })
})
