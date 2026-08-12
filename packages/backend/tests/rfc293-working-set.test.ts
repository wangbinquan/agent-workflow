// RFC-293 — regression locks for the shared working-context delta used by the
// batch API and legacy single-mount wrappers.

import { describe, expect, test } from 'bun:test'
import { applyIntentWorkingSetDelta } from '@/services/intent/workingSet'
import type { IntentContextManifest } from '@/services/intent/manifest'

const manifest: IntentContextManifest = [
  {
    handle: 'res#agent#1',
    resourceType: 'agent',
    resourceId: 'A1',
    root: true,
    detail: true,
  },
  {
    handle: 'res#skill#2',
    resourceType: 'skill',
    resourceId: 'S2',
    root: false,
    detail: true,
  },
]

describe('RFC-293 working-context pure delta', () => {
  test('removes a root, promotes a closure member, and allocates from the watermark', () => {
    const result = applyIntentWorkingSetDelta(
      manifest,
      { agent: 7, skill: 2 },
      {
        additions: [
          { resourceType: 'skill', resourceId: 'S2' },
          { resourceType: 'agent', resourceId: 'A8' },
        ],
        removals: ['res#agent#1'],
      },
    )
    expect(result.manifest.find((entry) => entry.resourceId === 'A1')?.root).toBe(false)
    expect(result.manifest.find((entry) => entry.resourceId === 'S2')?.root).toBe(true)
    expect(result.manifest.find((entry) => entry.resourceId === 'A8')?.handle).toBe('res#agent#8')
    expect(result.handleWatermark).toMatchObject({ agent: 8, skill: 2 })
    expect(result.changed).toBe(true)
    expect(manifest[0]?.root).toBe(true)
    expect(manifest[1]?.root).toBe(false)
  })

  test('treats already-root additions as a no-op without bumping state', () => {
    const result = applyIntentWorkingSetDelta(
      manifest,
      { agent: 1 },
      {
        additions: [{ resourceType: 'agent', resourceId: 'A1' }],
        removals: [],
      },
    )
    expect(result.changed).toBe(false)
    expect(result.addedHandles).toEqual([])
    expect(result.manifest).toEqual(manifest)
  })

  test('rejects removing a closure member or an unknown handle', () => {
    expect(() =>
      applyIntentWorkingSetDelta(
        manifest,
        {},
        {
          additions: [],
          removals: ['res#skill#2'],
        },
      ),
    ).toThrow('working-context root not found')
    expect(() =>
      applyIntentWorkingSetDelta(
        manifest,
        {},
        {
          additions: [],
          removals: ['res#workflow#99'],
        },
      ),
    ).toThrow('working-context root not found')
  })

  test('rejects add and remove of the same resource before applying either side', () => {
    expect(() =>
      applyIntentWorkingSetDelta(
        manifest,
        {},
        {
          additions: [{ resourceType: 'agent', resourceId: 'A1' }],
          removals: ['res#agent#1'],
        },
      ),
    ).toThrow('same resource cannot be added and removed')
    expect(manifest[0]?.root).toBe(true)
  })

  test('supports more than 64 roots and never reuses old ordinals', () => {
    const additions = Array.from({ length: 70 }, (_, index) => ({
      resourceType: 'workflow' as const,
      resourceId: `W${index + 1}`,
    }))
    const result = applyIntentWorkingSetDelta([], { workflow: 100 }, { additions, removals: [] })
    expect(result.manifest).toHaveLength(70)
    expect(result.manifest[0]?.handle).toBe('res#workflow#101')
    expect(result.manifest[69]?.handle).toBe('res#workflow#170')
    expect(result.handleWatermark.workflow).toBe(170)
  })
})
