// RFC-395 II-pre：改接生产启动 / 读取路径，保留原断言意图。
import { expectDeploymentSelection } from './helpers/deploymentSelectionSource'
import { readDaemonGraphSource } from './helpers/daemonGraphSource'
import { createPollingDaemonRuntimeHandleFactory } from '../src/bootstrap/daemonProviderRuntimeHandles'
import { memorySystemAgentBindingForTest } from './helpers/memoryDistill'
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory, ulid } from 'ulid'
import ts from 'typescript'
import type { Agent } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { clarifyRounds, memoryDistillJobs, nodeRunEvents, nodeRuns, tasks } from '@/db/schema'
import { composeNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
import type { NodeRunPromptOperations } from '@/modules/task-execution/public/types'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/taskExecutionReadModels'
import { taskNodeRunsProjection } from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { DrizzleMemoryDistillWorkStore } from '@/modules/memory/infrastructure/memoryDistillWorkStore'
import { composeMemoryOperationsFor } from '@/modules/memory/composition'
import type { NodeRunPromptReader } from '@/modules/task-execution/public/queries'
import { MEMORY_DISTILL_JOB_CHANNEL, memoryDistillJobBroadcaster } from '@/ws/broadcaster'
import {
  loadSourceEvents,
  rowToDistillJob,
} from '@/modules/memory/application/distill/memoryDistiller'
import { getSessionTree } from '@/services/sessionView'
import { describeEachProvider } from './helpers/eachProvider'
import { DESIGNER, CL, freshTaskId, seedTask } from './helpers/questionDispatchFixture'
import { runNode } from './helpers/runner'

function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Session siblings use ID order, so same-millisecond fixture attempts must be monotonic.
const sourceRunId = monotonicFactory()

async function sourceRun(db: ProviderNeutralDatabase, taskId: string, retryIndex = 0) {
  const id = sourceRunId()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: DESIGNER,
    iteration: 0,
    reviewIteration: 0,
    retryIndex,
    status: 'done',
    startedAt: retryIndex + 1,
    finishedAt: retryIndex + 2,
    promptText: null,
    promptPath: 'object:' + id,
    opencodeSessionId: 'session-' + taskId,
  })
  await db.insert(nodeRunEvents).values({
    nodeRunId: id,
    ts: retryIndex + 2,
    kind: 'text',
    sessionId: 'session-' + taskId,
    parentSessionId: null,
    payload: JSON.stringify({
      type: 'text',
      sessionID: 'session-' + taskId,
      messageID: 'message-' + id,
      part: { type: 'text', text: 'selected assistant reply' },
    }),
  })
  return id
}

async function clarifySource(db: ProviderNeutralDatabase, taskId: string, askingNodeRunId: string) {
  const intermediaryNodeRunId = ulid(),
    id = ulid()
  await db.insert(nodeRuns).values({
    id: intermediaryNodeRunId,
    taskId,
    nodeId: CL,
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status: 'awaiting_human',
  })
  await db.insert(clarifyRounds).values({
    id,
    kind: 'self',
    taskId,
    askingNodeId: DESIGNER,
    askingNodeRunId,
    askingShardKey: null,
    intermediaryNodeId: CL,
    intermediaryNodeRunId,
    iteration: 0,
    questionsJson: JSON.stringify([{ id: 'question', kind: 'open', text: 'Which provider?' }]),
    answersJson: JSON.stringify([{ questionId: 'question', text: 'Selected provider' }]),
    status: 'answered',
  })
  return rowToDistillJob({
    id: ulid(),
    debounceKey: taskId + ':clarify',
    sourceKind: 'clarify',
    sourceEventId: id,
    taskId,
    scopeResolvedJson: JSON.stringify({
      agentIds: [],
      workflowId: null,
      repoId: null,
      includeGlobal: true,
    }),
    status: 'pending',
    attempts: 0,
    nextRunAt: 1,
    lastError: null,
    createdAt: 1,
    startedAt: null,
    finishedAt: null,
  })
}

const noReviewedContent = Object.freeze({
  async read(_reference: string): Promise<string> {
    throw new Error('a clarify-only source must not read a review artifact')
  },
})

describeEachProvider('RFC-370 selected prompt consumer bindings', (harness) => {
  test('actual provider detail, legacy export and session siblings read the same opaque content', async () => {
    const db = harness.db,
      taskId = freshTaskId()
    await seedTask(db, taskId)
    const first = await sourceRun(db, taskId),
      second = await sourceRun(db, taskId, 1)
    const bodies = new Map([
      ['object:' + first, 'first selected user prompt'],
      ['object:' + second, 'second selected user prompt'],
    ])
    class Content {
      readonly calls: string[] = []
      #bodies = bodies
      reference(task: string, run: string) {
        return 'object:' + task + '/' + run
      }
      write() {
        throw new Error('read views must not write prompt content')
      }
      async read(reference: string) {
        this.calls.push(reference)
        return this.#bodies.get(reference) ?? null
      }
    }
    const content = Object.freeze(new Content()),
      prompts = composeNodeRunPromptOperations(content)
    const detail = await taskNodeRunsProjection({ db, nodeRunPrompts: prompts }, taskId)
    expect(detail.runs.map((run) => run.promptText)).toEqual([...bodies.values()])
    const session = await getSessionTree(
      createTaskExecutionReadModels(db).sessions,
      taskId,
      first,
      {},
      prompts,
    )
    expect(
      session.tree.messages
        .filter((message) => message.kind === 'user')
        .map((message) => message.text),
    ).toEqual([...bodies.values()])
    expect(content.calls).toEqual([...bodies.keys(), ...bodies.keys()])
  })

  test('clarify-only transcript waits for the selected opaque prompt reader ACK', async () => {
    const db = harness.db,
      taskId = freshTaskId(),
      entered = held<void>(),
      ack = held<string>()
    await seedTask(db, taskId)
    const run = await sourceRun(db, taskId),
      job = await clarifySource(db, taskId, run)
    const calls: string[] = []
    class Content {
      #reference = 'object:' + run
      reference() {
        return this.#reference
      }
      write() {
        throw new Error('unexpected prompt write')
      }
      read(reference: string) {
        expect(reference).toBe(this.#reference)
        calls.push(reference)
        entered.resolve(undefined)
        return ack.promise
      }
    }
    const prompts = composeNodeRunPromptOperations(Object.freeze(new Content()))
    let settled = false
    const pending = loadSourceEvents(
      new DrizzleMemoryDistillWorkStore(db),
      noReviewedContent,
      [job],
      prompts,
    )
    void pending.then(() => {
      settled = true
    })
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('selected clarify reader not reached')
        }),
      ])
      expect(settled).toBe(false)
      expect(calls).toEqual(['object:' + run])
      ack.resolve('body supplied by selected reader')
      const loaded = await pending
      expect(loaded.agentRun).toEqual([])
      expect(loaded.taskRun).toEqual([])
      expect(loaded.clarify).toHaveLength(1)
      expect(loaded.clarify[0]!.sourceTranscriptReason).toBeNull()
      expect(loaded.clarify[0]!.sourceTranscriptMd).toContain('body supplied by selected reader')
      expect(loaded.clarify[0]!.sourceTranscriptMd).toContain('selected assistant reply')
    } finally {
      ack.resolve('released')
      await pending.catch(() => {})
    }
  })

  test('clarify prompt content rejection preserves transcript fallback under the original budget', async () => {
    const db = harness.db,
      taskId = freshTaskId()
    await seedTask(db, taskId)
    const run = await sourceRun(db, taskId),
      job = await clarifySource(db, taskId, run)
    const calls: string[] = []
    const prompts = composeNodeRunPromptOperations({
      reference: () => 'object:' + run,
      write() {
        throw new Error('unexpected write')
      },
      async read(reference: string) {
        calls.push(reference)
        throw new Error('content unavailable')
      },
    })
    const loaded = await loadSourceEvents(
      new DrizzleMemoryDistillWorkStore(db),
      noReviewedContent,
      [job],
      prompts,
    )
    expect(calls).toEqual(['object:' + run])
    expect(loaded.clarify[0]!.sourceTranscriptReason).toBeNull()
    expect(loaded.clarify[0]!.sourceTranscriptMd).toContain('selected assistant reply')
    expect(loaded.clarify[0]!.sourceTranscriptMd).not.toContain('object:' + run)
    const rejectingReader = Object.freeze({
      async read() {
        throw new Error('reader unavailable')
      },
    })
    const degraded = await loadSourceEvents(
      new DrizzleMemoryDistillWorkStore(db),
      noReviewedContent,
      [job],
      rejectingReader,
    )
    expect(degraded.clarify[0]!.sourceTranscriptMd).toBeNull()
    expect(degraded.clarify[0]!.sourceTranscriptReason).toBe('parse-failed: reader unavailable')
  })

  test('actual memory composition timer waits for the selected reader and records its failure', async () => {
    const db = harness.db,
      taskId = freshTaskId(),
      jobId = ulid(),
      entered = held<void>(),
      ack = held<void>(),
      failure = held<string>()
    await seedTask(db, taskId)
    const run = await sourceRun(db, taskId)
    await db.insert(memoryDistillJobs).values({
      id: jobId,
      sourceKind: 'agent-run',
      sourceEventId: run,
      taskId,
      debounceKey: taskId + ':selected-prompt-loop',
      scopeResolvedJson: JSON.stringify({
        agentIds: [],
        workflowId: null,
        repoId: null,
        includeGlobal: true,
      }),
      status: 'pending',
      attempts: 0,
      nextRunAt: 0,
      createdAt: 1,
    })
    const calls: string[] = [],
      reason = 'selected loop reader stopped before runtime'
    class Reader implements NodeRunPromptReader {
      #reference = 'object:' + run
      async read(row: Parameters<NodeRunPromptReader['read']>[0]): Promise<string | null> {
        expect(row?.promptPath).toBe(this.#reference)
        calls.push(this.#reference)
        entered.resolve(undefined)
        await ack.promise
        throw new Error(reason)
      }
    }
    const memory = composeMemoryOperationsFor({
      systemAgentBinding: memorySystemAgentBindingForTest(),
      db,
      reviewedArtifacts: noReviewedContent,
      nodeRunPrompts: Object.freeze(new Reader()),
    })
    let failed = false
    const unsubscribe = memoryDistillJobBroadcaster.subscribe(
      MEMORY_DISTILL_JOB_CHANNEL,
      (event) => {
        if (event.type === 'distill.failed' && event.jobId === jobId) {
          failed = true
          failure.resolve(event.error)
        }
      },
    )
    const loop = await createPollingDaemonRuntimeHandleFactory({
      id: 'memory-distill',
      intervalMs: 10,
      run: () => memory.distillWorker.tick({}).then(() => undefined),
      onError: (error) => failure.resolve(String(error)),
    }).start({
      operationId: 'test',
      provider: harness.applicationBinding.provider,
      generationId: 'fixture',
    })
    try {
      await Promise.race([
        entered.promise,
        failure.promise.then((error) => {
          throw new Error('selected timer reader not reached: ' + error)
        }),
      ])
      expect(failed).toBe(false)
      expect(calls).toEqual(['object:' + run])
      ack.resolve(undefined)
      expect(await failure.promise).toBe(reason)
      expect(calls).toEqual(['object:' + run, 'object:' + run])
      expect(
        await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).get(),
      ).toMatchObject({ status: 'pending', attempts: 1, lastError: reason })
    } finally {
      ack.resolve(undefined)
      await loop.stop()
      await loop.drain()
      unsubscribe()
    }
  })

  test('real runner awaits prompt store then row patch before mark-running', async () => {
    const db = harness.db,
      taskId = freshTaskId(),
      root = mkdtempSync(join(tmpdir(), 'aw-prompt-order-'))
    const writeEntered = held<void>(),
      writeAck = held<void>(),
      patchEntered = held<void>(),
      patchAck = held<void>()
    const stop = new Error('stop after proving mark-running order'),
      signal = new AbortController()
    const trace: string[] = []
    await seedTask(db, taskId)
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    await db.update(tasks).set({ status: 'running', worktreePath }).where(eq(tasks.id, taskId))
    const nodeRunId = ulid()
    await db.insert(nodeRuns).values({
      id: nodeRunId,
      taskId,
      nodeId: DESIGNER,
      status: 'pending',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
    })
    const original = createTaskExecutionPersistence(db)
    const prompts: NodeRunPromptOperations = Object.freeze({
      async store(task: string, run: string, prompt: string) {
        expect([task, run]).toEqual([taskId, nodeRunId])
        expect(prompt).toContain('selected long body')
        trace.push('store')
        writeEntered.resolve(undefined)
        await writeAck.promise
        trace.push('store-ack')
        return { promptText: null, promptPath: 'object:runner' }
      },
      async read() {
        throw new Error('runner must not read stored prompt content')
      },
    })
    const persistence = {
      ...original,
      // Preserve the real provider participants' prototype methods and receivers.
      // Spreading the class instance loses loadEnvelopeNonce before prompt storage.
      nodeExecution: new Proxy(original.nodeExecution, {
        get(target, key) {
          if (key !== 'patch') {
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return async (input: Parameters<typeof original.nodeExecution.patch>[0]) => {
            if ('promptPath' in input.values) {
              expect(input.values).toEqual({ promptText: null, promptPath: 'object:runner' })
              trace.push('patch')
              patchEntered.resolve(undefined)
              await patchAck.promise
              trace.push('patch-ack')
            }
            return await target.patch(input)
          }
        },
      }),
      nodeRuns: new Proxy(original.nodeRuns, {
        get(target, key) {
          if (key !== 'transition') {
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return async (input: Parameters<typeof original.nodeRuns.transition>[0]) => {
            if (input.event.kind === 'mark-running') {
              trace.push('mark-running')
              throw stop
            }
            return await target.transition(input)
          }
        },
      }),
    }
    const agent = {
      id: ulid(),
      name: 'prompt-order',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: 'selected long body '.repeat(500),
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    } as Agent
    const pending = runNode({
      taskId,
      nodeRunId,
      nodeId: DESIGNER,
      agent,
      promptTemplate: 'selected long body '.repeat(500),
      inputs: {},
      worktreePath,
      templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId },
      skills: [],
      appHome: root,
      db,
      nodeRunPrompts: prompts,
      persistence,
      signal: signal.signal,
      binaryOverride: ['bun', 'run', resolve(import.meta.dir, 'fixtures/mock-opencode.ts')],
    }).then(
      () => new Error('runner unexpectedly completed'),
      (error: unknown) => error,
    )
    try {
      await Promise.race([
        writeEntered.promise,
        pending.then((error) => {
          throw error
        }),
      ])
      expect(trace).toEqual(['store'])
      expect(
        (await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get())?.status,
      ).toBe('pending')
      writeAck.resolve(undefined)
      await Promise.race([
        patchEntered.promise,
        pending.then((error) => {
          throw error
        }),
      ])
      expect(trace).toEqual(['store', 'store-ack', 'patch'])
      expect(
        (await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get())?.status,
      ).toBe('pending')
      patchAck.resolve(undefined)
      expect(await pending).toBe(stop)
      expect(trace).toEqual(['store', 'store-ack', 'patch', 'patch-ack', 'mark-running'])
      expect(
        await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get(),
      ).toMatchObject({ status: 'pending', promptText: null, promptPath: 'object:runner' })
    } finally {
      writeAck.resolve(undefined)
      patchAck.resolve(undefined)
      signal.abort()
      await pending
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function source(path: string) {
  return ts.createSourceFile(
    path,
    /(?:^|\/)bootstrap\/daemonStart\.ts$/.test(path)
      ? readDaemonGraphSource()
      : readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
}
function calls(root: ts.Node, sf: ts.SourceFile, name: string) {
  const found: ts.CallExpression[] = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === name) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}
function fields(call: ts.CallExpression, sf: ts.SourceFile) {
  const value = call.arguments[0]!
  if (!ts.isObjectLiteralExpression(value)) throw new Error('actual runner object required')
  return new Map(
    value.properties
      .filter(ts.isPropertyAssignment)
      .map((field) => [field.name.getText(sf), field.initializer.getText(sf)]),
  )
}

test('all three actual runner launch sites consume the family whose native root binds prompt operations next to appHome', () => {
  const sf = source('modules/task-execution/composition/nodeMechanics.ts'),
    found = calls(sf, sf, 'runNode')
  expect(found).toHaveLength(3)
  for (const call of found) {
    expect(call.arguments).toHaveLength(3)
    expect(['opts.taskAgentRuns', 'state.opts.taskAgentRuns']).toContain(
      call.arguments[0]!.getText(sf),
    )
  }
  const native = source('modules/task-execution/composition/localTaskAgentRunFamily.ts'),
    familyCall = onlyCall(native, native, 'composeLocalTaskAgentRunFamily'),
    values = fields(familyCall, native),
    receiver = values.get('appHome')!.replace(/\.request\.appHome$/, '')
  expect(values.get('nodeRunPrompts')).toBe(receiver + '.nodeRunPrompts')
  const purpose = properties(binding(native, native, 'purpose'), native)
  expect(purpose.get('nodeRunPrompts')?.getText(native)).toBe('input.nodeRunPrompts')
})

test('both real memory source branches and both read sites use the required public reader', () => {
  const sf = source('modules/memory/application/distill/memoryDistiller.ts')
  for (const name of ['loadClarifyTranscripts', 'loadAgentRunSources']) {
    const found = calls(sf, sf, name)
    expect(found).toHaveLength(1)
    expect(found[0]!.arguments[2]!.getText(sf)).toBe('nodeRunPrompts')
  }
  const rendered = calls(sf, sf, 'renderNodeRunTranscripts')
  expect(rendered).toHaveLength(2)
  for (const call of rendered) expect(call.arguments[2]!.getText(sf)).toBe('nodeRunPrompts')
  const reads = calls(sf, sf, 'nodeRunPrompts.read')
  expect(reads).toHaveLength(2)
  for (const call of reads) expect(ts.isAwaitExpression(call.parent)).toBe(true)
  expect(
    sf.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.getText(sf)),
  ).toContain("'@/modules/task-execution/public/queries'")
})

function compositionBody(sf: ts.SourceFile, name: string): ts.Block {
  const declaration = sf.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  )
  if (declaration?.body === undefined) throw new Error('missing actual composition: ' + name)
  return declaration.body
}

function binding(root: ts.Node, sf: ts.SourceFile, name: string): ts.Expression {
  const found: ts.VariableDeclaration[] = []
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(sf) === name) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  expect(found).toHaveLength(1)
  const expression = found[0]!.initializer
  if (expression === undefined) throw new Error('missing initializer: ' + name)
  if (
    name === 'nodeRunPrompts' &&
    ts.isConditionalExpression(expression) &&
    compact(expression.condition, sf) === 'selectedTaskRuns===undefined'
  ) {
    if (compact(expression.whenFalse, sf) !== 'selectedTaskRuns.nodeRunPrompts') {
      throw new Error('the complete run selection must own the root prompt reader')
    }
    return expression.whenTrue
  }
  return expression
}

function unwrapped(value: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(value) ? unwrapped(value.expression) : value
}

function properties(value: ts.Expression, sf: ts.SourceFile): Map<string, ts.Expression> {
  value = unwrapped(value)
  if (ts.isCallExpression(value) && value.expression.getText(sf) === 'Object.freeze') {
    expect(value.arguments).toHaveLength(1)
    return properties(value.arguments[0]!, sf)
  }
  if (!ts.isObjectLiteralExpression(value)) throw new Error('actual object required')
  const result = new Map<string, ts.Expression>()
  for (const field of value.properties) {
    if (ts.isPropertyAssignment(field)) result.set(field.name.getText(sf), field.initializer)
    if (ts.isShorthandPropertyAssignment(field)) result.set(field.name.text, field.name)
  }
  return result
}

function onlyCall(root: ts.Node, sf: ts.SourceFile, name: string): ts.CallExpression {
  const found = calls(root, sf, name)
  expect(found).toHaveLength(1)
  return found[0]!
}

function compact(value: ts.Node, sf: ts.SourceFile): string {
  return value.getText(sf).replace(/\s/g, '')
}

function factoryResult(value: ts.Expression): ts.Expression {
  value = unwrapped(value)
  if (!ts.isArrowFunction(value)) throw new Error('actual routes factory required')
  if (!ts.isBlock(value.body)) return unwrapped(value.body)
  const returns = value.body.statements.filter(ts.isReturnStatement)
  expect(returns).toHaveLength(1)
  if (returns[0]!.expression === undefined) throw new Error('actual routes return required')
  return returns[0]!.expression
}

test('CLI initial and replacement sessions carry one prompt selection through SQLite and PG', () => {
  const sf = source('bootstrap/daemonStart.ts'),
    body = compositionBody(sf, 'composeDaemonApplication'),
    selected = onlyCall(body, sf, 'composeNodeRunPromptOperations')
  expectDeploymentSelection('nodeRunPromptContentEffects', 'NodeRunPromptContentEffects')
  expect(selected.arguments.map((value) => compact(value, sf))).toEqual([
    'input.nodeRunPromptContentEffects',
    "join(input.appHome,'runs')",
  ])
  expect(binding(body, sf, 'nodeRunPrompts')).toBe(selected)
  expect(calls(sf, sf, 'composeNodeRunPromptOperations')).toHaveLength(1)
  expect(
    compact(
      properties(onlyCall(body, sf, 'composeDaemonMemoryModules').arguments[0]!, sf).get(
        'nodeRunPrompts',
      )!,
      sf,
    ),
  ).toBe('nodeRunPrompts')
  const provider = properties(
    onlyCall(body, sf, 'composeDaemonTaskExecutionModules').arguments[0]!,
    sf,
  )
  expect(compact(properties(provider.get('selection')!, sf).get('taskRunBinding')!, sf)).toBe(
    'taskRunRoot.drive',
  )
  expect(compact(properties(provider.get('selection')!, sf).get('nodeRunPrompts')!, sf)).toBe(
    'nodeRunPrompts',
  )
  expect(
    compact(
      properties(
        properties(onlyCall(body, sf, 'composeProviderAppComposition').arguments[0]!, sf).get(
          'modules',
        )!,
        sf,
      ).get('taskExecution')!,
      sf,
    ),
  ).toBe('taskExecutionModules')
  expect(compact(binding(sf, sf, 'sessionInput'), sf)).toContain('...profile.selections,')
  const sessions = calls(sf, sf, 'composeDaemonSession')
  expect(sessions).toHaveLength(2)
  for (const call of sessions) {
    const value = call.arguments[0]!
    if (!ts.isObjectLiteralExpression(value)) throw new Error('actual session input required')
    expect(
      value.properties.filter(ts.isSpreadAssignment).map((field) => compact(field, sf)),
    ).toContain('...sessionInput')
  }
  expect(compact(onlyCall(sf, sf, 'composeDaemonApplication').arguments[0]!, sf)).toContain(
    '...deploymentSelectionsOf(input),',
  )
})

test('PG application carries its one prompt receiver through memory, runtime and the actual HTTP graph', () => {
  const sf = source('bootstrap/daemonApplication.ts'),
    body = compositionBody(sf, 'composeDaemonApplication'),
    selected = onlyCall(body, sf, 'composeNodeRunPromptOperations')
  expectDeploymentSelection('nodeRunPromptContentEffects', 'NodeRunPromptContentEffects')
  expect(selected.arguments.map((value) => compact(value, sf))).toEqual([
    'input.nodeRunPromptContentEffects',
    "join(input.appHome,'runs')",
  ])
  expect(binding(body, sf, 'nodeRunPrompts')).toBe(selected)
  expect(calls(sf, sf, 'composeNodeRunPromptOperations')).toHaveLength(1)
  expect(
    compact(
      properties(onlyCall(body, sf, 'composeDaemonMemoryModules').arguments[0]!, sf).get(
        'nodeRunPrompts',
      )!,
      sf,
    ),
  ).toBe('nodeRunPrompts')
  const provider = properties(
    onlyCall(body, sf, 'composeDaemonTaskExecutionModules').arguments[0]!,
    sf,
  )
  expect(compact(properties(provider.get('selection')!, sf).get('taskRunBinding')!, sf)).toBe(
    'taskRunRoot.drive',
  )
  expect(compact(properties(provider.get('selection')!, sf).get('nodeRunPrompts')!, sf)).toBe(
    'nodeRunPrompts',
  )
  const http = properties(onlyCall(body, sf, 'composeProviderAppComposition').arguments[0]!, sf)
  expect(compact(properties(http.get('modules')!, sf).get('taskExecution')!, sf)).toBe(
    'taskExecutionModules',
  )
  expect(compact(onlyCall(body, sf, 'composeProviderAppDeps').arguments[0]!, sf)).toBe(
    'http.composition',
  )
  const neutral = source('bootstrap/daemonHttpComposition.ts'),
    owner = compositionBody(neutral, 'composeProviderAppComposition')
  expect(
    compact(properties(binding(owner, neutral, 'taskRoutes'), neutral).get('operations')!, neutral),
  ).toBe('taskExecutionProvider.routes.tasks')
  expect(
    compact(
      properties(binding(owner, neutral, 'taskExecutionRoutes'), neutral).get('tasks')!,
      neutral,
    ),
  ).toBe('taskRoutes')
  expect(
    compact(
      properties(binding(owner, neutral, 'composition'), neutral).get('taskExecution')!,
      neutral,
    ),
  ).toBe('taskExecutionRoutes')
  expect(calls(body, sf, 'selectNodeRunPromptOperations')).toHaveLength(0)
})

// RFC-382: the selected prompt receiver must survive the newly shared bundle boundary.
test('the bundle forwards selected prompts to both unchanged provider route factories', () => {
  const sf = source('bootstrap/daemonModules/taskExecution.ts')
  const selected = onlyCall(sf, sf, 'composeTaskExecutionProviderRuntime')
  const routes = properties(selected.arguments[0]!, sf).get('routes')!
  expect(compact(properties(factoryResult(routes), sf).get('nodeRunPrompts')!, sf)).toBe(
    'selection.nodeRunPrompts',
  )
  const runtime = source('modules/task-execution/composition/providerRuntime.ts')
  const route = onlyCall(runtime, runtime, 'createTaskRouteOperations')
  expect(compact(route.arguments[0]!, runtime)).toContain('...routeDependencies,')
})
