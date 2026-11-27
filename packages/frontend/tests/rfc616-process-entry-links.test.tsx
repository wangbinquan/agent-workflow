// RFC-616 §11.1 (design/RFC-616-process-metrics/design.md) — the three entries
// into process metrics: the "More" dialog of the workflow editor and of the
// workgroup page, and every digital employee card. All three build their
// target through `processMetricsLink`, so a subject's metrics open on the
// process tab with that subject already selected.
//
// What this file locks:
//   1. The link itself: route, tab, time range, subject kind and subject id,
//      and the reserved `-` for a subject without an id.
//   2. The observability page's own URL validator keeps everything the link
//      sends. If it dropped a field, the entry would silently land on the
//      overview tab or on the subject listing instead of the subject.
//   3. The process fields of the URL: valid values are kept, anything else is
//      dropped, and a revision comparison without its revision compares nothing.
//   4. The wiring in the three route files. They are large route components
//      (the employee type page has no render test at all), so the entry is
//      locked at source level like their other actions: which helper call,
//      which id, which label, which permission, and where on the page it sits.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  type AnyRouter,
} from '@tanstack/react-router'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PROCESS_NO_SUBJECT, PROCESS_SUBJECT_KINDS } from '@agent-workflow/shared'
import {
  processMetricsLink,
  validateProcessSearch,
} from '../src/components/process-metrics/processSearch'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'
import { navPermissionForPath } from '../src/lib/nav'
import { validateObservationSearch } from '../src/routes/observability'

const read = (file: string) =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', ...file.split('/')), 'utf8')

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex, `missing source boundary: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endIndex, `missing source boundary: ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

function count(source: string, token: string): number {
  return source.split(token).length - 1
}

afterEach(() => {
  cleanup()
})

describe('RFC-616 processMetricsLink', () => {
  test.each(PROCESS_SUBJECT_KINDS)(
    '%s: opens the process tab on that subject, over the last 30 days',
    (kind) => {
      expect(processMetricsLink(kind, 'subject-1')).toEqual({
        to: '/observability',
        search: { tab: 'process', range: '30d', kind, subject: 'subject-1' },
      })
    },
  )

  test('a subject without an id uses the reserved "-"', () => {
    expect(PROCESS_NO_SUBJECT).toBe('-')
    expect(processMetricsLink('workflow', null).search.subject).toBe('-')
  })

  test.each(PROCESS_SUBJECT_KINDS)(
    '%s: the observability page keeps every field the link sends',
    (kind) => {
      for (const subjectId of ['subject-1', null]) {
        const { search } = processMetricsLink(kind, subjectId)
        expect(validateObservationSearch(search)).toEqual(search)
      }
    },
  )
})

describe('RFC-616 validateProcessSearch', () => {
  test('valid values are kept as they are', () => {
    expect(
      validateProcessSearch({
        subject: 'wf-1',
        view: 'stages',
        compare: 'period',
        origin: 'subtask',
        unit: 'task-1',
      }),
    ).toEqual({
      subject: 'wf-1',
      view: 'stages',
      compare: 'period',
      origin: 'subtask',
      unit: 'task-1',
    })
  })

  test('the reserved "-" subject is a subject like any other', () => {
    expect(validateProcessSearch({ subject: PROCESS_NO_SUBJECT })).toEqual({ subject: '-' })
  })

  test('nothing in the URL means nothing selected', () => {
    expect(validateProcessSearch({})).toEqual({})
  })

  test('invalid values are dropped, field by field', () => {
    expect(
      validateProcessSearch({
        subject: '   ',
        view: 'everything',
        compare: 'both',
        split: 'three',
        origin: 'elsewhere',
        unit: 7,
      }),
    ).toEqual({})
    // One bad field does not take its valid neighbours with it.
    expect(validateProcessSearch({ subject: 'wf-1', view: 'everything', unit: 'task-1' })).toEqual({
      subject: 'wf-1',
      unit: 'task-1',
    })
    expect(validateProcessSearch({ subject: 'x'.repeat(201) })).toEqual({})
    expect(validateProcessSearch({ subject: 'x'.repeat(200) })).toEqual({
      subject: 'x'.repeat(200),
    })
  })

  test('a revision comparison carries its revision, from a number or from URL text', () => {
    expect(validateProcessSearch({ compare: 'version', split: 3 })).toEqual({
      compare: 'version',
      split: 3,
    })
    expect(validateProcessSearch({ compare: 'version', split: '3' })).toEqual({
      compare: 'version',
      split: 3,
    })
    expect(validateProcessSearch({ compare: 'version', split: 0 })).toEqual({
      compare: 'version',
      split: 0,
    })
  })

  test('compare=version without a usable split is dropped: it would compare nothing', () => {
    expect(validateProcessSearch({ compare: 'version' })).toEqual({})
    for (const split of ['three', -1, 1.5, Number.NaN]) {
      expect(validateProcessSearch({ compare: 'version', split }), String(split)).toEqual({})
    }
    // The rest of the URL survives the dropped comparison.
    expect(validateProcessSearch({ subject: 'wf-1', compare: 'version' })).toEqual({
      subject: 'wf-1',
    })
  })

  test('a split means something only next to compare=version', () => {
    expect(validateProcessSearch({ compare: 'period', split: 3 })).toEqual({ compare: 'period' })
    expect(validateProcessSearch({ split: 3 })).toEqual({})
  })

  test('the process fields belong to the process tab only', () => {
    const fields = { subject: 'wf-1', view: 'stages', compare: 'period', unit: 'task-1' }
    expect(validateObservationSearch({ tab: 'process', range: '30d', ...fields })).toEqual({
      tab: 'process',
      range: '30d',
      ...fields,
    })
    expect(validateObservationSearch({ tab: 'tasks', range: '30d', ...fields })).toEqual({
      tab: 'tasks',
      range: '30d',
    })
  })
})

// The two shapes the pages use: a router <Link> (employee card) and a button
// that calls navigate (an action of the "More" dialog).
function mountEntries() {
  const root = createRootRoute({ component: () => <Outlet /> })
  const source = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: function Source() {
      const navigate = useNavigate()
      return (
        <>
          <Link {...processMetricsLink('digital-employee', 'emp-1')} data-testid="entry-link">
            metrics
          </Link>
          <button
            type="button"
            data-testid="entry-action"
            onClick={() => void navigate(processMetricsLink('workgroup', 'wg-1'))}
          >
            metrics
          </button>
        </>
      )
    },
  })
  const observability = createRoute({
    getParentRoute: () => root,
    path: '/observability',
    validateSearch: (raw: Record<string, unknown>) => validateObservationSearch(raw),
    component: () => <p data-testid="landed">process metrics</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([source, observability]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router as AnyRouter} />)
  return router
}

describe('RFC-616 entry navigation', () => {
  test('a card link carries the whole target in its href and lands on that subject', async () => {
    const router = mountEntries()
    const link = await screen.findByTestId('entry-link')
    const href = new URL(link.getAttribute('href') ?? '', 'http://frontend.test')
    expect(href.pathname).toBe('/observability')
    expect(Object.fromEntries(href.searchParams)).toEqual({
      tab: 'process',
      range: '30d',
      kind: 'digital-employee',
      subject: 'emp-1',
    })

    fireEvent.click(link)
    await screen.findByTestId('landed')
    expect(router.state.location.pathname).toBe('/observability')
    expect(router.state.location.search).toEqual({
      tab: 'process',
      range: '30d',
      kind: 'digital-employee',
      subject: 'emp-1',
    })
  })

  test('a "More" action navigates to the same page with its own subject', async () => {
    const router = mountEntries()
    fireEvent.click(await screen.findByTestId('entry-action'))
    await screen.findByTestId('landed')
    expect(router.state.location.pathname).toBe('/observability')
    expect(router.state.location.search).toEqual({
      tab: 'process',
      range: '30d',
      kind: 'workgroup',
      subject: 'wg-1',
    })
  })
})

describe('RFC-616 entry wiring (source level)', () => {
  // The entry is shown to the people who can open the page it leads to: the
  // same read permission the navigation catalog names for /observability.
  const permission = navPermissionForPath('/observability')
  const gate = `const canOpenMetrics = usePermission('${permission}')`

  test('the observability page is gated by one read permission', () => {
    expect(permission).not.toBeNull()
  })

  test('workflow editor: one gated action in the More dialog, for this workflow', () => {
    const source = read('routes/workflows.edit.tsx')
    expect(source).toContain(gate)
    expect(count(source, 'processMetricsLink(')).toBe(1)

    const list = between(source, '<ResourceActionList', '</ResourceActionList>')
    const entry = between(
      list,
      '{canOpenMetrics && (',
      'data-testid="workflow-process-metrics-entry"',
    )
    expect(entry).toContain('<ResourceActionItem')
    expect(entry).toContain("label={t('processMetrics.entry')}")
    expect(entry).toContain("description={t('editor.metricsActionHint')}")
    expect(entry).toContain("void navigate(processMetricsLink('workflow', workflowId))")
    // The dialog closes first: leaving with unsaved changes opens a confirmation,
    // and two stacked dialogs is the state the editor's own tests rule out.
    const close = entry.indexOf("setModalSurface('none')")
    expect(close).toBeGreaterThan(-1)
    expect(close).toBeLessThan(entry.indexOf('void navigate('))
    // No other guard sits between this one and the action it guards.
    expect(count(entry, ' && (')).toBe(1)
  })

  test('workgroup page: one gated action in the More dialog, for this workgroup', () => {
    const source = read('routes/workgroups.detail.tsx')
    expect(source).toContain(gate)
    expect(count(source, 'processMetricsLink(')).toBe(1)

    const list = between(source, '<ResourceActionList', '</ResourceActionList>')
    const entry = between(
      list,
      '{canOpenMetrics && (',
      'data-testid="workgroup-process-metrics-entry"',
    )
    expect(entry).toContain('<ResourceActionItem')
    expect(entry).toContain("label={t('processMetrics.entry')}")
    expect(entry).toContain("description={t('workgroups.metricsActionHint')}")
    expect(entry).toContain("void navigate(processMetricsLink('workgroup', props.initial.id))")
    const close = entry.indexOf('setHeaderSurface(null)')
    expect(close).toBeGreaterThan(-1)
    expect(close).toBeLessThan(entry.indexOf('void navigate('))
    expect(count(entry, ' && (')).toBe(1)
  })

  test('digital employee card: one gated link among the card actions, for this employee', () => {
    const source = read('routes/digital-employees.$typeRef.tsx')
    expect(count(source, 'processMetricsLink(')).toBe(1)

    const panel = source.slice(source.indexOf('function EmployeesPanel('))
    expect(panel).toContain(gate)
    const actions = between(panel, '<div className="employee-summary-card__actions">', '</article>')
    const entry = between(actions, '{canOpenMetrics ? (', ') : null}')
    // The employee definition's own id is the subject of its metrics.
    expect(entry).toContain("{...processMetricsLink('digital-employee', employee.id)}")
    // Styled like the card's other actions, and addressable per employee.
    expect(entry).toContain('className="btn btn--sm"')
    expect(entry).toContain('data-testid={`digital-employee-process-metrics-${employee.id}`}')
    expect(entry).toContain("{t('processMetrics.entry')}")
    expect(count(entry, '<Link')).toBe(1)
  })

  test('the entry label and the two action descriptions exist in both languages', () => {
    for (const bundle of [zhCN, enUS]) {
      expect(bundle.processMetrics.entry.length).toBeGreaterThan(0)
      expect(bundle.editor.metricsActionHint.length).toBeGreaterThan(0)
      expect(bundle.workgroups.metricsActionHint.length).toBeGreaterThan(0)
    }
    expect(zhCN.processMetrics.entry).not.toBe(enUS.processMetrics.entry)
    expect(zhCN.editor.metricsActionHint).not.toBe(enUS.editor.metricsActionHint)
    expect(zhCN.workgroups.metricsActionHint).not.toBe(enUS.workgroups.metricsActionHint)
    // Each description names its own kind of subject.
    expect(zhCN.editor.metricsActionHint).toContain('工作流')
    expect(zhCN.workgroups.metricsActionHint).toContain('工作组')
    expect(enUS.editor.metricsActionHint).toContain('workflow')
    expect(enUS.workgroups.metricsActionHint).toContain('workgroup')
  })
})
