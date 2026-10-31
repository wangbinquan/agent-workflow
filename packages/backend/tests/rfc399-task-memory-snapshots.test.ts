// RFC-399 A10: required SPI preserves the historical snapshot bytes and decode result.
import { expect, test } from 'bun:test'
import type { InjectedMemorySnapshot } from '@agent-workflow/shared'
import { composeTaskMemorySnapshotPort } from '@/modules/memory/composition'
import {
  formatMemoryBlockFromSnapshot,
  memoryFencingForNonce,
  parseInjectedSnapshotJson,
} from '@/modules/memory/domain/injectionRendering'

const snapshot: InjectedMemorySnapshot[] = [
  {
    id: 'second',
    version: 3,
    scopeType: 'repo',
    scopeId: 'repo',
    title: 'Line one\nline two',
    bodyMd: 'body **two**',
    tags: ['two'],
    sourceKind: 'manual',
    approvedAt: 42,
  },
  {
    id: 'first',
    version: 1,
    scopeType: 'agent',
    scopeId: 'agent',
    title: 'First',
    bodyMd: 'body one',
    tags: [],
    sourceKind: 'manual',
    approvedAt: null,
  },
]

test('the injected renderer preserves snapshot order, empty results and every nonce form', () => {
  const port = composeTaskMemorySnapshotPort()
  for (const nonce of ['nonce-399', '', null, undefined]) {
    for (const value of [snapshot, [], null]) {
      expect(port.renderSnapshot(value, nonce)).toBe(
        formatMemoryBlockFromSnapshot(value, memoryFencingForNonce(nonce)),
      )
    }
  }
})

test('the injected decoder preserves valid snapshots and malformed JSON fallback', () => {
  const port = composeTaskMemorySnapshotPort()
  for (const raw of [
    JSON.stringify(snapshot),
    '{invalid',
    '{"not":"array"}',
    '[null,3,{}]',
    null,
  ]) {
    expect(port.parseSnapshotJson(raw)).toEqual(parseInjectedSnapshotJson(raw))
  }
  expect(port.parseSnapshotJson(JSON.stringify(snapshot))).toEqual(snapshot)
  expect(port.parseSnapshotJson('{invalid')).toBeNull()
})
