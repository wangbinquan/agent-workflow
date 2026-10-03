// RFC-370: complete selected workspace effects retain serial content and close ACKs.
// Exact 694 CI repair: launch-frozen submission and complete fake port retain the close ACK oracle.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AutomationWorkspaceDirectoryEntry,
  AutomationWorkspaceEffects,
  AutomationWorkspaceEffectsFactory,
  AutomationWorkspaceFileFacts,
} from '@/modules/development-automation/application/ports/automationWorkspaceEffects'
import {
  selectedAutomationWorkspaceEffects,
  withAutomationWorkspaceEffects,
} from '@/modules/development-automation/infrastructure/automationWorkspaceEffects'
import { createFileAutomationWorkspaceEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileAutomationWorkspaceEffects'
import {
  protectedRootSnapshotDigest,
  snapshotProtectedRoots,
} from '@/modules/development-automation/infrastructure/protectedSnapshot'
import {
  businessTreeSnapshot,
  businessTreeSnapshotDigest,
} from '@/modules/development-automation/infrastructure/workspaceValidator'
import { createWorkspaceValidationAdapter } from '@/modules/development-automation/infrastructure/attemptSupport'
import { composeDevelopmentEmployeeWorkspace } from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import { runMissionReconcile } from '@/modules/development-automation/application/missionReconciler'
import { createEmployeeReactionRoundQueries } from '@/modules/digital-employee/composition'
import {
  cachedRepos,
  employeeCases,
  employeeCaseWorkspaces,
  employeeReactionRounds,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import { buildPr3Fixture, PR3_JAVA_CELLS } from './helpers/rfc310Pr3Fixture'
import { fakeAgentActionPorts } from './helpers/rfc310AgentPorts'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected rejection')
}

interface TreeOptions {
  acquire?(id: number): void | Promise<void>
  close?(id: number): void | Promise<void>
  operation?(name: string, reference: string, id: number): void | Promise<void>
}
interface TreeItem {
  readonly kind: 'file' | 'directory'
  readonly bytes: Uint8Array
  readonly mode: number
}

/** Opaque references, frozen receivers and plain Uint8Array; no native reader exists. */
class SelectedTree implements AutomationWorkspaceEffectsFactory {
  #items = new Map<string, TreeItem>()
  #options: TreeOptions
  #scopes = 0
  readonly trace: string[] = []
  constructor(options: TreeOptions = {}) {
    this.#options = options
    Object.freeze(this)
  }
  resolve(reference: string, ...segments: readonly string[]): string {
    return [reference, ...segments].join('/').replace(/\/{2,}/g, '/')
  }
  parent(reference: string): string {
    const index = reference.lastIndexOf('/')
    return index === -1 ? reference : reference.slice(0, index)
  }
  directory(reference: string): void {
    const parent = this.parent(reference)
    if (parent !== reference && !this.#items.has(parent)) this.directory(parent)
    this.#items.set(reference, { kind: 'directory', bytes: new Uint8Array(), mode: 0o40755 })
  }
  file(reference: string, text: string, mode = 0o100644): void {
    this.directory(this.parent(reference))
    this.#items.set(reference, { kind: 'file', bytes: new TextEncoder().encode(text), mode })
  }
  read(reference: string): TreeItem | undefined {
    return this.#items.get(reference)
  }
  names(reference: string): string[] {
    const prefix = reference + '/'
    return [...this.#items.keys()]
      .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .map((key) => key.slice(prefix.length))
  }
  write(reference: string, item: TreeItem): void {
    this.#items.set(reference, item)
  }
  async enter(name: string, reference: string, id: number): Promise<void> {
    this.trace.push(`${id}:${name}:${reference}`)
    await this.#options.operation?.(name, reference, id)
  }
  async release(id: number): Promise<void> {
    this.trace.push(`${id}:close-entered`)
    await this.#options.close?.(id)
    this.trace.push(`${id}:closed`)
  }
  async acquire(): Promise<AutomationWorkspaceEffects> {
    const id = ++this.#scopes
    this.trace.push(`${id}:acquire`)
    await this.#options.acquire?.(id)
    return new SelectedTreeScope(this, id)
  }
}

class SelectedTreeScope implements AutomationWorkspaceEffects {
  #tree: SelectedTree
  #id: number
  #closed = false
  constructor(tree: SelectedTree, id: number) {
    this.#tree = tree
    this.#id = id
    Object.freeze(this)
  }
  async #enter(name: string, reference: string): Promise<void> {
    if (this.#closed) throw new Error('reader used after close')
    await this.#tree.enter(name, reference, this.#id)
  }
  async exists(reference: string): Promise<boolean> {
    await this.#enter('exists', reference)
    return this.#tree.read(reference) !== undefined
  }
  async inspect(
    reference: string,
    followLinks: boolean,
  ): Promise<AutomationWorkspaceFileFacts | undefined> {
    await this.#enter(followLinks ? 'stat' : 'lstat', reference)
    const item = this.#tree.read(reference)
    return item === undefined
      ? undefined
      : Object.freeze({ kind: item.kind, mode: item.mode, nlink: 1, size: item.bytes.length })
  }
  async listNames(reference: string): Promise<readonly string[]> {
    await this.#enter('listNames', reference)
    return Object.freeze(this.#tree.names(reference))
  }
  async listEntries(reference: string): Promise<readonly AutomationWorkspaceDirectoryEntry[]> {
    await this.#enter('listEntries', reference)
    return Object.freeze(
      this.#tree
        .names(reference)
        .map((name) =>
          Object.freeze({ name, kind: this.#tree.read(this.#tree.resolve(reference, name))!.kind }),
        ),
    )
  }
  async readBytes(reference: string): Promise<Uint8Array> {
    await this.#enter('readBytes', reference)
    return new Uint8Array(this.#tree.read(reference)!.bytes)
  }
  async readText(reference: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(reference))
  }
  async readLink(reference: string): Promise<string> {
    await this.#enter('readLink', reference)
    throw new Error('fixture has no links')
  }
  async createDirectory(reference: string, recursive: boolean): Promise<void> {
    await this.#enter('createDirectory', reference)
    if (!recursive && !this.#tree.read(this.#tree.parent(reference)))
      throw new Error('parent missing')
    this.#tree.directory(reference)
  }
  async copyFile(source: string, target: string, exclusive: boolean): Promise<void> {
    await this.#enter('copyFile', target)
    if (exclusive && this.#tree.read(target)) throw new Error('target exists')
    const item = this.#tree.read(source)!
    this.#tree.write(target, { ...item, bytes: new Uint8Array(item.bytes) })
  }
  async setMode(reference: string, mode: number): Promise<void> {
    await this.#enter('setMode', reference)
    this.#tree.write(reference, { ...this.#tree.read(reference)!, mode })
  }
  async writeText(reference: string, text: string): Promise<void> {
    await this.#enter('writeText', reference)
    this.#tree.file(reference, text)
  }
  async close(): Promise<void> {
    this.#closed = true
    await this.#tree.release(this.#id)
  }
}

const nativeRoots: string[] = []
afterEach(() => {
  for (const root of nativeRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-370 complete DA content lifetimes', () => {
  test('serial snapshots retain original digests with immutable names and later fresh reads', async () => {
    const tree = new SelectedTree()
    tree.file('logical:workspace/z.txt', 'last')
    tree.file('logical:workspace/a.txt', 'first')
    tree.file('logical:workspace/.git/HEAD', 'head')
    const protectedSnapshot = await snapshotProtectedRoots(
      { metadata: 'logical:workspace/.git' },
      {},
      tree,
    )
    expect([...protectedSnapshot.entries.get('metadata')!]).toEqual([['HEAD', sha256Hex('head')]])
    expect(protectedSnapshot.digest).toBe(protectedRootSnapshotDigest(protectedSnapshot.entries))
    const first = await businessTreeSnapshot('logical:workspace', tree)
    expect([...first]).toEqual([
      ['a.txt', `f:r:${sha256Hex('first')}`],
      ['z.txt', `f:r:${sha256Hex('last')}`],
    ])
    expect(businessTreeSnapshotDigest(first)).toBe(sha256Hex(JSON.stringify([...first])))
    expect(tree.trace.indexOf('2:readBytes:logical:workspace/a.txt')).toBeLessThan(
      tree.trace.indexOf('2:readBytes:logical:workspace/z.txt'),
    )
    tree.file('logical:workspace/a.txt', 'new')
    expect((await businessTreeSnapshot('logical:workspace', tree)).get('a.txt')).toBe(
      `f:r:${sha256Hex('new')}`,
    )
    expect(first.get('a.txt')).toBe(`f:r:${sha256Hex('first')}`)
    expect(tree.trace.filter((entry) => entry.endsWith(':closed'))).toHaveLength(3)
  })

  test('capture waits for acquisition and complete close; validation awaits its own scope', async () => {
    const acquired = gate(),
      entered = gate(),
      closing = gate(),
      closed = gate()
    const validationEntered = gate(),
      validationClose = gate()
    const tree = new SelectedTree({
      async acquire(id) {
        if (id === 1) {
          entered.release()
          await acquired.promise
        }
      },
      async close(id) {
        if (id === 1) {
          closing.release()
          await closed.promise
        } else {
          validationEntered.release()
          await validationClose.promise
        }
      },
    })
    tree.file('logical:workspace/app.ts', 'v1')
    const adapter = createWorkspaceValidationAdapter(tree)
    let captured = false
    const capturing = Promise.resolve(adapter.capturePreState('logical:workspace')).then(
      (value) => {
        captured = true
        return value
      },
    )
    await entered.promise
    expect(tree.trace).toEqual(['1:acquire'])
    acquired.release()
    await closing.promise
    expect(captured).toBe(false)
    closed.release()
    const preStateJson = await capturing
    expect(JSON.parse(preStateJson).business).toEqual([['app.ts', `f:r:${sha256Hex('v1')}`]])
    tree.file('logical:workspace/app.ts', 'v2')
    let validated = false
    const checking = Promise.resolve(
      adapter.validate({
        workspacePath: 'logical:workspace',
        preStateJson,
        outcome: 'changed',
        workspaceMode: 'edit-business-files',
        writablePrefixes: [],
        preservePaths: [],
        editablePaths: [],
        budget: { maxChangedFiles: 20, maxTotalBytes: 1000 },
      }),
    ).then((value) => {
      validated = true
      return value
    })
    await validationEntered.promise
    expect(validated).toBe(false)
    validationClose.release()
    expect(await checking).toEqual({ ok: true, kind: 'changed', changedPaths: ['app.ts'] })
    const protectedIndex = tree.trace.indexOf('1:stat:logical:workspace/.agent-workflow')
    const businessIndex = tree.trace.indexOf('1:lstat:logical:workspace')
    expect(protectedIndex).toBeLessThan(businessIndex)
  })

  test('selected failures retain values and aggregate body before close without fallback', async () => {
    for (const value of [undefined, null, 42, new Error('selected-body')]) {
      let released = 0
      const tree = new SelectedTree({
        operation() {
          throw value
        },
        close() {
          released += 1
        },
      })
      expect(await rejected(businessTreeSnapshot('logical:missing', tree))).toBe(value)
      expect(released).toBe(1)
    }
    const body = new Error('body'),
      close = new Error('close')
    const both = new SelectedTree({
      operation() {
        throw body
      },
      close() {
        throw close
      },
    })
    const result = await rejected(businessTreeSnapshot('logical:missing', both))
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toEqual([body, close])
    const closeOnly = new SelectedTree({
      close() {
        throw close
      },
    })
    expect(await rejected(businessTreeSnapshot('logical:missing', closeOnly))).toBe(close)
  })

  test('invalid complete objects never select native; a usable invalid-scope close is awaited', async () => {
    expect(() =>
      selectedAutomationWorkspaceEffects(null as unknown as AutomationWorkspaceEffectsFactory),
    ).toThrow('factory-incomplete')
    expect(() =>
      selectedAutomationWorkspaceEffects({
        acquire() {},
      } as unknown as AutomationWorkspaceEffectsFactory),
    ).toThrow('factory-incomplete')
    const closing = gate(),
      release = gate()
    const incomplete = Object.freeze({
      resolve(reference: string) {
        return reference
      },
      parent(reference: string) {
        return reference
      },
      acquire() {
        return {
          async close() {
            closing.release()
            await release.promise
          },
        }
      },
    }) as unknown as AutomationWorkspaceEffectsFactory
    let settled = false
    const reading = rejected(businessTreeSnapshot('logical:missing', incomplete)).then((error) => {
      settled = true
      return error
    })
    await closing.promise
    expect(settled).toBe(false)
    release.release()
    expect(((await reading) as Error).message).toBe('automation-workspace-effects-scope-incomplete')
    const failed = new SelectedTree({
      acquire() {
        throw undefined
      },
    })
    expect(await rejected(businessTreeSnapshot('logical:missing', failed))).toBeUndefined()
    expect(failed.trace).toEqual(['1:acquire'])
  })

  test('the native adapter retains binary copies, plain directory operations and text ACKs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc370-da-native-'))
    nativeRoots.push(root)
    const factory = createFileAutomationWorkspaceEffectsFactory()
    const source = factory.resolve(root, 'source'),
      target = factory.resolve(root, 'target')
    await withAutomationWorkspaceEffects(factory, async (scope) => {
      await scope.createDirectory(source, false)
      await scope.createDirectory(target, false)
      await scope.writeText(factory.resolve(source, 'input.txt'), 'bytes\u0000text')
      await scope.copyFile(
        factory.resolve(source, 'input.txt'),
        factory.resolve(target, 'input.txt'),
        true,
      )
      expect(Array.from(await scope.readBytes(factory.resolve(target, 'input.txt')))).toEqual(
        Array.from(new TextEncoder().encode('bytes\u0000text')),
      )
      expect(await scope.readText(factory.resolve(target, 'input.txt'))).toBe('bytes\u0000text')
      expect((await scope.listEntries(target)).map((entry) => [entry.name, entry.kind])).toEqual([
        ['input.txt', 'file'],
      ])
      expect(await scope.inspect(factory.resolve(target, 'missing'), false)).toBeUndefined()
      expect(await scope.exists(factory.resolve(target, 'input.txt'))).toBe(true)
    })
    expect((await businessTreeSnapshot(target, factory)).get('input.txt')).toBe(
      `f:r:${sha256Hex('bytes\u0000text')}`,
    )
  })
})

describeEachProvider('RFC-370 actual DA selected workspace ordering', (harness) => {
  test('a held capture close prevents context publication and actual Agent launch', async () => {
    const closing = gate(),
      release = gate()
    const tree = new SelectedTree({
      async close() {
        closing.release()
        await release.promise
      },
    })
    tree.file('logical:action-workspace/app.ts', 'baseline')
    const fixture = await buildPr3Fixture({ db: harness.db })
    const launches: string[] = [],
      contexts: string[] = []
    const deps = fixture.deps({
      repositoryFacts: {
        async collect() {
          return {
            cells: structuredClone(PR3_JAVA_CELLS) as never,
            factsRef: 'workspace-effects-facts',
          }
        },
      },
      ...fakeAgentActionPorts({
        db: harness.db,
        launches,
        overrides: {
          workspaceValidation: createWorkspaceValidationAdapter(tree),
          actionWorkspace: {
            async materialize() {
              return {
                workspacePath: 'logical:action-workspace',
                businessTreeDigest: 'b'.repeat(64),
              }
            },
            adopt() {
              return {
                workspacePath: 'logical:action-workspace',
                businessTreeDigest: 'b'.repeat(64),
              }
            },
            discard() {},
          },
          attemptContext: {
            async save(json) {
              contexts.push(json)
              return 'selected-context'
            },
            load() {
              return contexts[0] ?? null
            },
          },
        },
      }),
    })
    const missionId = await fixture.launchDirect('selected-workspace-close')
    expect(
      (
        await fixture.materializer.stashDirectSubmission({
          missionId,
          submission: { title: 'Add feature', body: 'do the thing', uploads: [] },
        })
      ).ok,
    ).toBe(true)
    await runMissionReconcile(deps, missionId)
    await runMissionReconcile(deps, missionId)
    const launching = runMissionReconcile(deps, missionId)
    try {
      await closing.promise
      expect(launches).toEqual([])
      expect(contexts).toEqual([])
    } finally {
      release.release()
    }
    const launched = await launching
    expect(launched.kind === 'decided' && launched.handled).toBe('action-launched')
    expect(launches).toHaveLength(1)
    expect(contexts).toHaveLength(1)
    const frozen = JSON.parse(contexts[0]!)
    expect(typeof frozen.preStateJson).toBe('string')
    expect(JSON.parse(frozen.preStateJson).business).toEqual([
      ['app.ts', `f:r:${sha256Hex('baseline')}`],
    ])
  }, 20_000)

  for (const closeFailure of [false, true]) {
    test(`initial content close ${closeFailure ? 'failure preserves no row' : 'ACK precedes Case persistence and checkpoint'}`, async () => {
      const closing = gate(),
        release = gate(),
        failure = new Error('selected-initial-close')
      const tree = new SelectedTree({
        async close(id) {
          if (id === 1) {
            closing.release()
            await release.promise
            if (closeFailure) throw failure
          }
        },
      })
      const db = harness.db,
        baselineSha = 'a'.repeat(40)
      await db.insert(cachedRepos).values({
        id: 'selected-repo',
        urlHash: 'selected',
        urlEnc: null,
        urlRedacted: 'logical:repo',
        localPath: 'logical:repo',
        defaultBranch: 'main',
        lastFetchedAt: 1,
        createdAt: 1,
      })
      await db.insert(employeeCases).values({
        id: 'selected-case',
        employeeId: 'employee',
        employeeRevision: 1,
        typeId: 'development',
        typeRevision: 1,
        primaryContextId: 'issue',
        executionPolicyRevision: 1,
        state: 'active',
        terminalKind: null,
        blockReason: null,
        currentWorkItemRef: 'analyze-implement',
        activeRoundId: 'selected-round',
        revision: 1,
        writerGeneration: 1,
        createdAt: 1,
        updatedAt: 1,
        terminalAt: null,
      })
      const plan = {
        roundRef: 'selected-round',
        caseRef: { id: 'selected-case' },
        workItemRef: 'analyze-implement',
        workspacePolicy: {
          mode: 'write',
          businessChangeOnOk: 'required',
          writablePrefixes: [],
          platformWritePrefixes: [],
        },
        inputEnvelopeJson: JSON.stringify({
          contextsJson: JSON.stringify([
            {
              typeId: 'development.issue-handling',
              stateJson: JSON.stringify({
                repositoryRef: 'selected-repo',
                request: {
                  body: 'selected request',
                  externalId: null,
                  workingBranch: null,
                  uploads: [
                    {
                      artifactRef: 'employee-input:' + 'b'.repeat(64),
                      placement: 'repository',
                      targetPath: 'uploaded.txt',
                      originalName: 'input.txt',
                    },
                  ],
                },
                materialArtifactRefs: [],
              }),
            },
          ]),
        }),
      }
      await db.insert(employeeReactionRounds).values({
        id: 'selected-round',
        caseId: 'selected-case',
        caseRevision: 1,
        inboxId: null,
        employeeId: 'employee',
        employeeRevision: 1,
        ruleId: 'selected-workspace',
        workItemRef: 'analyze-implement',
        workContractId: 'development.analyze-implement',
        workContractVersion: 1,
        toolId: null,
        toolRevision: null,
        executionPolicyRevision: 1,
        inputContextRefsJson: '[]',
        planJson: JSON.stringify(plan),
        state: 'running',
        executionRef: 'selected-task',
        outputJson: null,
        attemptOrdinal: 0,
        createdAt: 2,
        updatedAt: 2,
        settledAt: null,
      })
      let checkpoints = 0
      const participant = composeDevelopmentEmployeeWorkspace({
        db,
        appHome: 'logical:home',
        automationWorkspaceEffects: tree,
        reactionRounds: createEmployeeReactionRoundQueries(db),
        inputArtifacts: {
          async copyBlobTo(_ref, target) {
            tree.file(target, 'uploaded')
          },
        },
        repositoryPreparation: {
          async prepare() {
            return { id: 'selected-repo', localPath: 'logical:repo', defaultBranch: 'main' }
          },
        },
        sourceControl: {
          async resolveBaseline() {
            return { baselineSha, targetBranch: 'main', remoteHeadSha: null }
          },
          async materialize({ caseRoot }) {
            const path = tree.resolve(caseRoot, 'workspace')
            tree.directory(path)
            tree.file(tree.resolve(path, 'README.md'), 'baseline')
            return { workspacePath: path }
          },
          checkpoint() {
            checkpoints += 1
            expect(tree.trace).toContain('1:closed')
            return { checkpointDigest: 'c'.repeat(64) }
          },
          async restore() {
            throw new Error('fixture never restores')
          },
        },
        conflictMerge: {
          async prepare() {
            throw new Error('fixture has no conflict')
          },
          async inspect() {
            throw new Error('fixture has no conflict')
          },
        },
      })
      const preparing = participant.prepare({
        planJson: JSON.stringify(plan),
        attemptJson: JSON.stringify({ ordinal: 0, mode: 'initial' }),
      })
      // Attach the failure handler immediately while the selected close is held.
      const outcome = preparing.then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error }),
      )
      try {
        await closing.promise
        expect(await db.select().from(employeeCaseWorkspaces)).toEqual([])
        expect(checkpoints).toBe(0)
        expect(
          tree.read(
            'logical:home/workspaces/employee-cases/selected-case/scene/workspace/uploaded.txt',
          )?.bytes,
        ).toEqual(new TextEncoder().encode('uploaded'))
      } finally {
        release.release()
      }
      const result = await outcome
      if (closeFailure) {
        expect(result.error).toBe(failure)
        expect(await db.select().from(employeeCaseWorkspaces)).toEqual([])
        expect(checkpoints).toBe(0)
      } else {
        expect(result.error).toBeUndefined()
        expect(result.value?.kind).toBe('repository')
        expect(await db.select().from(employeeCaseWorkspaces)).toHaveLength(1)
        expect(checkpoints).toBe(1)
        const request = tree.read(
          'logical:home/workspaces/employee-cases/selected-case/scene/workspace/.agent-workflow/inputs/requirements/selected-case/request.json',
        )!
        expect(JSON.parse(new TextDecoder().decode(request.bytes)).body).toBe('selected request')
      }
    }, 20_000)
  }
})
