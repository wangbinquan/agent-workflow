// RFC-303 runtime ownership locks: a durable terminal fact must stop the exact
// attached driver, wait for its finally/reap receipt, and reject forged effect
// capabilities. These are the process-local halves of the row/owner race.
import { describe, expect, test } from 'bun:test'

import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import { sourceTerminationCapabilityMatches } from '@/modules/task-execution/application/sourceTerminationCapability'
import { InMemoryTaskDriverSupervisor } from '@/modules/task-execution/infrastructure/inMemoryTaskDriverSupervisor'
import type {
  SourceTerminationEffectCapability,
  TaskSourceTerminationEffectInput,
} from '@/modules/task-execution/public/participants'

const cause = {
  kind: 'webhook-terminal',
  terminal: 'merged',
  deliveryId: 'delivery-1',
  streamRevision: 7,
} as const

describe('RFC-303 task driver ownership', () => {
  test('stop targets the attached generation and settles only after owner release', async () => {
    const registry = new InMemoryTaskDriverSupervisor()
    const controller = new AbortController()
    expect(registry.tryAttach('task-1', controller)).toBe(true)
    expect(registry.tryAttach('task-1', new AbortController())).toBe(false)

    const ticket = registry.requestStop('task-1', cause)
    expect(ticket).not.toBe('no-active-owner')
    if (ticket === 'no-active-owner') throw new Error('expected owner ticket')
    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toEqual(cause)

    let settled = false
    void registry.awaitStopped(ticket).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(registry.release('task-1', controller, { kind: 'released' })).toBe(true)
    expect(await registry.awaitStopped(ticket)).toEqual({ kind: 'released' })
  })

  test('a stale controller cannot release a newer or different owner', async () => {
    const registry = new InMemoryTaskDriverSupervisor()
    const owner = new AbortController()
    expect(registry.tryAttach('task-1', owner)).toBe(true)
    expect(registry.release('task-1', new AbortController())).toBe(false)
    expect(registry.has('task-1')).toBe(true)

    const ticket = registry.requestStop('task-1', cause)
    if (ticket === 'no-active-owner') throw new Error('expected owner ticket')
    expect(registry.release('task-1', owner, { kind: 'unreaped', code: 'child-unkillable' })).toBe(
      true,
    )
    expect(await registry.awaitStopped(ticket)).toEqual({
      kind: 'unreaped',
      code: 'child-unkillable',
    })
  })

  test('a missing owner is reported explicitly', () => {
    const registry = new InMemoryTaskDriverSupervisor()
    expect(registry.requestStop('missing', cause)).toBe('no-active-owner')
  })
})

describe('RFC-303 source termination capability', () => {
  const input: TaskSourceTerminationEffectInput = {
    effectId: 'effect-1',
    binding: 'binding-1',
    streamRevision: 3,
    kind: 'fence-closed',
    deliveryId: 'delivery-1',
  }

  test('only the minted object matches its exact durable claim', () => {
    const capability = mintSourceTerminationEffectCapability(input)
    expect(sourceTerminationCapabilityMatches(capability, input)).toBe(true)
    expect(sourceTerminationCapabilityMatches(capability, { ...input, streamRevision: 4 })).toBe(
      false,
    )
    expect(sourceTerminationCapabilityMatches({} as SourceTerminationEffectCapability, input)).toBe(
      false,
    )
  })
})
