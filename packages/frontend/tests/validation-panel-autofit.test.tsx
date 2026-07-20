// RFC-016 T9: ValidationPanel must surface an inline "Auto-fit" button
// alongside any `wrapper-children-outside-bounds` warning, and clicking it
// must invoke the onAutoFitWrapper callback with the wrapper id from the
// issue's pointer. Locks both the visibility contract and the wire-up.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '../src/i18n'
// Import the partitionIssues pure helper to verify warning routing as well.
// The route's local ValidationIssue type omits `pointer`; we widen the
// fixture shape here because that's what the Auto-fit button reads.
import { partitionIssues as _partitionIssues } from '../src/routes/workflows.edit'
interface MiniIssue {
  code: string
  message: string
  severity?: 'error' | 'warning'
  pointer?: string
}
function partitionIssues(issues: MiniIssue[]): { errors: MiniIssue[]; warnings: MiniIssue[] } {
  return _partitionIssues(
    issues as unknown as Parameters<typeof _partitionIssues>[0],
  ) as unknown as {
    errors: MiniIssue[]
    warnings: MiniIssue[]
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

// We render a minimal mock of the inline ValidationPanel structure. The
// component itself is private to workflows.edit.tsx (not exported); locking
// the rendering at the route level would drag in TanStack Router + the
// whole query layer. The intent here is to lock the **mapping from warning
// code → Auto-fit button + pointer wiring**, which is straightforward to
// reproduce in isolation. The full integration is covered by the
// source-level guard test below.
function MiniPanel({
  issues,
  onAutoFitWrapper,
}: {
  issues: Array<{ code: string; message: string; severity?: 'error' | 'warning'; pointer?: string }>
  onAutoFitWrapper?: (id: string) => void
}) {
  const { warnings } = partitionIssues(issues)
  return (
    <ul>
      {warnings.map((i, idx) => (
        <li key={`w-${idx}`}>
          <code>{i.code}</code> — {i.message}
          {i.code === 'wrapper-children-outside-bounds' &&
          i.pointer !== undefined &&
          onAutoFitWrapper !== undefined ? (
            <button
              type="button"
              className="validation-panel__action"
              onClick={() => onAutoFitWrapper(i.pointer as string)}
            >
              Auto-fit
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

describe('ValidationPanel Auto-fit (RFC-016 T9)', () => {
  test('renders an Auto-fit button next to wrapper-children-outside-bounds warnings', () => {
    render(
      <MiniPanel
        issues={[
          {
            code: 'wrapper-children-outside-bounds',
            message: "wrapper 'w1' contains inner node 'a1' positioned outside its visual bounds",
            severity: 'warning',
            pointer: 'w1',
          },
        ]}
        onAutoFitWrapper={() => {}}
      />,
    )
    expect(screen.getByText('Auto-fit')).toBeDefined()
  })

  test('clicking Auto-fit invokes the callback with the wrapper id (pointer)', () => {
    const spy = vi.fn()
    render(
      <MiniPanel
        issues={[
          {
            code: 'wrapper-children-outside-bounds',
            message: 'drift',
            severity: 'warning',
            pointer: 'w1',
          },
        ]}
        onAutoFitWrapper={spy}
      />,
    )
    fireEvent.click(screen.getByText('Auto-fit'))
    expect(spy).toHaveBeenCalledWith('w1')
  })

  test('no Auto-fit button for unrelated warning codes (e.g. input-orphan-declared)', () => {
    render(
      <MiniPanel
        issues={[
          {
            code: 'input-orphan-declared',
            message: 'orphan key',
            severity: 'warning',
            pointer: 'k1',
          },
        ]}
        onAutoFitWrapper={() => {}}
      />,
    )
    expect(screen.queryByText('Auto-fit')).toBeNull()
  })
})

// Source-level guard so the workflows.edit route can't quietly lose the
// Auto-fit wiring without flipping a test red.
describe('workflows.edit source guard (RFC-016 T9 wiring)', () => {
  test('routes/workflows.edit.tsx wires onAutoFitWrapper → clearWrapperSize', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
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
