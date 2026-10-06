// RFC-370: the same verification policy drives selected command/evidence owners.
// Opaque fixtures exercise real DA persistence; they are not CS acceptance.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { ulid } from 'ulid'
import { runVerificationProfileWithEffects } from '@/modules/development-automation/application/verificationRunner'
import type {
  VerificationCommandEffects,
  VerificationCommandEffectsFactory,
  VerificationProcessFacts,
  VerificationStep,
} from '@/modules/development-automation/application/ports/verificationCommandEffects'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import type { VerificationProfileContent } from '@/modules/development-automation/domain/verificationProfile'
import { composeDevelopmentAutomation } from '@/modules/development-automation/composition'
import {
  createLocalVerificationCommandEffects,
  createRepoScriptResolver as nativeResolver,
} from '@/modules/development-automation/infrastructure/local/verificationCommandEffects'
import { createRepoScriptResolver as compatibilityResolver } from '@/modules/development-automation/infrastructure/verificationRunner'
import { defaultAutomationPolicyContent } from '@/modules/development-automation/domain/automationPolicy'
import {
  canonicalDigest,
  canonicalStringify,
} from '@/modules/development-automation/domain/canonicalJson'
import {
  createVerificationProfile,
  publishVerificationProfile,
} from '@/modules/development-automation/application/commands/verificationProfileCommands'
import { createVerificationProfilePersistence } from '@/modules/development-automation/infrastructure/configResourceStore'
import type { FactCell } from '@/modules/development-automation/domain/factCell'
import type { FactCellValue } from '@/modules/development-automation/domain/facts'
import { createAutomationPolicy, publishAutomationPolicy } from './helpers/digitalEmployeeStore'
import { buildPr3Fixture, type ProviderPr3Fixture } from './helpers/rfc310Pr3Fixture'
import { describeEachProvider } from './helpers/eachProvider'

type KnownVerificationCell = Extract<FactCell<FactCellValue>, { readonly state: 'known' }>
const workspaceRef = 'owner:workspace:verification'
const artifact = {
  selector: 'file-glob:reports/*.json',
  path: 'reports/result.json',
  sha256: 'f'.repeat(64),
  bytes: 23,
}
function step(id: string, patch: Partial<VerificationStep> = {}): VerificationStep {
  return {
    stepId: id,
    programRef: 'owner:program:' + id,
    argsRef: 'owner:args:' + id,
    timeoutMs: 4567,
    networkProfileRef: 'existing-profile@1',
    successExitCodes: [0],
    evidenceSelectors: [],
    ...patch,
  }
}
function profile(
  steps: VerificationStep[],
  stopPolicy: VerificationProfileContent['stopPolicy'] = 'first-failure',
): VerificationProfileContent {
  return { schemaVersion: 1, steps, stopPolicy, maxParallel: 8 }
}
class OpaqueProgram {
  get argv(): never {
    throw new Error('common verification policy read native argv')
  }
  get path(): never {
    throw new Error('common verification policy read a native program path')
  }
  get pid(): never {
    throw new Error('common verification policy read a native process identity')
  }
}
class SelectedCommands implements VerificationCommandEffects {
  readonly #program = new OpaqueProgram()
  readonly #calls: string[]
  readonly #outcomes: ReadonlyMap<string, VerificationProcessFacts>
  constructor(
    calls: string[],
    outcomes: ReadonlyMap<string, VerificationProcessFacts> = new Map(),
  ) {
    this.#calls = calls
    this.#outcomes = outcomes
  }
  async resolveProgram(input: Parameters<VerificationCommandEffects['resolveProgram']>[0]) {
    this.#calls.push('resolve:' + input.programRef)
    expect(input.workspaceRef).toBe(workspaceRef)
    expect(input.argsRef).toBe('owner:args:' + input.programRef.split(':').at(-1))
    return input.programRef.endsWith(':missing') ? null : this.#program
  }
  async execute(input: Parameters<VerificationCommandEffects['execute']>[0]) {
    this.#calls.push('execute:' + input.step.stepId)
    expect(input.program).toBe(this.#program)
    expect(input.workspaceRef).toBe(workspaceRef)
    expect(input.step.timeoutMs).toBe(4567)
    expect(input.step.networkProfileRef).toBe('existing-profile@1')
    return (
      this.#outcomes.get(input.step.stepId) ?? {
        exitCode: 0,
        timedOut: false,
        outputTailRef: 'owner:stdout:' + input.step.stepId,
      }
    )
  }
  async collectFiles(input: Parameters<VerificationCommandEffects['collectFiles']>[0]) {
    this.#calls.push('collect:' + input.pattern)
    expect(input.workspaceRef).toBe(workspaceRef)
    return [{ ...artifact, selector: 'file-glob:' + input.pattern }]
  }
}

describe('RFC-370 selected verification command policy', () => {
  test('opaque owners retain receiver, serial order, all selectors and the original receipt projection', async () => {
    const calls: string[] = []
    const effects = new SelectedCommands(calls)
    const first = step('a', {
      evidenceSelectors: [
        { kind: 'stdout-tail', value: 1 },
        { kind: 'file-glob', value: 'reports/*.json' },
        { kind: 'file-glob', value: 'extra/*.txt' },
      ],
    })
    const receipt = await runVerificationProfileWithEffects(effects, {
      workspacePath: workspaceRef,
      profile: profile([first, step('b')]),
    })
    expect(calls).toEqual([
      'resolve:owner:program:a',
      'execute:a',
      'collect:reports/*.json',
      'collect:extra/*.txt',
      'resolve:owner:program:b',
      'execute:b',
    ])
    expect(receipt.ok).toBe(true)
    expect(receipt.steps[0]?.evidenceFiles).toEqual([
      artifact,
      { ...artifact, selector: 'file-glob:extra/*.txt' },
    ])
    expect(receipt.steps[0]?.durationMs).toBeGreaterThanOrEqual(0)
    const originalReceipt = [
      {
        stepId: 'a',
        ok: true,
        exitCode: 0,
        timedOut: false,
        outputTailRef: 'owner:stdout:a',
        evidenceFiles: [artifact, { ...artifact, selector: 'file-glob:extra/*.txt' }],
      },
      {
        stepId: 'b',
        ok: true,
        exitCode: 0,
        timedOut: false,
        outputTailRef: 'owner:stdout:b',
        evidenceFiles: [],
      },
    ]
    expect(receipt.receiptDigest).toBe(
      createHash('sha256').update(JSON.stringify(originalReceipt)).digest('hex'),
    )
  })

  test('resolution, execution and artifact ACKs all precede the next step and completion', async () => {
    const entered = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
    const release = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
    const events: string[] = []
    const program = new OpaqueProgram()
    const effects: VerificationCommandEffects = {
      async resolveProgram() {
        expect(this).toBe(effects)
        events.push('resolve')
        entered[0]!.resolve()
        await release[0]!.promise
        return program
      },
      async execute(input) {
        expect(this).toBe(effects)
        expect(input.program).toBe(program)
        events.push('execute')
        entered[1]!.resolve()
        await release[1]!.promise
        return { exitCode: 0, timedOut: false, outputTailRef: 'owner:tail' }
      },
      async collectFiles() {
        expect(this).toBe(effects)
        events.push('collect')
        entered[2]!.resolve()
        await release[2]!.promise
        return [artifact]
      },
    }
    let completed = false
    const running = runVerificationProfileWithEffects(effects, {
      workspacePath: workspaceRef,
      profile: profile([
        step('a', { evidenceSelectors: [{ kind: 'file-glob', value: 'reports/*.json' }] }),
      ]),
    }).finally(() => {
      completed = true
    })
    try {
      for (let i = 0; i < 3; i++) {
        await entered[i]!.promise
        expect(events).toEqual(['resolve', 'execute', 'collect'].slice(0, i + 1))
        expect(completed).toBe(false)
        release[i]!.resolve()
      }
      expect((await running).ok).toBe(true)
    } finally {
      for (const barrier of release) barrier.resolve()
      await running
    }
  })

  for (const stopPolicy of ['first-failure', 'collect-all'] as const) {
    for (const failure of ['missing', 'nonzero', 'timeout'] as const) {
      test(`${stopPolicy} preserves ${failure} verdict and step selection`, async () => {
        const calls: string[] = []
        const facts = {
          exitCode: failure === 'nonzero' ? 7 : 0,
          timedOut: failure === 'timeout',
          outputTailRef: 'ALL TESTS PASSED',
        }
        const effects = new SelectedCommands(calls, new Map([[failure, facts]]))
        const receipt = await runVerificationProfileWithEffects(effects, {
          workspacePath: workspaceRef,
          profile: profile([step(failure), step('next')], stopPolicy),
        })
        expect(receipt.ok).toBe(false)
        expect(receipt.steps.map((s) => s.stepId)).toEqual(
          stopPolicy === 'first-failure' ? [failure] : [failure, 'next'],
        )
        expect(receipt.steps[0]?.ok).toBe(false)
        if (failure === 'missing') {
          expect(receipt.steps[0]).toEqual({
            stepId: 'missing',
            ok: false,
            exitCode: null,
            timedOut: false,
            durationMs: 0,
            outputTailRef: null,
            evidenceFiles: [],
          })
          expect(calls).not.toContain('execute:missing')
        }
      })
    }
  }
  test('custom successExitCodes, empty profiles and duration-free digest retain existing semantics', async () => {
    const effects = new SelectedCommands(
      [],
      new Map([['tolerated', { exitCode: 7, timedOut: false, outputTailRef: null }]]),
    )
    const input = {
      workspacePath: workspaceRef,
      profile: profile([step('tolerated', { successExitCodes: [0, 7] })]),
    }
    const first = await runVerificationProfileWithEffects(effects, input)
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
    const second = await runVerificationProfileWithEffects(effects, input)
    expect(first.ok).toBe(true)
    expect(first.receiptDigest).toBe(second.receiptDigest)
    const empty = await runVerificationProfileWithEffects(effects, {
      workspacePath: workspaceRef,
      profile: profile([]),
    })
    expect(empty).toEqual({
      ok: true,
      stopPolicy: 'first-failure',
      steps: [],
      receiptDigest: createHash('sha256').update('[]').digest('hex'),
    })
  })
  for (const phase of ['resolveProgram', 'execute', 'collectFiles'] as const) {
    test(`${phase} rejection or missing member cannot invoke native fallback`, async () => {
      for (const missing of [false, true]) {
        const effects = new SelectedCommands([])
        const failure = new Error('selected ' + phase + ' unavailable')
        Object.defineProperty(effects, phase, {
          value: missing
            ? undefined
            : async () => {
                throw failure
              },
        })
        const running = runVerificationProfileWithEffects(effects, {
          workspacePath: workspaceRef,
          profile: profile([
            step('a', { evidenceSelectors: [{ kind: 'file-glob', value: 'reports/*.json' }] }),
          ]),
        })
        if (missing) await expect(running).rejects.toBeInstanceOf(TypeError)
        else await expect(running).rejects.toBe(failure)
      }
    })
  }
  test('native resolver alias and original receiver remain; argv is not eagerly interpreted', () => {
    expect(compatibilityResolver).toBe(nativeResolver)
    const calls: string[] = []
    const resolved = new OpaqueProgram()
    const resolver = {
      resolve(input: { programRef: string; argsRef: string | null; workspacePath: string }) {
        expect(this).toBe(resolver)
        expect(input).toEqual({
          programRef: 'owner:program:a',
          argsRef: 'owner:args:a',
          workspacePath: workspaceRef,
        })
        calls.push('resolve')
        return resolved
      },
    }
    const evidence = new Proxy({} as EvidenceArtifactPort, {
      get() {
        throw new Error('resolution must not read evidence')
      },
    })
    const effects = createLocalVerificationCommandEffects({ resolver, evidence })
    const program = effects.resolveProgram({
      programRef: 'owner:program:a',
      argsRef: 'owner:args:a',
      workspaceRef,
    })
    expect(program).not.toBe(resolved)
    expect(program).not.toBeNull()
    expect(calls).toEqual(['resolve'])
  })
})

const neverMatchRules = [
  {
    ruleId: 'never',
    when: [{ kind: 'boolean-is', fact: 'requirement.bundleComplete', value: false }],
    capabilityId: 'change.implement' as const,
  },
]
const treeOid = 't'.repeat(40)
type Cells = Record<string, FactCell<FactCellValue>>
function cell(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 'fixture' }
}
async function currentCells(fx: ProviderPr3Fixture, missionId: string): Promise<Cells> {
  const mission = await fx.store.getMission(missionId)
  if (mission?.requirementBundleRef === null || mission === null)
    throw new Error('missing mission snapshot')
  return { ...((await fx.snapshots.getCells(mission.requirementBundleRef)) ?? {}) }
}
async function seedVerificationMission(fx: ProviderPr3Fixture, mode: string) {
  const now = Date.now()
  const profileStore = createVerificationProfilePersistence(fx.db)
  const profileDeps = { store: profileStore, now: () => now }
  const profileRow = await createVerificationProfile(profileDeps, {
    actorUserId: 'admin',
    name: 'selected-verification-' + mode,
    draft: profile([
      step(mode === 'missing' ? 'missing' : 'a', {
        evidenceSelectors: [{ kind: 'file-glob', value: 'reports/*.json' }],
      }),
    ]),
  })
  await publishVerificationProfile(profileDeps, { id: profileRow.id, actorUserId: 'admin' })
  const profileRef = profileRow.id + '@1'
  const policyRow = await createAutomationPolicy(fx.db, {
    name: 'selected-verification-policy-' + mode,
    ownerUserId: 'admin',
    draft: {
      ...defaultAutomationPolicyContent(),
      actionPriority: { rules: neverMatchRules },
      verification: { requiredProfileRefs: [profileRef], stopPolicy: 'first-failure' },
    },
  })
  await publishAutomationPolicy(fx.db, { id: policyRow.id, publishedBy: 'admin' })
  const missionId = await fx.launchDirect('selected-verification-' + ulid())
  const mission = (await fx.store.getMission(missionId))!
  await fx.store.occUpdate(missionId, mission.revision, mission.epoch, {
    status: 'working',
    policyId: policyRow.id,
    policyRevision: 1,
  })
  const runId = 'run-' + missionId
  await fx.store.createActionRun({
    id: runId,
    missionId,
    missionRevision: 0,
    decisionId: 'decision-' + missionId,
    capabilityId: 'change.implement',
    capabilityContractVersion: 1,
    templateId: null,
    templateRevision: null,
    workSetDigest: null,
    inputFactDigest: 'e'.repeat(64),
    baselineRef: 'base-verification',
    writable: true,
    now,
  })
  await fx.store.settleActionRun({
    id: runId,
    status: 'settled',
    resultRef: 'f'.repeat(64),
    failureJson: null,
    now,
  })
  const preRef = await fx.evidence.contexts.save(
    JSON.stringify({
      baselineRepoPath: 'owner:baseline:verification',
      baselineSha: 'b'.repeat(40),
      workspacePath: 'owner:overlay:verification',
    }),
  )
  await fx.store.claimAttempt({
    id: 'attempt-' + missionId,
    actionRunId: runId,
    rerunSeq: 0,
    attemptSeq: 0,
    executionRef: null,
    baselineRef: 'base-verification',
    nonceDigest: 'n'.repeat(64),
    inputDigest: 'i'.repeat(64),
    preSnapshotRef: preRef,
    now,
  })
  await fx.store.settleAttempt({
    id: 'attempt-' + missionId,
    status: 'validated',
    rejectionJson: null,
    outcomeRef: 'f'.repeat(64),
    now,
  })
  const cells: Cells = {
    'requirement.bundleComplete': cell(true),
    'action.lastOutcome': cell('changed'),
    'action.lastCapability': cell('change.implement'),
    '__action.candidateState': cell('derived'),
    '__action.candidateTreeOid': cell(treeOid),
    '__action.candidateRef': cell('f'.repeat(64)),
    '__action.runId': cell(runId),
  }
  const before = (await fx.store.getMission(missionId))!
  const snapshotId = ulid()
  await fx.store.insertFactSnapshot({
    id: snapshotId,
    missionId,
    missionRevision: before.revision,
    capturedAt: new Date().toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(cells),
    refsJson: '{}',
    digest: canonicalDigest(cells),
    now,
  })
  await fx.store.occUpdate(missionId, before.revision, before.epoch, {
    requirementBundleRef: snapshotId,
  })
  return { missionId, profileRef, preRef }
}

describeEachProvider('RFC-370 real DA selected verification family', (harness) => {
  for (const mode of [
    'success',
    'nonzero',
    'timeout',
    'missing',
    'resolve-error',
    'execute-error',
    'collect-error',
    'factory-error',
  ] as const) {
    test(`${mode} traverses the real module action and awaits cleanup before durable verification facts`, async () => {
      const fx = await buildPr3Fixture({ db: harness.db, rules: neverMatchRules })
      const seeded = await seedVerificationMission(fx, mode)
      const appHome = mkdtempSync(join(tmpdir(), 'rfc370-verification-module-'))
      const events: string[] = []
      const failure = new Error('selected owner ' + mode)
      const cleanupEntered = Promise.withResolvers<void>()
      const cleanupRelease = Promise.withResolvers<void>()
      const outcomes = new Map([
        [
          'a',
          {
            exitCode: mode === 'nonzero' ? 7 : 0,
            timedOut: mode === 'timeout',
            outputTailRef: 'ALL TESTS PASSED',
          },
        ],
      ])
      class Commands extends SelectedCommands {
        readonly #mode = mode
        override async resolveProgram(
          input: Parameters<VerificationCommandEffects['resolveProgram']>[0],
        ) {
          if (this.#mode === 'resolve-error') {
            events.push('resolve-error')
            throw failure
          }
          return await super.resolveProgram(input)
        }
        override async execute(input: Parameters<VerificationCommandEffects['execute']>[0]) {
          if (this.#mode === 'execute-error') {
            events.push('execute-error')
            throw failure
          }
          return await super.execute(input)
        }
        override async collectFiles(
          input: Parameters<VerificationCommandEffects['collectFiles']>[0],
        ) {
          if (this.#mode === 'collect-error') {
            events.push('collect-error')
            throw failure
          }
          return await super.collectFiles(input)
        }
      }
      class Factory implements VerificationCommandEffectsFactory {
        readonly #evidence = fx.evidence
        readonly #mode = mode
        create(input: Parameters<VerificationCommandEffectsFactory['create']>[0]) {
          expect(input.evidence).toBe(this.#evidence)
          events.push('factory')
          if (this.#mode === 'factory-error') throw failure
          return new Commands(events, outcomes)
        }
      }
      const automation = composeDevelopmentAutomation({
        db: harness.db,
        appHome,
        evidenceArtifacts: fx.evidence,
        verificationCommands: new Factory(),
        candidateDelivery: {
          async stage(input) {
            expect(input).toMatchObject({
              baselineRepoPath: 'owner:baseline:verification',
              baselineSha: 'b'.repeat(40),
              overlayRoot: 'owner:overlay:verification',
            })
            events.push('stage')
            return {
              ok: true,
              ws: workspaceRef,
              treeOid,
              async cleanup() {
                events.push('cleanup-enter')
                cleanupEntered.resolve()
                await cleanupRelease.promise
                events.push('cleanup-done')
              },
            }
          },
          async commit() {
            throw new Error('verification must complete before publication')
          },
          async push() {
            throw new Error('verification must complete before push')
          },
        },
      })
      const running = automation.reconcile(seeded.missionId).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      try {
        await Promise.race([
          cleanupEntered.promise,
          running.then(() => {
            throw new Error('real verification did not reach selected cleanup')
          }),
        ])
        expect(
          (await currentCells(fx, seeded.missionId))['__delivery.verificationReceiptRef'],
        ).toBeUndefined()
        expect(events.at(-1)).toBe('cleanup-enter')
        cleanupRelease.resolve()
        const outcome = await running
        const cells = await currentCells(fx, seeded.missionId)
        expect(events.at(-1)).toBe('cleanup-done')
        if (mode.endsWith('-error')) {
          expect(outcome).toEqual({ ok: false, error: failure })
          expect(cells['__delivery.verificationReceiptRef']).toBeUndefined()
          expect(cells['verification.lastOutcome']).toBeUndefined()
        } else {
          const passed = mode === 'success'
          expect(outcome.ok).toBe(true)
          if (!outcome.ok) throw outcome.error
          expect(outcome.result).toMatchObject({
            kind: 'decided',
            selected: { kind: 'run-verification', profileRef: seeded.profileRef },
            handled: passed ? 'collected' : 'blocked',
          })
          expect(
            (cells['__delivery.verifiedTreeOid'] as KnownVerificationCell | undefined)?.value,
          ).toBe(treeOid)
          expect(
            (cells['__delivery.verifiedProfiles'] as KnownVerificationCell | undefined)?.value,
          ).toBe(JSON.stringify({ [seeded.profileRef]: passed ? 'passed' : 'failed' }))
          expect(
            (cells['verification.lastOutcome'] as KnownVerificationCell | undefined)?.value,
          ).toBe(passed ? 'passed' : 'failed')
          expect(
            (cells['verification.allRequiredPassed'] as KnownVerificationCell | undefined)?.value,
          ).toBe(passed)
          expect(
            (cells['verification.failedProfileRefs'] as KnownVerificationCell | undefined)?.value,
          ).toEqual(passed ? [] : [seeded.profileRef])
          const digest = createHash('sha256')
            .update(
              JSON.stringify([
                {
                  stepId: mode === 'missing' ? 'missing' : 'a',
                  ok: passed,
                  exitCode: mode === 'missing' ? null : mode === 'nonzero' ? 7 : 0,
                  timedOut: mode === 'timeout',
                  outputTailRef: mode === 'missing' ? null : 'ALL TESTS PASSED',
                  evidenceFiles: mode === 'missing' ? [] : [artifact],
                },
              ]),
            )
            .digest('hex')
          expect(cells['__delivery.verificationReceiptRef']).toEqual({
            state: 'known',
            value: digest,
            sourceRevision: digest,
          })
          const mission = (await fx.store.getMission(seeded.missionId))!
          expect(mission.blockCode).toBe(passed ? null : 'verification-failed:' + seeded.profileRef)
          if (!passed)
            expect(mission.blockDetail).toBe(
              mode === 'missing'
                ? 'missing(exit=none)'
                : mode === 'timeout'
                  ? 'a(exit=0,timeout)'
                  : 'a(exit=7)',
            )
        }
        const commands =
          mode === 'factory-error'
            ? []
            : mode === 'resolve-error'
              ? ['resolve-error']
              : mode === 'missing'
                ? ['resolve:owner:program:missing']
                : mode === 'execute-error'
                  ? ['resolve:owner:program:a', 'execute-error']
                  : mode === 'collect-error'
                    ? ['resolve:owner:program:a', 'execute:a', 'collect-error']
                    : ['resolve:owner:program:a', 'execute:a', 'collect:reports/*.json']
        expect(events).toEqual(['stage', 'factory', ...commands, 'cleanup-enter', 'cleanup-done'])
      } finally {
        cleanupRelease.resolve()
        await running
        rmSync(appHome, { recursive: true, force: true })
        rmSync(fx.stagingRoot, { recursive: true, force: true })
        const blob = fx.evidence.blobPath(seeded.preRef)
        const evidenceRoot = dirname(dirname(dirname(blob)))
        expect(evidenceRoot).toContain('rfc310-pr3-evidence-')
        rmSync(evidenceRoot, { recursive: true, force: true })
      }
    }, 120_000)
  }
})

const sourceRoot = resolve(import.meta.dir, '../src')
function readSource(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(resolve(sourceRoot, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
}
function descendants<T extends ts.Node>(
  node: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = []
  const visit = (current: ts.Node) => {
    if (predicate(current)) found.push(current)
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}
function bodyOf(source: ts.SourceFile, name: string) {
  const fn = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  )
  if (fn?.body === undefined) throw new Error('missing real verification root: ' + name)
  return fn.body
}
function propertiesOf(node: ts.Node, source: ts.SourceFile) {
  return descendants(node, ts.isPropertyAssignment).filter(
    (property) => property.name.getText(source) === 'verificationCommands',
  )
}
describe('RFC-370 verification command composition contract', () => {
  for (const [path, name, receiver] of [
    ['server.ts', 'composeFallbackDevelopmentAutomation', 'deps'],
    ['cli/postgresqlDaemonApplication.ts', 'composePostgresqlApplication', 'input'],
    ['cli/start.ts', 'composeSqliteProviderSession', 'input'],
  ] as const) {
    test(`${name} selects the complete native factory only for an absent override`, () => {
      const source = readSource(path)
      const calls = descendants(bodyOf(source, name), ts.isCallExpression).filter(
        (call) => call.expression.getText(source) === 'composeDevelopmentAutomation',
      )
      expect(calls).toHaveLength(1)
      const arg = calls[0]!.arguments[0]!
      if (!ts.isObjectLiteralExpression(arg)) throw new Error('missing DA options object')
      const selected = propertiesOf(arg, source)
      expect(selected).toHaveLength(1)
      expect(selected[0]!.parent).toBe(arg)
      expect(selected[0]!.initializer.getText(source).replace(/\s/g, '')).toBe(
        `${receiver}.verificationCommands===undefined?createLocalVerificationCommandEffectsFactory():${receiver}.verificationCommands`,
      )
      expect(source.text).toContain(
        "from '@/modules/development-automation/composition/localVerificationCommands'",
      )
    })
  }
  test('CLI initial construction, PostgreSQL dispatch and SQLite HTTP reassembly forward the same factory', () => {
    const source = readSource('cli/start.ts')
    for (const [name, receiver] of [
      ['startCommand', 'opts'],
      ['composePostgresqlProviderSession', 'input'],
      ['composeSqliteProviderSession', 'input'],
    ] as const) {
      const forwards = propertiesOf(bodyOf(source, name), source).filter((p) =>
        ts.isPropertyAccessExpression(p.initializer),
      )
      expect(forwards).toHaveLength(1)
      expect(forwards[0]!.initializer.getText(source)).toBe(receiver + '.verificationCommands')
    }
  })
  test('the module requires the family and creates it with the original evidence before parsing its profile', () => {
    const source = readSource('modules/development-automation/composition.ts')
    const options = source.statements.find(
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) &&
        node.name.text === 'DevelopmentAutomationCompositionOptions',
    )!
    const member = options.members.find(
      (node) =>
        ts.isPropertySignature(node) && node.name.getText(source) === 'verificationCommands',
    )
    if (member === undefined || !ts.isPropertySignature(member))
      throw new Error('missing complete verification factory')
    expect(member.questionToken).toBeUndefined()
    expect(member.type?.getText(source)).toBe('VerificationCommandEffectsFactory')
    const calls = descendants(source, ts.isCallExpression).filter(
      (call) => call.expression.getText(source) === 'runVerificationProfileWithEffects',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.arguments[0]!.getText(source).replace(/\s/g, '')).toBe(
      'deps.verificationCommands.create({evidence})',
    )
    const argument = calls[0]!.arguments[1]!
    expect(argument.getText(source).replace(/\s/g, '')).toBe(
      '{workspacePath:input.workspacePath,profile:verificationProfileContentSchema.parse(input.profile),}',
    )
    expect(source.text).not.toContain("from './infrastructure/verificationRunner'")
    expect(source.text).not.toContain('createRepoScriptResolver')
    const policy = readSource('modules/development-automation/application/verificationRunner.ts')
    expect(policy.text).not.toMatch(
      /Bun\.(?:spawn|file|Glob)|from ['"]node:(?:fs|child_process|path)['"]|killProcessTree/,
    )
  })
})
