// RFC-370: the actual runner, collaboration factory and provider HTTP roots await selected artifact ACKs.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import ts from 'typescript'
import {
  WORKFLOW_SCHEMA_VERSION,
  WORKTREE_FILE_MAX_BYTES,
  WorkflowDefinitionSchema,
  type Agent,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { docVersions, nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import { composePortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import { parseArchiveJson } from '@/modules/task-execution/public/queries'
import { createCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/collaborationRuntimeMechanics'
import { describeEachProvider } from './helpers/eachProvider'
import { createProviderHttpApplication } from './helpers/providerHttpApplication'
import { DESIGNER, freshTaskId, seedTask } from './helpers/questionDispatchFixture'
import { held, callablePromise, MemoryPortArtifactContent } from './helpers/portArtifactContent'
import { runNode } from './helpers/runner'

async function fixture(db: ProviderNeutralDatabase) {
  const taskId = freshTaskId(),
    root = mkdtempSync(join(tmpdir(), 'aw-port-binding-'))
  try {
    await seedTask(db, taskId)
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath)
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
    return { taskId, nodeRunId, root, worktreePath }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
function agent(): Agent {
  return {
    id: ulid(),
    name: 'archive-binding',
    description: '',
    outputs: ['report'],
    outputKinds: { report: 'path<md>' },
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: { outputKinds: { report: 'path<md>' } },
    bodyMd: 'Produce a report.',
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}
function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {}
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key]
    process.env[key] = env[key]
  }
  return body().finally(() => {
    for (const key of Object.keys(env)) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}
const usageEvent = {
  type: 'step_finish',
  sessionID: 'artifact-session',
  part: {
    id: 'artifact-step',
    tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 20, write: 0 } },
  },
}
const mockEnv = {
  MOCK_OPENCODE_OUTPUTS: JSON.stringify({ report: './report.md' }),
  MOCK_OPENCODE_EVENTS: JSON.stringify([usageEvent]),
}

function invoke(
  db: ProviderNeutralDatabase,
  h: Awaited<ReturnType<typeof fixture>>,
  content: Readonly<MemoryPortArtifactContent>,
) {
  return runNode({
    taskId: h.taskId,
    nodeRunId: h.nodeRunId,
    nodeId: DESIGNER,
    agent: agent(),
    inputs: {},
    worktreePath: h.worktreePath,
    templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
    skills: [],
    appHome: h.root,
    db,
    portArtifacts: composePortArtifactOperations(content, h.root),
    binaryOverride: ['bun', 'run', resolve(import.meta.dir, 'fixtures/mock-opencode.ts')],
  })
}

describeEachProvider('RFC-370 real port artifact consumers', (harness) => {
  test('real runner waits for copy ACK before outputs, roster and opaque reference persistence', async () => {
    const db = harness.db,
      h = await fixture(db),
      entered = held<void>(),
      ack = held<void>()
    const bytes = Buffer.from('# durable selected report\n内容')
    writeFileSync(join(h.worktreePath, 'report.md'), bytes)
    const content = Object.freeze(
      new MemoryPortArtifactContent({
        copy: () => {
          entered.resolve(undefined)
          return callablePromise(ack.promise)
        },
      }),
    )
    content.put({ workspaceRef: h.worktreePath, relativePath: 'report.md' }, bytes)
    let settled = false
    const pending = withEnv(mockEnv, () => invoke(db, h, content)).then((result) => {
      settled = true
      return result
    })
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('runner ended before selected copy')
        }),
      ])
      expect(settled).toBe(false)
      expect(
        await db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, h.nodeRunId)),
      ).toEqual([])
      expect(
        (await db.select().from(nodeRuns).where(eq(nodeRuns.id, h.nodeRunId)).get())?.status,
      ).toBe('running')
      expect(content.archives.size).toBe(0)
      ack.resolve(undefined)
      const result = await pending
      expect(result).toMatchObject({
        status: 'done',
        exitCode: 0,
        outputs: { report: 'report.md' },
        portFilePaths: ['report.md'],
        tokenUsage: { input: 100, output: 10, cacheRead: 20 },
      })
      const rows = await db
        .select()
        .from(nodeRunOutputs)
        .where(eq(nodeRunOutputs.nodeRunId, h.nodeRunId))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ portName: 'report', content: 'report.md', kind: 'path<md>' })
      expect(parseArchiveJson(rows[0]!.archiveJson)!.items[0]).toMatchObject({
        path: 'report.md',
        file: 'object:' + h.taskId + '/' + h.nodeRunId + '/report/0.md',
        size: bytes.length,
        truncated: false,
      })
      expect(content.calls.indexOf('copy-ack')).toBeLessThan(
        content.calls.indexOf('link:report.md'),
      )
      expect(
        (await db.select().from(nodeRuns).where(eq(nodeRuns.id, h.nodeRunId)).get())?.tokInput,
      ).toBe(100)
    } finally {
      ack.resolve(undefined)
      await pending
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  for (const variant of ['copy', 'write', 'error-message'] as const) {
    test(
      'real runner preserves environment failure, exitCode and usage for arbitrary ' +
        variant +
        ' rejection',
      async () => {
        const db = harness.db,
          h = await fixture(db)
        const reason =
          variant === 'copy'
            ? Object.create(null)
            : variant === 'write'
              ? {
                  [Symbol.toPrimitive]() {
                    throw new Error('description unavailable')
                  },
                }
              : Object.defineProperty(new Error('archive transport failure'), 'message', {
                  value: {
                    [Symbol.toPrimitive]() {
                      throw new Error('message description unavailable')
                    },
                  },
                })
        const bytes =
          variant !== 'write'
            ? Buffer.from('small report')
            : Buffer.alloc(WORKTREE_FILE_MAX_BYTES + 1, 120)
        writeFileSync(join(h.worktreePath, 'report.md'), bytes)
        const content = Object.freeze(
          new MemoryPortArtifactContent(
            variant !== 'write'
              ? { copy: () => Promise.reject(reason) }
              : { write: () => Promise.reject(reason) },
          ),
        )
        content.put({ workspaceRef: h.worktreePath, relativePath: 'report.md' }, bytes)
        try {
          const result = await withEnv(mockEnv, () => invoke(db, h, content))
          expect(result).toMatchObject({
            status: 'failed',
            exitCode: 0,
            errorMessage: 'port-artifact-archive-failed: unavailable error description',
            tokenUsage: { input: 100, output: 10, cacheRead: 20 },
          })
          expect(result.failureCode).toBeUndefined()
          expect(result.errorMessage).not.toContain('runtime-spawn-failed')
          expect(
            await db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, h.nodeRunId)),
          ).toEqual([])
          expect(
            await db.select().from(nodeRuns).where(eq(nodeRuns.id, h.nodeRunId)).get(),
          ).toMatchObject({
            status: 'failed',
            exitCode: 0,
            failureCode: null,
            tokInput: 100,
            tokOutput: 10,
            tokCacheRead: 20,
            tokTotal: result.tokenUsage.total,
          })
          expect(content.archives.size).toBe(0)
          expect(content.calls).toContain(variant !== 'write' ? 'copy:report.md' : 'write')
        } finally {
          rmSync(h.root, { recursive: true, force: true })
        }
      },
    )
  }

  test('selected collaboration reader ACK precedes doc versions and review park', async () => {
    const db = harness.db,
      h = await fixture(db),
      entered = held<void>(),
      ack = held<void>()
    const definition = WorkflowDefinitionSchema.parse({
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      nodes: [
        { id: DESIGNER, kind: 'agent-single', agentName: 'writer' },
        { id: 'review', kind: 'review' },
      ],
      edges: [
        {
          id: 'review-edge',
          source: { nodeId: DESIGNER, portName: 'report' },
          target: { nodeId: 'review', portName: '__review_input__' },
        },
      ],
      outputs: [],
    })
    const reviewNode = definition.nodes.find((node) => node.id === 'review')
    if (reviewNode === undefined) throw new Error('fixture review node missing')
    await db
      .update(tasks)
      .set({ workflowSnapshot: JSON.stringify(definition) })
      .where(eq(tasks.id, h.taskId))
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, h.nodeRunId))
    const archiveJson = JSON.stringify({
      v: 1,
      items: [{ path: 'repo/report.md', file: 'object:review-source', size: 28, truncated: false }],
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: h.nodeRunId,
      portName: 'report',
      content: 'report.md',
      kind: 'path<md>',
      archiveJson,
    })
    const content = Object.freeze(
      new MemoryPortArtifactContent({
        read: () => {
          entered.resolve(undefined)
          return ack.promise
        },
      }),
    )
    content.archives.set('object:review-source', Buffer.from('# selected review body'))
    const operations = composePortArtifactOperations(content, h.root),
      selectedHomes: string[] = []
    const collaboration = createCollaborationRuntimeMechanics(db, {
      portArtifactReaderFor: (appHome) => {
        selectedHomes.push(appHome)
        return operations
      },
    })
    let settled = false
    const pending = collaboration
      .dispatchReviewNode({
        taskId: h.taskId,
        appHome: h.root,
        definition,
        node: reviewNode,
        iteration: 0,
        scopeRoot: 'workspace:containing-scope',
        repoDirName: 'repo',
        containerRunId: null,
      })
      .then((result) => {
        settled = true
        return result
      })
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error('review ended before read ACK: ' + result.message)
        }),
      ])
      expect(settled).toBe(false)
      expect(selectedHomes).toEqual([h.root])
      expect(await db.select().from(docVersions).where(eq(docVersions.taskId, h.taskId))).toEqual(
        [],
      )
      expect(
        await db
          .select()
          .from(nodeRuns)
          .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'review'))),
      ).toEqual([])
      expect((await db.select().from(tasks).where(eq(tasks.id, h.taskId)).get())?.status).toBe(
        'running',
      )
      ack.resolve(undefined)
      expect((await pending).kind).toBe('awaiting_review')
      const docs = await db.select().from(docVersions).where(eq(docVersions.taskId, h.taskId))
      expect(docs).toHaveLength(1)
      expect(readFileSync(join(h.root, docs[0]!.bodyPath), 'utf8')).toBe('# selected review body')
      expect(docs[0]!.sourceFilePath).toBe('report.md')
      expect(
        (
          await db
            .select()
            .from(nodeRuns)
            .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'review')))
            .get()
        )?.status,
      ).toBe('awaiting_review')
      expect(content.sources).toEqual([])
    } finally {
      ack.resolve(undefined)
      await pending
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test('real provider HTTP root waits for selected download ACK and uses selected meta queries', async () => {
    const db = harness.db,
      h = await fixture(db),
      entered = held<void>(),
      ack = held<void>()
    const content = Object.freeze(
      new MemoryPortArtifactContent({
        read: () => {
          entered.resolve(undefined)
          return callablePromise(ack.promise)
        },
      }),
    )
    const bytes = Buffer.from('# remote download\n内容'),
      archiveJson = JSON.stringify({
        v: 1,
        items: [
          { path: 'report.md', file: 'object:download', size: bytes.length, truncated: true },
        ],
      })
    content.archives.set('object:download', bytes)
    await db.insert(nodeRunOutputs).values({
      nodeRunId: h.nodeRunId,
      portName: 'report',
      content: 'report.md',
      kind: 'path<md>',
      archiveJson,
    })
    const application = await createProviderHttpApplication(harness, {
      token: 'tok',
      configPath: join(h.root, 'config.json'),
      appHome: h.root,
      opencodeVersion: '1.14.25',
      dbVersion: 17,
      portArtifactContentEffects: content,
    })
    const headers = { Authorization: 'Bearer tok' },
      path = '/api/tasks/' + h.taskId + '/port-artifacts/' + h.nodeRunId + '/report'
    let settled = false
    const pending = Promise.resolve(application.app.request(path + '?item=0', { headers })).then(
      (response) => {
        settled = true
        return response
      },
    )
    try {
      await Promise.race([
        entered.promise,
        pending.then((response) => {
          throw new Error('HTTP ended before selected read: ' + response.status)
        }),
      ])
      expect(settled).toBe(false)
      expect(content.calls).toEqual(['read:object:download'])
      ack.resolve(undefined)
      const response = await pending
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
      expect(response.headers.get('X-AW-Artifact-Truncated')).toBe('1')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
      content.calls.length = 0
      const meta = await application.app.request(path, { headers })
      expect(meta.status).toBe(200)
      expect(await meta.json()).toEqual({
        items: [{ path: 'report.md', size: bytes.length, truncated: true, source: 'archive' }],
      })
      expect(content.calls).toEqual(['exists:object:download'])
    } finally {
      ack.resolve(undefined)
      await pending
      await application.dispose()
      rmSync(h.root, { recursive: true, force: true })
    }
  })
})

function source(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
}
function calls(root: ts.Node, sf: ts.SourceFile, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === name) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}
function objectFields(node: ts.Node, sf: ts.SourceFile) {
  if (!ts.isObjectLiteralExpression(node)) throw new Error('actual object literal required')
  const values = new Map<string, string>()
  for (const field of node.properties) {
    if (ts.isPropertyAssignment(field))
      values.set(field.name.getText(sf), field.initializer.getText(sf))
    else if (ts.isShorthandPropertyAssignment(field))
      values.set(field.name.getText(sf), field.name.getText(sf))
  }
  return values
}

test('all three actual runNode launch sites bind the same artifact operations as their runtime', () => {
  const sf = source('modules/task-execution/composition/nodeMechanics.ts'),
    found = calls(sf, sf, 'runNode')
  expect(found).toHaveLength(3)
  expect(found.map((call) => call.arguments[0]!.getText(sf))).toEqual([
    'opts.taskAgentRuns',
    'state.opts.taskAgentRuns',
    'opts.taskAgentRuns',
  ])
})

test('both real fanout shard and aggregator runNode sites retain the same selected artifact operations', () => {
  const sf = source('modules/task-execution/composition/wrapperMechanics.ts'),
    found = calls(sf, sf, 'runNode')
  expect(found).toHaveLength(2)
  expect(found.map((call) => objectFields(call.arguments[1]!, sf).get('nodeRunId'))).toEqual([
    'shardRunId',
    'aggRunId',
  ])
  expect(found.map((call) => call.arguments[0]!.getText(sf))).toEqual([
    'opts.taskAgentRuns',
    'opts.taskAgentRuns',
  ])
})

// RFC-370 binds the original selected artifact receiver once into the complete
// family; each launch above uses that family instead of a native options member.
test('the real drive binds its exact selected artifact receiver into the family and preserves the native archive/read receiver', () => {
  const drive = source('modules/task-execution/composition/localTaskRunSelection.ts')
  const selected = calls(drive, drive, 'input.taskAgentRunsFor')
  expect(selected).toHaveLength(1)
  expect(objectFields(selected[0]!.arguments[0]!, drive).get('portArtifacts')).toBe(
    'binding.portArtifacts',
  )
  expect(drive.text).toContain('const portArtifacts = input.portArtifactsFor(request.appHome)')
  const local = source('modules/task-execution/composition/localTaskAgentRunFamily.ts')
  expect(calls(local, local, 'input.portArtifacts.archive')).toHaveLength(1)
  expect(calls(local, local, 'input.portArtifacts.read')).toHaveLength(1)
  expect(local.text).toContain(
    'workspaceRef: workspaces.workingDirectory(item.source.workspaceRef)',
  )
  expect(local.text).toContain('workspaces.workingDirectory(request.fallbackWorkspaceRef)')
})

test('CLI initial and replacement sessions carry raw content selection into the real SQLite and PG composers', () => {
  const sf = source('cli/start.ts')
  const sqlite = calls(sf, sf, 'composePortArtifactOperations')
  expect(sqlite).toHaveLength(1)
  expect(sqlite[0]!.arguments.map((arg) => arg.getText(sf))).toEqual([
    'input.portArtifactContentEffects',
    'Paths.root',
  ])
  const pg = calls(sf, sf, 'composePostgresqlDaemonApplication')
  expect(pg).toHaveLength(1)
  expect(objectFields(pg[0]!.arguments[0]!, sf).get('portArtifactContentEffects')).toBe(
    'input.portArtifactContentEffects',
  )
  const sqliteDeps = calls(sf, sf, 'composeSqliteAppDeps')
  expect(sqliteDeps).toHaveLength(1)
  expect(objectFields(sqliteDeps[0]!.arguments[0]!, sf).get('portArtifacts')).toBe('portArtifacts')
  expect(
    sf.text.match(/portArtifactContentEffects: opts\.portArtifactContentEffects/g),
  ).toHaveLength(1)
})

test('PG and HTTP roots share one selected service between runtime, review and the real artifact route', () => {
  const pg = source('cli/postgresqlDaemonApplication.ts'),
    server = source('server.ts')
  const pgSelection = calls(pg, pg, 'composePortArtifactOperations')
  expect(pgSelection).toHaveLength(1)
  expect(pgSelection[0]!.arguments.map((arg) => arg.getText(pg))).toEqual([
    'input.portArtifactContentEffects',
    'input.appHome',
  ])
  expect(pg.text).toContain('taskRunBinding: taskRunRoot.drive')
  expect(pg.text).toContain('portArtifactReaderFor: () => portArtifacts')
  expect(pg.text).toMatch(
    /portArtifacts:\s*Object\.freeze\(\{\s*taskExecutionReadModels: [^,]+,\s*portArtifacts,\s*\}\)/,
  )
  const selections = calls(server, server, 'composePortArtifactOperations')
  expect(selections).toHaveLength(1)
  expect(selections[0]!.arguments.map((arg) => arg.getText(server))).toEqual([
    'deps.portArtifactContentEffects',
    'appHome',
  ])
  expect(server.text).toContain('deps.portArtifacts === undefined')
  expect(server.text).toContain('selectPortArtifactOperations(deps.portArtifacts, appHome)')
  expect(server.text).toContain('taskRunBinding: taskRunRoot.drive')
  expect(server.text).toContain('portArtifactReaderFor: () => portArtifacts')
  expect(server.text).toContain(
    'portArtifactReaderFor: () => selectPortArtifactReader(deps.portArtifacts, appHome)',
  )
  expect(
    calls(server, server, 'mountPortArtifactRoutes').map((call) =>
      call.arguments[1]!.getText(server),
    ),
  ).toEqual(['input.taskExecution.portArtifacts', 'deps'])
})

test('ordinary scheduler and repair dispatch use the selected factory; body read stays inside the original lock', () => {
  const scheduler = source('modules/task-execution/composition/nodeMechanics.ts'),
    repair = source('modules/task-execution/infrastructure/taskRouteRepairOperations.ts'),
    factory = source('modules/collaboration/infrastructure/collaborationRuntimeMechanics.ts'),
    review = source('modules/collaboration/infrastructure/review.ts')
  expect(calls(scheduler, scheduler, 'collaboration.dispatchReviewNode')).toHaveLength(1)
  expect(
    calls(repair, repair, 'dependencies.collaborationRuntime.dispatchReviewNode'),
  ).toHaveLength(1)
  expect(factory.text).toContain('dependencies.portArtifactReaderFor(input.appHome)')
  expect(review.text).toContain(
    'withTaskReviewMutationLock(args.taskId, () => dispatchReviewNodeUnlocked(args))',
  )
  expect(review.text).toContain(
    'await selectPortArtifactReader(args.portArtifactReader, appHome).read(',
  )
  expect(review.text).toContain('fallbackWorkspaceRef: scopeRoot')
})
