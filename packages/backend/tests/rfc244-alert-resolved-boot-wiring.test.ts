// RFC-244 — daemon assembly lock for lifecycle-alert resolution dirty truth.
//
// Service-level tests prove that reconciliation emits one onResolved callback
// per affected task. Route tests prove the additive WS frame shape. This file
// guards the remaining production seam: every background reconciler started by
// cli/start.ts must receive the same broadcaster callback.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const START_SOURCE = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')

function assemblySlice(startMarker: string, endMarker: string): string {
  const start = START_SOURCE.indexOf(startMarker)
  const end = START_SOURCE.indexOf(endMarker, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return START_SOURCE.slice(start, end)
}

describe('RFC-244 lifecycle alert resolution boot wiring', () => {
  test('defines one tasks-list resolved broadcaster with the strict additive frame', () => {
    const helper = assemblySlice('const broadcastResolved =', 'const lifecycleInvariantsTicker =')
    expect(helper).toContain('tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL')
    expect(helper).toContain("type: 'lifecycle.alert.resolved'")
    expect(helper).toContain('taskId,')
  })

  test('threads the same callback through all three daemon reconcilers', () => {
    const assemblies = [
      assemblySlice('startLifecycleInvariantsLoop({', '// RFC-053 P-6'),
      assemblySlice('startStuckTaskDetectorLoop({', '// RFC-101:'),
      assemblySlice('startAutoRepairLoop({', '// RFC-108 T20'),
    ]

    for (const assembly of assemblies) {
      expect(assembly).toContain('onResolved: broadcastResolved')
    }
    expect(START_SOURCE.match(/onResolved: broadcastResolved/g)).toHaveLength(3)
  })
})
