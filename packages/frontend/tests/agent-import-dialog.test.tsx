// RFC-018 T3 — integration coverage for AgentImportDialog.
// Locks the four critical paths in design.md §6.2:
// (1) Parse button disabled when raw input empty
// (2) Paste tab → valid markdown → Parse → preview + Apply forwards result
// (3) Malformed YAML → warning visible + Apply disabled
// (4) currentValue overlap → overwrite banner lists the field

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { AgentMarkdownParseResult } from '@agent-workflow/shared'
import { AgentImportDialog } from '../src/components/AgentImportDialog'
import { emptyAgent } from '../src/components/AgentForm'

function setup(overrides: Partial<Parameters<typeof AgentImportDialog>[0]> = {}) {
  const onApply = vi.fn<(r: AgentMarkdownParseResult) => void>()
  const onClose = vi.fn()
  const utils = render(
    <AgentImportDialog
      open
      onApply={onApply}
      onClose={onClose}
      currentValue={overrides.currentValue ?? emptyAgent()}
      {...overrides}
    />,
  )
  return { ...utils, onApply, onClose }
}

describe('AgentImportDialog', () => {
  test('Parse is disabled when rawText is empty', () => {
    setup()
    const parseBtn = screen.getByTestId('agent-import-parse') as HTMLButtonElement
    expect(parseBtn.disabled).toBe(true)
  })

  test('paste tab → parse → apply forwards parser result and closes', () => {
    const { onApply, onClose } = setup()
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    const textarea = screen.getByTestId('agent-import-textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, {
      target: {
        value: ['---', 'description: A reviewer', 'model: x', '---', 'body line'].join('\n'),
      },
    })
    fireEvent.click(screen.getByTestId('agent-import-parse'))
    const applyBtn = screen.getByTestId('agent-import-apply') as HTMLButtonElement
    expect(applyBtn.disabled).toBe(false)
    fireEvent.click(applyBtn)
    expect(onApply).toHaveBeenCalledTimes(1)
    const result = onApply.mock.calls[0]![0]
    expect(result.partial.description).toBe('A reviewer')
    // RFC-115: `model` is no longer a first-class agent field — a legacy
    // `model:` frontmatter key routes into frontmatterExtra, never partial.model.
    expect(result.partial.frontmatterExtra?.model).toBe('x')
    expect(result.partial.bodyMd).toBe('body line')
    expect(onClose).toHaveBeenCalled()
  })

  test('malformed YAML surfaces warning and disables Apply', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    fireEvent.change(screen.getByTestId('agent-import-textarea'), {
      target: { value: '---\nkey: : :\n---\nbody' },
    })
    fireEvent.click(screen.getByTestId('agent-import-parse'))
    const warning = screen.getByTestId('agent-import-warning')
    expect(warning.textContent ?? '').toContain('yaml-parse-failed:')
    const applyBtn = screen.getByTestId('agent-import-apply') as HTMLButtonElement
    expect(applyBtn.disabled).toBe(true)
  })

  test('overwrite banner lists fields the user already edited', () => {
    const current = { ...emptyAgent(), description: 'kept by user', model: 'm0' }
    setup({ currentValue: current })
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    fireEvent.change(screen.getByTestId('agent-import-textarea'), {
      target: { value: '---\ndescription: imported\n---\nbody' },
    })
    fireEvent.click(screen.getByTestId('agent-import-parse'))
    const banner = screen.getByTestId('agent-import-overwrite')
    expect(banner.textContent ?? '').toContain('description')
  })

  test('RFC-194: port preview routes fields to Ports and role to Advanced', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    fireEvent.change(screen.getByTestId('agent-import-textarea'), {
      target: {
        value: [
          '---',
          'inputs:',
          '  - name: source',
          '    kind: string',
          'outputs: [result]',
          'outputKinds:',
          '  result: markdown',
          'role: aggregator',
          'outputWrapperPortNames:',
          '  result: merged_result',
          '---',
        ].join('\n'),
      },
    })
    fireEvent.click(screen.getByTestId('agent-import-parse'))

    const rows = screen.getAllByRole('row')
    const routes = Object.fromEntries(
      rows.map((row) => {
        const cells = row.querySelectorAll('td')
        return [cells[0]?.textContent, cells[2]?.textContent]
      }),
    )
    expect(routes.inputs).toContain('Ports')
    expect(routes.outputs).toContain('Ports')
    expect(routes.outputKinds).toContain('Ports')
    expect(routes.outputWrapperPortNames).toContain('Ports')
    expect(routes.role).toContain('Advanced')
  })

  test('RFC-194: overwrite banner includes edited port fields', () => {
    setup({
      currentValue: {
        ...emptyAgent(),
        inputs: [{ name: 'old_in', kind: 'string' }],
        outputs: ['old_out'],
        outputKinds: { old_out: 'markdown' },
        role: 'aggregator',
        outputWrapperPortNames: { old_out: 'old_wrapper' },
      },
    })
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    fireEvent.change(screen.getByTestId('agent-import-textarea'), {
      target: {
        value: [
          '---',
          'inputs:',
          '  - name: new_in',
          '    kind: string',
          'outputs: [new_out]',
          'outputKinds:',
          '  new_out: markdown',
          'role: normal',
          'outputWrapperPortNames:',
          '  new_out: new_wrapper',
          '---',
        ].join('\n'),
      },
    })
    fireEvent.click(screen.getByTestId('agent-import-parse'))

    const banner = screen.getByTestId('agent-import-overwrite').textContent ?? ''
    expect(banner).toContain('inputs')
    expect(banner).toContain('outputs')
    expect(banner).toContain('outputKinds')
    expect(banner).toContain('role')
    expect(banner).toContain('outputWrapperPortNames')
  })

  test('RFC-194: outputs-only import cannot silently claim an existing orphan sidecar', () => {
    const { onApply, onClose } = setup({
      currentValue: {
        ...emptyAgent(),
        outputKinds: { future: 'markdown' },
        outputWrapperPortNames: { future: 'published' },
      },
    })
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    fireEvent.change(screen.getByTestId('agent-import-textarea'), {
      target: { value: ['---', 'outputs: [future]', '---'].join('\n') },
    })
    fireEvent.click(screen.getByTestId('agent-import-parse'))

    const conflict = screen.getByTestId('agent-import-port-conflict')
    expect(conflict.textContent).toContain('outputKinds:future')
    expect(conflict.textContent).toContain('outputWrapperPortNames:future')
    const apply = screen.getByTestId('agent-import-apply') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)
    expect(onApply).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
