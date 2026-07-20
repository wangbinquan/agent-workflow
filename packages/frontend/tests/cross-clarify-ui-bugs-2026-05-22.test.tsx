// RFC-056 follow-up — 2026-05-22 UI bug report (three regressions reported
// after the cross-clarify canvas UX shipped):
//
//   1. Deleting one half of the (ask, ans) questioner pair leaves the
//      sibling behind — runtime sees a half-wired channel.
//   2. Forward drag from cross-clarify.to_questioner onto an agent's left
//      input strip is rejected because the classifier required the drop
//      to land on the `__clarify_response__` system target handle, which
//      a fresh agent does not yet render (the handle only materialises
//      AFTER an outbound edge exists — see WorkflowCanvas.computePorts
//      fallback). User report: "从 cross-clarify 右侧 output 拖到 agent
//      左侧拖不上".
//   3. The two output handles on the cross-clarify node have no visible
//      label, so a user can't tell which handle should be wired to which
//      agent (questioner vs designer).
//
// LOCKS:
//   - cascadeRemoveCrossClarifyChannel drops the (ask, ans) pair when
//     either half is removed.
//   - cascade is wired into WorkflowCanvas.commitChange so all delete
//     paths (Delete key, EdgeInspector remove) go through it.
//   - classifyCrossClarifyConnection no longer requires
//     targetHandle === '__clarify_response__' for the to_questioner
//     forward direction.
//   - The two CrossClarifyNode handles have data-testid'd label siblings
//     so the user can tell them apart at a glance.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'
import {
  applyCrossClarifyDesignerDrag,
  applyCrossClarifyQuestionerReverseDrag,
  cascadeRemoveCrossClarifyChannel,
  classifyCrossClarifyConnection,
} from '../src/components/canvas/crossClarifyDragHelper'
import { CrossClarifyNode } from '../src/components/canvas/nodes/CrossClarifyNode'
import '../src/i18n'

const WORKFLOW_TRANSITION_TS = resolve(__dirname, '..', 'src', 'lib', 'workflow-transition.ts')

function baseDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [],
    outputs: [],
  }
}

function wireQuestioner(def: WorkflowDefinition): WorkflowDefinition {
  return applyCrossClarifyQuestionerReverseDrag(def, {
    questionerNodeId: 'questioner',
    crossClarifyNodeId: 'cross1',
  })
}

describe('Bug 1: cascadeRemoveCrossClarifyChannel drops the sibling on single-edge delete', () => {
  test('removing the ASK edge also drops the ANS edge of the same pair', () => {
    const def = wireQuestioner(baseDef())
    const askEdge = def.edges.find((e) => e.source.portName === '__clarify__') as WorkflowEdge
    expect(askEdge).toBeDefined()
    // Simulate the user deleting only the ask edge.
    const afterDelete: WorkflowDefinition = {
      ...def,
      edges: def.edges.filter((e) => e.id !== askEdge.id),
    }
    expect(afterDelete.edges.length).toBe(1)
    const next = cascadeRemoveCrossClarifyChannel(afterDelete, [askEdge])
    // Both halves should be gone.
    expect(next.edges.length).toBe(0)
  })

  test('removing the ANS edge also drops the ASK edge of the same pair', () => {
    const def = wireQuestioner(baseDef())
    const ansEdge = def.edges.find((e) => e.source.portName === 'to_questioner') as WorkflowEdge
    expect(ansEdge).toBeDefined()
    const afterDelete: WorkflowDefinition = {
      ...def,
      edges: def.edges.filter((e) => e.id !== ansEdge.id),
    }
    const next = cascadeRemoveCrossClarifyChannel(afterDelete, [ansEdge])
    expect(next.edges.length).toBe(0)
  })

  test('removing the DESIGNER edge does NOT cascade — it has no sibling', () => {
    let def = wireQuestioner(baseDef())
    def = applyCrossClarifyDesignerDrag(def, {
      crossClarifyNodeId: 'cross1',
      designerNodeId: 'designer',
    })
    expect(def.edges.length).toBe(3)
    const designerEdge = def.edges.find((e) => e.source.portName === 'to_designer') as WorkflowEdge
    expect(designerEdge).toBeDefined()
    const afterDelete: WorkflowDefinition = {
      ...def,
      edges: def.edges.filter((e) => e.id !== designerEdge.id),
    }
    const next = cascadeRemoveCrossClarifyChannel(afterDelete, [designerEdge])
    // Questioner pair untouched (2 edges remain).
    expect(next.edges.length).toBe(2)
  })

  test('returns def by reference when no cross-clarify edges were removed', () => {
    const def = wireQuestioner(baseDef())
    const noisyEdge: WorkflowEdge = {
      id: 'unrelated',
      source: { nodeId: 'designer', portName: 'main' },
      target: { nodeId: 'questioner', portName: 'inp' },
    }
    const next = cascadeRemoveCrossClarifyChannel(def, [noisyEdge])
    expect(next).toBe(def)
  })

  test('the canonical workflow transition invokes cross-clarify cascade after clarify cascade', () => {
    const src = readFileSync(WORKFLOW_TRANSITION_TS, 'utf8')
    expect(src).toContain('cascadeRemoveCrossClarifyChannel')
    // Ordering: RFC-023 cascade must come before RFC-056 cascade so
    // staged-by-reference short-circuits chain naturally. (Both helpers
    // return def by reference on no-op, so ordering is mostly cosmetic.)
    const rfc023 = src.indexOf('cascadeRemoveClarifyChannel(staged')
    const rfc056 = src.indexOf('cascadeRemoveCrossClarifyChannel(staged')
    expect(rfc023).toBeGreaterThan(-1)
    expect(rfc056).toBeGreaterThan(-1)
    expect(rfc023).toBeLessThan(rfc056)
  })
})

describe('Bug 2: classifyCrossClarifyConnection accepts to_questioner forward drag onto the catch-all', () => {
  test('to_questioner source + ANY target handle matches as questioner-reverse', () => {
    const def = baseDef()
    // xyflow drop onto the catch-all left strip of the agent passes
    // `__inbound__` as targetHandle. Before the 2026-05-22 fix the
    // classifier required `__clarify_response__` and rejected this.
    const out = classifyCrossClarifyConnection(def, {
      source: 'cross1',
      target: 'questioner',
      sourceHandle: 'to_questioner',
      targetHandle: '__inbound__',
    })
    expect(out).toEqual({
      kind: 'questioner-reverse',
      questionerNodeId: 'questioner',
      crossClarifyNodeId: 'cross1',
    })
  })

  test('to_questioner source + null target handle still matches (xyflow can omit targetHandle)', () => {
    const def = baseDef()
    const out = classifyCrossClarifyConnection(def, {
      source: 'cross1',
      target: 'questioner',
      sourceHandle: 'to_questioner',
      targetHandle: null,
    })
    expect(out?.kind).toBe('questioner-reverse')
  })

  test('to_questioner source still matches the canonical __clarify_response__ target handle (no regression)', () => {
    const def = baseDef()
    const out = classifyCrossClarifyConnection(def, {
      source: 'cross1',
      target: 'questioner',
      sourceHandle: 'to_questioner',
      targetHandle: '__clarify_response__',
    })
    expect(out?.kind).toBe('questioner-reverse')
  })
})

describe('Bug 3: CrossClarifyNode renders disambiguating labels next to the two output handles', () => {
  function renderNode() {
    return render(
      <ReactFlowProvider>
        <CrossClarifyNode
          id="cross1"
          data={{
            surface: 'task',
            nodeId: 'cross1',
            kind: 'clarify-cross-agent',
            title: 'cross1',
            inputPorts: [],
            outputPorts: [],
          }}
          selected={false}
          type="clarify-cross-agent"
          isConnectable
          dragging={false}
          zIndex={0}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          draggable
          selectable
          deletable
        />
      </ReactFlowProvider>,
    )
  }

  test('renders a `to_questioner` label with the expected testid', () => {
    renderNode()
    const el = document.querySelector('[data-testid="cross-clarify-handle-label-to-questioner"]')
    expect(el).not.toBeNull()
    expect(el?.textContent ?? '').toMatch(/questioner|反问者/)
  })

  test('renders a `to_designer` label with the expected testid', () => {
    renderNode()
    const el = document.querySelector('[data-testid="cross-clarify-handle-label-to-designer"]')
    expect(el).not.toBeNull()
    expect(el?.textContent ?? '').toMatch(/designer|设计者/i)
  })
})
