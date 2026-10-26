// RFC-395 II-b W0: owners implement, A collects. Locks deterministic read-only probe assembly.
import { describe, expect, test } from 'bun:test'
import { collectReadOnlyProbes } from '@/platform/persistence/migration/run/probes'
import type { ReadOnlyProbe } from '@/platform/persistence/migration/run/types'

const probe = (id: string): ReadOnlyProbe => ({
  id,
  run: () => Promise.resolve({ id, passed: true, detail: null }),
})

describe('RFC-395 W0 probe convention', () => {
  test('collection preserves owner/probe order and never executes a probe', () => {
    let calls = 0
    const task: ReadOnlyProbe = {
      id: 'task-execution:mounts',
      run: () => {
        calls += 1
        return Promise.resolve({ id: 'task-execution:mounts', passed: true, detail: null })
      },
    }
    const content = probe('platform/content:bytes')
    const publication = probe('platform/content:publications')
    const taskProbes = Object.freeze([task])
    const result = collectReadOnlyProbes([
      { owner: 'task-execution', probes: taskProbes },
      { owner: 'platform/content', probes: [content, publication] },
    ])
    expect(result).toEqual([task, content, publication])
    expect(result[0]).toBe(task)
    expect(taskProbes).toEqual([task])
    expect(Object.isFrozen(result)).toBe(true)
    expect(calls).toBe(0)
  })

  test('empty contributions remain empty without synthesizing a successful probe', () => {
    expect(collectReadOnlyProbes([])).toEqual([])
    expect(collectReadOnlyProbes([{ owner: 'collaboration', probes: [] }])).toEqual([])
  })

  test('duplicate owner registration is rejected even with disjoint probe IDs', () => {
    expect(() =>
      collectReadOnlyProbes([
        { owner: 'collaboration', probes: [probe('collaboration:answers')] },
        { owner: 'collaboration', probes: [probe('collaboration:gates')] },
      ]),
    ).toThrow('migration-probe-owner-duplicate:collaboration')
  })

  test('duplicate IDs are rejected instead of being silently overwritten', () => {
    expect(() =>
      collectReadOnlyProbes([
        {
          owner: 'intent',
          probes: [probe('intent:apply'), probe('intent:apply')],
        },
      ]),
    ).toThrow('migration-probe-id-duplicate:intent:apply')
  })

  test.each(['answers', 'collaboration:', 'task-execution:answers'])(
    'a probe ID must have its declared owner and a local suffix: %s',
    (id) => {
      expect(() =>
        collectReadOnlyProbes([{ owner: 'collaboration', probes: [probe(id)] }]),
      ).toThrow(`migration-probe-id-owner-mismatch:${id}`)
    },
  )
})
