// RFC-359 W39: passive fixture diagnostics keep original hook Promise and cleanup order.
// These are pure deferred-port controls; they do not connect to PostgreSQL or run suite bodies.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import * as harness from './helpers/eachProvider'
import type {
  ProviderHarnessLifecycleEvent,
  ProviderHarnessLifecyclePorts,
} from './helpers/eachProvider'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function clockPorts() {
  let now = 0
  const reports: ProviderHarnessLifecycleEvent[] = []
  const timers: { at: number; callback: () => void; cleared: boolean; unrefs: number }[] = []
  const ports: ProviderHarnessLifecyclePorts = {
    now: () => now,
    schedule(callback, delayMs) {
      const timer = { at: now + delayMs, callback, cleared: false, unrefs: 0 }
      timers.push(timer)
      return {
        unref: () => {
          timer.unrefs += 1
        },
        clear: () => {
          timer.cleared = true
        },
      }
    },
    report: (event) => {
      reports.push(event)
    },
  }
  return {
    ports,
    reports,
    timers,
    advance(value: number) {
      now = value
      for (const timer of timers) {
        if (!timer.cleared && timer.at <= now) {
          timer.cleared = true
          timer.callback()
        }
      }
    },
  }
}

async function microtasks() {
  await Promise.resolve()
  await Promise.resolve()
}

function actualRegistration(options: harness.DescribeEachProviderOptions = {}) {
  const source = readFileSync(new URL('./helpers/eachProvider.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('eachProvider.ts', source, ts.ScriptTarget.Latest, true)
  const names = new Set([
    'registerPostgresql',
    'closePostgresqlHarnessDatabases',
    'runProviderHarnessLifecycle',
    'runProviderHarnessLifecycleStep',
  ])
  const declarations = ast.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      names.has(statement.name.text),
  )
  if (!declarations.some((node) => node.name?.text === 'registerPostgresql')) {
    throw new Error('Actual registerPostgresql declaration missing')
  }
  const program = ts.transpileModule(
    declarations.map((node) => node.getText(ast).replace(/^export /, '')).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } },
  ).outputText
  const calls: string[] = []
  const hooks: { name: string; args: unknown[] }[] = []
  const initialized = deferred<void>()
  const closed = deferred<void>()
  const diagnosticClock = clockPorts()
  let observerCreations = 0
  const client = Object.freeze({ fixtureClientIdentity: 'original' })
  const database = {
    client,
    runtime: {
      close: () => {
        calls.push('runtime.close')
        return closed.promise
      },
    },
    raw: () => {
      throw new Error('Unexpected SQL in a pure registration control')
    },
    snapshot: new Map(),
    sinks: new Set(),
  }
  const factory = async () => {
    calls.push('factory.enter')
    await initialized.promise
    calls.push('factory.return')
    return database
  }
  const bindings = {
    process,
    resolvePostgresqlTestUrlEnv: () => 'AW_TEST_POSTGRESQL_URL',
    currentDatabaseSchemaProvider: () => 'original-schema',
    selectDatabaseSchemaProvider: () => {
      calls.push('schema.restore')
      return () => {}
    },
    createPostgresqlHarnessDatabase: factory,
    // RFC-359 W8：harness 在 beforeAll 抢一把库级 advisory lock、afterAll 释放
    // （`acquirePostgresqlFileLock`，用来关掉文件边界的重叠窗口，见其头注）。
    // 本控制面是纯注册面、不连库，所以这里给一个记账替身——它同时把「拿了必须放」
    // 钉进 `calls` 序列：少了 `file.unlock` 就说明某条清理路径漏放锁了。
    acquirePostgresqlFileLock: async () => {
      calls.push('file.lock')
      return {
        release: async () => {
          calls.push('file.unlock')
        },
      }
    },
    createProviderHarnessLifecycleObserver: (
      ...args: Parameters<typeof harness.createProviderHarnessLifecycleObserver>
    ) => {
      observerCreations += 1
      return harness.createProviderHarnessLifecycleObserver(args[0], diagnosticClock.ports)
    },
    POSTGRESQL_DATABASE_SETUP_TIMEOUT_MS: 60_000,
    POSTGRESQL_DATABASE_CLEANUP_TIMEOUT_MS: 90_000,
    beforeAll: (...args: unknown[]) => hooks.push({ name: 'beforeAll', args }),
    beforeEach: (...args: unknown[]) => hooks.push({ name: 'beforeEach', args }),
    afterEach: (...args: unknown[]) => hooks.push({ name: 'afterEach', args }),
    afterAll: (...args: unknown[]) => hooks.push({ name: 'afterAll', args }),
    harnessView: () => undefined,
    test: () => {
      throw new Error('Unexpected missing-provider registration')
    },
  }
  const compile = new Function(...Object.keys(bindings), program + '\nreturn registerPostgresql')
  const register: unknown = Reflect.apply(compile, undefined, Object.values(bindings))
  if (typeof register !== 'function') throw new Error('Actual registration is not callable')
  Reflect.apply(register, undefined, [
    () => {
      calls.push('body.register')
    },
    options,
    1,
    'same-suite',
  ])
  return {
    calls,
    hooks,
    initialized,
    closed,
    diagnosticClock,
    get observerCreations() {
      return observerCreations
    },
    invoke(name: string) {
      const callback = hooks.find((hook) => hook.name === name)?.args[0]
      if (typeof callback !== 'function') throw new Error('Missing actual hook callback')
      const result: unknown = Reflect.apply(callback, undefined, [])
      if (!(result instanceof Promise)) throw new Error('Expected original async hook Promise')
      return result
    },
  }
}

describe('RFC359 W39 passive fixture lifecycle diagnostics', () => {
  test('keeps a fast original Promise and value without output', async () => {
    const clock = clockPorts()
    const observer = harness.createProviderHarnessLifecycleObserver(
      { sourceFile: import.meta.url, suite: 'fast' },
      clock.ports,
    )
    const original = deferred<object>()
    const value = Object.freeze({ original: true })
    let calls = 0
    const result = observer.run('setup', () => {
      calls += 1
      return original.promise
    })
    expect(result).toBe(original.promise)
    expect(calls).toBe(1)
    expect(clock.timers.map((timer) => timer.unrefs)).toEqual([1])
    original.resolve(value)
    expect(await result).toBe(value)
    await microtasks()
    expect(clock.reports).toEqual([])
    expect(clock.timers.every((timer) => timer.cleared)).toBe(true)
  })

  test('reports only at the diagnostic threshold and actual late settlement', async () => {
    const clock = clockPorts()
    const observer = harness.createProviderHarnessLifecycleObserver(
      { sourceFile: import.meta.url, suite: 'pending' },
      clock.ports,
    )
    const original = deferred<void>()
    const result = observer.run('setup', (phase) => phase.run('migration', () => original.promise))
    expect(result).toBe(original.promise)
    clock.advance(4_749)
    expect(clock.reports).toHaveLength(0)
    clock.advance(4_750)
    expect(clock.reports).toHaveLength(1)
    expect(clock.reports[0]?.kind).toBe('near-deadline')
    expect(clock.reports[0]?.events.map((event) => [event.phase, event.state])).toEqual([
      ['setup', 'enter'],
      ['migration', 'enter'],
    ])
    original.resolve()
    await result
    await microtasks()
    expect(clock.reports.map((event) => event.kind)).toEqual(['near-deadline', 'settled'])
    expect(clock.reports[1]?.operationId).toBe(clock.reports[0]?.operationId)
    expect(clock.reports[1]?.events.map((event) => [event.phase, event.state])).toEqual([
      ['setup', 'enter'],
      ['migration', 'enter'],
      ['migration', 'fulfilled'],
      ['setup', 'fulfilled'],
    ])
    expect(clock.timers.every((timer) => timer.cleared)).toBe(true)
  })

  test('bounds each operation buffer across repeated resets without restarting timers', async () => {
    const clock = clockPorts()
    const observer = harness.createProviderHarnessLifecycleObserver(
      { sourceFile: import.meta.url, suite: 'bounded' },
      clock.ports,
    )
    for (let index = 0; index < 80; index += 1) {
      const original = Promise.resolve(index)
      expect(observer.run('reset', () => original)).toBe(original)
      await original
    }
    await microtasks()
    expect(clock.reports).toEqual([])
    expect(clock.timers.every((timer) => timer.cleared)).toBe(true)
    const original = deferred<void>()
    const result = observer.run('setup', (phase) => {
      for (let index = 0; index < 80; index += 1) phase.run(`step-${index}`, () => index)
      return original.promise
    })
    clock.advance(4_750)
    expect(clock.reports).toHaveLength(1)
    expect(clock.reports[0]?.events).toHaveLength(64)
    expect(clock.reports[0]?.events[0]?.phase).toBe('setup')
    expect(clock.reports[0]?.events.at(-1)?.phase).toBe('step-79')
    original.resolve()
    await result
    await microtasks()
    expect(clock.reports.map((event) => event.kind)).toEqual(['near-deadline', 'settled'])
    expect(clock.reports[1]?.events).toHaveLength(64)
    expect(clock.timers).toHaveLength(81)
    expect(clock.timers.every((timer) => timer.cleared)).toBe(true)
  })

  test('preserves rejection and synchronous throw identities', async () => {
    const clock = clockPorts()
    const observer = harness.createProviderHarnessLifecycleObserver(
      { sourceFile: import.meta.url, suite: 'errors' },
      clock.ports,
    )
    const error = Object.assign(new Error('controlled original error'), { code: 'original-code' })
    const original = deferred<void>()
    const result = observer.run('cleanup', () => original.promise)
    original.reject(error)
    expect(result).toBe(original.promise)
    await expect(result).rejects.toBe(error)
    let received: unknown
    try {
      observer.run('setup', () => {
        throw error
      })
    } catch (caught) {
      received = caught
    }
    expect(received).toBe(error)
    expect(clock.reports.map((event) => event.kind)).toEqual(['rejected', 'rejected'])
    expect(clock.reports.every((event) => event.events.at(-1)?.errorCode === 'original-code')).toBe(
      true,
    )
    expect(clock.timers.every((timer) => timer.cleared)).toBe(true)
  })

  test('contains observer port and error-code access failures', async () => {
    for (const fault of ['now', 'schedule', 'unref', 'clear', 'report', 'code'] as const) {
      const clock = clockPorts()
      const fail = () => {
        throw new Error('diagnostic port failure')
      }
      const ports: ProviderHarnessLifecyclePorts = {
        ...clock.ports,
        ...(fault === 'now' ? { now: fail } : {}),
        ...(fault === 'report' ? { report: fail } : {}),
        schedule(callback, delay) {
          if (fault === 'schedule') return fail()
          const timer = clock.ports.schedule(callback, delay)
          return {
            unref: fault === 'unref' ? fail : timer.unref,
            clear: fault === 'clear' ? fail : timer.clear,
          }
        },
      }
      const observer = harness.createProviderHarnessLifecycleObserver(
        { sourceFile: import.meta.url, suite: fault },
        ports,
      )
      const error = new Error('original failure')
      if (fault === 'code') Object.defineProperty(error, 'code', { get: fail })
      const original = deferred<void>()
      let calls = 0
      const result = observer.run('setup', () => {
        calls += 1
        return original.promise
      })
      original.reject(error)
      expect(result).toBe(original.promise)
      await expect(result).rejects.toBe(error)
      await microtasks()
      expect(calls).toBe(1)
    }
  })

  test('actual unbound hooks keep memoization and wait for initialization before close', async () => {
    const control = actualRegistration()
    expect(control.hooks.map((hook) => [hook.name, hook.args.length])).toEqual([
      ['beforeAll', 1],
      ['beforeEach', 1],
      ['afterEach', 1],
      ['afterAll', 1],
    ])
    const setup = control.invoke('beforeAll')
    expect(control.invoke('beforeAll')).toBe(setup)
    const cleanup = control.invoke('afterAll')
    let cleanupDone = false
    void cleanup.then(() => {
      cleanupDone = true
    })
    await microtasks()
    expect(cleanupDone).toBe(false)
    expect(control.calls).toEqual(['body.register', 'file.lock', 'factory.enter'])
    control.initialized.resolve()
    await setup
    await microtasks()
    expect(control.calls).toEqual([
      'body.register',
      'file.lock',
      'factory.enter',
      'factory.return',
      'runtime.close',
    ])
    expect(cleanupDone).toBe(false)
    control.closed.resolve()
    await cleanup
    // RFC-359 W8：`file.lock` 必须在**任何** DDL / 建库之前，`file.unlock` 必须在
    // `runtime.close` 之后——下一个文件拿到锁时，本文件已经没有任何连接留在库上。
    // 这个顺序就是那把锁全部的价值所在；顺序错了它挡不住文件边界的重叠。
    expect(control.calls).toEqual([
      'body.register',
      'file.lock',
      'factory.enter',
      'factory.return',
      'runtime.close',
      'file.unlock',
      'schema.restore',
    ])
    expect(control.observerCreations).toBe(0)
    expect(control.diagnosticClock.timers).toEqual([])
    expect(control.diagnosticClock.reports).toEqual([])
  })

  test('actual unbound cleanup preserves its original close error and restoration', async () => {
    const control = actualRegistration()
    const setup = control.invoke('beforeAll')
    control.initialized.resolve()
    await setup
    const cleanup = control.invoke('afterAll')
    const error = new Error('original close failure')
    control.closed.reject(error)
    const failure = await cleanup.catch((caught: unknown) => caught)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).cause).toBe(error)
    // RFC-359 W8：`file.lock` 必须在**任何** DDL / 建库之前，`file.unlock` 必须在
    // `runtime.close` 之后——下一个文件拿到锁时，本文件已经没有任何连接留在库上。
    // 这个顺序就是那把锁全部的价值所在；顺序错了它挡不住文件边界的重叠。
    expect(control.calls).toEqual([
      'body.register',
      'file.lock',
      'factory.enter',
      'factory.return',
      'runtime.close',
      'file.unlock',
      'schema.restore',
    ])
    expect(control.observerCreations).toBe(0)
  })

  test('actual bound hooks identify setup and cleanup as separate operations', async () => {
    const control = actualRegistration({ lifecycleDiagnostics: { sourceFile: import.meta.url } })
    const setup = control.invoke('beforeAll')
    const cleanup = control.invoke('afterAll')
    control.diagnosticClock.advance(4_750)
    expect(control.diagnosticClock.reports).toHaveLength(2)
    expect(new Set(control.diagnosticClock.reports.map((event) => event.operationId)).size).toBe(2)
    expect(
      control.diagnosticClock.reports.every(
        (event) => event.sourceFile === import.meta.url && event.suite === 'same-suite',
      ),
    ).toBe(true)
    control.initialized.resolve()
    await setup
    control.closed.resolve()
    await cleanup
    await microtasks()
    expect(control.diagnosticClock.reports.map((event) => event.kind)).toEqual([
      'near-deadline',
      'near-deadline',
      'settled',
      'settled',
    ])
    expect(control.calls.filter((event) => event === 'runtime.close')).toHaveLength(1)
    expect(control.diagnosticClock.timers.every((timer) => timer.cleared)).toBe(true)
  })
})
