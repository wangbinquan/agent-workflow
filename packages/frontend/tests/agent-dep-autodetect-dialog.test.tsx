// RFC-038 T2 — locks DependencyAutodetectDialog UI:
//   (1) renders one section per non-empty group with all candidates checked
//       by default
//   (2) toggling a checkbox then clicking Import calls onApply with only the
//       checked subset and closes
//   (3) Cancel does NOT call onApply and closes
//   (4) empty result → EmptyState renders, footer collapses to Close only
//   (5) loadFailures surface as muted footer notes

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DependencyAutodetectDialog } from '../src/components/agents/DependencyAutodetectDialog'
import type { DetectionResult } from '../src/lib/agent-dep-detect'
import { setBaseUrl, setToken } from '../src/stores/auth'

const FULL_RESULT: DetectionResult = {
  agents: {
    candidates: [{ id: 'agent-git-diff', name: 'git-diff-snapshot', description: 'diff' }],
  },
  skills: { candidates: [{ id: 'skill-playwright', name: 'playwright-runner' }] },
  mcps: { candidates: [{ id: 'mcp-code-review', name: 'code-review-mcp' }] },
  plugins: { candidates: [{ id: 'plugin-schema', name: 'schema-validator' }] },
}

const EMPTY_RESULT: DetectionResult = {
  agents: { candidates: [] },
  skills: { candidates: [] },
  mcps: { candidates: [] },
  plugins: { candidates: [] },
}

function renderDialog(node: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DependencyAutodetectDialog', () => {
  test('renders four sections with candidates pre-checked', () => {
    renderDialog(
      <DependencyAutodetectDialog
        open
        result={FULL_RESULT}
        loadFailures={[]}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId('autodetect-section-agents')).toBeTruthy()
    expect(screen.getByTestId('autodetect-section-skills')).toBeTruthy()
    expect(screen.getByTestId('autodetect-section-mcps')).toBeTruthy()
    expect(screen.getByTestId('autodetect-section-plugins')).toBeTruthy()
    const cb = screen.getByTestId('autodetect-checkbox-agents-agent-git-diff') as HTMLInputElement
    expect(cb.checked).toBe(true)
  })

  test('toggle + import → onApply with checked subset only, onClose not called by apply', () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    renderDialog(
      <DependencyAutodetectDialog
        open
        result={FULL_RESULT}
        loadFailures={[]}
        onApply={onApply}
        onClose={onClose}
      />,
    )
    // Uncheck the skills candidate.
    fireEvent.click(screen.getByTestId('autodetect-checkbox-skills-skill-playwright'))
    fireEvent.click(screen.getByTestId('autodetect-apply'))
    expect(onApply).toHaveBeenCalledTimes(1)
    const selection = onApply.mock.calls[0]![0]
    expect(selection.agents).toEqual(['agent-git-diff'])
    expect(selection.skills).toEqual([])
    expect(selection.mcps).toEqual(['mcp-code-review'])
    expect(selection.plugins).toEqual(['plugin-schema'])
    // Apply itself does not close — parent owns dialog open state.
    expect(onClose).not.toHaveBeenCalled()
  })

  test('cancel button does not call onApply', () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    renderDialog(
      <DependencyAutodetectDialog
        open
        result={FULL_RESULT}
        loadFailures={[]}
        onApply={onApply}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByTestId('autodetect-cancel'))
    expect(onApply).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  test('empty result → EmptyState shown, only Close button in footer', () => {
    const onClose = vi.fn()
    renderDialog(
      <DependencyAutodetectDialog
        open
        result={EMPTY_RESULT}
        loadFailures={[]}
        onApply={vi.fn()}
        onClose={onClose}
      />,
    )
    expect(screen.getByTestId('empty-state')).toBeTruthy()
    const closeBtn = screen.getByTestId('autodetect-close')
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByTestId('autodetect-apply')).toBeNull()
  })

  test('loadFailures render muted notes for each failed group', () => {
    renderDialog(
      <DependencyAutodetectDialog
        open
        result={FULL_RESULT}
        loadFailures={['plugins']}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const failures = document.querySelectorAll('.agent-dep-autodetect__failures li')
    expect(failures.length).toBe(1)
  })

  test('section hidden when its candidates array is empty', () => {
    const result: DetectionResult = {
      agents: { candidates: [{ id: 'agent-a', name: 'a' }] },
      skills: { candidates: [] },
      mcps: { candidates: [] },
      plugins: { candidates: [] },
    }
    renderDialog(
      <DependencyAutodetectDialog
        open
        result={result}
        loadFailures={[]}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('autodetect-section-skills')).toBeNull()
    expect(screen.queryByTestId('autodetect-section-agents')).toBeTruthy()
  })

  test('duplicate names show resolved owner cues and keep distinct id selections', async () => {
    setBaseUrl('http://daemon.test')
    setToken('tok')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: 'owner-a', displayName: 'Alice' },
          { id: 'owner-b', displayName: 'Bob' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const onApply = vi.fn()
    const result: DetectionResult = {
      agents: {
        candidates: [
          { id: 'agent-a', name: 'reviewer', ownerUserId: 'owner-a' },
          { id: 'agent-b', name: 'reviewer', ownerUserId: 'owner-b' },
        ],
      },
      skills: { candidates: [] },
      mcps: { candidates: [] },
      plugins: { candidates: [] },
    }
    renderDialog(
      <DependencyAutodetectDialog
        open
        result={result}
        loadFailures={[]}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    )
    expect(await screen.findByText('reviewer · Alice')).toBeTruthy()
    expect(await screen.findByText('reviewer · Bob')).toBeTruthy()
    fireEvent.click(screen.getByTestId('autodetect-checkbox-agents-agent-a'))
    fireEvent.click(screen.getByTestId('autodetect-apply'))
    expect(onApply).toHaveBeenCalledWith({
      agents: ['agent-b'],
      skills: [],
      mcps: [],
      plugins: [],
    })
  })
})
