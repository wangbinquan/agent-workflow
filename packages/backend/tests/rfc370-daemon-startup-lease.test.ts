import { expect, test } from 'bun:test'
import {
  composeDaemonStartupLease,
  readDaemonStartupRecoveryAuthority,
  runDaemonStartupWithLease,
  type DaemonStartupLease,
  type DaemonStartupLeasePort,
} from '../src/modules/system-operations/composition'
import { createDaemonRecoveryAuthorityProof } from '../src/modules/task-execution/composition/bootRecovery'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

const nextTurn = () => new Promise<void>((accept) => setImmediate(accept))

function selectedLease() {
  const events: string[] = []
  const recoveryEntered = deferred()
  const recoveryAck = deferred()
  const releaseEntered = deferred()
  const releaseAck = deferred()
  class Lease implements DaemonStartupLease {
    get diagnostics() {
      return Object.freeze({ holder: 'selected-service-instance' })
    }
    async recoveryAuthority(input: Parameters<DaemonStartupLease['recoveryAuthority']>[0]) {
      expect<DaemonStartupLease>(this).toBe(lease)
      events.push('recovery:enter')
      recoveryEntered.resolve()
      await recoveryAck.promise
      return {
        daemonGeneration: input.daemonGeneration,
        acquiredAt: 73,
        receiptDigest: 'selected-opaque-startup-receipt',
      }
    }
    async release() {
      expect<DaemonStartupLease>(this).toBe(lease)
      events.push('release:enter')
      releaseEntered.resolve()
      await releaseAck.promise
      events.push('release:ack')
    }
    releaseOnExit() {
      expect<DaemonStartupLease>(this).toBe(lease)
      events.push('exit-release')
    }
  }
  const lease: DaemonStartupLease = Object.freeze(new Lease())
  return { lease, events, recoveryEntered, recoveryAck, releaseEntered, releaseAck }
}

test('selected prototype acquisition ACK precedes boot and never constructs the local provider', async () => {
  const f = selectedLease()
  const entered = deferred()
  const ack = deferred()
  let booted = false
  let localCalls = 0
  class Provider implements DaemonStartupLeasePort {
    async acquire() {
      expect<DaemonStartupLeasePort>(this).toBe(provider)
      entered.resolve()
      await ack.promise
      return f.lease
    }
  }
  const provider: DaemonStartupLeasePort = Object.freeze(new Provider())
  expect(Object.keys(provider)).toEqual([])
  expect(Object.keys(f.lease)).toEqual([])
  const boot = composeDaemonStartupLease({
    selected: provider,
    local() {
      localCalls += 1
      throw new Error('selected startup must not inspect local files')
    },
  }).then((lease) =>
    runDaemonStartupWithLease(lease, async () => {
      expect(lease).toBe(f.lease)
      booted = true
      return 'ready'
    }),
  )
  await entered.promise
  await nextTurn()
  expect(booted).toBe(false)
  ack.resolve()
  await expect(boot).resolves.toBe('ready')
  expect(localCalls).toBe(0)
  expect(f.events).toEqual([])
  expect(f.lease.diagnostics).toEqual({ holder: 'selected-service-instance' })
}, 20_000)

test('an opaque recovery receipt is used only after its ACK, with no native identity fields', async () => {
  const f = selectedLease()
  let resolved = false
  const reading = readDaemonStartupRecoveryAuthority(f.lease, 'business-generation').then(
    (receipt) => {
      resolved = true
      return createDaemonRecoveryAuthorityProof(receipt)
    },
  )
  await f.recoveryEntered.promise
  await nextTurn()
  expect(resolved).toBe(false)
  f.recoveryAck.resolve()
  const proof = await reading
  expect(proof.daemonGeneration).toBe('business-generation')
  expect(proof.acquiredAt).toBe(73)
  expect(proof.lockReceiptDigest).toBe('selected-opaque-startup-receipt')
  expect(f.events).toEqual(['recovery:enter'])
}, 20_000)

test('a failed boot waits for selected release ACK and preserves the original error', async () => {
  const f = selectedLease()
  const failure = new Error('boot-provider-failed')
  let observed: unknown
  const result = runDaemonStartupWithLease(f.lease, async () => {
    throw failure
  }).catch((error: unknown) => {
    observed = error
  })
  await f.releaseEntered.promise
  await nextTurn()
  expect(observed).toBeUndefined()
  expect(f.events).toEqual(['release:enter'])
  f.releaseAck.resolve()
  await result
  expect(observed).toBe(failure)
  expect(f.events).toEqual(['release:enter', 'release:ack'])
  f.lease.releaseOnExit()
  expect(f.events).toEqual(['release:enter', 'release:ack', 'exit-release'])
}, 20_000)

// RFC-370 first gate P2: a selected diagnostics getter may fail after acquire ACK.
test('a synchronous diagnostics getter failure waits for the selected release ACK', async () => {
  const f = selectedLease()
  const failure = new Error('selected-diagnostics-failed')
  let reads = 0
  let localCalls = 0
  let booted = false
  let observed: unknown
  class Lease implements DaemonStartupLease {
    get diagnostics(): Readonly<Record<string, unknown>> {
      reads += 1
      throw failure
    }
    recoveryAuthority(input: Parameters<DaemonStartupLease['recoveryAuthority']>[0]) {
      return f.lease.recoveryAuthority(input)
    }
    release() {
      return f.lease.release()
    }
    releaseOnExit() {
      return f.lease.releaseOnExit()
    }
  }
  const selected: DaemonStartupLease = Object.freeze(new Lease())
  const result = composeDaemonStartupLease({
    selected: { acquire: () => selected },
    local() {
      localCalls += 1
      throw new Error('selected startup must not inspect local files')
    },
  })
    .then((lease) =>
      runDaemonStartupWithLease(lease, async () => {
        expect(lease).toBe(selected)
        expect(Object.keys(lease)).toEqual([])
        void lease.diagnostics
        booted = true
      }),
    )
    .catch((error: unknown) => {
      observed = error
    })
  await f.releaseEntered.promise
  await nextTurn()
  expect(reads).toBe(1)
  expect(booted).toBe(false)
  expect(localCalls).toBe(0)
  expect(observed).toBeUndefined()
  expect(f.events).toEqual(['release:enter'])
  f.releaseAck.resolve()
  await result
  expect(observed).toBe(failure)
  expect(f.events).toEqual(['release:enter', 'release:ack'])
}, 20_000)

test.each([false, true])(
  'selected acquisition failure (%s async) never falls back',
  async (async) => {
    const failure = new Error('startup-claim-refused')
    let localCalls = 0
    const selected: DaemonStartupLeasePort = {
      acquire() {
        if (async) return Promise.reject(failure)
        throw failure
      },
    }
    await expect(
      composeDaemonStartupLease({
        selected,
        local() {
          localCalls += 1
          throw new Error('local fallback')
        },
      }),
    ).rejects.toBe(failure)
    expect(localCalls).toBe(0)
  },
)

test.each([
  { daemonGeneration: 'other', acquiredAt: 1, receiptDigest: 'receipt' },
  { daemonGeneration: 'expected', acquiredAt: 1, receiptDigest: '' },
  { daemonGeneration: 'expected', acquiredAt: Number.NaN, receiptDigest: 'receipt' },
])('a mismatched recovery receipt fails boot and releases its selected claim', async (receipt) => {
  let released = 0
  const lease: DaemonStartupLease = {
    diagnostics: {},
    recoveryAuthority: () => receipt,
    release() {
      released += 1
    },
    releaseOnExit() {},
  }
  await expect(
    runDaemonStartupWithLease(lease, () => readDaemonStartupRecoveryAuthority(lease, 'expected')),
  ).rejects.toThrow('daemon-startup-recovery-authority-invalid')
  expect(released).toBe(1)
})

test('boot and release failures remain separately observable', async () => {
  const bootFailure = new Error('boot-failed')
  const releaseFailure = new Error('release-ack-lost')
  const lease: DaemonStartupLease = {
    diagnostics: {},
    recoveryAuthority() {
      throw new Error('unused')
    },
    release() {
      throw releaseFailure
    },
    releaseOnExit() {},
  }
  const failure = await runDaemonStartupWithLease(lease, async () => {
    throw bootFailure
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error('missing aggregate boot error')
  expect(failure.errors).toEqual([bootFailure, releaseFailure])
})
