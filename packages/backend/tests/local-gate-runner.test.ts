// Regression guard for the optimized local gate.
//
// A previous direct `bun test --parallel` attempt deadlocked because workers
// shared the daemon flock/home. The local runner instead launches complete,
// serial Bun shards and gives every process a distinct home/temp namespace.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOCAL_GATE_LANES } from '../../../scripts/local-gate'
import {
  buildBackendShardPlans,
  DEFAULT_LOCAL_BACKEND_SHARDS,
  resolveLocalBackendShardCount,
  resolveLocalTestSeed,
} from '../../../scripts/test-backend-sharded'

describe('local backend shard plan', () => {
  test('defaults to four complete serial-isolate shards', () => {
    const plans = buildBackendShardPlans({
      runRoot: '/tmp/aw-local-gate',
      shardCount: DEFAULT_LOCAL_BACKEND_SHARDS,
      baseSeed: 100,
      bunExecutable: '/opt/bun',
    })

    expect(plans).toHaveLength(4)
    expect(plans.map((plan) => `${plan.index}/${plan.count}`)).toEqual(['1/4', '2/4', '3/4', '4/4'])
    expect(plans.map((plan) => plan.seed)).toEqual([100, 101, 102, 103])
    for (const plan of plans) {
      expect(plan.command).toEqual([
        '/opt/bun',
        'test',
        '--isolate',
        '--randomize',
        `--seed=${plan.seed}`,
        `--shard=${plan.index}/4`,
        '--dots',
      ])
    }
  })

  test('assigns every shard a unique persistent home and temp baseline', () => {
    const plans = buildBackendShardPlans({
      runRoot: '/tmp/aw-local-gate',
      shardCount: 4,
      baseSeed: 200,
    })

    expect(new Set(plans.map((plan) => plan.homeDir)).size).toBe(4)
    expect(new Set(plans.map((plan) => plan.tempDir)).size).toBe(4)
    for (const plan of plans) {
      expect(plan.env.AGENT_WORKFLOW_HOME).toBe(plan.homeDir)
      expect(plan.env.AGENT_WORKFLOW_TEST_SHARD_HOME).toBe(plan.homeDir)
      expect(plan.env.AGENT_WORKFLOW_TEST_SHARD_TMP).toBe(plan.tempDir)
      expect(plan.env.TMPDIR).toBe(plan.tempDir)
      expect(plan.env.TMP).toBe(plan.tempDir)
      expect(plan.env.TEMP).toBe(plan.tempDir)
    }
  })

  test('rejects malformed shard and seed overrides', () => {
    expect(resolveLocalBackendShardCount(undefined)).toBe(4)
    expect(resolveLocalBackendShardCount('6')).toBe(6)
    expect(() => resolveLocalBackendShardCount('0')).toThrow('AW_LOCAL_BACKEND_SHARDS')
    expect(() => resolveLocalBackendShardCount('2.5')).toThrow('AW_LOCAL_BACKEND_SHARDS')
    expect(resolveLocalTestSeed('2147483647')).toBe(2_147_483_647)
    expect(() => resolveLocalTestSeed('-1')).toThrow('AW_LOCAL_TEST_SEED')
  })
})

describe('local full-gate plan', () => {
  test('runs the backend concurrently with every canonical quality and non-backend gate', () => {
    expect(LOCAL_GATE_LANES.map((lane) => lane.name)).toEqual(['backend', 'quality'])
    expect(LOCAL_GATE_LANES[0]?.commands).toEqual([
      { label: 'backend tests', args: ['run', 'test:backend'] },
    ])
    expect(LOCAL_GATE_LANES[1]?.commands.map((command) => command.args.join(' '))).toEqual([
      'run typecheck',
      'run lint',
      'run format:check',
      'run depcheck',
      'run test:shared',
      'run test:frontend',
    ])
  })

  test('collects every lane result instead of short-circuiting on the first red command', () => {
    const source = readFileSync(resolve(import.meta.dir, '../../../scripts/local-gate.ts'), 'utf8')
    expect(source).toContain('failures.push(error)')
    expect(source).toContain('continuing to collect remaining results')
    expect(source).toContain('await Promise.allSettled(lanes)')
    expect(source).not.toContain('await Promise.all(lanes)')
  })
})
