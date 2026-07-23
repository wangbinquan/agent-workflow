// RFC-197 — AgentImportDialog select/review/result task flow.
// Locks complete field disclosure, draft-only apply semantics, stale file-read
// isolation, RFC-194 orphan protection, and the shared primitive/focus contract.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type {
  AgentMarkdownParseResult,
  ResolveAgentImportRefsRequest,
  ResolveAgentImportRefsResult,
} from '@agent-workflow/shared'
import { ApiError } from '../src/api/client'
import { AgentImportDialog } from '../src/components/AgentImportDialog'
import { emptyAgent } from '../src/components/AgentForm'

function setup(overrides: Partial<Parameters<typeof AgentImportDialog>[0]> = {}) {
  const onApply =
    vi.fn<(result: AgentMarkdownParseResult, resolved: ResolveAgentImportRefsResult) => void>()
  const onClose = vi.fn()
  const onViewForm = vi.fn()
  const props: Parameters<typeof AgentImportDialog>[0] = {
    open: true,
    onApply,
    onResolve: resolveForTest,
    onClose,
    onViewForm,
    currentValue: emptyAgent(),
    ...overrides,
  }
  const utils = render(<AgentImportDialog {...props} />)
  return { ...utils, props, onApply, onClose, onViewForm }
}

async function resolveForTest(
  request: ResolveAgentImportRefsRequest,
): Promise<ResolveAgentImportRefsResult> {
  return {
    dependsOn: request.dependsOn,
    mcp: request.mcp,
    plugins: request.plugins,
    skills: request.skills?.map((selector) =>
      selector.kind === 'project'
        ? { kind: 'project', name: selector.name }
        : { kind: 'managed', skillId: selector.name },
    ),
  }
}

function pasteAndCheck(raw: string): void {
  fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
  fireEvent.change(screen.getByTestId('agent-import-textarea'), { target: { value: raw } })
  fireEvent.click(screen.getByTestId('agent-import-parse'))
}

describe('AgentImportDialog', () => {
  test('opens on a shared file dropzone and disables Check until a source exists', async () => {
    setup()
    expect(screen.getByTestId('agent-import-file-dropzone')).toBeTruthy()
    expect((screen.getByTestId('agent-import-parse') as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('agent-import-file-button'))
    })
  })

  test('source tabs keep stable two-way DOM associations for their conditional panels', () => {
    setup()
    const uploadTab = screen.getByRole('tab', { name: /upload/i })
    const uploadPanel = screen.getByRole('tabpanel')
    expect(uploadTab.id).toBe('agent-import-source-tab-upload')
    expect(uploadTab.getAttribute('aria-controls')).toBe(uploadPanel.id)
    expect(uploadPanel.id).toBe('agent-import-source-panel-upload')
    expect(uploadPanel.getAttribute('aria-labelledby')).toBe(uploadTab.id)
    const hiddenPastePanel = document.getElementById('agent-import-source-panel-paste')
    expect(hiddenPastePanel?.hasAttribute('hidden')).toBe(true)
    expect(hiddenPastePanel?.getAttribute('aria-labelledby')).toBe('agent-import-source-tab-paste')

    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    const pasteTab = screen.getByRole('tab', { name: /paste/i })
    const pastePanel = screen.getByRole('tabpanel')
    expect(pasteTab.id).toBe('agent-import-source-tab-paste')
    expect(pasteTab.getAttribute('aria-controls')).toBe(pastePanel.id)
    expect(pastePanel.id).toBe('agent-import-source-panel-paste')
    expect(pastePanel.getAttribute('aria-labelledby')).toBe(pasteTab.id)
    expect(
      document.getElementById('agent-import-source-panel-upload')?.hasAttribute('hidden'),
    ).toBe(true)
  })

  test('full paste review exposes all five form sections, including formerly hidden resources', async () => {
    setup()
    pasteAndCheck(
      [
        '---',
        'name: reviewer',
        'description: Reviews changes',
        'runtime: opencode-review',
        'inputs:',
        '  - name: source',
        '    kind: string',
        'outputs: [result]',
        'outputKinds:',
        '  result: markdown',
        'outputWrapperPortNames:',
        '  result: merged',
        'dependsOn: [planner]',
        'mcp: [github]',
        'plugins: [review-tools]',
        'role: aggregator',
        'permission:',
        '  edit: deny',
        'mode: subagent',
        '---',
        'Review carefully.',
      ].join('\n'),
    )

    for (const tab of ['basics', 'prompt', 'ports', 'resources', 'advanced']) {
      expect(screen.getByTestId(`agent-import-section-${tab}`)).toBeTruthy()
    }
    for (const field of ['runtime', 'dependsOn', 'mcp', 'plugins']) {
      expect(screen.getByTestId(`agent-import-item-${field}`)).toBeTruthy()
    }
    expect((screen.getByTestId('agent-import-apply') as HTMLButtonElement).disabled).toBe(false)
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('agent-import-review-heading'))
    })
  })

  test('Apply writes the draft once, stays open on a stable not-created result, then views form', async () => {
    const { onApply, onClose, onViewForm } = setup()
    pasteAndCheck(['---', 'description: A reviewer', '---', 'body line'].join('\n'))

    fireEvent.click(screen.getByTestId('agent-import-apply'))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply.mock.calls[0]![0].partial).toMatchObject({
      description: 'A reviewer',
      bodyMd: 'body line',
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('agent-import-result')).toBeTruthy()
    expect(screen.getByTestId('agent-import-not-created')).toBeTruthy()
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('agent-import-result-heading'))
    })

    fireEvent.click(screen.getByTestId('agent-import-view-form'))
    expect(onViewForm).toHaveBeenCalledWith('basics')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('Back cancels an in-flight reference resolution without applying its late result', async () => {
    let releaseResolve!: (value: ResolveAgentImportRefsResult) => void
    const onResolve = vi.fn(
      () =>
        new Promise<ResolveAgentImportRefsResult>((resolve) => {
          releaseResolve = resolve
        }),
    )
    const { onApply } = setup({ onResolve })
    pasteAndCheck(['---', 'description: canceled import', '---'].join('\n'))

    fireEvent.click(screen.getByTestId('agent-import-apply'))
    await waitFor(() =>
      expect(screen.getByTestId('agent-import-apply').getAttribute('aria-busy')).toBe('true'),
    )
    fireEvent.click(screen.getByTestId('agent-import-back'))

    expect(screen.getByTestId('agent-import-textarea')).toBeTruthy()
    expect(screen.queryByTestId('agent-import-result')).toBeNull()
    await act(async () => releaseResolve({}))
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.getByTestId('agent-import-textarea')).toBeTruthy()
  })

  test('Import another clears the result and both source drafts', async () => {
    setup()
    pasteAndCheck(['---', 'description: first', '---'].join('\n'))
    fireEvent.click(screen.getByTestId('agent-import-apply'))
    fireEvent.click(await screen.findByTestId('agent-import-another'))

    expect(screen.getByTestId('agent-import-file-dropzone')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    expect((screen.getByTestId('agent-import-textarea') as HTMLTextAreaElement).value).toBe('')
  })

  test('ambiguous references require an explicit stable id mapping before apply', async () => {
    const onResolve = vi
      .fn<(request: ResolveAgentImportRefsRequest) => Promise<ResolveAgentImportRefsResult>>()
      .mockRejectedValueOnce(
        new ApiError(409, 'import-ref-ambiguous', 'ambiguous reference', {
          ambiguities: [
            {
              selector: { type: 'agent', name: 'planner' },
              candidates: [
                {
                  id: 'agent-owner-a',
                  ownerUserId: 'owner-a',
                  ownerUsername: 'alice',
                  visibility: 'public',
                },
                {
                  id: 'agent-owner-b',
                  ownerUserId: 'owner-b',
                  ownerUsername: 'bob',
                  visibility: 'public',
                },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce({ dependsOn: ['agent-owner-b'] })
    const { onApply } = setup({ onResolve })
    pasteAndCheck(['---', 'dependsOn: [planner]', '---'].join('\n'))

    fireEvent.click(screen.getByTestId('agent-import-apply'))
    const mapping = await screen.findByTestId('agent-import-mapping-agent-planner')
    expect((screen.getByTestId('agent-import-apply') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(mapping)
    fireEvent.mouseDown(screen.getByRole('option', { name: /bob/i }))
    fireEvent.click(screen.getByTestId('agent-import-apply'))

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onResolve.mock.calls[1]?.[0].selections).toEqual([
      {
        selector: { type: 'agent', name: 'planner' },
        resourceId: 'agent-owner-b',
      },
    ])
    expect(onApply.mock.calls[0]?.[1].dependsOn).toEqual(['agent-owner-b'])
  })

  test('a stale explicit mapping never silently rebinds to the sole remaining candidate', async () => {
    const selector = { type: 'agent' as const, name: 'planner' }
    const alice = {
      id: 'agent-owner-a',
      ownerUserId: 'owner-a',
      ownerUsername: 'alice',
      visibility: 'public' as const,
    }
    const bob = {
      id: 'agent-owner-b',
      ownerUserId: 'owner-b',
      ownerUsername: 'bob',
      visibility: 'public' as const,
    }
    const onResolve = vi
      .fn<(request: ResolveAgentImportRefsRequest) => Promise<ResolveAgentImportRefsResult>>()
      .mockRejectedValueOnce(
        new ApiError(409, 'import-ref-ambiguous', 'ambiguous reference', {
          ambiguities: [{ selector, candidates: [alice, bob] }],
        }),
      )
      .mockRejectedValueOnce(
        new ApiError(409, 'import-ref-selection-stale', 'stale selection', {
          selector,
          ambiguities: [{ selector, candidates: [alice] }],
        }),
      )
    const { onApply } = setup({ onResolve })
    pasteAndCheck(['---', 'dependsOn: [planner]', '---'].join('\n'))

    fireEvent.click(screen.getByTestId('agent-import-apply'))
    const mapping = await screen.findByTestId('agent-import-mapping-agent-planner')
    fireEvent.click(mapping)
    fireEvent.mouseDown(screen.getByRole('option', { name: /bob/i }))
    fireEvent.click(screen.getByTestId('agent-import-apply'))

    await waitFor(() => expect(mapping.textContent).toContain('Select resource owner'))
    expect(onResolve).toHaveBeenCalledTimes(2)
    expect(onApply).not.toHaveBeenCalled()
    expect((screen.getByTestId('agent-import-apply') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(mapping)
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /alice/i })).toBeTruthy()
  })

  test('source tabs preserve independent upload and paste drafts', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    fireEvent.change(screen.getByTestId('agent-import-textarea'), {
      target: { value: 'pasted body' },
    })
    fireEvent.click(screen.getByRole('tab', { name: /upload/i }))
    expect(screen.getByTestId('agent-import-file-dropzone')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    expect((screen.getByTestId('agent-import-textarea') as HTMLTextAreaElement).value).toBe(
      'pasted body',
    )
  })

  test('upload reads on Check and uses the complete filename stem as fallback name', async () => {
    setup()
    const file = new File(['ignored'], 'security-reviewer.markdown', { type: 'text/markdown' })
    Object.defineProperty(file, 'text', {
      value: vi.fn().mockResolvedValue('Review the changes.'),
    })
    fireEvent.change(screen.getByTestId('agent-import-file'), { target: { files: [file] } })
    fireEvent.click(screen.getByTestId('agent-import-parse'))

    await waitFor(() => expect(screen.getByTestId('agent-import-review-heading')).toBeTruthy())
    expect(screen.getByTestId('agent-import-item-name').textContent).toContain('security-reviewer')
  })

  test('file read rejection stays in select with a recoverable alert', async () => {
    setup()
    const file = new File(['ignored'], 'broken.md')
    Object.defineProperty(file, 'text', {
      value: vi.fn().mockRejectedValue(new Error('disk unavailable')),
    })
    fireEvent.change(screen.getByTestId('agent-import-file'), { target: { files: [file] } })
    fireEvent.click(screen.getByTestId('agent-import-parse'))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('disk unavailable'))
    expect(screen.queryByTestId('agent-import-review-heading')).toBeNull()
    expect((screen.getByTestId('agent-import-parse') as HTMLButtonElement).disabled).toBe(false)
  })

  test('a file read resolving after close cannot populate the next import session', async () => {
    let resolveText!: (value: string) => void
    const pendingText = new Promise<string>((resolve) => {
      resolveText = resolve
    })
    const onApply = vi.fn()
    const onClose = vi.fn()
    const currentValue = emptyAgent()
    const { rerender } = render(
      <AgentImportDialog
        open
        onApply={onApply}
        onResolve={resolveForTest}
        onClose={onClose}
        currentValue={currentValue}
      />,
    )
    const file = new File(['ignored'], 'late.md')
    Object.defineProperty(file, 'text', { value: vi.fn(() => pendingText) })
    fireEvent.change(screen.getByTestId('agent-import-file'), { target: { files: [file] } })
    fireEvent.click(screen.getByTestId('agent-import-parse'))

    rerender(
      <AgentImportDialog
        open={false}
        onApply={onApply}
        onResolve={resolveForTest}
        onClose={onClose}
        currentValue={currentValue}
      />,
    )
    await act(async () => resolveText('stale body'))
    rerender(
      <AgentImportDialog
        open
        onApply={onApply}
        onResolve={resolveForTest}
        onClose={onClose}
        currentValue={currentValue}
      />,
    )

    expect(screen.getByTestId('agent-import-file-dropzone')).toBeTruthy()
    expect(screen.queryByTestId('agent-import-review-heading')).toBeNull()
    expect((screen.getByTestId('agent-import-parse') as HTMLButtonElement).disabled).toBe(true)
  })

  test('malformed YAML surfaces a blocking ErrorBanner and disables draft apply', () => {
    setup()
    pasteAndCheck('---\nkey: : :\n---\nbody')
    expect(screen.getByTestId('agent-import-warning').textContent).toContain('yaml-parse-failed:')
    expect((screen.getByTestId('agent-import-apply') as HTMLButtonElement).disabled).toBe(true)
  })

  test('non-blocking warnings remain visible while valid extras can be applied', () => {
    setup()
    pasteAndCheck(['---', 'description: 42', '---'].join('\n'))
    expect(screen.getByTestId('agent-import-warnings').textContent).toContain(
      'description must be string',
    )
    expect(screen.getByTestId('agent-import-item-frontmatterExtra.description')).toBeTruthy()
    expect((screen.getByTestId('agent-import-apply') as HTMLButtonElement).disabled).toBe(false)
  })

  test('an empty uploaded file renders EmptyState and cannot perform a no-op apply', async () => {
    const { onApply } = setup()
    const file = new File([], 'empty.md', { type: 'text/markdown' })
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue('') })
    fireEvent.change(screen.getByTestId('agent-import-file'), { target: { files: [file] } })
    fireEvent.click(screen.getByTestId('agent-import-parse'))

    await waitFor(() => expect(screen.getByTestId('agent-import-empty')).toBeTruthy())
    expect(screen.getByTestId('agent-import-empty')).toBeTruthy()
    const apply = screen.getByTestId('agent-import-apply') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)
    expect(onApply).not.toHaveBeenCalled()
  })

  test('overwrite impact lists fields the user already edited', () => {
    setup({ currentValue: { ...emptyAgent(), description: 'kept by user' } })
    pasteAndCheck(['---', 'description: imported', '---'].join('\n'))
    expect(screen.getByTestId('agent-import-overwrite').textContent).toContain('description')
  })

  test('RFC-194 orphan sidecars block Apply and offer the Ports repair route', () => {
    const { onApply, onClose, onViewForm } = setup({
      currentValue: {
        ...emptyAgent(),
        outputKinds: { future: 'markdown' },
        outputWrapperPortNames: { future: 'published' },
      },
    })
    pasteAndCheck(['---', 'outputs: [future]', '---'].join('\n'))

    const conflict = screen.getByTestId('agent-import-port-conflict')
    expect(conflict.textContent).toContain('outputKinds:future')
    expect(conflict.textContent).toContain('outputWrapperPortNames:future')
    expect((screen.getByTestId('agent-import-apply') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('agent-import-fix-ports'))
    expect(onViewForm).toHaveBeenCalledWith('ports')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })

  test('Back preserves the selected source but invalidates the old review', () => {
    setup()
    pasteAndCheck(['---', 'description: before', '---'].join('\n'))
    fireEvent.click(screen.getByTestId('agent-import-back'))

    expect((screen.getByTestId('agent-import-textarea') as HTMLTextAreaElement).value).toContain(
      'description: before',
    )
    expect(screen.queryByTestId('agent-import-apply')).toBeNull()
  })
})
