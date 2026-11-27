// RFC-016 T9: ValidationPanel must surface an inline "Auto-fit" button
// alongside any `wrapper-children-outside-bounds` warning, and clicking it
// must invoke onAutoFitWrapper with the resolved wrapper id. RFC-624 replaces
// the old MiniPanel copy with the real component, including strict targets and
// the legacy pointer compatibility path. The route wire-up remains guarded.

import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { renderValidationPanel } from './validation-panel.helpers'

describe('ValidationPanel Auto-fit (RFC-016 T9)', () => {
  test('renders an Auto-fit button next to wrapper-children-outside-bounds warnings', async () => {
    await renderValidationPanel(
      [
        {
          code: 'wrapper-children-outside-bounds',
          message: "wrapper 'w1' contains inner node 'a1' positioned outside its visual bounds",
          severity: 'warning',
          pointer: 'w1',
        },
      ],
      { onAutoFitWrapper: vi.fn() },
    )
    expect(screen.getByRole('button', { name: 'Auto-fit' })).toBeDefined()
  })

  test('clicking Auto-fit invokes the callback with the wrapper id (pointer)', async () => {
    const spy = vi.fn()
    await renderValidationPanel(
      [
        {
          code: 'wrapper-children-outside-bounds',
          message: 'drift',
          severity: 'warning',
          pointer: 'w1',
        },
      ],
      { onAutoFitWrapper: spy },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Auto-fit' }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('w1')
  })

  test('no Auto-fit button for unrelated warning codes (e.g. input-orphan-declared)', async () => {
    await renderValidationPanel(
      [
        {
          code: 'input-orphan-declared',
          message: 'orphan key',
          severity: 'warning',
          pointer: 'k1',
        },
      ],
      { onAutoFitWrapper: vi.fn() },
    )
    expect(screen.getByRole('button', { name: /input-orphan-declared/ })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Auto-fit' })).toBeNull()
  })

  test('a strict node target takes precedence over a different legacy pointer', async () => {
    const spy = vi.fn()
    await renderValidationPanel(
      [
        {
          code: 'wrapper-children-outside-bounds',
          message: 'inner wrapper drift',
          severity: 'warning',
          pointer: 'w1',
          target: { kind: 'node', nodeId: 'inner' },
        },
      ],
      { onAutoFitWrapper: spy },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Auto-fit' }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('inner')
  })

  test('a stale strict target does not fall back to a still-existing legacy pointer', async () => {
    const spy = vi.fn()
    const { onNavigate } = await renderValidationPanel(
      [
        {
          code: 'wrapper-children-outside-bounds',
          message: 'removed wrapper',
          severity: 'warning',
          pointer: 'w1',
          target: { kind: 'node', nodeId: 'deleted-wrapper' },
        },
      ],
      { onAutoFitWrapper: spy },
    )
    expect(screen.queryByRole('button', { name: 'Auto-fit' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /wrapper-children-outside-bounds/ }))
    expect(onNavigate).not.toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
    expect(screen.getAllByText(/object changed/i).length).toBeGreaterThan(0)
  })

  test('a resolvable wrapper does not offer Auto-fit without a callback', async () => {
    await renderValidationPanel([
      {
        code: 'wrapper-children-outside-bounds',
        message: 'wrapper drift',
        severity: 'warning',
        pointer: 'w1',
      },
    ])
    expect(screen.getByRole('button', { name: /wrapper-children-outside-bounds/ })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Auto-fit' })).toBeNull()
  })
})

// Source-level guard so the workflows.edit route can't quietly lose the
// Auto-fit wiring without flipping a test red.
describe('workflows.edit source guard (RFC-016 T9 wiring)', () => {
  test('routes/workflows.edit.tsx wires onAutoFitWrapper → clearWrapperSize', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = await fs.readFile(path.join(here, '../src/routes/workflows.edit.tsx'), 'utf8')
    const panelSrc = await fs.readFile(
      path.join(here, '../src/components/workflow-editor/ValidationPanel.tsx'),
      'utf8',
    )
    expect(src).toMatch(/onAutoFitWrapper=/)
    expect(src).toMatch(/clearWrapperSize\(/)
    expect(panelSrc).toMatch(/wrapper-children-outside-bounds/)
  })
})
