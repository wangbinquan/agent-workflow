import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { TaskArchiveContentBinding } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import {
  openMaintenanceWorkerEffectsScope,
  type MaintenanceWorkerEffectsCapability,
  type MaintenanceWorkerEffectsDescriptor,
  type MaintenanceWorkerEffectsEnvironment,
} from '@/platform/background/maintenanceWorkerEffects'
import {
  createMaintenanceWorkerEffectsInit,
  readMaintenanceWorkerEffectsFrame,
} from '@/platform/background/maintenanceWorkerEffectsProtocol'
import { MAINTENANCE_CATALOG_DIGEST } from '@/platform/background/maintenanceCatalog'
import { MAINTENANCE_PROTOCOL_VERSION } from '@/platform/background/maintenanceProtocol'
import { routeMaintenanceWorkerRequest } from '@/platform/background/maintenanceWorkerMessageRouter'
import { startMaintenanceWorkerSupervisor } from '@/platform/background/maintenanceWorkerSupervisor'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const descriptor = (
  capabilities: readonly MaintenanceWorkerEffectsCapability[],
): MaintenanceWorkerEffectsDescriptor => ({
  moduleSpecifier: 'fixture:worker-effects',
  exportName: 'createEffects',
  configurationJson: '{"store":"logical"}',
  capabilities,
})

const context = { appHome: 'logical:worker-home', instanceRef: 'worker-instance-one' }

class PrototypeEnvironment implements MaintenanceWorkerEffectsEnvironment {
  readonly #calls: string[]
  readonly #wait: Promise<void> | undefined
  readonly #entered: (() => void) | undefined
  readonly #closeError: Error | undefined
  readonly pluginGenerationGc
  readonly resourcePackageRecovery
  readonly taskArchive: TaskArchiveContentBinding

  constructor(input: {
    calls: string[]
    wait?: Promise<void>
    entered?: () => void
    closeError?: Error
  }) {
    this.#calls = input.calls
    this.#wait = input.wait
    this.#entered = input.entered
    this.#closeError = input.closeError
    const calls = input.calls
    this.pluginGenerationGc = Object.freeze({
      async hasCandidates() {
        calls.push('has-candidates')
        return true
      },
      async collect(request: { readonly referencedCachedPaths: ReadonlySet<string> }) {
        calls.push(`collect:${[...request.referencedCachedPaths].join(',')}`)
        return ['logical:retired-generation']
      },
    })
    this.resourcePackageRecovery = Object.freeze({
      async rollForward() {
        calls.push('roll-forward')
      },
      async compensate() {
        calls.push('compensate')
      },
    })
    this.taskArchive = Object.freeze({
      locations: Object.freeze({
        archiveDir: 'logical:archives',
        runsDir: 'logical:runs',
        logsDir: 'logical:logs',
      }),
      content: Object.freeze({
        resolve(reference: string, ...segments: readonly string[]) {
          return [reference, ...segments].join('/')
        },
        exists: async () => false,
        list: async () => [],
        createDirectory: async () => {},
        remove: async () => {},
        move: async () => {},
        appendText: async () => {},
        writeText: async () => {},
        restoreMovedDirectories: async () => false,
      }),
    })
    Object.freeze(this)
  }

  async dispose() {
    this.#calls.push('dispose')
    this.#entered?.()
    await this.#wait
    if (this.#closeError !== undefined) throw this.#closeError
    this.#calls.push('disposed')
  }
}

test('selected complete objects and archive locations keep their receivers; extra families stay inactive', async () => {
  const calls: string[] = []
  const environment = new PrototypeEnvironment({ calls })
  const imported: string[] = []
  const scope = openMaintenanceWorkerEffectsScope({
    descriptor: descriptor(['taskArchive', 'pluginGenerationGc']),
    context,
    importModule: async (specifier) => {
      imported.push(specifier)
      return { createEffects: () => environment }
    },
  })
  const selected = await scope.ready
  expect(imported).toEqual(['fixture:worker-effects'])
  expect(selected.taskArchive).toBe(environment.taskArchive)
  expect(selected.taskArchive?.content).toBe(environment.taskArchive.content)
  expect(selected.taskArchive?.locations).toEqual({
    archiveDir: 'logical:archives',
    runsDir: 'logical:runs',
    logsDir: 'logical:logs',
  })
  expect(selected.resourcePackageRecovery).toBeUndefined()
  expect(selected.pluginGenerationGc).toBe(environment.pluginGenerationGc)
  expect(await selected.pluginGenerationGc?.hasCandidates({})).toBe(true)
  expect(
    await selected.pluginGenerationGc?.collect({
      referencedCachedPaths: new Set(['logical:live']),
    }),
  ).toEqual(['logical:retired-generation'])
  await scope.dispose()
  expect(calls).toEqual(['has-candidates', 'collect:logical:live', 'dispose', 'disposed'])
})

test('the actual external module entry supplies a frozen prototype receiver', async () => {
  const scope = openMaintenanceWorkerEffectsScope({
    descriptor: {
      ...descriptor(['pluginGenerationGc']),
      moduleSpecifier: new URL('./fixtures/rfc370-maintenance-effects.mjs', import.meta.url).href,
    },
    context,
  })
  const selected = await scope.ready
  expect(await selected.pluginGenerationGc?.hasCandidates({})).toBe(true)
  expect(
    await selected.pluginGenerationGc?.collect({ referencedCachedPaths: new Set(['logical:one']) }),
  ).toEqual(['worker-instance-one:logical:one'])
  await scope.dispose()
  await expect(selected.pluginGenerationGc!.hasCandidates({})).rejects.toThrow(
    'fixture-effects-disposed',
  )
})

test('missing archive locations fail readiness and still wait for the environment release ACK', async () => {
  const calls: string[] = []
  const close = gate()
  const entered = gate()
  const complete = new PrototypeEnvironment({ calls })
  const environment = {
    taskArchive: { content: complete.taskArchive.content } as TaskArchiveContentBinding,
    async dispose() {
      calls.push('dispose')
      entered.release()
      await close.promise
      calls.push('disposed')
    },
  }
  const scope = openMaintenanceWorkerEffectsScope({
    descriptor: descriptor(['taskArchive']),
    context,
    importModule: async () => ({ createEffects: () => environment }),
  })
  await expect(scope.ready).rejects.toThrow(
    'maintenance-worker-effects-incomplete:taskArchive-locations',
  )
  let disposed = false
  const pending = scope.dispose().then(() => {
    disposed = true
  })
  await entered.promise
  expect(disposed).toBe(false)
  close.release()
  await pending
  expect(calls).toEqual(['dispose', 'disposed'])
})

test('disposal racing the factory ACK cannot publish an already closing environment', async () => {
  const calls: string[] = []
  const constructing = gate()
  const factoryEntered = gate()
  const closing = gate()
  const disposerEntered = gate()
  const environment = new PrototypeEnvironment({
    calls,
    wait: closing.promise,
    entered: disposerEntered.release,
  })
  const scope = openMaintenanceWorkerEffectsScope({
    descriptor: descriptor(['pluginGenerationGc']),
    context,
    importModule: async () => ({
      async createEffects() {
        factoryEntered.release()
        await constructing.promise
        return environment
      },
    }),
  })
  const disposal = scope.dispose()
  expect(scope.dispose()).toBe(disposal)
  await factoryEntered.promise
  expect(calls).toEqual([])
  constructing.release()
  await expect(scope.ready).rejects.toThrow('maintenance-worker-effects-scope-disposing')
  await disposerEntered.promise
  expect(calls).toEqual(['dispose'])
  closing.release()
  await disposal
  expect(calls).toEqual(['dispose', 'disposed'])
})

test('a failed release retains its rejection and invokes the selected disposer once', async () => {
  const calls: string[] = []
  const failure = new Error('selected-client-close-failed')
  const environment = new PrototypeEnvironment({ calls, closeError: failure })
  const scope = openMaintenanceWorkerEffectsScope({
    descriptor: descriptor(['resourcePackageRecovery']),
    context,
    importModule: async () => ({ createEffects: () => environment }),
  })
  await scope.ready
  const first = scope.dispose()
  await expect(first).rejects.toBe(failure)
  expect(scope.dispose()).toBe(first)
  await expect(scope.dispose()).rejects.toBe(failure)
  expect(calls).toEqual(['dispose'])
})

test('missing factory exports fail and never open a substitute environment', async () => {
  const scope = openMaintenanceWorkerEffectsScope({
    descriptor: descriptor(['pluginGenerationGc']),
    context,
    importModule: async () => ({ unrelatedFactory: () => new PrototypeEnvironment({ calls: [] }) }),
  })
  await expect(scope.ready).rejects.toThrow('maintenance-worker-effects-factory-missing')
  await scope.dispose()
})

const init = {
  type: 'init' as const,
  version: MAINTENANCE_PROTOCOL_VERSION,
  catalogDigest: MAINTENANCE_CATALOG_DIGEST,
  dbPath: 'fixture.sqlite',
  migrationsFolder: 'fixture-migrations',
  appHome: 'fixture-home',
  sqlite: { synchronous: 'NORMAL' as const, pageCacheMib: 8, mmapMib: 0, busyTimeoutMs: 50 },
}

test('the selected wrapper reuses the complete original phase decision table', () => {
  const wrapped = createMaintenanceWorkerEffectsInit(init, descriptor(['pluginGenerationGc']))
  const frame = readMaintenanceWorkerEffectsFrame(wrapped)
  for (const phase of ['idle', 'initialising', 'ready'] as const)
    expect(routeMaintenanceWorkerRequest(phase, frame.request)).toEqual(
      routeMaintenanceWorkerRequest(phase, init),
    )
  expect(frame.effects).toEqual(descriptor(['pluginGenerationGc']))
  expect(readMaintenanceWorkerEffectsFrame(init).request).toBe(init)
  for (const raw of [
    { type: 'wake', version: MAINTENANCE_PROTOCOL_VERSION },
    { type: 'drain', version: MAINTENANCE_PROTOCOL_VERSION },
  ])
    for (const phase of ['idle', 'initialising', 'ready'] as const)
      expect(
        routeMaintenanceWorkerRequest(phase, readMaintenanceWorkerEffectsFrame(raw).request),
      ).toEqual(routeMaintenanceWorkerRequest(phase, raw))
  expect(() => readMaintenanceWorkerEffectsFrame({ ...wrapped, version: 3 })).toThrow()
  expect(() =>
    createMaintenanceWorkerEffectsInit(
      init,
      descriptor(['pluginGenerationGc', 'pluginGenerationGc']),
    ),
  ).toThrow()
})

test('the real supervisor sends one selected init and keeps native drain and generation fencing', async () => {
  class FakeWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null
    onerror: ((event: ErrorEvent) => unknown) | null = null
    readonly messages: unknown[] = []
    terminated = false
    postMessage(message: unknown) {
      this.messages.push(message)
    }
    terminate() {
      this.terminated = true
    }
    emit(data: unknown) {
      this.onmessage?.({ data } as MessageEvent<unknown>)
    }
  }
  const first = new FakeWorker()
  const second = new FakeWorker()
  const workers = [first, second]
  const effects = descriptor(['pluginGenerationGc'])
  const supervisor = startMaintenanceWorkerSupervisor({
    appHome: init.appHome,
    databaseInit: {
      dbPath: init.dbPath,
      migrationsFolder: init.migrationsFolder,
      sqlite: init.sqlite,
    },
    workerFactory: () => workers.shift()!,
    effectsBootstrap: effects,
  })
  expect(first.messages).toEqual([createMaintenanceWorkerEffectsInit(init, effects)])
  const paused = supervisor.pause()
  first.emit({ type: 'ready', version: 1, catalogDigest: MAINTENANCE_CATALOG_DIGEST, at: 1 })
  expect(first.messages).toHaveLength(2)
  expect(first.messages[1]).toEqual({ type: 'drain', version: 1 })
  first.emit({ type: 'drained', version: 1, at: 2 })
  await paused
  expect(first.terminated).toBe(true)
  await supervisor.resume()
  expect(second.messages).toEqual([createMaintenanceWorkerEffectsInit(init, effects)])
  first.emit({ type: 'drained', version: 1, at: 3 })
  expect(second.terminated).toBe(false)
  const stopping = supervisor.stop()
  second.emit({ type: 'drained', version: 1, at: 4 })
  await stopping
  expect(second.terminated).toBe(true)
})

interface ConnectionCloseControls {
  readonly heartbeat?: Promise<void>
  readonly effects: { dispose(): Promise<void> }
  readonly pool: { close(): Promise<void> }
  readonly sqliteClose?: () => void
}
interface ActualConnectionLifetime {
  close(): Promise<void>
  drain(): Promise<void>
  readonly events: Array<{ readonly type: string }>
}

function actualConnectionLifetime(controls: ConnectionCloseControls): ActualConnectionLifetime {
  const source = ts.createSourceFile(
    'maintenanceWorker.ts',
    readFileSync(
      new URL('../src/platform/background/maintenanceWorker.ts', import.meta.url),
      'utf8',
    ),
    ts.ScriptTarget.Latest,
    true,
  )
  const functions = ['closeConnection', 'drainIfReady'].map((name) => {
    const declaration = source.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    )
    if (!declaration?.body) throw new Error(`missing original Worker lifetime: ${name}`)
    return declaration.getText(source)
  })
  const stateNames = source.statements.flatMap((node) =>
    ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Let) !== 0
      ? node.declarationList.declarations.map((declaration) => declaration.name.getText(source))
      : [],
  )
  expect(stateNames).toContain('connectionClosing')
  const actual = ts.transpileModule(functions.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  // Evaluate the actual complete two lifetime functions, as in W29. Only close
  // acknowledgements are controlled; no application or database rows are faked.
  return new Function(
    'controls',
    'MAINTENANCE_PROTOCOL_VERSION',
    `let ${stateNames.map((name) => `${name} = null`).join(', ')};
     draining = true; processing = false; initialised = true;
     heartbeatInFlight = controls.heartbeat ?? null;
     db = {$client: {close: controls.sqliteClose ?? (() => {})}};
     postgresqlRuntime = controls.pool;
     workerEffectsScope = controls.effects; workerEffects = {};
     const events = []; const emit = (event) => events.push(event);
     ${actual}
     return {close: closeConnection, drain: drainIfReady, events};`,
  )(controls, MAINTENANCE_PROTOCOL_VERSION) as ActualConnectionLifetime
}

test('two original drain handlers wait for one complete dispose and PostgreSQL pool close ACK', async () => {
  const disposeEntered = gate(),
    disposeAck = gate(),
    poolEntered = gate(),
    poolAck = gate()
  const calls: string[] = []
  const lifetime = actualConnectionLifetime({
    effects: {
      async dispose() {
        calls.push('dispose')
        disposeEntered.release()
        await disposeAck.promise
      },
    },
    pool: {
      async close() {
        calls.push('pool-close')
        poolEntered.release()
        await poolAck.promise
      },
    },
    sqliteClose() {
      calls.push('client-close')
    },
  })
  const close = lifetime.close()
  expect(lifetime.close()).toBe(close)
  const firstDrain = lifetime.drain(),
    secondDrain = lifetime.drain()
  await disposeEntered.promise
  expect(calls).toEqual(['dispose'])
  expect(lifetime.events).toEqual([])
  disposeAck.release()
  await poolEntered.promise
  expect(calls).toEqual(['dispose', 'client-close', 'pool-close'])
  expect(lifetime.events).toEqual([])
  poolAck.release()
  await Promise.all([close, firstDrain, secondDrain])
  expect(calls).toEqual(['dispose', 'client-close', 'pool-close'])
  expect(lifetime.events.map((event) => event.type)).toEqual(['drained', 'drained'])
})

test('one complete close waits for the original heartbeat before selected disposal', async () => {
  const heartbeat = gate()
  const calls: string[] = []
  const lifetime = actualConnectionLifetime({
    heartbeat: heartbeat.promise,
    effects: {
      async dispose() {
        calls.push('dispose')
      },
    },
    pool: {
      async close() {
        calls.push('pool-close')
      },
    },
  })
  const close = lifetime.close()
  expect(lifetime.close()).toBe(close)
  expect(calls).toEqual([])
  heartbeat.release()
  await close
  expect(calls).toEqual(['dispose', 'pool-close'])
})

for (const failureAt of ['dispose', 'pool-close'] as const) {
  test(`a repeated close keeps the original ${failureAt} failure and never fabricates drained`, async () => {
    const failure = new Error(`selected-close-${failureAt}`)
    const calls: string[] = []
    const lifetime = actualConnectionLifetime({
      effects: {
        async dispose() {
          calls.push('dispose')
          if (failureAt === 'dispose') throw failure
        },
      },
      pool: {
        async close() {
          calls.push('pool-close')
          if (failureAt === 'pool-close') throw failure
        },
      },
    })
    const close = lifetime.close()
    expect(lifetime.close()).toBe(close)
    await expect(close).rejects.toBe(failure)
    expect(lifetime.close()).toBe(close)
    await expect(lifetime.drain()).rejects.toBe(failure)
    expect(calls).toEqual(['dispose', 'pool-close'])
    expect(lifetime.events).toEqual([])
  })
}

function actualWorkerErrorMessage(): (error: unknown) => string {
  const source = ts.createSourceFile(
    'maintenanceWorker.ts',
    readFileSync(
      new URL('../src/platform/background/maintenanceWorker.ts', import.meta.url),
      'utf8',
    ),
    ts.ScriptTarget.Latest,
    true,
  )
  const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'errorMessage',
  )
  if (!declaration?.body) throw new Error('missing actual Worker failure formatter')
  const actual = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(`${actual}\nreturn errorMessage;`)() as (error: unknown) => string
}

test('actual Worker failure messages retain the original query cause and terminate circular chains', () => {
  const message = actualWorkerErrorMessage()
  expect(message(new Error('original plain failure'))).toBe('original plain failure')
  expect(message('original primitive failure')).toBe('original primitive failure')
  expect(message(undefined)).toBe('undefined')
  expect(message(null)).toBe('null')
  const nativeCause = new Error('original database failure')
  const query = new Error('original query wrapper', { cause: nativeCause })
  expect(message(new Error('worker init wrapper', { cause: query }))).toBe(
    'worker init wrapper <- original query wrapper <- original database failure',
  )
  expect(message(new Error('original wrapper', { cause: 42 }))).toBe('original wrapper <- 42')
  const outer = new Error('outer')
  const inner = new Error('inner', { cause: outer })
  outer.cause = inner
  expect(message(outer)).toBe('outer <- inner')
})
