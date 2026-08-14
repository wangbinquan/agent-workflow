// RFC-234 (T9) — draft-panel rich preview locks:
//   1. isScriptPath flags executable-looking text files (D20 warning badge).
//   2. Skill ops render the file tree with script badges + body diff.
//   3. Workgroup ops render member structure — leader chip, human-placeholder
//      chip, and `$new:` refs resolved through bundle names.
//   4. Workflow ops render the read-only canvas on the 'intent-preview'
//      surface for a schema-valid definition, and degrade to the
//      unavailable note (raw JSON stays reachable) when the definition
//      fails local validation.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from '@agent-workflow/shared'
import {
  collectWorkflowTemplateDiffs,
  IntentOpPreview,
  isScriptPath,
} from '../src/components/intent/IntentOpPreview'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { enUS } from '../src/i18n/en-US'
import '../src/i18n'

const workflowCanvasProps = vi.hoisted(
  () => [] as Array<{ definition: WorkflowDefinition; surface: string; readOnly: boolean }>,
)
vi.mock('../src/components/canvas/WorkflowCanvas', () => ({
  WorkflowCanvas: (props: {
    definition: WorkflowDefinition
    surface: string
    readOnly: boolean
  }) => {
    workflowCanvasProps.push(props)
    return <div data-testid="workflow-canvas-mock" />
  },
}))

beforeEach(() => {
  workflowCanvasProps.length = 0
  setBaseUrl('http://daemon.test')
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
  )
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function renderPreview(op: Record<string, unknown>, opErrors: string[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <IntentOpPreview
        op={op}
        mounts={[]}
        bundleNames={new Map([['$new:auditor', '审计员']])}
        opErrors={opErrors}
      />
    </QueryClientProvider>,
  )
}

describe('RFC-234 IntentOpPreview', () => {
  test('isScriptPath flags script suffixes only', () => {
    expect(isScriptPath('tools/run.sh')).toBe(true)
    expect(isScriptPath('gen.PY')).toBe(true)
    expect(isScriptPath('notes/readme.md')).toBe(false)
    expect(isScriptPath('data.json')).toBe(false)
  })

  test('skill op renders file tree with script badge and body diff', () => {
    renderPreview({
      opId: 'op-1',
      action: 'create',
      resourceType: 'skill',
      tempRef: '$new:sk',
      payload: {
        name: 'sk',
        description: '',
        bodyMd: '# how to',
        files: [
          { path: 'scripts/build.sh', content: 'echo hi' },
          { path: 'docs/usage.md', content: 'usage' },
        ],
      },
    })
    expect(screen.getByTestId('intent-preview-skill')).toBeTruthy()
    // Path shows in the tree AND inside the raw-JSON details — assert at least one.
    expect(screen.getAllByText(/scripts\/build\.sh/).length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('intent-script-badge').length).toBe(1)
    expect(screen.getByText(enUS.intent.previewBodyDiff)).toBeTruthy()
  })

  test('workgroup op renders structure with leader + human placeholder', () => {
    renderPreview({
      opId: 'op-2',
      action: 'create',
      resourceType: 'workgroup',
      tempRef: '$new:wg',
      payload: {
        name: 'wg',
        mode: 'leader_worker',
        leaderDisplayName: '组长A',
        members: [
          { memberType: 'agent', agentRef: '$new:auditor', displayName: '组长A', roleDesc: '' },
          { memberType: 'human', displayName: '评审员', roleDesc: '把关' },
        ],
      },
    })
    expect(screen.getByTestId('intent-preview-workgroup')).toBeTruthy()
    expect(screen.getByText(enUS.intent.previewLeader)).toBeTruthy()
    expect(screen.getByText(enUS.intent.previewHumanPlaceholder)).toBeTruthy()
    // `$new:auditor` resolves through the bundle-name map.
    expect(screen.getByText('审计员')).toBeTruthy()
  })

  test('keeps op validation feedback separated from the rich preview', () => {
    renderPreview(
      {
        opId: 'op-validation',
        action: 'create',
        resourceType: 'skill',
        tempRef: '$new:sk',
        payload: { name: 'sk', description: '', bodyMd: '', files: [] },
      },
      ['Name is required'],
    )

    const banner = screen.getByText('Name is required').closest('.notice-banner')
    expect(banner?.parentElement?.classList.contains('feedback-stack')).toBe(true)
    expect(banner?.parentElement?.classList.contains('feedback-stack--section')).toBe(true)
    expect(banner?.parentElement?.nextElementSibling).toBe(
      screen.getByTestId('intent-preview-skill'),
    )
  })

  test('workflow op renders a graph summary and opens a large read-only canvas preview', () => {
    renderPreview({
      opId: 'op-3',
      action: 'create',
      resourceType: 'workflow',
      tempRef: '$new:wf',
      payload: {
        name: 'wf',
        definition: {
          $schema_version: WORKFLOW_SCHEMA_VERSION,
          inputs: [],
          nodes: [{ id: 'n1', kind: 'agent-single', agentRef: '$new:auditor' }],
          edges: [],
        },
      },
    })
    expect(screen.getByTestId('intent-preview-workflow')).toBeTruthy()
    expect(screen.getByText(enUS.intent.previewWorkflowGraph)).toBeTruthy()
    expect(screen.getByText(enUS.intent.previewNodeCount.replace('{{count}}', '1'))).toBeTruthy()
    expect(screen.getByText(enUS.intent.previewEdgeCount.replace('{{count}}', '0'))).toBeTruthy()
    expect(screen.getByTestId('intent-preview-canvas')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', {
        name: enUS.intent.previewOpenCanvas,
      }),
    )
    expect(screen.getByTestId('intent-preview-canvas-dialog')).toBeTruthy()
    expect(screen.getByTestId('intent-preview-canvas-expanded')).toBeTruthy()
  })

  test('RFC-302 inline, expanded and raw views consume the same persisted geometry', () => {
    renderPreview({
      opId: 'op-layout',
      action: 'create',
      resourceType: 'workflow',
      tempRef: '$new:laid-out',
      payload: {
        name: 'laid-out',
        definition: {
          $schema_version: WORKFLOW_SCHEMA_VERSION,
          inputs: [],
          nodes: [
            {
              id: 'n1',
              kind: 'agent-single',
              agentRef: '$new:auditor',
              position: { x: 80, y: 80 },
            },
            { id: 'n2', kind: 'output', position: { x: 480, y: 80 } },
          ],
          edges: [],
        },
      },
    })

    expect(workflowCanvasProps).toHaveLength(1)
    const inline = workflowCanvasProps[0]!
    expect(inline).toMatchObject({ surface: 'intent-preview', readOnly: true })
    expect(inline.definition.nodes.map((node) => node.position)).toEqual([
      { x: 80, y: 80 },
      { x: 480, y: 80 },
    ])
    const raw = screen.getByText(enUS.intent.previewRawJson).parentElement?.querySelector('pre')
    expect(raw?.textContent).toContain('"x": 80')
    expect(raw?.textContent).toContain('"x": 480')

    fireEvent.click(screen.getByRole('button', { name: enUS.intent.previewOpenCanvas }))
    expect(workflowCanvasProps.length).toBeGreaterThanOrEqual(2)
    expect(workflowCanvasProps.at(-1)?.definition).toBe(inline.definition)
  })

  test('invalid workflow definition degrades to the raw payload', () => {
    renderPreview({
      opId: 'op-4',
      action: 'create',
      resourceType: 'workflow',
      tempRef: '$new:wf2',
      payload: { name: 'wf2', definition: { nodes: 'nonsense' } },
    })
    expect(screen.getByText(enUS.intent.previewCanvasUnavailable)).toBeTruthy()
    expect(screen.getByText(enUS.intent.previewRawJson)).toBeTruthy()
    expect(screen.queryByTestId('intent-preview-workflow')).toBeNull()
    cleanup()
  })

  test('workflow diff covers every inventoried template surface without depending on node order', () => {
    const before = {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      edges: [],
      nodes: [
        { id: 'agent', kind: 'agent-single', promptTemplate: 'before agent' },
        {
          id: 'group',
          kind: 'call-workgroup',
          workgroupName: 'reviewers',
          goalTemplate: 'before goal',
        },
        {
          id: 'review',
          kind: 'review',
          inputSource: { nodeId: 'agent', portName: 'result' },
          commentInjectTemplate: 'before review',
        },
        {
          id: 'host',
          kind: 'code-host-call',
          provider: 'gitlab',
          action: 'custom',
          params: { title: 'before param', removed: 'remove me' },
          request: {
            method: 'POST',
            path: '/before/path',
            query: { search: 'before query' },
            body: '{"value":"before body"}',
          },
        },
      ],
    } as WorkflowDefinition
    const after = {
      ...before,
      nodes: [
        {
          ...before.nodes[3],
          params: { title: 'after param', added: 'add me' },
          request: {
            method: 'POST',
            path: '/after/path',
            query: { search: 'after query' },
            body: '{"value":"after body"}',
          },
        },
        { ...before.nodes[2], commentInjectTemplate: 'after review' },
        { ...before.nodes[1], goalTemplate: 'after goal' },
        { ...before.nodes[0], promptTemplate: 'after agent' },
      ],
    } as WorkflowDefinition

    const diffs = collectWorkflowTemplateDiffs(before, after)
    expect(
      Object.fromEntries(diffs.map((diff) => [diff.label, [diff.before, diff.after]])),
    ).toEqual({
      'agent/promptTemplate': ['before agent', 'after agent'],
      'group/goalTemplate': ['before goal', 'after goal'],
      'review/commentInjectTemplate': ['before review', 'after review'],
      'host/params/title': ['before param', 'after param'],
      'host/params/removed': ['remove me', ''],
      'host/request/path': ['/before/path', '/after/path'],
      'host/request/query/search': ['before query', 'after query'],
      'host/request/body': ['{"value":"before body"}', '{"value":"after body"}'],
      'host/params/added': ['', 'add me'],
    })
  })
})
