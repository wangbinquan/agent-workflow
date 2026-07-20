import { cleanup, fireEvent, render } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ComponentProps, ReactNode } from 'react'
import type { EdgeProps } from '@xyflow/react'

vi.mock('@xyflow/react', () => ({
  BaseEdge: () => <svg data-testid="base-edge" />,
  EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <>{children}</>,
  getBezierPath: () => ['M 0 0 L 100 100', 50, 50, 0, 0],
}))

import { WorkflowCanvasEdge } from '../src/components/canvas/WorkflowCanvasEdge'
import i18n from '../src/i18n'

afterEach(() => cleanup())

describe('workflow edge midpoint insertion affordance', () => {
  test('renders one focusable midpoint button without claiming the edge click', () => {
    const onInsertNode = vi.fn()
    const parentClick = vi.fn()
    const props = {
      id: 'ordinary',
      source: 'a',
      target: 'b',
      sourceX: 0,
      sourceY: 0,
      targetX: 100,
      targetY: 100,
      sourcePosition: 'right',
      targetPosition: 'left',
      selected: true,
      data: { onInsertNode },
    } as unknown as EdgeProps
    const { getByRole } = render(
      <I18nextProvider i18n={i18n}>
        <div onClick={parentClick}>
          <WorkflowCanvasEdge {...(props as ComponentProps<typeof WorkflowCanvasEdge>)} />
        </div>
      </I18nextProvider>,
    )

    const add = getByRole('button', {
      name: /Insert a step on this connection|在这条连线上插入步骤/,
    })
    expect(add.getAttribute('data-selected')).toBe('true')
    fireEvent.click(add)
    expect(onInsertNode).toHaveBeenCalledTimes(1)
    expect(onInsertNode.mock.calls[0]?.[0]).toBe('ordinary')
    expect(onInsertNode.mock.calls[0]?.[1]).toBe(add)
    expect(parentClick).not.toHaveBeenCalled()
  })
})
