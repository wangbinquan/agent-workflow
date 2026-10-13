import { expect, spyOn, test } from 'bun:test'
import { ConfigSchema } from '@agent-workflow/shared'
import { runEventCenterCycle } from '@/modules/event-center/composition'
import { runDigitalEmployeeOsCycle } from '@/modules/digital-employee/composition'
import {
  IndeterminateRuntimeProcessError,
  MemoryDistillSettlementPendingError,
} from '@/modules/memory/composition'
import type { MemoryDistillWorker } from '@/modules/memory/public/commands'
import {
  bindDigitalEmployeeHostOwner,
  bindEventCenterHostOwner,
  bindMemoryDistillHostOwner,
} from '../src/cli/daemonHostExecutionOwners'
import { deferred } from './helpers/taskHostExecution'

function grant() {
  let active = true
  const context = {
    generation: 'bounded-owner',
    reference: Object.freeze({}),
    current() {
      expect(this).toBe(context)
      return active
    },
  }
  return {
    context,
    scope: {
      provider: 'sqlite' as const,
      generationId: context.generation,
      operationId: 'bounded-owner',
    },
    lose() {
      active = false
    },
  }
}
function unexpected(): never {
  throw new Error('unadmitted operation')
}

test.each(['publication', 'observer', 'notification'] as const)(
  'Event Center retains the admitted %s ACK and stops before the next work unit',
  async (held) => {
    const entered = deferred(),
      release = deferred(),
      calls: string[] = []
    const one = async (name: string) => {
      calls.push(name)
      if (name === held) {
        entered.resolve()
        await release.promise
        return 'completed' as const
      }
      return 'idle' as const
    }
    const results: Awaited<ReturnType<typeof runEventCenterCycle>>[] = []
    const owner = bindEventCenterHostOwner({
      worker: {
        runOnePublication: () => one('publication'),
        runOneDueObserver: () => one('observer'),
        runOneNotification: () => one('notification'),
      },
      onCycle: (result) => {
        results.push(result)
      },
      onError: unexpected,
    })
    const g = grant(),
      handle = await owner.start(g)
    await entered.promise
    g.lose()
    await owner.quiesceAuthorityLoss({ context: g.context, handle })
    let drained = false
    const draining = Promise.resolve(owner.drainAuthorityLoss({ context: g.context, handle })).then(
      () => {
        drained = true
      },
    )
    await Promise.resolve()
    expect(drained).toBe(false)
    release.resolve()
    await draining
    expect(calls).toEqual(
      ['publication', 'observer', 'notification'].slice(
        0,
        ['publication', 'observer', 'notification'].indexOf(held) + 1,
      ),
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.madeProgress).toBe(true)
  },
)

test('Digital Employee keeps the original reaction launch receipt after loss, without beginning inspection', async () => {
  const entered = deferred(),
    release = deferred(),
    calls: string[] = []
  const results: Awaited<ReturnType<typeof runDigitalEmployeeOsCycle>>[] = []
  const owner = bindDigitalEmployeeHostOwner({
    async prepare() {
      calls.push('prepare')
    },
    dependencies: {
      runtime: {
        async publishOneChannelResult() {
          calls.push('channel')
          return 'idle'
        },
        async pumpOneDelivery() {
          calls.push('delivery')
          return false
        },
        async planOneReaction() {
          calls.push('plan')
          return null
        },
        async runOneOutbox() {
          calls.push('outbox')
          return 'idle'
        },
        async dispatchOneReaction() {
          calls.push('dispatch')
          entered.resolve()
          await release.promise
          return 'launched'
        },
        inspectOneExecution: unexpected,
      },
    },
    onCycle: (result) => {
      results.push(result)
    },
    onError: unexpected,
  })
  const g = grant(),
    handle = await owner.start(g)
  await entered.promise
  g.lose()
  await owner.quiesceAuthorityLoss({ context: g.context, handle })
  let drained = false
  const draining = Promise.resolve(owner.drainAuthorityLoss({ context: g.context, handle })).then(
    () => {
      drained = true
    },
  )
  await Promise.resolve()
  expect(drained).toBe(false)
  release.resolve()
  await draining
  expect(calls).toEqual(['prepare', 'channel', 'delivery', 'plan', 'outbox', 'dispatch'])
  expect(results[0]).toMatchObject({
    reactionDispatches: 1,
    executionSettlements: 0,
    madeProgress: true,
  })
})

test('inactive bounded drivers do not call any business worker', async () => {
  const execution = { current: () => false }
  expect(
    await runEventCenterCycle(
      {
        runOnePublication: unexpected,
        runOneDueObserver: unexpected,
        runOneNotification: unexpected,
      },
      32,
      execution,
    ),
  ).toMatchObject({ steps: 0, madeProgress: false })
  expect(
    await runDigitalEmployeeOsCycle(
      {
        runtime: {
          publishOneChannelResult: unexpected,
          pumpOneDelivery: unexpected,
          planOneReaction: unexpected,
          runOneOutbox: unexpected,
          dispatchOneReaction: unexpected,
          inspectOneExecution: unexpected,
        },
      },
      32,
      execution,
    ),
  ).toMatchObject({ steps: 0, madeProgress: false })
})

test('Memory owner waits for the exact initial recovery before acknowledging a lost startup', async () => {
  const entered = deferred(),
    release = deferred()
  const worker: MemoryDistillWorker = {
    tick: unexpected,
    start: unexpected,
    listJobs: unexpected,
    async recoverRunning() {
      entered.resolve()
      await release.promise
      return { recovered: 1 }
    },
  }
  const owner = bindMemoryDistillHostOwner({
      worker,
      configuration: { read: unexpected },
      onError: unexpected,
    }),
    g = grant()
  let started = false
  const starting = owner.start(g).then((handle) => {
    started = true
    return handle
  })
  await entered.promise
  g.lose()
  expect(started).toBe(false)
  release.resolve()
  const handle = await starting
  await owner.quiesceAuthorityLoss({ context: g.context, handle })
  await owner.drainAuthorityLoss({ context: g.context, handle })
})

// The real memory store/runtime test lives beside the original scheduler cases.
// This case additionally locks the root adapter's error handling: logging an
// unreaped process may not turn it into a successful lifecycle ACK.
test('Memory owner propagates an unreaped original turn through its actual drain', async () => {
  const entered = deferred(),
    release = deferred()
  const failure = new IndeterminateRuntimeProcessError('fixture original runtime still alive')
  const errors: unknown[] = []
  const worker: MemoryDistillWorker = {
    start: unexpected,
    listJobs: unexpected,
    recoverRunning: async () => ({ recovered: 0 }),
    async tick(options) {
      expect(options?.execution?.current()).toBe(true)
      entered.resolve()
      await release.promise
      throw failure
    },
  }
  const owner = bindMemoryDistillHostOwner({
    worker,
    configuration: { read: () => ({ ...ConfigSchema.parse({}), memoryDistillerEnabled: true }) },
    onError: (error) => {
      errors.push(error)
    },
  })
  const g = grant(),
    timer = spyOn(globalThis, 'setTimeout'),
    handle = await owner.start(g)
  try {
    const args = timer.mock.calls[0],
      result = timer.mock.results[0]
    if (args === undefined || result?.type !== 'return' || typeof args[0] !== 'function')
      throw new Error('original memory polling timer missing')
    clearTimeout(result.value)
    args[0](...args.slice(2))
    await entered.promise
    g.lose()
    await owner.quiesceAuthorityLoss({ context: g.context, handle })
    release.resolve()
    await expect(
      Promise.resolve(owner.drainAuthorityLoss({ context: g.context, handle })),
    ).rejects.toBe(failure)
    expect(errors).toEqual([failure])
  } finally {
    release.resolve()
    await handle.stop()
    timer.mockRestore()
  }
})

for (const close of ['pause', 'loss'] as const) {
  test(`Memory ${close} drain waits for explicit original recovery and its settlement ACK`, async () => {
    let ticks = 0,
      physical = 0,
      settlements = 0,
      permitReap = false
    const entered = deferred(),
      release = deferred()
    const error = new IndeterminateRuntimeProcessError('original unreaped execution', async () => {
      physical += 1
      return permitReap
    })
    error.retainOriginalSettlement(['original:job'], async () => {
      settlements += 1
    })
    const owner = bindMemoryDistillHostOwner({
      worker: {
        start: unexpected,
        listJobs: unexpected,
        recoverRunning: async () => ({ recovered: 0 }),
        async tick() {
          ticks += 1
          entered.resolve()
          await release.promise
          throw error
        },
      },
      configuration: { read: () => ({ ...ConfigSchema.parse({}), memoryDistillerEnabled: true }) },
      onError: () => {},
    })
    const g = grant(),
      timer = spyOn(globalThis, 'setTimeout'),
      handle = await owner.start(g)
    const drain = () =>
      Promise.resolve(
        close === 'loss'
          ? owner.drainAuthorityLoss({ context: g.context, handle })
          : handle.drain(),
      )
    try {
      const args = timer.mock.calls[0],
        result = timer.mock.results[0]
      if (!args || result?.type !== 'return' || typeof args[0] !== 'function')
        throw new Error('original polling timer missing')
      clearTimeout(result.value)
      args[0](...args.slice(2))
      await entered.promise
      if (close === 'loss') {
        g.lose()
        await owner.quiesceAuthorityLoss({ context: g.context, handle })
      } else await handle.stop()
      release.resolve()
      await expect(drain()).rejects.toBe(error)
      expect(physical).toBe(0)
      expect(await error.recoverOriginal()).toBe(false)
      await expect(drain()).rejects.toBe(error)
      permitReap = true
      expect(await error.recoverOriginal()).toBe(true)
      await drain()
      await drain()
      expect(ticks).toBe(1)
      expect(physical).toBe(2)
      expect(settlements).toBe(1)
    } finally {
      release.resolve()
      await handle.stop()
      timer.mockRestore()
    }
  })

  test(`Memory ${close} retries only the original settlement and waits for its actual ACK`, async () => {
    let ticks = 0,
      retries = 0,
      acknowledged = false
    const entered = deferred(),
      release = deferred(),
      ack = deferred()
    const originalFailure = new MemoryDistillSettlementPendingError(async () => {
      retries += 1
      if (!acknowledged) throw new Error('original receipt still unacknowledged')
      await ack.promise
    }, new Error('original receipt ACK lost'))
    const worker: MemoryDistillWorker = {
      start: unexpected,
      listJobs: unexpected,
      recoverRunning: async () => ({ recovered: 0 }),
      async tick() {
        ticks += 1
        entered.resolve()
        await release.promise
        throw originalFailure
      },
    }
    const errors: unknown[] = []
    const owner = bindMemoryDistillHostOwner({
      worker,
      configuration: { read: () => ({ ...ConfigSchema.parse({}), memoryDistillerEnabled: true }) },
      onError: (error) => {
        errors.push(error)
      },
    })
    const g = grant(),
      timer = spyOn(globalThis, 'setTimeout'),
      handle = await owner.start(g)
    const drain = () =>
      Promise.resolve(
        close === 'loss'
          ? owner.drainAuthorityLoss({ context: g.context, handle })
          : handle.drain(),
      )
    try {
      const args = timer.mock.calls[0],
        result = timer.mock.results[0]
      if (!args || result?.type !== 'return' || typeof args[0] !== 'function')
        throw new Error('original memory polling timer missing')
      clearTimeout(result.value)
      args[0](...args.slice(2))
      await entered.promise
      if (close === 'loss') {
        g.lose()
        await owner.quiesceAuthorityLoss({ context: g.context, handle })
      } else await handle.stop()
      release.resolve()
      await expect(drain()).rejects.toThrow('original receipt still unacknowledged')
      acknowledged = true
      let completed = false
      const first = drain().then(() => {
          completed = true
        }),
        second = drain()
      await Promise.resolve()
      expect(completed).toBe(false)
      ack.resolve()
      await Promise.all([first, second])
      await drain()
      expect(ticks).toBe(1)
      expect(retries).toBe(2)
      expect(errors).toEqual([originalFailure])
    } finally {
      release.resolve()
      ack.resolve()
      await handle.stop()
      timer.mockRestore()
    }
  })
}
