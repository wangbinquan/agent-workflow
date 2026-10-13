// RFC-370: availability feedback must leave resource forms mounted and name
// unavailable groups without inventing a native grant or starting execution.
import { afterEach, beforeEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { HostExecutionStatus } from '@agent-workflow/shared'
import { HostExecutionNotice } from '../src/components/shell/HostExecutionBanner'
import {
  HostExecutionReadinessContext,
  useHostExecutionAvailability,
} from '../src/hooks/useHostExecutionAvailability'
import i18n from '../src/i18n'

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
})
afterEach(cleanup)

test('native installations have no fabricated host-status warning', () => {
  render(<HostExecutionNotice view={{ mode: 'native', status: null }} />)
  expect(screen.queryByTestId('host-execution-status')).toBeNull()
})

test('resource-only feedback preserves resource editing and explains delayed execution in both languages', async () => {
  const view: HostExecutionStatus = {
    mode: 'resource-only',
    status: {
      phase: 'standby',
      generation: 'resource-only',
      readyGroups: [],
      reason: 'host-execution-resource-only',
    },
  }
  const rendered = render(<HostExecutionNotice view={view} />)
  expect(screen.getByRole('status').textContent).toContain('Continue editing and saving resources')
  await i18n.changeLanguage('zh-CN')
  rendered.rerender(<HostExecutionNotice view={view} />)
  expect(screen.getByRole('status').textContent).toContain('可以继续编辑和保存资源')
})

test('a partial active host names available and unavailable groups separately', () => {
  render(
    <HostExecutionNotice
      view={{
        mode: 'execution',
        status: {
          phase: 'active',
          generation: 'partial-host',
          readyGroups: ['task'],
          reason: null,
        },
      }}
    />,
  )
  expect(screen.getByRole('status').textContent).toContain('Available now: Workflow tasks')
  expect(screen.getByRole('status').textContent).toContain(
    'Not ready: Automatic intent continuation',
  )
  expect(screen.getByRole('status').textContent).toContain('MCP tests')
})

function Actions() {
  const task = useHostExecutionAvailability('task'),
    mcp = useHostExecutionAvailability('diagnostics')
  return (
    <>
      <button className="btn" disabled={!task.available} title={task.unavailableReason}>
        Launch task
      </button>
      <button className="btn" disabled={!mcp.available} title={mcp.unavailableReason}>
        Test MCP
      </button>
      <input aria-label="Resource name" defaultValue="Preserved draft" />
    </>
  )
}

test('unknown and resource-only status keep execution disabled and preserve resource input state across activation', () => {
  const rendered = render(
    <HostExecutionReadinessContext.Provider value={undefined}>
      <Actions />
    </HostExecutionReadinessContext.Provider>,
  )
  const task = screen.getByRole('button', { name: 'Launch task' }) as HTMLButtonElement
  const mcp = screen.getByRole('button', { name: 'Test MCP' }) as HTMLButtonElement
  const resource = screen.getByRole('textbox', { name: 'Resource name' }) as HTMLInputElement
  resource.value = 'Unsaved edited resource'
  expect(task.disabled).toBe(true)
  expect(mcp.disabled).toBe(true)
  rendered.rerender(
    <HostExecutionReadinessContext.Provider
      value={{
        mode: 'resource-only',
        status: { phase: 'standby', generation: 'resource-only', readyGroups: [], reason: null },
      }}
    >
      <Actions />
    </HostExecutionReadinessContext.Provider>,
  )
  expect(task.disabled).toBe(true)
  rendered.rerender(
    <HostExecutionReadinessContext.Provider
      value={{
        mode: 'execution',
        status: { phase: 'active', generation: 'activated', readyGroups: ['task'], reason: null },
      }}
    >
      <Actions />
    </HostExecutionReadinessContext.Provider>,
  )
  expect(task.disabled).toBe(false)
  expect(mcp.disabled).toBe(true)
  expect(screen.getByRole('textbox', { name: 'Resource name' })).toBe(resource)
  expect(resource.value).toBe('Unsaved edited resource')
})
