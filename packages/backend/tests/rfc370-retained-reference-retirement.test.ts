import { rowToDistillJob, runDistill } from '@/modules/memory/application/distill/memoryDistiller'
import { composeSystemAgentRunFamily } from '@/modules/task-execution/composition/systemAgentRunFamily'
import type { SystemAgentRunFamily } from '@/modules/task-execution/public/participants'
import { createSqliteMemoryDistillTestContext } from './helpers/memoryDistill'
import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import { intentSessions, intentTurns, users, memoryDistillJobs } from '@/db/schema'
import { runIntentTurn } from '@/modules/intent/application/turnEngine'
import type { IntentSystemAgentRunFamily } from '@/modules/intent/application/ports/intentSystemAgent'
import { createFileIntentScratchStore } from '@/modules/intent/infrastructure/local/fileIntentScratchStore'
import { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'
import { createLocalSystemAgentRetainedContents } from '@/modules/runtime-management/composition/systemAgentMaterial'
import { emptySystemAgentOutputEvidence } from '@/services/systemAgentRun'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createIntentSessionForTest,
  intentDumpAuxiliaryForTest,
  intentGraphValidationForTest,
  intentPersistenceForTest,
  intentResourceCatalogBinding,
} from './helpers/intentResourceCatalogBinding'

const homes = new Set<string>()
function home() {
  const root = mkdtempSync(join(tmpdir(), 'aw-retained-retirement-'))
  homes.add(root)
  return root
}
afterEach(() => {
  for (const root of homes) rmSync(root, { recursive: true, force: true })
  homes.clear()
})

test('forget retires exactly one reference and preserves physical diagnostics and its sibling', async () => {
  const root = home()
  const owner = createLocalSystemAgentRetainedContents({ appHome: () => root })
  const scope = owner.workspaces.capture({
    namespace: 'intent',
    name: 'same-root',
  })
  const first = owner.open({
    scope,
    feature: () => 'intent-builder',
    seedFiles: () => [],
  })
  const second = owner.open({
    scope,
    feature: () => 'intent-builder',
    seedFiles: () => [],
  })
  mkdirSync(first.locations.root, { recursive: true })
  const diagnostic = join(first.locations.root, 'diagnostic.txt')
  writeFileSync(diagnostic, 'original failed turn')
  const mtime = statSync(first.locations.root).mtimeMs
  expect(first.locations.root).toBe(second.locations.root)
  expect(first.workspace.retainedRef).not.toBe(second.workspace.retainedRef)

  owner.contents.forget({ retainedRef: first.workspace.retainedRef })
  owner.contents.forget({ retainedRef: first.workspace.retainedRef })
  expect(readFileSync(diagnostic, 'utf8')).toBe('original failed turn')
  expect(statSync(first.locations.root).mtimeMs).toBe(mtime)
  expect(
    await owner.contents.release({
      retainedRef: first.workspace.retainedRef,
      scope,
    }),
  ).toEqual({
    removed: false,
    reason: 'unsafe-path',
  })
  expect(
    await owner.contents.release({
      retainedRef: second.workspace.retainedRef,
      scope,
    }),
  ).toEqual({
    removed: true,
  })
  expect(existsSync(first.locations.root)).toBe(false)
  owner.contents.forget({ retainedRef: second.workspace.retainedRef })

  const fresh = owner.open({
    scope,
    feature: () => 'intent-builder',
    seedFiles: () => [],
  })
  mkdirSync(fresh.locations.root, { recursive: true })
  owner.contents.forget({ retainedRef: first.workspace.retainedRef })
  expect(
    await owner.contents.release({
      retainedRef: fresh.workspace.retainedRef,
      scope,
    }),
  ).toEqual({
    removed: true,
  })
})

describeEachProvider('RFC-370 terminal Intent retained-reference retirement', (harness) => {
  for (const mode of [
    'runtime-failure',
    'missing-envelope',
    'invalid-ports',
    'release-failure',
    'forget-failure',
    'diagnostic-failure',
  ] as const) {
    test(`${mode}: the real turn retires its original reference without removing diagnostics`, async () => {
      const root = home(),
        id = ulid(),
        now = Date.now()
      await harness.db.insert(users).values({
        id,
        username: 'retirement-' + id.toLowerCase(),
        displayName: 'Retirement',
        role: 'user',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      const actor: Actor = {
        user: {
          id,
          username: 'retirement',
          displayName: 'Retirement',
          role: 'user',
          status: 'active',
        },
        source: 'session',
        permissions: new Set(),
      }
      const { session } = await createIntentSessionForTest(
        harness.db,
        actor,
        { message: 'Choose a workflow' },
        root,
      )
      const native = composeLocalSystemAgentRunFamily({
        appHome: () => root,
      })
      let directory = '',
        mtime = 0,
        returned = false
      const selected = native.withFixture(async (request) => {
        if (typeof request.scratchName !== 'string')
          throw new Error('missing Intent workspace name')
        directory = join(root, 'intent-scratch', request.scratchName)
        mkdirSync(directory, { recursive: true })
        writeFileSync(join(directory, 'diagnostic.txt'), 'keep original diagnostics')
        mtime = statSync(directory).mtimeMs
        const nonce = /nonce="([^"]+)"/.exec(request.prompt)?.[1]
        expect(nonce).toBeString()
        const ports =
          mode === 'release-failure'
            ? '<port name="questions">[{"id":"q1","question":"Which workflow?","options":["Build","Audit"],"multiSelect":false}]</port>'
            : '<port name="summary">Missing required result ports</port>'
        return {
          status:
            mode === 'release-failure' || mode === 'missing-envelope' || mode === 'invalid-ports'
              ? 'ok'
              : 'exit-nonzero',
          exitCode:
            mode === 'release-failure' || mode === 'missing-envelope' || mode === 'invalid-ports'
              ? 0
              : 2,
          eventText:
            mode === 'missing-envelope'
              ? ''
              : `<workflow-output nonce="${nonce}">${ports}</workflow-output>`,
          stderrTail: 'original diagnostic',
          durationMs: 1,
          scratchDir: directory,
          scratchRetained: true,
          outputEvidence: emptySystemAgentOutputEvidence(),
        }
      })
      const nativeContents = selected.family.retainedContents
      const forgotten: string[] = []
      let reference = '',
        ownerReads = 0,
        methodReads = 0,
        releases = 0
      const exactForget = function (
        this: IntentSystemAgentRunFamily['retainedContents'],
        request: { readonly retainedRef: string },
      ) {
        expect(this).toBe(contents)
        expect(request.retainedRef).toBe(reference)
        forgotten.push(request.retainedRef)
        nativeContents.forget.call(nativeContents, request)
        if (mode === 'forget-failure' || mode === 'diagnostic-failure')
          throw new Error('forget diagnostic')
      }
      const contents: IntentSystemAgentRunFamily['retainedContents'] = {
        get forget() {
          methodReads++
          if (returned)
            return () => {
              throw new Error('replacement method was selected')
            }
          return exactForget
        },
        release(request) {
          expect(this).toBe(contents)
          expect(request.retainedRef).toBe(reference)
          releases++
          return { removed: false, reason: 'remove-failed' }
        },
      }
      const replacement: IntentSystemAgentRunFamily['retainedContents'] = {
        forget() {
          throw new Error('replacement owner was selected')
        },
        release() {
          throw new Error('replacement owner was selected')
        },
      }
      const family: IntentSystemAgentRunFamily = {
        workspaces: selected.family.workspaces,
        async run(request) {
          expect(this).toBe(family)
          const result = await selected.family.run.call(selected.family, request)
          reference = result.retainedRef
          returned = true
          return result
        },
        get retainedContents() {
          ownerReads++
          return returned && mode !== 'release-failure' ? replacement : contents
        },
      }
      const log = createLogger('retained-retirement')
      let warnings = 0
      if (mode === 'diagnostic-failure')
        log.warn = () => {
          warnings++
          throw new Error('retirement logger failed')
        }
      const runtime = selected.bindRuntime({
        binaryPath: 'selected-runtime',
      })
      const outcome = await runIntentTurn(
        {
          persistence: intentPersistenceForTest(harness.db),
          appHome: root,
          resourceCatalog: intentResourceCatalogBinding(harness.db, actor, root),
          dumpAuxiliary: intentDumpAuxiliaryForTest(harness.db),
          graphValidation: intentGraphValidationForTest(harness.db),
          systemAgents: family,
          log,
          config: {
            runtime: {
              name: 'selected',
              protocol: 'opencode',
              runtimeBinding: runtime.runtimeBinding,
              model: null,
              variant: null,
              temperature: null,
              steps: null,
              maxSteps: null,
              isSandbox: false,
              extraArgs: null,
              configDir: { env: 'OPENCODE_CONFIG_DIR', name: '.opencode' },
            },
            lang: null,
            timeoutMs: 30_000,
            stdoutCapBytes: 8 * 1024 * 1024,
            maxGenerateRounds: 50,
            maxQuestionRounds: 5,
            extraInstructions: null,
          },
        },
        { sessionId: session.id, actor },
      )
      expect(outcome.kind).toBe(mode === 'release-failure' ? 'questions' : 'error')
      if (mode !== 'release-failure')
        expect(outcome.errorCode).toBe(
          mode === 'missing-envelope'
            ? 'intent-envelope-missing'
            : mode === 'invalid-ports'
              ? 'intent-ports-exclusive'
              : 'intent-run-exit-nonzero',
        )
      expect(forgotten).toEqual([reference])
      expect(reference).toStartWith('aw-system-fixture:')
      expect(methodReads).toBe(1)
      expect(ownerReads).toBe(mode === 'release-failure' ? 2 : 1)
      expect(releases).toBe(mode === 'release-failure' ? 1 : 0)
      expect(warnings).toBe(mode === 'diagnostic-failure' ? 1 : 0)
      expect(readFileSync(join(directory, 'diagnostic.txt'), 'utf8')).toBe(
        'keep original diagnostics',
      )
      expect(statSync(directory).mtimeMs).toBe(mtime)
      const turn = (
        await harness.db.select().from(intentTurns).where(eq(intentTurns.id, outcome.turnId))
      )[0]
      expect(turn).toMatchObject({
        scratchRetained: true,
        captureState: 'complete',
      })
      const fresh = (
        await harness.db.select().from(intentSessions).where(eq(intentSessions.id, session.id))
      )[0]
      expect(fresh?.inFlightTurnId).toBeNull()
      expect(
        await nativeContents.release({
          retainedRef: reference,
          scope: selected.family.workspaces.capture({
            namespace: 'intent',
            name: outcome.turnId,
          }),
        }),
      ).toEqual({ removed: false, reason: 'unsafe-path' })
      expect(existsSync(directory)).toBe(true)
      const scratch = createFileIntentScratchStore({
        appHome: root,
        directoryName: 'intent-scratch',
      })
      expect(await scratch.staleTurnIds(mtime + 1)).toContain(outcome.turnId)
      await scratch.remove(outcome.turnId)
      expect(existsSync(directory)).toBe(false)
    }, 30_000)
  }

  test('owner and forget getters cannot consume either slot before the original run finally', async () => {
    const root = home(),
      id = ulid(),
      now = Date.now()
    await harness.db.insert(users).values({
      id,
      username: 'retirement-slots-' + id.toLowerCase(),
      displayName: 'Retirement slots',
      role: 'user',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    const actor: Actor = {
      user: {
        id,
        username: 'retirement-slots',
        displayName: 'Retirement slots',
        role: 'user',
        status: 'active',
      },
      source: 'session',
      permissions: new Set(),
    }
    const native = composeLocalSystemAgentRunFamily({ appHome: () => root })
    let runs = 0
    const selected = native.withFixture(async (request) => {
      runs++
      if (typeof request.scratchName !== 'string') throw new Error('missing Intent workspace name')
      const directory = join(root, 'intent-scratch', request.scratchName)
      mkdirSync(directory, { recursive: true })
      const nonce = /nonce="([^"]+)"/.exec(request.prompt)?.[1]
      return {
        status: 'ok',
        exitCode: 0,
        eventText: `<workflow-output nonce="${nonce}"><port name="questions">[{"id":"q1","question":"Which workflow?","options":["Build","Audit"],"multiSelect":false}]</port></workflow-output>`,
        stderrTail: '',
        durationMs: 1,
        scratchDir: directory,
        scratchRetained: true,
        outputEvidence: emptySystemAgentOutputEvidence(),
      }
    })
    const runtime = selected.bindRuntime({ binaryPath: 'selected-runtime' })
    const failure = new Error('original retained owner getter failure')
    for (const mode of ['owner-getter', 'method-getter', 'healthy'] as const) {
      const { session } = await createIntentSessionForTest(
        harness.db,
        actor,
        { message: 'Choose a workflow' },
        root,
      )
      const systemAgents: IntentSystemAgentRunFamily =
        mode === 'healthy'
          ? selected.family
          : {
              workspaces: selected.family.workspaces,
              run(request) {
                return selected.family.run.call(selected.family, request)
              },
              get retainedContents() {
                if (mode === 'owner-getter') throw failure
                return {
                  get forget(): IntentSystemAgentRunFamily['retainedContents']['forget'] {
                    throw failure
                  },
                  release(
                    input: Parameters<IntentSystemAgentRunFamily['retainedContents']['release']>[0],
                  ) {
                    return selected.family.retainedContents.release(input)
                  },
                }
              },
            }
      const outcome = await runIntentTurn(
        {
          persistence: intentPersistenceForTest(harness.db),
          appHome: root,
          resourceCatalog: intentResourceCatalogBinding(harness.db, actor, root),
          dumpAuxiliary: intentDumpAuxiliaryForTest(harness.db),
          graphValidation: intentGraphValidationForTest(harness.db),
          systemAgents,
          config: {
            runtime: {
              name: 'selected',
              protocol: 'opencode',
              runtimeBinding: runtime.runtimeBinding,
              model: null,
              variant: null,
              temperature: null,
              steps: null,
              maxSteps: null,
              isSandbox: false,
              extraArgs: null,
              configDir: { env: 'OPENCODE_CONFIG_DIR', name: '.opencode' },
            },
            lang: null,
            timeoutMs: 30_000,
            stdoutCapBytes: 8 * 1024 * 1024,
            maxGenerateRounds: 50,
            maxQuestionRounds: 5,
            extraInstructions: null,
          },
        },
        { sessionId: session.id, actor },
      )
      expect(outcome.kind).toBe(mode === 'healthy' ? 'questions' : 'error')
      if (mode !== 'healthy') expect(outcome.errorCode).toBe('intent-turn-crashed')
      const turn = (
        await harness.db.select().from(intentTurns).where(eq(intentTurns.id, outcome.turnId))
      )[0]
      if (mode !== 'healthy')
        expect(JSON.parse(turn?.contentJson ?? '{}').detail).toBe(failure.message)
      const fresh = (
        await harness.db.select().from(intentSessions).where(eq(intentSessions.id, session.id))
      )[0]
      expect(fresh?.inFlightTurnId).toBeNull()
      expect(runs).toBe(mode === 'healthy' ? 1 : 0)
    }
  }, 30_000)
})

describeEachProvider('RFC-370 Memory retained references across a terminal chain', (harness) => {
  for (const mode of [
    'unreaped',
    'spawn-failed',
    'release-failure',
    'forget-failure',
    'success',
  ] as const) {
    test(`${mode}: retire every round after the original release policy without replacing the outcome`, async () => {
      const root = home(),
        id = ulid(),
        now = Date.now()
      await harness.db.insert(memoryDistillJobs).values({
        id,
        debounceKey: 'retirement-' + id,
        sourceKind: 'feedback',
        sourceEventId: 'source-' + id,
        taskId: null,
        scopeResolvedJson: JSON.stringify({
          agentIds: [],
          workflowId: null,
          repoId: null,
          includeGlobal: true,
        }),
        status: 'running',
        attempts: 0,
        nextRunAt: now,
        createdAt: now,
      })
      const row = (
        await harness.db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, id))
      )[0]
      if (row === undefined) throw new Error('missing real distill job')
      const job = rowToDistillJob(row),
        context = createSqliteMemoryDistillTestContext(harness.db, root)
      const nonce = 'retirement-memory-nonce',
        releaseFailure = new Error('original release failure')
      let directory = '',
        mtime = 0,
        round = 0
      const binding = composeLocalSystemAgentRunFamily({ appHome: () => root })
      const native = binding.withFixture(async (request) => {
        round += 1
        directory = join(request.scratchParent, request.scratchName ?? 'missing')
        if (round === 1) {
          mkdirSync(directory, { recursive: true })
          writeFileSync(join(directory, 'diagnostic.txt'), 'original whole chain')
          mtime = statSync(directory).mtimeMs
        }
        const status =
          round === 1 || mode === 'success' || mode === 'release-failure'
            ? 'ok'
            : mode === 'unreaped'
              ? 'unreaped'
              : 'spawn-failed'
        return {
          status,
          exitCode: status === 'ok' ? 0 : null,
          eventText:
            round === 1
              ? 'follow up without an envelope'
              : `<workflow-output nonce="${nonce}"><port name="candidates">{"candidates":[]}</port></workflow-output>`,
          stderrTail: 'original cleanup failure',
          durationMs: 1,
          scratchDir: directory,
          scratchRetained: true,
          capturedSessionId: 'retained-memory-conversation',
          outputEvidence: emptySystemAgentOutputEvidence(),
        }
      })
      const references: string[] = [],
        forgotten: string[] = [],
        releases: string[] = []
      let selectedScope:
        | Parameters<typeof native.family.retainedContents.release>[0]['scope']
        | undefined
      const retainedContents: SystemAgentRunFamily['retainedContents'] = {
        release(request) {
          expect(this).toBe(retainedContents)
          releases.push(request.retainedRef)
          if (mode === 'release-failure') throw releaseFailure
          return native.family.retainedContents.release(request)
        },
        forget(request) {
          expect(this).toBe(retainedContents)
          expect(references).toHaveLength(2)
          forgotten.push(request.retainedRef)
          native.family.retainedContents.forget(request)
          if (mode === 'forget-failure') throw new Error('retirement diagnostic failure')
        },
      }
      const family: SystemAgentRunFamily = {
        workspaces: native.family.workspaces,
        retainedContents,
        async run(request) {
          selectedScope ??= request.workspaceScope
          expect(request.workspaceScope).toBe(selectedScope)
          if (references.length === 1)
            expect(request.resumeSessionId).toBe('retained-memory-conversation')
          const result = await native.family.run(request)
          references.push(result.retainedRef)
          retainedContents.forget = () => {
            throw new Error('replacement retirement must never run')
          }
          return result
        },
      }
      const outcome = await runDistill({
        store: context.store,
        nodeRunPrompts: context.nodeRunPrompts,
        reviewedArtifacts: context.reviewedArtifacts,
        job,
        siblings: [job],
        systemAgents: family,
        envelopeNonce: nonce,
        timeoutMs: 30_000,
      }).then(
        (value) => ({ kind: 'fulfilled' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      expect(references).toHaveLength(2)
      expect(new Set(references).size).toBe(2)
      expect(forgotten).toEqual(references)
      if (mode === 'success') {
        expect(outcome.kind).toBe('fulfilled')
        if (outcome.kind !== 'fulfilled') throw outcome.error
        expect(outcome.value).toEqual({ candidatesCreated: 0, createdMemoryIds: [] })
        expect(existsSync(directory)).toBe(false)
      } else {
        expect(outcome.kind).toBe('rejected')
        if (outcome.kind !== 'rejected') throw new Error('original chain failure was lost')
        if (mode === 'release-failure') expect(outcome.error).toBe(releaseFailure)
        else
          expect((outcome.error as Error).message).toMatch(
            mode === 'unreaped' ? /could not be reaped/ : /original cleanup failure/,
          )
        expect(readFileSync(join(directory, 'diagnostic.txt'), 'utf8')).toBe('original whole chain')
        expect(statSync(directory).mtimeMs).toBe(mtime)
      }
      expect(releases).toEqual(
        mode === 'success' || mode === 'release-failure' ? [references[1]!] : [],
      )
      if (selectedScope === undefined) throw new Error('missing actual chain scope')
      for (const retainedRef of references) {
        expect(
          await native.family.retainedContents.release({ retainedRef, scope: selectedScope }),
        ).toEqual({ removed: false, reason: 'unsafe-path' })
      }
    }, 30_000)
  }
})

test('a rejected invocation reads its reference once and retires that exact reference after the getter changes', async () => {
  for (const rawFailure of [undefined, new Error('original scratch discard failure')]) {
    for (const replacement of ['throw', 'different-ref'] as const) {
      const root = home(),
        owner = createLocalSystemAgentRetainedContents({ appHome: () => root })
      const scope = owner.workspaces.capture({
        namespace: 'shared',
        name: 'failed-opened-invocation',
      })
      const selected = owner.open({
        scope,
        feature: () => 'failed-opened-invocation',
        seedFiles: () => [],
      })
      const retainedRef = selected.workspace.retainedRef
      mkdirSync(selected.locations.root, { recursive: true })
      writeFileSync(join(selected.locations.root, 'diagnostic.txt'), 'original failed setup')
      const mtime = statSync(selected.locations.root).mtimeMs
      let prepared = false,
        referenceReads = 0
      const forgotten: string[] = []
      const retainedContents: SystemAgentRunFamily['retainedContents'] = {
        release: (request) => owner.contents.release(request),
        forget(request) {
          expect(this).toBe(retainedContents)
          forgotten.push(request.retainedRef)
          owner.contents.forget(request)
        },
      }
      const family = composeSystemAgentRunFamily({
        workspaces: owner.workspaces,
        retainedContents,
        invocations: {
          open() {
            return {
              workspace: {
                ...selected.workspace,
                get retainedRef() {
                  referenceReads += 1
                  if (prepared) {
                    if (replacement === 'throw')
                      throw new Error('reference getter changed after prepare')
                    return 'replacement-reference-must-not-be-retired'
                  }
                  return retainedRef
                },
                discard() {
                  throw rawFailure
                },
              },
              acknowledgeStart: () => true,
              async prepareWorkspace() {
                prepared = true
                retainedContents.forget = () => {
                  throw new Error('replacement retirement must never run')
                }
                throw new Error('original workspace setup failure')
              },
              async compile() {
                throw new Error('setup failure must not compile')
              },
            }
          },
        },
      })
      const outcome = await family
        .run({
          feature: 'failed-opened-invocation',
          agentName: 'persona',
          systemPrompt: 'system',
          prompt: 'prompt',
          protocol: 'opencode',
          workspaceScope: scope,
        })
        .then(
          () => ({ kind: 'fulfilled' as const }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
      expect(outcome.kind).toBe('rejected')
      if (outcome.kind !== 'rejected') throw new Error('original rejected invocation was swallowed')
      expect(outcome.error).toBe(rawFailure)
      expect(referenceReads).toBe(1)
      expect(forgotten).toEqual([retainedRef])
      expect(readFileSync(join(selected.locations.root, 'diagnostic.txt'), 'utf8')).toBe(
        'original failed setup',
      )
      expect(statSync(selected.locations.root).mtimeMs).toBe(mtime)
      expect(await owner.contents.release({ retainedRef, scope })).toEqual({
        removed: false,
        reason: 'unsafe-path',
      })
    }
  }
})
