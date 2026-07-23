import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
  Agent,
  WorkflowDefinition,
  WorkflowDraftValidationReceipt,
} from '@agent-workflow/shared'
import {
  WorkflowStarterDialog,
  workflowStarterCandidateHash,
  type WorkflowStarterDraftValidator,
} from '../src/components/workflow-editor/WorkflowStarterDialog'
import i18n from '../src/i18n'

function agent(
  name: string,
  options: Partial<Pick<Agent, 'outputs' | 'outputKinds' | 'role' | 'outputWrapperPortNames'>> = {},
): Agent {
  return {
    id: `id-${name}`,
    name,
    description: `${name} description`,
    outputs: options.outputs ?? ['result'],
    outputKinds: options.outputKinds ?? { result: 'markdown' },
    outputWrapperPortNames: options.outputWrapperPortNames,
    role: options.role,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

const agents = [
  agent('coder'),
  agent('auditor', { outputs: ['finding'], outputKinds: { finding: 'markdown' } }),
  agent('aggregator', {
    role: 'aggregator',
    outputs: ['summary'],
    outputKinds: { summary: 'markdown' },
  }),
  agent('fixer', { outputs: ['patch'], outputKinds: { patch: 'markdown' } }),
]
const empty: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes: [], edges: [] }

function successfulValidator(): WorkflowStarterDraftValidator {
  return vi.fn(async ({ definition }) => ({
    candidateHash: await workflowStarterCandidateHash(definition),
    validationContextHash: 'b'.repeat(64),
    validatedAt: Date.now(),
    ok: true,
    issues: [],
  }))
}

function renderDialog(props: Partial<React.ComponentProps<typeof WorkflowStarterDialog>> = {}) {
  const onApply = vi.fn()
  const onUseBlank = vi.fn()
  const onClose = vi.fn()
  const validateDraft = props.validateDraft ?? successfulValidator()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const result = render(
    <WorkflowStarterDialog
      open
      workflowId="wf-1"
      definition={empty}
      agents={agents}
      inventorySignature="inventory-1"
      onApply={onApply}
      onUseBlank={onUseBlank}
      onClose={onClose}
      validateDraft={validateDraft}
      {...props}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
        </QueryClientProvider>
      ),
    },
  )
  return { ...result, onApply, onUseBlank, onClose, validateDraft }
}

afterEach(() => cleanup())

describe('WorkflowStarterDialog', () => {
  test('shows three starting choices and blank hands back to the node picker', async () => {
    const { getByTestId, onUseBlank, onApply } = renderDialog()
    expect(getByTestId('workflow-starter-standard-development')).not.toBeNull()
    expect(getByTestId('workflow-starter-audit-only')).not.toBeNull()
    fireEvent.click(getByTestId('workflow-starter-blank'))
    expect(onUseBlank).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })

  test('empty workflow applies only after a fresh second validation receipt', async () => {
    const validateDraft = successfulValidator()
    const { getByTestId, onApply, onClose } = renderDialog({ validateDraft })
    await waitFor(() => expect(getByTestId('workflow-starter-valid')).not.toBeNull())
    expect(validateDraft).toHaveBeenCalledTimes(1)
    fireEvent.click(getByTestId('workflow-starter-apply'))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(validateDraft).toHaveBeenCalledTimes(2)
    expect(onApply.mock.calls[0]?.[0]).toMatchObject({ $schema_version: 4 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('non-empty replacement needs a second explicit click before fresh validation', async () => {
    const validateDraft = successfulValidator()
    const nonEmpty: WorkflowDefinition = {
      ...empty,
      nodes: [{ id: 'existing', kind: 'input', inputKey: 'old' }],
    }
    const { getByTestId, getByText, onApply } = renderDialog({
      definition: nonEmpty,
      validateDraft,
    })
    await waitFor(() => expect(getByTestId('workflow-starter-valid')).not.toBeNull())
    fireEvent.click(getByTestId('workflow-starter-apply'))
    expect(onApply).not.toHaveBeenCalled()
    expect(getByText(/Replace workflow|替换当前工作流/)).not.toBeNull()
    fireEvent.click(getByTestId('workflow-starter-apply'))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(validateDraft).toHaveBeenCalledTimes(2)
  })

  test('inventory refresh aborts the stale preview before requesting a new receipt', async () => {
    const calls: AbortSignal[] = []
    const validateDraft: WorkflowStarterDraftValidator = vi.fn(
      ({ signal }) =>
        new Promise<WorkflowDraftValidationReceipt>((_resolve, reject) => {
          calls.push(signal)
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const { rerender } = renderDialog({ validateDraft })
    await waitFor(() => expect(calls).toHaveLength(1))
    rerender(
      <WorkflowStarterDialog
        open
        workflowId="wf-1"
        definition={empty}
        agents={agents}
        inventorySignature="inventory-2"
        onApply={() => undefined}
        onUseBlank={() => undefined}
        onClose={() => undefined}
        validateDraft={validateDraft}
      />,
    )
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[0]?.aborted).toBe(true)
  })
})
