// RFC-395 N-domain: immutable rs1 identity and explicit mint roles, dormant until N.
import { describe, expect, test } from 'bun:test'
import { encodeRunSlot, type RunSlot } from '@/modules/task-execution/domain/runSelection/slots'
import {
  RUN_SLOT_KEY_VERSION,
  decodeCanonicalRunSlot,
  encodeCanonicalRunSlot,
} from '@/modules/task-execution/domain/runSelection/slotKey'
import {
  nodeRunSlotKeyForMint,
  type NodeRunMintSlotFacts,
} from '@/modules/task-execution/domain/runSelection/mintIdentity'
import {
  NO_PRODUCER_SHARD_SLOT,
  producerShardSlot,
} from '@/modules/task-execution/domain/runInputShard'

const examples: readonly [RunSlot, string][] = [
  [
    { kind: 'node', nodeId: 'n', frame: { containerRunId: null, iteration: 0 } },
    '["rs1","node","n",null,0]',
  ],
  [
    { kind: 'container', nodeId: 'w', frame: { containerRunId: 'outer', iteration: 2 } },
    '["rs1","container","w","outer",2]',
  ],
  [{ kind: 'shard', nodeId: 'n', iteration: 1, shardKey: null }, '["rs1","shard","n",1,null]'],
  [{ kind: 'shard', nodeId: 'n', iteration: 1, shardKey: '' }, '["rs1","shard","n",1,""]'],
  [{ kind: 'aggregator', nodeId: 'a', iteration: 1 }, '["rs1","aggregator","a",1]'],
  [
    {
      kind: 'synthetic',
      owner: { kind: 'task', id: 't' },
      syntheticKind: 'repo-prep',
      discriminator: '__repo_prep__',
    },
    '["rs1","synthetic","task","t","repo-prep","__repo_prep__"]',
  ],
  [
    {
      kind: 'synthetic',
      owner: { kind: 'attempt', id: 'p' },
      syntheticKind: 'commit-session',
      discriminator: 'n',
    },
    '["rs1","synthetic","attempt","p","commit-session","n"]',
  ],
  [
    { kind: 'workgroup-host', nodeId: 'h', shardKey: 'msg:1' },
    '["rs1","workgroup-host","h","msg:1"]',
  ],
]

function mint(slot: RunSlot): NodeRunMintSlotFacts {
  switch (slot.kind) {
    case 'node':
    case 'shard':
    case 'aggregator':
      return { role: 'node-attempt', syntheticKind: null, slot }
    case 'container':
      return { role: 'container', syntheticKind: null, slot }
    case 'workgroup-host':
      return { role: 'synthetic', syntheticKind: 'workgroup-host', slot }
    case 'synthetic':
      return { role: 'synthetic', syntheticKind: slot.syntheticKind, slot }
  }
}

describe('RFC-395 N-domain canonical slot codec', () => {
  test.each(examples)('pins rs1 bytes and mint agreement: %j', (slot, encoded) => {
    expect(RUN_SLOT_KEY_VERSION).toBe('rs1')
    expect(encodeCanonicalRunSlot(slot)).toBe(encoded)
    expect(encodeRunSlot(slot)).toBe(encoded)
    expect(decodeCanonicalRunSlot(encoded)).toEqual(slot)
    expect(nodeRunSlotKeyForMint(mint(slot))).toBe(encoded)
  })

  test('injectivity across all dimensions, arbitrary delimiters, Unicode and empty values', () => {
    const strings = [
      '',
      'a',
      'a|b',
      'a,b',
      'null',
      '"',
      '\\',
      '\u0000',
      '中文🙂',
      'é',
      'e\u0301',
      '\ud800',
      'shard-v1:none',
    ]
    const seen = new Map<string, RunSlot>()
    const check = (slot: RunSlot) => {
      const key = encodeCanonicalRunSlot(slot)
      expect(decodeCanonicalRunSlot(key)).toEqual(slot)
      expect(encodeCanonicalRunSlot(decodeCanonicalRunSlot(key))).toBe(key)
      const previous = seen.get(key)
      if (previous !== undefined) expect(previous).toEqual(slot)
      seen.set(key, slot)
    }
    for (const nodeId of strings)
      for (const other of [null, ...strings]) {
        check({ kind: 'workgroup-host', nodeId, shardKey: other })
        for (const iteration of [0, 1, Number.MAX_SAFE_INTEGER]) {
          check({ kind: 'node', nodeId, frame: { containerRunId: other, iteration } })
          check({ kind: 'container', nodeId, frame: { containerRunId: other, iteration } })
          check({ kind: 'shard', nodeId, iteration, shardKey: other })
          check({ kind: 'aggregator', nodeId, iteration })
        }
        for (const kind of ['task', 'attempt'] as const)
          for (const syntheticKind of [
            'repo-prep',
            'commit-push',
            'commit-session',
            'merge-resolve',
            'dw-gate',
            'wg-gate',
            'dw-orchestrator',
          ] as const)
            check({
              kind: 'synthetic',
              owner: { kind, id: nodeId },
              syntheticKind,
              discriminator: other ?? 'fallback',
            })
      }
    expect(seen.size).toBeGreaterThan(4000)
  })

  test('shares R1 null/empty semantics without changing the existing structured rs1 representation', () => {
    expect(producerShardSlot(null)).toBe(NO_PRODUCER_SHARD_SLOT)
    expect(producerShardSlot('')).toBe('shard-v1:key:""')
    const slot = { kind: 'shard' as const, nodeId: 'n', iteration: 0 }
    const values = [null, '', NO_PRODUCER_SHARD_SLOT, 'shard-v1:key:""', '🙂']
    expect(
      new Set(values.map((shardKey) => encodeCanonicalRunSlot({ ...slot, shardKey }))).size,
    ).toBe(values.length)
    expect(new Set(values.map(producerShardSlot)).size).toBe(values.length)
  })

  test.each([
    '[]',
    '["rs2","aggregator","n",0]',
    '["rs1","node","n",null,0,1]',
    '["rs1", "aggregator", "n", 0]',
    '["rs1","aggregator","n",-0]',
    '["rs1","aggregator","n",1.0]',
    '["rs1","aggregator","n",-1]',
    '["rs1","shard","n",0]',
    '["rs1","synthetic","task","t","workgroup-host","h"]',
  ])('rejects noncanonical bytes or unknown version: %s', (value) => {
    expect(() => decodeCanonicalRunSlot(value)).toThrow('invalid-run-slot')
  })

  test.each([-1, -0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects lossy iteration %s',
    (iteration) => {
      expect(() => encodeCanonicalRunSlot({ kind: 'aggregator', nodeId: 'n', iteration })).toThrow(
        'invalid-run-slot-iteration',
      )
    },
  )

  test('does not turn missing scope facts into recorded nulls', () => {
    for (const slot of [
      { kind: 'shard', nodeId: 'n', iteration: 0 },
      { kind: 'workgroup-host', nodeId: 'h' },
      { kind: 'node', nodeId: 'n', frame: { iteration: 0 } },
    ])
      expect(() => encodeCanonicalRunSlot(slot as RunSlot)).toThrow('invalid-run-slot')
  })
})

describe('RFC-395 N-domain writer-owned mint identity', () => {
  test('excludes mutable rounds, attempts, generations, and fanout outer frames', () => {
    for (const [slot] of examples) {
      const facts = mint(slot)
      const withMutableAttributes = {
        ...facts,
        reviewIteration: 8,
        wgRound: 5,
        retryIndex: 10,
        generationSeq: 12,
      }
      expect(nodeRunSlotKeyForMint(withMutableAttributes)).toBe(nodeRunSlotKeyForMint(facts))
    }
    const shard = { kind: 'shard' as const, nodeId: 'n', iteration: 3, shardKey: '' }
    expect(encodeCanonicalRunSlot({ ...shard, containerRunId: 'g0' } as RunSlot)).toBe(
      encodeCanonicalRunSlot({ ...shard, containerRunId: 'g1' } as RunSlot),
    )
    expect(
      encodeCanonicalRunSlot({
        kind: 'node',
        nodeId: 'n',
        frame: { containerRunId: 'g0', iteration: 3 },
      }),
    ).not.toBe(
      encodeCanonicalRunSlot({
        kind: 'node',
        nodeId: 'n',
        frame: { containerRunId: 'g1', iteration: 3 },
      }),
    )
  })

  test('checks role/slot and synthetic-kind agreement at runtime', () => {
    for (const [slot] of examples) {
      expect(() =>
        nodeRunSlotKeyForMint({ ...mint(slot), role: 'wrong' } as unknown as NodeRunMintSlotFacts),
      ).toThrow('node-run-role-slot-mismatch')
      expect(() =>
        nodeRunSlotKeyForMint({
          ...mint(slot),
          syntheticKind: 'wrong',
        } as unknown as NodeRunMintSlotFacts),
      ).toThrow('node-run-role-slot-mismatch')
    }
    expect(() =>
      nodeRunSlotKeyForMint({
        role: 'container',
        syntheticKind: null,
        slot: examples[0]![0],
      } as NodeRunMintSlotFacts),
    ).toThrow('node-run-role-slot-mismatch')
    expect(() =>
      nodeRunSlotKeyForMint({
        role: 'synthetic',
        syntheticKind: 'wg-gate',
        slot: examples[7]![0],
      } as NodeRunMintSlotFacts),
    ).toThrow('node-run-role-slot-mismatch')
  })
})
