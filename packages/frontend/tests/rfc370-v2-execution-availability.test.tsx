// RFC-370 v2 H7 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md):
// execution entrypoints are disabled only while a CrewStation-hosted instance is
// known not to be active. Standalone, and an unknown status (still loading or a
// failed read), never block the UI; the standby banner shows only for a hosted
// instance without execution.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import type { ExecutionGroup, ExecutionStatus } from '@agent-workflow/shared'
import {
  ExecutionStatusContext,
  useExecutionAvailability,
} from '../src/hooks/useExecutionAvailability'
import { ExecutionStandbyBanner } from '../src/components/shell/ExecutionStandbyBanner'
import i18n from '../src/i18n'

afterEach(() => {
  cleanup()
})

function Probe(props: { group: ExecutionGroup }) {
  const execution = useExecutionAvailability(props.group)
  let asserted = 'ok'
  try {
    execution.assertAvailable()
  } catch (error) {
    asserted = (error as Error).message
  }
  return (
    <button type="button" disabled={!execution.available} title={execution.unavailableReason}>
      {asserted}
    </button>
  )
}

function renderWith(status: ExecutionStatus | undefined, node: React.ReactElement) {
  return render(
    <ExecutionStatusContext.Provider value={status}>{node}</ExecutionStatusContext.Provider>,
  )
}

describe('useExecutionAvailability', () => {
  test('outside the app shell the instance is standalone and available', () => {
    render(<Probe group="task" />)
    const button = screen.getByRole<HTMLButtonElement>('button')
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('ok')
  })

  test('an unknown status never blocks execution', () => {
    renderWith(undefined, <Probe group="intent" />)
    expect(screen.getByRole<HTMLButtonElement>('button').disabled).toBe(false)
  })

  test('an active hosted instance is available', () => {
    renderWith({ mode: 'crewstation', state: 'active', reason: null }, <Probe group="memory" />)
    expect(screen.getByRole<HTMLButtonElement>('button').disabled).toBe(false)
  })

  test('a standby or frozen hosted instance disables execution with a reason', async () => {
    await i18n.changeLanguage('en-US')
    const reason = i18n.t('execution.unavailable', {
      group: i18n.t('execution.group.diagnostics'),
    })
    for (const state of ['standby', 'frozen'] as const) {
      const view = renderWith(
        { mode: 'crewstation', state, reason: null },
        <Probe group="diagnostics" />,
      )
      const button = screen.getByRole<HTMLButtonElement>('button')
      expect(button.disabled).toBe(true)
      expect(button.getAttribute('title')).toBe(reason)
      expect(button.textContent).toBe(reason)
      view.unmount()
    }
  })
})

describe('ExecutionStandbyBanner', () => {
  test('stays hidden for standalone, unknown and active instances', () => {
    for (const status of [
      undefined,
      { mode: 'standalone', state: 'active', reason: null },
      { mode: 'crewstation', state: 'active', reason: null },
    ] as const) {
      const view = renderWith(status, <ExecutionStandbyBanner />)
      expect(screen.queryByTestId('execution-status')).toBeNull()
      view.unmount()
    }
  })

  test('explains standby and frozen hosted instances', async () => {
    await i18n.changeLanguage('zh-CN')
    for (const state of ['standby', 'frozen'] as const) {
      const view = renderWith(
        { mode: 'crewstation', state, reason: null },
        <ExecutionStandbyBanner />,
      )
      const banner = screen.getByTestId('execution-status')
      expect(banner.textContent).toContain(i18n.t(`execution.${state}`))
      expect(banner.textContent).toContain(i18n.t(`execution.${state}Description`))
      view.unmount()
    }
  })
})
