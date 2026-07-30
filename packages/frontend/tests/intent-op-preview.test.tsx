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
import { cleanup, render, screen } from '@testing-library/react'
import { IntentOpPreview, isScriptPath } from '../src/components/intent/IntentOpPreview'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { enUS } from '../src/i18n/en-US'
import '../src/i18n'

beforeEach(() => {
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

  test('workflow op renders intent-preview canvas; invalid definition degrades', () => {
    renderPreview({
      opId: 'op-3',
      action: 'create',
      resourceType: 'workflow',
      tempRef: '$new:wf',
      payload: {
        name: 'wf',
        definition: {
          $schema_version: 2,
          inputs: [],
          nodes: [{ id: 'n1', kind: 'agent-single', agentRef: '$new:auditor' }],
          edges: [],
        },
      },
    })
    expect(screen.getByTestId('intent-preview-canvas')).toBeTruthy()
    cleanup()

    renderPreview({
      opId: 'op-4',
      action: 'create',
      resourceType: 'workflow',
      tempRef: '$new:wf2',
      payload: { name: 'wf2', definition: { nodes: 'nonsense' } },
    })
    expect(screen.getByText(enUS.intent.previewCanvasUnavailable)).toBeTruthy()
    expect(screen.getByText(enUS.intent.previewRawJson)).toBeTruthy()
  })
})
