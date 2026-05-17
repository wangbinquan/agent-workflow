// RFC-026 PR-B T11 — NodeInspector clarify branch: sessionMode segmented control.
//
// Two locks:
//   1. The segmented renders both options ('isolated' / 'inline') with the
//      correct aria-checked: the active one matches `node.sessionMode`
//      (undefined → 'isolated' per RFC-026 §2 default-fallback contract).
//   2. Clicking the inactive option fires onChange with the new
//      sessionMode embedded in node — the workflow.definition surfaces
//      the explicit user choice so future PUTs roundtrip it.
//
// If any of these go red, the editor either silently shows the wrong
// default or fails to persist user intent — a UX regression even before
// the runtime kicks in.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { NodeInspector } from '../src/components/canvas/NodeInspector'
import '../src/i18n'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ binary: 'opencode', cached: false, models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function makeDef(node: WorkflowNode): WorkflowDefinition {
  return { $schema_version: 3, inputs: [], nodes: [node], edges: [] }
}

function Host({
  initial,
  onChangeSpy,
}: {
  initial: WorkflowDefinition
  onChangeSpy: (def: WorkflowDefinition) => void
}) {
  const [def, setDef] = useState<WorkflowDefinition>(initial)
  return (
    <NodeInspector
      definition={def}
      selectedNodeId="c1"
      agents={[]}
      onChange={(next) => {
        setDef(next)
        onChangeSpy(next)
      }}
      onClose={() => {}}
    />
  )
}

describe('NodeInspector — RFC-026 clarify sessionMode segmented', () => {
  test('missing sessionMode renders Isolated as active (default fallback)', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef({
          id: 'c1',
          kind: 'clarify',
          title: '',
          description: '',
        } as unknown as WorkflowNode)}
        onChangeSpy={onChange}
      />,
    )
    const iso = screen.getByTestId('clarify-session-mode-isolated')
    const inl = screen.getByTestId('clarify-session-mode-inline')
    expect(iso.getAttribute('aria-checked')).toBe('true')
    expect(inl.getAttribute('aria-checked')).toBe('false')
  })

  test('explicit sessionMode="inline" renders Inline as active', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef({
          id: 'c1',
          kind: 'clarify',
          title: '',
          description: '',
          sessionMode: 'inline',
        } as unknown as WorkflowNode)}
        onChangeSpy={onChange}
      />,
    )
    const iso = screen.getByTestId('clarify-session-mode-isolated')
    const inl = screen.getByTestId('clarify-session-mode-inline')
    expect(iso.getAttribute('aria-checked')).toBe('false')
    expect(inl.getAttribute('aria-checked')).toBe('true')
  })

  test('clicking the inline option patches the node with sessionMode="inline"', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef({
          id: 'c1',
          kind: 'clarify',
          title: '',
          description: '',
        } as unknown as WorkflowNode)}
        onChangeSpy={onChange}
      />,
    )
    fireEvent.click(screen.getByTestId('clarify-session-mode-inline'))
    const last = onChange.mock.calls.at(-1)?.[0] as WorkflowDefinition
    const patched = last.nodes[0] as Record<string, unknown>
    expect(patched.sessionMode).toBe('inline')
    // Other fields preserved
    expect(patched.id).toBe('c1')
    expect(patched.kind).toBe('clarify')
  })

  test('clicking the isolated option writes the explicit value too (not undefined)', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef({
          id: 'c1',
          kind: 'clarify',
          title: '',
          description: '',
          sessionMode: 'inline',
        } as unknown as WorkflowNode)}
        onChangeSpy={onChange}
      />,
    )
    fireEvent.click(screen.getByTestId('clarify-session-mode-isolated'))
    const last = onChange.mock.calls.at(-1)?.[0] as WorkflowDefinition
    const patched = last.nodes[0] as Record<string, unknown>
    expect(patched.sessionMode).toBe('isolated')
  })
})
