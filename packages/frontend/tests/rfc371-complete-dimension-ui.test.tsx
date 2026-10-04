// RFC-371: complete-report dimensions retain shared Dialog details and exact four-bucket contributions.
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  CompleteObservationDimension,
  CompleteObservationDimensionTask,
  CompleteObservationMetrics,
} from '@agent-workflow/shared'
import { CompleteDimensionDetails } from '../src/components/observability/CompleteDimensionDetails'
import {
  CompleteDimensionRows,
  CompleteTaskRows,
} from '../src/components/observability/CompleteObservationTables'
import i18n from '../src/i18n'

const exact: CompleteObservationMetrics = {
  state: 'ready',
  invocations: '48',
  observedInvocations: '48',
  records: '48',
  tokens: {
    input: '9007199254740993',
    cacheRead: '2',
    cacheWrite: '3',
    output: '4',
    total: '9007199254741002',
  },
  cost: { currency: 'CNY', state: 'complete', amount: '1.25' },
}
const runtime: CompleteObservationDimension = {
  key: 'runtime:frozen-registration',
  kind: 'runtime',
  label: '受理时的算力',
  metrics: exact,
  taskCount: '48',
  selection: {
    runtime: {
      authority: 'local',
      sourceId: null,
      registrationId: 'original-registration',
      configurationRevision: 7,
      protocol: 'opencode',
    },
  },
}
const model: CompleteObservationDimension = {
  key: 'model:actual-model',
  kind: 'model',
  label: '实际模型名称',
  metrics: exact,
  taskCount: '48',
  selection: {
    model: {
      authority: 'local',
      sourceId: null,
      provider: 'original-provider',
      model: 'actual-model',
    },
  },
}
const task: CompleteObservationDimensionTask = {
  task: {
    id: 'last-original-task',
    name: '最后一个原任务',
    status: 'done',
    parentTaskId: null,
    startedAt: 1,
    finishedAt: 2,
    runningMs: 1,
    runningSince: null,
  },
  metrics: exact,
  timing: {
    wallMs: '1',
    runningMs: '1',
    range: { from: 1, to: 2 },
    intervals: { state: 'complete', activeUnionMs: '1', cumulativeMs: '1', unknown: '0' },
  },
}
function fixture(row: CompleteObservationDimension) {
  const onTask = vi.fn()
  function Page() {
    const [selected, select] = useState<CompleteObservationDimension | null>(null)
    const triggerRef = useRef<HTMLElement | null>(null),
      fallbackRef = useRef<HTMLDivElement | null>(null)
    return (
      <div ref={fallbackRef} tabIndex={-1}>
        <CompleteDimensionRows
          rows={[row]}
          selectedKey={selected?.key}
          triggerRef={triggerRef}
          onSelect={(value, trigger) => {
            triggerRef.current = trigger
            select(value)
          }}
        />
        {selected && (
          <CompleteDimensionDetails
            row={selected}
            onClose={() => select(null)}
            triggerRef={triggerRef}
            fallbackRef={fallbackRef}
          >
            <CompleteTaskRows rows={[{ ...task, metrics: selected.metrics }]} onTask={onTask} />
          </CompleteDimensionDetails>
        )}
      </div>
    )
  }
  render(<Page />)
  return { onTask }
}
beforeEach(async () => {
  await i18n.changeLanguage('zh')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test.each(['zh', 'en'])(
  'runtime restores metadata, exact counters and shared close/focus in %s',
  async (language) => {
    await i18n.changeLanguage(language)
    const f = fixture(runtime),
      trigger = screen.getByRole('button', {
        name: i18n.t('runObservability.runtimeView', { name: runtime.label }),
      })
    expect(trigger.textContent).toBe(runtime.label)
    expect(trigger.closest('th')?.textContent).toContain(
      i18n.t('runObservability.revision', { revision: 7 }),
    )
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', {
      name: i18n.t('runObservability.runtimeContributions', { name: runtime.label }),
    })
    expect(within(dialog).getByText('original-registration')).toBeTruthy()
    expect(within(dialog).getByText('opencode')).toBeTruthy()
    expect(within(dialog).getByText(i18n.t('runObservability.runtimeConfiguration'))).toBeTruthy()
    expect(
      within(dialog).getByText(i18n.t('runObservability.runtimeContributionHint')),
    ).toBeTruthy()
    expect(
      dialog.querySelector('[data-observation-contributions]')?.classList.contains('stack--md'),
    ).toBe(true)
    expect(dialog.querySelectorAll('.card')).toHaveLength(2)
    const bins = dialog.querySelector('[data-token-buckets]')!
    expect(bins.querySelector('[data-token-bucket="input"] dd')?.textContent).toBe(
      BigInt('9007199254740993').toLocaleString(language),
    )
    for (const [bucket, expected] of [
      ['cacheRead', '2'],
      ['cacheWrite', '3'],
      ['output', '4'],
    ])
      expect(bins.querySelector('[data-token-bucket="' + bucket + '"] dd')?.textContent).toBe(
        expected,
      )
    expect(dialog.textContent).toContain('¥1.25')
    expect(dialog.textContent).not.toContain('$')
    const last = within(dialog).getByRole('button', { name: task.task.name })
    fireEvent.click(last)
    expect(f.onTask).toHaveBeenCalledWith(task.task.id, last)
    fireEvent.click(
      within(dialog.querySelector<HTMLElement>('.dialog__footer')!).getByRole('button', {
        name: i18n.t('common.close'),
        exact: true,
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  },
)

test('model shows frozen actual provider and unpriced money preserves qualified complete Tokens', async () => {
  fixture({
    ...model,
    metrics: { ...exact, cost: { currency: 'CNY', state: 'unpriced', amount: null } },
  })
  const trigger = screen.getByRole('button', {
    name: i18n.t('runObservability.modelView', { name: model.label }),
  })
  expect(trigger.closest('th')?.textContent).toContain('original-provider')
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog', {
    name: i18n.t('runObservability.modelContributions', { name: model.label }),
  })
  expect(within(dialog).getByText('original-provider')).toBeTruthy()
  expect(
    within(dialog).getByText(i18n.t('runObservability.dimensionContributionHint')),
  ).toBeTruthy()
  expect(dialog.textContent).toContain(BigInt(exact.tokens.total).toLocaleString('zh'))
  expect(dialog.textContent).toContain(i18n.t('runObservability.unpriced'))
  expect(dialog.textContent).not.toContain('¥')
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})

test('not-ready dimensions retain Task entry and four unknown buckets without numeric subtotals', async () => {
  fixture({
    ...runtime,
    label: null,
    metrics: { state: 'not-ready', gaps: ['missing-original-page'] },
  })
  fireEvent.click(
    screen.getByRole('button', {
      name: i18n.t('runObservability.runtimeView', {
        name: i18n.t('runObservability.runtimeNameUnknown'),
      }),
    }),
  )
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByRole('button', { name: task.task.name })).toBeTruthy()
  expect(dialog.textContent).toContain('missing-original-page')
  for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'])
    expect(dialog.querySelector('[data-token-bucket="' + bucket + '"] dd')?.textContent).toBe(
      i18n.t('runObservability.unknown'),
    )
  expect(dialog.textContent).not.toContain('9,007,199')
  expect(dialog.textContent).not.toContain('¥')
})
