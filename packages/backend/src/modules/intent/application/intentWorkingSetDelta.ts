import type { IntentWorkingSetDelta } from '@agent-workflow/shared'

import { ValidationError } from '@/util/errors'
import {
  allocateHandle,
  createHandleAllocator,
  handleWatermarkOf,
  manifestEntryFor,
  mergeHandleWatermarks,
  type IntentContextManifest,
  type IntentHandleWatermark,
} from '@/services/intent/manifest'

export interface AppliedIntentWorkingSetDelta {
  readonly manifest: IntentContextManifest
  readonly handleWatermark: IntentHandleWatermark
  readonly changed: boolean
  readonly addedHandles: readonly string[]
  readonly removedHandles: readonly string[]
}

export function applyIntentWorkingSetDelta(
  manifest: readonly IntentContextManifest[number][],
  watermark: IntentHandleWatermark,
  delta: IntentWorkingSetDelta,
): AppliedIntentWorkingSetDelta {
  const next: IntentContextManifest = manifest.map((entry) => ({ ...entry }))
  const byHandle = new Map(next.map((entry) => [entry.handle, entry]))
  const removing = new Set(delta.removals)

  for (const handle of delta.removals) {
    const entry = byHandle.get(handle)
    if (entry === undefined || !entry.root) {
      throw new ValidationError('intent-mount-not-found', 'working-context root not found')
    }
  }
  for (const addition of delta.additions) {
    const existing = manifestEntryFor(next, addition.resourceType, addition.resourceId)
    if (existing !== undefined && removing.has(existing.handle)) {
      throw new ValidationError(
        'intent-working-set-contradiction',
        'the same resource cannot be added and removed in one update',
      )
    }
  }

  const removedHandles: string[] = []
  for (const handle of delta.removals) {
    const entry = byHandle.get(handle)!
    entry.root = false
    removedHandles.push(handle)
  }
  const allocator = createHandleAllocator(next, watermark)
  const addedHandles: string[] = []
  for (const addition of delta.additions) {
    const existing = manifestEntryFor(next, addition.resourceType, addition.resourceId)
    if (existing !== undefined) {
      if (!existing.root) {
        existing.root = true
        addedHandles.push(existing.handle)
      }
      continue
    }
    const handle = allocateHandle(allocator, addition.resourceType, addition.resourceId)
    next.push({
      handle,
      resourceType: addition.resourceType,
      resourceId: addition.resourceId,
      root: true,
      detail: false,
    })
    addedHandles.push(handle)
  }
  return {
    manifest: next,
    handleWatermark: mergeHandleWatermarks(watermark, handleWatermarkOf(allocator)),
    changed: addedHandles.length > 0 || removedHandles.length > 0,
    addedHandles,
    removedHandles,
  }
}
