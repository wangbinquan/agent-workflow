// Regression: when /tasks/:id (and any other page that mounts
// WorkflowCanvas) hands the canvas its agents via `useQuery(['agents'])`,
// the first render lands while the query is still loading — `agents=[]`.
// Under the broken code, the def-sync useEffect's gate read only
// `definition !== prev || nodeStatuses !== prev`, so when `agents`
// resolved a tick later the agentByName Map updated but the canvas never
// rebuilt its `nodes` array. Agent nodes therefore stayed with empty
// `outputPorts`, no right-side Handles were rendered, and every edge
// whose source pointed at one of those missing handles was dropped by
// xyflow (visible symptom: "coder→review 的连线不渲染了").
//
// This test mounts WorkflowCanvas with `agents=[]`, asserts that the
// agent node has none of its output handles, then re-renders with the
// loaded agent and asserts the named output handle now exists in the
// DOM. The fix is to include an `agentsChanged` clause in the rebuild
// gate (WorkflowCanvas.tsx — see `externalAgentsRef`).

import { afterEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { Agent } from '@agent-workflow/shared'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { WorkflowCanvas } from '../src/components/canvas/WorkflowCanvas'
import i18n from '../src/i18n'

afterEach(() => {
  document.body.innerHTML = ''
})

function makeDef(): WorkflowDefinition {
  return {
    $schema_version: 2,
    inputs: [],
    nodes: [
      {
        id: 'agent_coder',
        kind: 'agent-single',
        agentName: 'coder',
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }
}

const CODER: Agent = {
  name: 'coder',
  description: 'coder',
  outputs: ['software_design', 'test_design'],
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  permission: {},
  bodyMd: '',
  frontmatterExtra: {},
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
} as unknown as Agent

describe('WorkflowCanvas rebuilds when agents query resolves after mount', () => {
  test('agent output Handles appear once agents prop populates', () => {
    const def = makeDef()
    const { container, rerender } = render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas definition={def} agents={[]} readOnly />
      </I18nextProvider>,
    )
    // Initially the agents query hasn't resolved — no output handles
    // should be rendered for agent_coder. (The catch-all left handle
    // still renders; we look only for the right-side named handle.)
    const initialOutputs = container.querySelectorAll(
      '[data-nodeid="agent_coder"][data-handlepos="right"]',
    )
    expect(initialOutputs.length).toBe(0)

    // Simulate useQuery resolving with the agent list.
    rerender(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas definition={def} agents={[CODER]} readOnly />
      </I18nextProvider>,
    )

    const outputs = container.querySelectorAll(
      '[data-nodeid="agent_coder"][data-handlepos="right"]',
    )
    const ids = Array.from(outputs).map((h) => h.getAttribute('data-handleid'))
    expect(ids).toEqual(expect.arrayContaining(['software_design', 'test_design']))
  })
})
