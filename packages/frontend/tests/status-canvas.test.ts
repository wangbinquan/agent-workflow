// nodeStatuses → CanvasNodeData.status propagation (P-2-12).

import { describe, expect, test } from 'vitest'
import { __testToFlowNodes as toFlowNodes } from '../src/components/canvas/WorkflowCanvas'

describe('toFlowNodes with statuses', () => {
  test('attaches status when present in the map', () => {
    const flow = toFlowNodes([{ id: 'a1', kind: 'agent-single' }], [], [], { a1: 'running' })
    const data = flow[0]?.data as { status?: string }
    expect(data.status).toBe('running')
  })

  test('leaves status undefined when nodeId is missing from the map', () => {
    const flow = toFlowNodes([{ id: 'a1', kind: 'agent-single' }], [], [], {})
    const data = flow[0]?.data as { status?: string }
    expect(data.status).toBeUndefined()
  })

  test('omits status entirely when statuses arg is undefined', () => {
    const flow = toFlowNodes([{ id: 'a1', kind: 'agent-single' }], [], [])
    const data = flow[0]?.data as { status?: string }
    expect(data.status).toBeUndefined()
  })
})
