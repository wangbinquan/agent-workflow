// Locks the platform-to-existing-verifier contract: actual facts only, no
// declaration-as-observation fallback, no secret-bearing malformed payloads.
import { expect, test } from 'bun:test'
import type { BusinessEvent } from '@/platform/crewstation/businessExecution'
import {
  readHostedStartupInventory,
  hostedStartupObservation,
} from '@/platform/crewstation/startupInventory'
import { hostedEventRecord } from '@/modules/task-execution/infrastructure/crewstation/runtimeEvents'
import { verifyStartup, observationForVerification } from '@/services/execution/startupVerification'
import { buildRuntimeInventoryObservation } from '@/services/execution/inventoryObservation'
import { emptyDeclaredManifest } from '@/services/execution/agentInjection'
import { getRuntimeDriver } from '@/services/runtime'

const report = () => ({
  version: 1,
  state: 'verified',
  source: 'opencode-inventory',
  mcpServers: [
    { name: 'loaded', status: 'connected' },
    { name: 'broken', status: 'failed' },
  ],
  skills: ['actual'],
  agents: [],
})
const event = (data: unknown): BusinessEvent =>
  ({
    taskId: 'parent',
    subtaskId: 'child',
    attempt: 3,
    cursor: '9',
    sourceEventId: 'event-9',
    occurredAt: new Date(1000).toISOString(),
    type: 'startup-inventory',
    data,
  }) as BusinessEvent

test('stream inventory reaches the ordinary verifier and preserves unreported faces', async () => {
  const record = hostedEventRecord(event(report()), 'opencode')
  expect(record.event).toMatchObject({ kind: 'startup_inventory', persist: false })
  const observation = record.event.data!.startupObservation!
  expect(observation).not.toHaveProperty('tools')
  const caps = {
    ...getRuntimeDriver('opencode').capabilities,
    startupObservation: 'init-event' as const,
  }
  let fileReads = 0
  const selected = await observationForVerification(caps, {
    claudeInit: null,
    streamObservation: observation,
    loadSnapshot: () => {
      fileReads++
      return null
    },
  })
  expect(fileReads).toBe(0)
  expect(selected).toBe(observation)
  const declared = {
    ...emptyDeclaredManifest(),
    mcpServers: ['loaded', 'broken', 'missing'],
    skills: ['actual', 'missing-skill'],
    subagents: ['missing-agent'],
  }
  expect(verifyStartup(declared, selected)).toMatchObject({
    observation: 'verified',
    mcpUnusable: [
      { name: 'broken', status: 'failed' },
      { name: 'missing', status: 'missing' },
    ],
    skillsMissing: ['missing-skill'],
    subagentsMissing: ['missing-agent'],
  })
  const inventory = buildRuntimeInventoryObservation({
    capabilities: caps,
    freshRun: true,
    declared,
    claudeInit: null,
    snapshot: null,
    streamObservation: observation,
    now: 1000,
  })
  expect(inventory).toMatchObject({
    state: 'captured',
    faces: {
      skills: [
        { key: 'actual', provenance: 'injected' },
        { key: 'missing-skill', provenance: 'declared-missing' },
      ],
    },
  })
  if (inventory.state === 'captured') expect(inventory.faces).not.toHaveProperty('tools')
})

test('unavailable and malformed reports retain their reason without fabricating an empty captured inventory', () => {
  for (const state of ['unavailable', 'malformed'] as const) {
    const observation = hostedStartupObservation(
      readHostedStartupInventory(
        { version: 1, state, reason: 'inventory-file-missing' },
        'opencode',
      ),
    )
    const actual = buildRuntimeInventoryObservation({
      capabilities: getRuntimeDriver('opencode').capabilities,
      freshRun: true,
      declared: emptyDeclaredManifest(),
      claudeInit: null,
      snapshot: null,
      streamObservation: observation,
      now: 1000,
    })
    expect(actual).toEqual({ state, reason: 'inventory-file-missing', message: null })
  }
})

test('strict inventory transport rejects source mismatch, duplicate names, unknown fields and secret diagnostics', () => {
  for (const invalid of [
    { ...report(), version: 2 },
    { ...report(), source: 'claude-init' },
    { ...report(), agents: ['duplicate', 'duplicate'] },
    {
      ...report(),
      mcpServers: [
        { name: 'x', status: 'connected' },
        { name: 'x', status: 'failed' },
      ],
    },
    { ...report(), mcpServers: [{ name: 'x', status: 'connected', hint: 'secret-token' }] },
    { ...report(), headers: { authorization: 'secret-token' } },
    { version: 1, state: 'unavailable', reason: 'secret-token /etc/private/config' },
    { ...report(), skills: ['bad\nname'] },
  ]) {
    const record = hostedEventRecord(event(invalid), 'opencode')
    expect(record.event.data?.startupObservation?.state).toBe('malformed')
    expect(record.raw).not.toContain('secret-token')
    expect(record.event.data).not.toHaveProperty('inventory')
  }
  expect(
    hostedEventRecord(event({ ...report(), skills: ['x'.repeat(270_000)] }), 'opencode').event.data
      ?.startupObservation,
  ).toEqual({ state: 'unavailable', reason: 'inventory-too-large' })
  expect(hostedEventRecord(event(report())).event.data?.startupObservation?.state).toBe(
    'unavailable',
  )
})
