// RFC-370: selected upload ACKs must precede the real journal receipt and Task admission in both providers.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import ts from 'typescript'
import { StartTaskSchema, WorkflowDefinitionSchema } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { workflows, tasks } from '@/db/schema'
import { admitDaemonIdentity, actorOfDirectAuthority } from '@/auth/session'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import { composeTaskExecutionResourceBinding } from '@/modules/resource-catalog/composition/taskExecution'
import { createTaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import { taskExecutionResourceDependencies } from '@/services/execution/taskExecutionResourceDependencies'
import {
  createRootTaskLaunchKernel,
  createTaskRouteWorkspaceParticipant,
} from '@/modules/task-execution/composition/taskRouteLaunch'
import { applyTaskWorkspaceUploads } from '@/modules/task-execution/infrastructure/taskWorkspaceUploads'
import { createWorkspacePreparationJournal } from '@/modules/task-execution/infrastructure/workspacePreparationJournal'
import type { UploadPlan } from '@/services/upload'
import { describeEachProvider } from './helpers/eachProvider'
import { createProviderHttpApplication } from './helpers/providerHttpApplication'
import { held } from './helpers/portArtifactContent'
import {
  MemoryWorkspaceUploadContent,
  MemoryWorkspaceUploadFactory,
} from './helpers/workspaceUploadContent'

function plan(workspaceRef = 'opaque:prepared'): UploadPlan {
  return {
    worktreePath: workspaceRef,
    defs: new Map([['refs', { key: 'refs', targetDir: 'inputs' }]]),
    files: [
      { inputKey: 'refs', filename: 'a.txt', declaredMime: 'text/plain', bytes: Uint8Array.of(65) },
    ],
    limits: { perFile: 100, perRequest: 200, perCount: 2 },
  }
}
async function preparedJournal(db: ProviderNeutralDatabase) {
  const taskId = ulid(),
    journal = createWorkspacePreparationJournal(db)
  const initial = await journal.prepare({
    id: taskId,
    admissionKey: taskId,
    requestDigest: 'preparation',
    lane: 'pre-materialized',
    operationRef: null,
    ownerFence: 7,
    now: Date.now(),
  })
  const saved = await journal.advance({
    id: taskId,
    expectedVersion: initial.version,
    ownerFence: 7,
    from: 'preparing',
    to: 'prepared',
    artifactJson: '{}',
    now: Date.now(),
  })
  if (saved === null) throw new Error('fixture preparation failed')
  return { taskId, journal, saved }
}

describeEachProvider('RFC-370 selected upload journal and launch bindings', (harness) => {
  test('held write sees its durable reservation but no receipt or Task, then receipt bypasses bind', async () => {
    const f = await preparedJournal(harness.db),
      entered = held<void>(),
      release = held<void>()
    const content = Object.freeze(
      new MemoryWorkspaceUploadContent(async (method) => {
        if (method === 'write') {
          const row = await f.journal.read(f.taskId),
            receipt = JSON.parse(row!.artifactJson!)
          expect(receipt.uploadPlan.placements).toEqual(['a.txt'])
          expect(receipt.uploads).toBeUndefined()
          expect(await harness.db.select().from(tasks)).toEqual([])
          entered.resolve()
          await release.promise
        }
      }),
    )
    const factory = Object.freeze(new MemoryWorkspaceUploadFactory(content))
    const pending = applyTaskWorkspaceUploads({
      db: harness.db,
      taskId: f.taskId,
      plan: plan(),
      workspaceUploads: factory,
    })
    await entered.promise
    expect(factory.bindings).toEqual([
      { workspaceRef: 'opaque:prepared', generation: '7', version: String(f.saved.version) },
    ])
    expect(content.entries.size).toBe(0)
    release.resolve()
    const result = await pending,
      row = await f.journal.read(f.taskId),
      receipt = JSON.parse(row!.artifactJson!)
    expect(receipt.uploads.packedByKey).toEqual([['refs', ['inputs/a.txt']]])
    expect(row!.state).toBe('prepared')
    expect(result.packedByKey.get('refs')).toEqual(['inputs/a.txt'])
    const invalidFactory = null as unknown as MemoryWorkspaceUploadFactory
    expect(
      (
        await applyTaskWorkspaceUploads({
          db: harness.db,
          taskId: f.taskId,
          plan: plan(),
          workspaceUploads: invalidFactory,
        })
      ).packedByKey.get('refs'),
    ).toEqual(['inputs/a.txt'])
    expect(factory.bindings).toHaveLength(1)
    await expect(
      applyTaskWorkspaceUploads({
        db: harness.db,
        taskId: f.taskId,
        plan: { ...plan(), files: [{ ...plan().files[0]!, bytes: Uint8Array.of(66) }] },
        workspaceUploads: factory,
      }),
    ).rejects.toMatchObject({ code: 'workspace-upload-request-mismatch' })
    expect(factory.bindings).toHaveLength(1)
  })

  test('commit-then-reject uses the same reserved placement on retry and compares the complete bytes', async () => {
    const f = await preparedJournal(harness.db),
      reason = new Error('lost write ACK')
    class CommitThenReject extends MemoryWorkspaceUploadContent {
      #lost = false
      override async write(fileRef: string, bytes: Uint8Array) {
        await super.write(fileRef, bytes)
        if (!this.#lost) {
          this.#lost = true
          throw reason
        }
      }
    }
    const content = Object.freeze(new CommitThenReject()),
      factory = Object.freeze(new MemoryWorkspaceUploadFactory(content))
    const input = { db: harness.db, taskId: f.taskId, plan: plan(), workspaceUploads: factory }
    await expect(applyTaskWorkspaceUploads(input)).rejects.toBe(reason)
    expect(JSON.parse((await f.journal.read(f.taskId))!.artifactJson!).uploads).toBeUndefined()
    expect(content.entries.has(content.key('inputs', 'a.txt'))).toBe(true)
    expect((await applyTaskWorkspaceUploads(input)).packedByKey.get('refs')).toEqual([
      'inputs/a.txt',
    ])
    expect(content.calls.filter((x) => x.startsWith('write:'))).toHaveLength(1)
    expect(content.calls.filter((x) => x.startsWith('read:'))).toHaveLength(1)
    expect(content.entries.size).toBe(1)
    expect(factory.bindings).toHaveLength(2)
  })

  test('the original whole-writer interruption seam remains and simultaneous selection is explicit', async () => {
    const f = await preparedJournal(harness.db),
      factory = new MemoryWorkspaceUploadFactory(new MemoryWorkspaceUploadContent())
    let calls = 0
    const result = { packedByKey: new Map([['refs', ['inputs/a.txt']]]) }
    const write = async (request: UploadPlan) => {
      calls++
      await request.recovery!.reserve(0, 'a.txt')
      return result
    }
    await expect(
      applyTaskWorkspaceUploads({
        db: harness.db,
        taskId: f.taskId,
        plan: plan(),
        workspaceUploads: factory,
        write,
      }),
    ).rejects.toThrow('whole writer override')
    expect(calls).toBe(0)
    expect(factory.bindings).toHaveLength(0)
    expect(
      await applyTaskWorkspaceUploads({ db: harness.db, taskId: f.taskId, plan: plan(), write }),
    ).toBe(result)
    expect(calls).toBe(1)
    expect(JSON.parse((await f.journal.read(f.taskId))!.artifactJson!).uploads.packedByKey).toEqual(
      [['refs', ['inputs/a.txt']]],
    )
  })

  test('the real shared Task kernel waits for selected bytes before admission and coordinator submission', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'aw-upload-launch-'))),
      entered = held<void>(),
      release = held<void>()
    try {
      const identityAccess = createIdentityAccessRuntime({ db: harness.db }),
        identity = await admitDaemonIdentity(identityAccess)
      if (identity === null) throw new Error('fixture identity missing')
      const actor = actorOfDirectAuthority(identity),
        workflowId = ulid()
      const definition = WorkflowDefinitionSchema.parse({
        $schema_version: 1,
        inputs: [],
        nodes: [],
        edges: [],
      })
      await harness.db
        .insert(workflows)
        .values({ id: workflowId, name: workflowId, definition: JSON.stringify(definition) })
      const workspace = createTaskRouteWorkspaceParticipant({
        db: harness.db,
        appHome: home,
        sourceContexts: identityAccess.taskPreparationContext,
        repositoryPreparation: composeRepositoryPreparation({ db: harness.db, appHome: home }),
      })
      const content = Object.freeze(
          new MemoryWorkspaceUploadContent((method) => {
            if (method === 'write') {
              entered.resolve()
              return release.promise
            }
          }),
        ),
        factory = Object.freeze(new MemoryWorkspaceUploadFactory(content))
      const submitted: string[] = []
      const kernel = createRootTaskLaunchKernel({
        db: harness.db,
        workspace,
        workspaceUploads: factory,
        gitCommitIdentity: identityAccess.getUserGitCommitIdentity,
        coordinator: {
          async submit(request) {
            submitted.push(request.taskId)
            return { kind: 'accepted', taskId: request.taskId }
          },
        },
      })
      const pending = kernel.launch({
        actor,
        resourceAuthority: {
          actor,
          authority: identity.authority,
          resources: createTaskExecutionResourceBinding(
            harness.db,
            composeTaskExecutionResourceBinding(taskExecutionResourceDependencies),
          ),
        },
        invoker: { type: 'user', launchKind: 'direct-json' },
        task: StartTaskSchema.parse({
          workflowId,
          name: 'selected upload',
          scratch: true,
          inputs: {},
        }),
        subject: {
          workflowId,
          workflowName: workflowId,
          workflowVersion: 1,
          workflowSnapshot: definition,
          builtin: false,
        },
        uploads: {
          parts: [
            {
              inputKey: 'refs',
              filename: 'a.txt',
              declaredMime: 'text/plain',
              blob: new Blob([Uint8Array.of(65)]),
            },
          ],
          definitions: plan().defs,
          limits: plan().limits,
        },
      })
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('kernel completed before write ACK')
        }),
      ])
      expect(await harness.db.select().from(tasks)).toEqual([])
      expect(submitted).toEqual([])
      const binding = factory.bindings[0]!
      expect(existsSync(binding.workspaceRef)).toBe(true)
      expect(existsSync(join(binding.workspaceRef, 'inputs', 'a.txt'))).toBe(false)
      release.resolve()
      const result = await pending
      expect(result.inputs.refs).toBe('inputs/a.txt')
      expect(submitted).toEqual([result.id])
      expect((await createWorkspacePreparationJournal(harness.db).forTask(result.id))?.state).toBe(
        'admitted',
      )
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, result.id)))[0]?.inputs,
      ).toBe(JSON.stringify({ refs: 'inputs/a.txt' }))
      expect(content.entries.get(content.key('inputs', 'a.txt'))).toEqual({
        kind: 'file',
        bytes: Uint8Array.of(65),
      })
      expect(factory.bindings).toHaveLength(1)
    } finally {
      release.resolve()
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
  test('standalone provider HTTP multipart uses the selected receiver and waits before its 201 response', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'aw-upload-http-'))),
      entered = held<void>(),
      release = held<void>()
    const content = Object.freeze(
        new MemoryWorkspaceUploadContent((method) => {
          if (method === 'write') {
            entered.resolve()
            return release.promise
          }
        }),
      ),
      factory = Object.freeze(new MemoryWorkspaceUploadFactory(content))
    const application = await createProviderHttpApplication(harness, {
      appHome: home,
      configPath: join(home, 'config.json'),
      token: 'tok',
      dbVersion: 17,
      opencodeVersion: '1.14.25',
      workspaceUploads: factory,
    })
    let pending: Promise<Response> | undefined
    try {
      const workflowId = ulid(),
        definition = WorkflowDefinitionSchema.parse({
          $schema_version: 1,
          inputs: [{ kind: 'upload', key: 'refs', label: 'References', targetDir: 'inputs' }],
          nodes: [],
          edges: [],
        })
      await harness.db
        .insert(workflows)
        .values({ id: workflowId, name: workflowId, definition: JSON.stringify(definition) })
      const form = new FormData()
      form.set(
        'payload',
        new Blob([JSON.stringify({ workflowId, name: 'HTTP upload', scratch: true, inputs: {} })], {
          type: 'application/json',
        }),
      )
      form.append('files[refs][]', new Blob(['A']), 'a.txt')
      let completed = false
      pending = Promise.resolve(
        application.app.request('/api/tasks', {
          method: 'POST',
          body: form,
          headers: { Authorization: 'Bearer tok' },
        }),
      ).then((response) => {
        completed = true
        return response
      })
      await Promise.race([
        entered.promise,
        pending.then((response) => {
          throw new Error('HTTP completed before selected write: ' + response.status)
        }),
      ])
      expect(completed).toBe(false)
      expect(await harness.db.select().from(tasks)).toEqual([])
      expect(factory.bindings).toHaveLength(1)
      expect(existsSync(join(factory.bindings[0]!.workspaceRef, 'inputs', 'a.txt'))).toBe(false)
      release.resolve()
      const response = await pending
      expect(response.status).toBe(201)
      const result = (await response.json()) as { id: string; inputs: Record<string, string> }
      expect(result.inputs.refs).toBe('inputs/a.txt')
      expect(content.entries.get(content.key('inputs', 'a.txt'))).toEqual({
        kind: 'file',
        bytes: Uint8Array.of(65),
      })
      expect((await createWorkspacePreparationJournal(harness.db).forTask(result.id))?.state).toBe(
        'admitted',
      )
      expect(factory.bindings).toHaveLength(1)
    } finally {
      release.resolve()
      await pending?.catch(() => {})
      await application.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
})

test('real roots, provider reassembly, SQLite arms and PG preselection preserve the same complete factory', () => {
  const root = resolve(import.meta.dir, '../src')
  const source = (path: string) => readFileSync(join(root, path), 'utf8')
  const cli = source('cli/start.ts'),
    pg = source('cli/postgresqlDaemonApplication.ts'),
    http = source('server.ts')
  function values(text: string, property: string) {
    const sf = ts.createSourceFile('root.ts', text, ts.ScriptTarget.Latest, true),
      result: string[] = []
    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) && node.name.getText(sf) === property)
        result.push(node.initializer.getText(sf))
      if (ts.isShorthandPropertyAssignment(node) && node.name.getText(sf) === property)
        result.push(node.name.getText(sf))
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return result
  }
  expect(values(cli, 'workspaceUploads')).toEqual([
    'input.workspaceUploads',
    'selectWorkspaceUploadContentFactory(opts.workspaceUploads)',
    'input.workspaceUploads',
    'input.workspaceUploads',
  ])
  expect(values(pg, 'workspaceUploads')).toEqual(['workspaceUploads'])
  expect(values(http, 'workspaceUploads')).toEqual(['workspaceUploads', 'deps.workspaceUploads'])
  expect(http).toContain(
    'deps.taskRouteLaunch ?? createSqliteTaskRouteLaunchOperations(taskRouteLaunchDependencies)',
  )
  expect(http).toContain(
    'createSqliteTaskExecutionLaunchParticipant(\n    taskRouteLaunchDependencies,\n  )',
  )
  const providers = source('modules/task-execution/composition/providerRuntime.ts')
  expect(providers).toContain(
    'createSqliteTaskExecutionLaunchParticipant({ db, ...dependencies.routeLaunch })',
  )
  expect(providers).toContain('workspace: routeWorkspace,\n    ...dependencies.routeLaunch,')
  expect(providers).toContain('createRootTaskLaunchKernel(routeLaunchDependencies)')
  const sqlite = source('modules/task-execution/infrastructure/sqliteTaskRouteLaunchOperations.ts')
  expect(sqlite.match(/\.\.\.input,/g)).toHaveLength(2)
  expect(
    values(
      source('modules/task-execution/infrastructure/taskRouteLaunchOperations.ts'),
      'workspaceUploads',
    ),
  ).toEqual(['dependencies.workspaceUploads'])
})
