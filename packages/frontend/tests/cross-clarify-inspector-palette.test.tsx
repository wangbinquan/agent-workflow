// RFC-056 PR-C T9 — locks NodeInspector + palette wiring for cross-clarify.
//
// LOCKS:
//   1. NodeInspector renders a section keyed by `data-testid='cross-clarify-inspector'`
//      when the selected node is `clarify-cross-agent`.
//   2. The questioner segmented control fires `onPatch` with a
//      sessionModeForQuestioner delta when clicked. (The designer-rerun
//      session toggle was removed by RFC-056 patch 2026-06-22 — dead config.)
//   3. The questioner segmented control defaults to 'isolated' on a fresh node.
//   4. Palette catalog exposes a `clarify-cross-agent` entry under the
//      Human section.
//   5. Source-text guard: clarify-cross-agent reaches NodeInspector.tsx /
//      nodePalette.ts / WorkflowCanvas.tsx so a future rename catches.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render } from '@testing-library/react'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { NodeInspector } from '../src/components/canvas/NodeInspector'
import { buildPalette, makeNode } from '../src/components/canvas/nodePalette'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

const NODE_INSPECTOR_TSX = resolve(
  __dirname,
  '..',
  'src',
  'components',
  'canvas',
  'NodeInspector.tsx',
)
const PALETTE_TS = resolve(__dirname, '..', 'src', 'components', 'canvas', 'nodePalette.ts')
const CANVAS_TSX = resolve(__dirname, '..', 'src', 'components', 'canvas', 'WorkflowCanvas.tsx')

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mkDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [{ id: 'cc1', kind: 'clarify-cross-agent', title: '', description: '' }],
    edges: [],
    outputs: [],
  }
}

function renderInspector(def: WorkflowDefinition, onChange: (next: WorkflowDefinition) => void) {
  return render(
    <NodeInspector
      definition={def}
      selectedNodeId="cc1"
      agents={[] as Agent[]}
      onChange={onChange}
      onClose={() => undefined}
    />,
  )
}

describe('RFC-056 NodeInspector — clarify-cross-agent', () => {
  test('renders the cross-clarify inspector section when selected', () => {
    const def = mkDef()
    renderInspector(def, vi.fn())
    expect(document.querySelector('[data-testid="cross-clarify-inspector"]')).not.toBeNull()
    expect(
      document.querySelector('[data-testid="cross-clarify-session-mode-questioner"]'),
    ).not.toBeNull()
    // The designer session-mode control is intentionally absent (removed by
    // RFC-056 patch 2026-06-22 — the designer rerun is always isolated).
    expect(document.querySelector('[data-testid="cross-clarify-session-mode-designer"]')).toBeNull()
  })

  test('clicking the questioner "inline" segmented option fires onChange with sessionModeForQuestioner=inline', () => {
    const def = mkDef()
    const onChange = vi.fn<(next: WorkflowDefinition) => void>()
    renderInspector(def, onChange)
    const btn = document.querySelector(
      '[data-testid="cross-clarify-session-mode-questioner-inline"]',
    ) as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    fireEvent.click(btn!)
    const lastDef = onChange.mock.calls.at(-1)?.[0]
    expect(lastDef).toBeDefined()
    const node = lastDef!.nodes.find((n) => n.id === 'cc1') as
      | (WorkflowNode & { sessionModeForQuestioner?: string })
      | undefined
    expect(node?.sessionModeForQuestioner).toBe('inline')
  })

  test('the questioner segmented control defaults to "isolated" on a freshly-dropped node', () => {
    const def = mkDef()
    renderInspector(def, vi.fn())
    const isolatedQuestioner = document.querySelector(
      '[data-testid="cross-clarify-session-mode-questioner-isolated"]',
    ) as HTMLButtonElement | null
    expect(isolatedQuestioner?.getAttribute('aria-checked')).toBe('true')
  })
})

// Locks the parity between same-node clarify (RFC-023) and cross-clarify
// (RFC-056) inspector layouts: the cross-clarify panel must surface the same
// read-only status fields (linked questioner / linked designer / in-loop)
// the same-node clarify panel exposes. Without these the two detail panels
// drift apart (user-reported regression 2026-05-22). If any of these go red
// the inspector lost a status field — restore before relaxing the lock.
describe('RFC-056 NodeInspector parity with RFC-023 clarify — status fields', () => {
  test('missing wiring: shows linked-questioner-missing + linked-designer-missing + in-loop-warning', () => {
    const def = mkDef()
    renderInspector(def, vi.fn())
    expect(
      document.querySelector('[data-testid="cross-clarify-linked-questioner-missing"]'),
    ).not.toBeNull()
    expect(
      document.querySelector('[data-testid="cross-clarify-linked-designer-missing"]'),
    ).not.toBeNull()
    expect(document.querySelector('[data-testid="cross-clarify-in-loop-warning"]')).not.toBeNull()
  })

  test('shows linked-questioner / linked-designer chips when their edges exist, and in-loop chip when wrapped', () => {
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'q1', kind: 'agent-single' } as unknown as WorkflowNode,
        { id: 'd1', kind: 'agent-single' } as unknown as WorkflowNode,
        { id: 'cc1', kind: 'clarify-cross-agent', title: '', description: '' },
        {
          id: 'loop1',
          kind: 'wrapper-loop',
          nodeIds: ['cc1'],
          maxIterations: 3,
          exitCondition: { kind: 'port-empty' },
        } as unknown as WorkflowNode,
      ],
      edges: [
        {
          id: 'e_q_ask',
          source: { nodeId: 'q1', portName: '__clarify__' },
          target: { nodeId: 'cc1', portName: 'questions' },
        },
        {
          id: 'e_cc_to_d',
          source: { nodeId: 'cc1', portName: 'to_designer' },
          target: { nodeId: 'd1', portName: '__external_feedback__' },
        },
      ],
      outputs: [],
    }
    renderInspector(def, vi.fn())
    const q = document.querySelector(
      '[data-testid="cross-clarify-linked-questioner"]',
    ) as HTMLElement | null
    const d = document.querySelector(
      '[data-testid="cross-clarify-linked-designer"]',
    ) as HTMLElement | null
    expect(q?.textContent).toBe('q1')
    expect(d?.textContent).toBe('d1')
    expect(document.querySelector('[data-testid="cross-clarify-in-loop"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="cross-clarify-in-loop-warning"]')).toBeNull()
  })
})

describe('RFC-056 palette catalog', () => {
  test('buildPalette includes a clarify-cross-agent item in the Human section', () => {
    const sections = buildPalette([], (key) => key)
    const human = sections.find((s) => s.label === 'editor.paletteHuman')
    expect(human).toBeDefined()
    const cross = human?.items.find(
      (it) => (it.item as { kind: string }).kind === 'clarify-cross-agent',
    )
    expect(cross).toBeDefined()
  })

  test('makeNode for clarify-cross-agent produces a node with kind=clarify-cross-agent and default fields', () => {
    const node = makeNode(
      { kind: 'clarify-cross-agent' },
      { x: 0, y: 0 },
      { existingIds: new Set() },
    )
    expect(node.kind).toBe('clarify-cross-agent')
    const rec = node as unknown as Record<string, unknown>
    expect(rec.title).toBe('')
    expect(rec.description).toBe('')
  })
})

describe('RFC-056 source-text grep guards (T9)', () => {
  test('CrossClarifyEdit references cross-clarify-inspector + session-mode-* testids', () => {
    // RFC-146 T3: the cross-clarify branch moved from the NodeInspector
    // switch to inspector/CrossClarifyEdit.tsx; NodeInspector keeps the
    // 'clarify-cross-agent' registry entry (checked below).
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'components', 'canvas', 'inspector', 'CrossClarifyEdit.tsx'),
      'utf-8',
    )
    expect(src).toContain('cross-clarify-inspector')
    expect(src).toContain('cross-clarify-session-mode-questioner')
    expect(src).toContain('sessionModeForQuestioner')
    // Designer session-mode toggle removed (RFC-056 patch 2026-06-22).
    expect(src).not.toContain('sessionModeForDesigner')
    // The registry itself still names the kind.
    const inspector = readFileSync(NODE_INSPECTOR_TSX, 'utf-8')
    expect(inspector).toMatch(/'clarify-cross-agent':\s*CrossClarifyEdit/)
  })

  test('nodePalette.ts has clarify-cross-agent in PaletteItem + SHORT', () => {
    const src = readFileSync(PALETTE_TS, 'utf-8')
    expect(src).toMatch(/'clarify-cross-agent'/)
    expect(src).toContain('crossClarify.canvas.paletteLabel')
  })

  test('WorkflowCanvas.tsx wires CrossClarifyNode + classifyCrossClarifyConnection', () => {
    const src = readFileSync(CANVAS_TSX, 'utf-8')
    expect(src).toContain('CrossClarifyNode')
    expect(src).toContain('classifyCrossClarifyConnection')
    expect(src).toContain('applyCrossClarifyQuestionerReverseDrag')
    expect(src).toContain('applyCrossClarifyDesignerDrag')
    expect(src).toContain('clearCrossClarifyEdgesForRemovedNodes')
  })
})
