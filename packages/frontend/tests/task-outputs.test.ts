// collectPorts walks the workflow snapshot stored on a Task and pulls the
// declared output ports out — used by the TaskOutputPanel. The snapshot
// shape is loosely defined (the validator + zod schema sit elsewhere), so
// the helper is paranoid about runtime types.

import { describe, expect, test } from 'vitest'
import { collectPorts } from '../src/components/TaskOutputPanel'

describe('collectPorts', () => {
  test('extracts ports[] from output nodes', () => {
    const snap = {
      nodes: [
        { id: 'a', kind: 'agent-single' },
        {
          id: 'o1',
          kind: 'output',
          ports: [
            { name: 'final', bind: { nodeId: 'a', portName: 'result' } },
            { name: 'notes', bind: { nodeId: 'a', portName: 'notes' } },
          ],
        },
      ],
    }
    const ports = collectPorts(snap)
    expect(ports).toHaveLength(2)
    expect(ports[0]).toEqual({ name: 'final', nodeId: 'a', portName: 'result' })
    expect(ports[1]).toEqual({ name: 'notes', nodeId: 'a', portName: 'notes' })
  })

  test('also accepts top-level outputs[] bindings', () => {
    const snap = {
      nodes: [],
      outputs: [{ name: 'summary', bind: { nodeId: 'x', portName: 'out' } }],
    }
    const ports = collectPorts(snap)
    expect(ports).toEqual([{ name: 'summary', nodeId: 'x', portName: 'out' }])
  })

  test('ignores invalid entries quietly', () => {
    const snap = {
      nodes: [
        // missing kind
        { id: 'x', ports: [{ name: 'a', bind: { nodeId: 'y', portName: 'z' } }] },
        // wrong-typed entries
        { kind: 'output', ports: [{ name: 42, bind: { nodeId: 'a', portName: 'p' } }] },
        // missing bind
        { kind: 'output', ports: [{ name: 'ok' }] },
        // valid
        {
          kind: 'output',
          ports: [{ name: 'good', bind: { nodeId: 'a', portName: 'p' } }],
        },
      ],
    }
    expect(collectPorts(snap)).toEqual([{ name: 'good', nodeId: 'a', portName: 'p' }])
  })

  test('returns [] for non-object snapshots', () => {
    expect(collectPorts(null)).toEqual([])
    expect(collectPorts(undefined)).toEqual([])
    expect(collectPorts(42)).toEqual([])
  })

  test('returns [] when there are no output nodes', () => {
    const snap = { nodes: [{ id: 'a', kind: 'agent-single' }] }
    expect(collectPorts(snap)).toEqual([])
  })
})
