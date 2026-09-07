// RFC-359: each provider core receives a complete policy. Constructor callbacks
// retain their owning session and resolve later lexical bindings only when called;
// there is no optional slot or post-construction bind step to omit.

import { describe, expect, test } from 'bun:test'

import { buildActor } from '../src/auth/actor'
import { composeDaemonRealtimePolicy } from '../src/cli/daemonRealtimePolicy'
import type { DirectRequestAuthority } from '../src/modules/identity-access/public/participants'
import type { RealtimeCompositionPolicy } from '../src/modules/runtime-management/public/participants'

const actor = buildActor({
  user: {
    id: 'realtime-user',
    username: 'realtime-user',
    displayName: 'Realtime User',
    role: 'user',
    status: 'active',
  },
  source: 'session',
})

const authority = Object.freeze({}) as DirectRequestAuthority

function policy(label: string, calls: string[]): RealtimeCompositionPolicy {
  return {
    resourceVisibility: {
      async canViewResource(receivedActor, type, row) {
        calls.push(`resource:${receivedActor.user.id}:${type}:${row.id}`)
        return label === 'primary'
      },
    },
    memoryVisibility: {
      async canViewMemory(receivedAuthority, receivedActor, scope) {
        expect(receivedAuthority).toBe(authority)
        calls.push(
          `memory:${receivedActor.user.id}:${scope.scopeType}:${scope.scopeId ?? 'global'}`,
        )
        return label === 'primary'
      },
    },
    repoImportOwnerUserId(batchId) {
      calls.push(`repo:${batchId}`)
      return `${label}:${batchId}`
    },
    redactTaskEventPayload(payload, actorSource) {
      calls.push(`redact:${actorSource}`)
      return { label, payload }
    },
  }
}

describe('RFC-359 complete daemon realtime policy', () => {
  test('constructs one frozen policy with all four capabilities', () => {
    const composed = composeDaemonRealtimePolicy(policy('primary', []))
    expect(Object.keys(composed).sort()).toEqual([
      'memoryVisibility',
      'redactTaskEventPayload',
      'repoImportOwnerUserId',
      'resourceVisibility',
    ])
    expect(Object.isFrozen(composed)).toBe(true)
    expect(Object.isFrozen(composed.resourceVisibility)).toBe(true)
    expect(Object.isFrozen(composed.memoryVisibility)).toBe(true)
  })

  test('forwards complete inputs and results without a later bind step', async () => {
    const calls: string[] = []
    const retained = composeDaemonRealtimePolicy(policy('primary', calls))
    await expect(
      retained.resourceVisibility.canViewResource(actor, 'workgroup', {
        id: 'workgroup-1',
        ownerUserId: actor.user.id,
        visibility: 'private',
      }),
    ).resolves.toBe(true)
    await expect(
      retained.memoryVisibility.canViewMemory(authority, actor, {
        scopeType: 'repo',
        scopeId: 'repo-1',
      }),
    ).resolves.toBe(true)
    expect(retained.repoImportOwnerUserId('batch-1')).toBe('primary:batch-1')
    expect(retained.redactTaskEventPayload({ value: 'payload' }, 'pat')).toEqual({
      label: 'primary',
      payload: { value: 'payload' },
    })
    expect(calls).toEqual([
      'resource:realtime-user:workgroup:workgroup-1',
      'memory:realtime-user:repo:repo-1',
      'repo:batch-1',
      'redact:pat',
    ])
  })

  test('captures methods with their receivers and does not replace a retained policy', () => {
    const original = {
      ...policy('primary', []),
      label: 'owner',
      repoImportOwnerUserId(batch: string) {
        return `${this.label}:${batch}`
      },
    }
    const retained = composeDaemonRealtimePolicy(original)
    original.repoImportOwnerUserId = () => 'replacement'
    expect(retained.repoImportOwnerUserId('batch')).toBe('owner:batch')
  })

  test('keeps independent daemon sessions on their own owners', () => {
    const first = composeDaemonRealtimePolicy(policy('first', []))
    const second = composeDaemonRealtimePolicy(policy('second', []))
    expect(first.repoImportOwnerUserId('batch')).toBe('first:batch')
    expect(second.repoImportOwnerUserId('batch')).toBe('second:batch')
    expect(first.repoImportOwnerUserId('batch')).toBe('first:batch')
  })

  test('constructs callbacks before their lexical owner without evaluating that owner', () => {
    const composed = composeDaemonRealtimePolicy({
      ...policy('primary', []),
      repoImportOwnerUserId: (batch) => owner.repoImportOwnerUserId(batch),
    })
    const owner = policy('later', [])
    expect(composed.repoImportOwnerUserId('batch')).toBe('later:batch')
  })
})
