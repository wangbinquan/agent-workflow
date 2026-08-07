// RFC-253 T43 (AC-37 / AC-38) — the script Inspector must SHOW the envelope,
// not describe it.
//
// The panel used to carry one sentence: `<workflow-output nonce="$AW_ENVELOPE_NONCE">`.
// A user read it, typed it into a python node, and the run failed
// `script-envelope-missing` — D5 guarantees the platform substitutes nothing
// into a body, so `$AW_ENVELOPE_NONCE` stayed a literal and the nonce-scoped
// parser matched nothing. These lock the replacement:
//   - a sample exists ONLY in envelope mode (single-port mode must not be
//     taught a protocol it does not use);
//   - the sample tracks the declared ports and the selected language;
//   - what the copy button puts on the clipboard reads the nonce from the
//     environment rather than embedding the literal;
//   - the input sample checks the spill variable first (AC-3 is otherwise
//     invisible in the UI).
// The generator itself is proven runnable in
// `packages/backend/tests/rfc253-script-snippets.test.ts`.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { ScriptEdit } from '../src/components/canvas/inspector/ScriptEdit'

vi.mock('../src/hooks/useActor', () => ({
  useActor: () => ({
    data: {
      user: { id: 'me', username: 'me', displayName: 'Me', role: 'admin', status: 'active' },
      source: 'session',
      permissions: ['scripts:author'],
      linkedIdentities: [],
      pats: [],
    },
  }),
  usePermission: () => true,
}))

const copyText = vi.fn(async () => true)
vi.mock('../src/lib/clipboard', () => ({ copyText: (text: string) => copyText(text) }))

afterEach(() => {
  cleanup()
  copyText.mockClear()
})

function scriptNode(extra: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: 's1',
    kind: 'script',
    position: { x: 0, y: 0 },
    language: 'python',
    script: 'print(1)',
    ...extra,
  } as unknown as WorkflowNode
}

function renderEdit(node: WorkflowNode, edges: WorkflowDefinition['edges'] = []) {
  const definition: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes: [node],
    edges,
  } as WorkflowDefinition
  const onPatch = vi.fn()
  render(
    <ScriptEdit
      node={node}
      agents={[] as Agent[]}
      definition={definition}
      onPatch={onPatch}
      onCommitDef={vi.fn()}
      onTransition={vi.fn()}
      onHistoryBoundary={vi.fn()}
    />,
  )
  return { onPatch }
}

const inboundEdge = {
  id: 'e1',
  source: { nodeId: 'a1', portName: 'out' },
  target: { nodeId: 's1', portName: 'git-diff' },
} as WorkflowDefinition['edges'][number]

describe('T43 — envelope sample', () => {
  test('single-port mode gets no envelope sample', () => {
    renderEdit(scriptNode())
    expect(screen.queryByTestId('script-envelope-sample')).toBeNull()
  })

  test('declaring ports reveals a read-only sample for the selected language', () => {
    renderEdit(scriptNode({ outputs: [{ name: 'summary' }] }))
    const sample = screen.getByTestId('script-envelope-sample')
    expect(sample.getAttribute('data-readonly')).toBe('true')
    expect(sample.getAttribute('data-language')).toBe('python')
  })

  test('the copied text reads the nonce from the environment, not as a literal', () => {
    renderEdit(scriptNode({ outputs: [{ name: 'summary' }, { name: 'findings' }] }))
    fireEvent.click(screen.getByTestId('script-envelope-sample-copy'))
    expect(copyText).toHaveBeenCalledTimes(1)
    const copied = copyText.mock.calls[0]?.[0] as string
    expect(copied).toContain("os.environ['AW_ENVELOPE_NONCE']")
    // The exact shape that broke for the reporting user.
    expect(copied).not.toContain('nonce="$AW_ENVELOPE_NONCE"')
    expect(copied).toContain('<port name="summary">TODO</port>')
    expect(copied).toContain('<port name="findings">TODO</port>')
  })

  test('the sample follows the language segmented control', () => {
    renderEdit(scriptNode({ language: 'bash', outputs: [{ name: 'summary' }] }))
    expect(screen.getByTestId('script-envelope-sample').getAttribute('data-language')).toBe('bash')
    fireEvent.click(screen.getByTestId('script-envelope-sample-copy'))
    const copied = copyText.mock.calls[0]?.[0] as string
    // bash is the one language where the shell itself expands the variable.
    expect(copied).toContain('<workflow-output nonce="$AW_ENVELOPE_NONCE">')
    expect(copied).toContain('cat <<EOF')
  })
})

describe('T43 — input sample', () => {
  test('no inbound edges ⇒ no sample to give', () => {
    renderEdit(scriptNode())
    expect(screen.queryByTestId('script-input-sample')).toBeNull()
  })

  test('an inbound edge produces a reader keyed by the folded variable name', () => {
    renderEdit(scriptNode(), [inboundEdge])
    expect(screen.getByTestId('script-input-sample')).not.toBeNull()
    fireEvent.click(screen.getByTestId('script-input-sample-copy'))
    const copied = copyText.mock.calls[0]?.[0] as string
    expect(copied).toContain("GIT_DIFF = read_port('GIT_DIFF')")
    // The spill branch must come first or a large upstream value reads as ''.
    expect(copied.indexOf('AW_PORT_FILE_')).toBeLessThan(
      copied.indexOf("os.environ.get('AW_PORT_' + suffix"),
    )
  })
})
