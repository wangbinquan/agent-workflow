// RFC-062: locks the `'in-flight'` literal into the InventoryReasonCode union
// so the read-end fallback in `services/inventory.ts` can emit it without a
// schema regression. Reason for this file (not folded into inventory-schema):
// the regression we're locking in is the *existence of the literal*, not the
// shape of the discriminated union — keep the test name pinpointed so a future
// "let's slim the union back down" PR turns this file red with the right
// signal.

import { describe, expect, test } from 'bun:test'
import {
  InventoryReasonCodeSchema,
  InventorySnapshotMissingSchema,
  InventorySnapshotSchema,
} from '../src/inventory'

describe('RFC-062: in-flight reason code', () => {
  test('InventoryReasonCodeSchema accepts the literal "in-flight"', () => {
    expect(InventoryReasonCodeSchema.parse('in-flight')).toBe('in-flight')
  })

  test('InventorySnapshotMissingSchema accepts {captured:false, reason:in-flight}', () => {
    const parsed = InventorySnapshotMissingSchema.parse({
      captured: false,
      reason: 'in-flight',
      message: null,
    })
    expect(parsed.captured).toBe(false)
    expect(parsed.reason).toBe('in-flight')
    expect(parsed.message).toBeNull()
  })

  test('InventorySnapshotSchema discriminator routes in-flight to the missing branch', () => {
    const parsed = InventorySnapshotSchema.parse({
      captured: false,
      reason: 'in-flight',
      message: null,
    })
    expect(parsed.captured).toBe(false)
    if (!parsed.captured) expect(parsed.reason).toBe('in-flight')
  })
})
