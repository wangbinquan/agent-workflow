import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import type { PipelineEvidencePort } from '@/modules/development-automation/application/ports/reconcilerPorts'
import { composeDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { mergeRequestContextSchema } from '@/modules/development-automation/composition/employeeTypePackage'

const migrations = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []
const headSha = 'a'.repeat(40)
const targetSha = 'b'.repeat(40)
const adapterRef = { id: 'pipeline-adapter', revision: 7 }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type PlatformDeps = Parameters<typeof composeDevelopmentEmployeePlatformWorkItems>[0]
type PlatformPlan = Parameters<
  ReturnType<typeof composeDevelopmentEmployeePlatformWorkItems>['execute']
>[0]
type CollectEnvelope = Extract<
  Awaited<ReturnType<PipelineEvidencePort['collect']>>,
  { ok: true }
>['envelope']

const passGate = {
  gateKey: 'compile',
  required: true,
  status: 'pass' as const,
  runRef: 'run-1',
  attempt: 1,
  finishedAt: '2026-08-25T00:00:00.000Z',
  retryability: 'safe' as const,
  failureCategories: [],
  files: [],
}

function envelope(overrides: Partial<CollectEnvelope> = {}): CollectEnvelope {
  return {
    providerKey: 'enterprise-ci',
    providerHeadSha: headSha,
    targetSha,
    completeness: 'complete',
    gates: [passGate],
    redaction: 'complete',
    ...overrides,
  }
}

function mergeRequestContext(target: string | null = targetSha) {
  return {
    id: 'mr-context',
    revision: 1,
    typeId: 'development.merge-request',
    lifecycleState: 'active',
    artifactRefs: [],
    stateJson: JSON.stringify(
      mergeRequestContextSchema.parse({
        status: 'active',
        mergeRequestRef: 'repo-1!42',
        headSha,
        targetSha: target,
        issueHandlingContextRef: 'issue-context',
        readyToMerge: false,
        repositoryRef: 'repo-1',
        providerMrRef: '42',
      }),
    ),
  }
}

function plan(target: string | null = targetSha): PlatformPlan {
  return {
    roundRef: 'round-pipeline',
    executionNonce: 'c'.repeat(64),
    caseRef: { id: 'case-pipeline' },
    employeeTypeRef: { typeId: 'development', revision: 10 },
    triggeringEventRef: 'pipeline-wake',
    workItemRef: 'collect-pipeline',
    connectionRef: adapterRef,
    externalWaitDeadlineMs: 60_000,
    inputEnvelopeJson: JSON.stringify({
      contextsJson: JSON.stringify([mergeRequestContext(target)]),
    }),
  }
}

function harness(input: {
  envelope: () => CollectEnvelope
  failure?: Extract<Awaited<ReturnType<PipelineEvidencePort['collect']>>, { ok: false }>['failure']
  outputBudget?: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number }
  stagedBytes?: number
  stagedFiles?: () => Readonly<Record<string, string>>
  refreshedTargetSha?: string | null
  refreshFails?: boolean
}) {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc323-platform-pipeline-'))
  roots.push(appHome)
  mkdirSync(join(appHome, 'workspaces', 'employee-cases', 'case-pipeline', 'scene', 'workspace'), {
    recursive: true,
  })
  const collectedInputs: Parameters<PipelineEvidencePort['collect']>[0][] = []
  let cleanupCount = 0
  const pipelineEvidence: PipelineEvidencePort = {
    async collect(request) {
      collectedInputs.push(request)
      if (input.failure !== undefined) return { ok: false, failure: input.failure }
      const stagedRoot = mkdtempSync(join(tmpdir(), 'rfc323-pipeline-sink-'))
      roots.push(stagedRoot)
      if ((input.stagedBytes ?? 0) > 0) {
        writeFileSync(join(stagedRoot, 'unreferenced.log'), 'x'.repeat(input.stagedBytes ?? 0))
      }
      for (const [relativePath, content] of Object.entries(input.stagedFiles?.() ?? {})) {
        const file = join(stagedRoot, relativePath)
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, content)
      }
      return {
        ok: true,
        envelope: input.envelope(),
        stagedRoot,
        outputBudget: input.outputBudget ?? {
          maxFiles: 10,
          maxFileBytes: 1024,
          maxTotalBytes: 4096,
        },
        cleanup() {
          cleanupCount += 1
          rmSync(stagedRoot, { recursive: true, force: true })
        },
      }
    },
    async trigger() {
      throw new Error('not used')
    },
    async rerun() {
      throw new Error('not used')
    },
  }
  const deps = {
    db: createInMemoryDb(migrations),
    appHome,
    pipelineEvidence,
    reactionRounds: {} as PlatformDeps['reactionRounds'],
    repoRemote: { resolve: () => null },
    mrEffects: {} as PlatformDeps['mrEffects'],
    sourceControl: {} as PlatformDeps['sourceControl'],
    conflictMerge: {} as PlatformDeps['conflictMerge'],
    mrFacts: {
      async collect() {
        if (input.refreshFails) {
          return { ok: false as const, code: 'mr-facts-unavailable', detail: 'provider outage' }
        }
        return {
          ok: true as const,
          snapshot: {
            state: 'opened' as const,
            headSha,
            targetSha: input.refreshedTargetSha ?? targetSha,
            targetBranch: 'main',
            draft: false,
            mergeableState: 'mergeable' as const,
            approvalHold: false,
            mergedCommitSha: null,
            unresolvedReviewCount: 0,
            reviewThreads: [],
          },
        }
      },
    },
  } satisfies PlatformDeps
  return {
    platform: composeDevelopmentEmployeePlatformWorkItems(deps),
    appHome,
    collectedInputs,
    cleanupCount: () => cleanupCount,
  }
}

describe('RFC-323 platform-owned pipeline collection', () => {
  test('composition does not create the pipeline evidence store before collection', () => {
    const fixture = harness({ envelope })
    expect(existsSync(join(fixture.appHome, 'evidence'))).toBe(false)
  })

  test('uses the frozen Adapter ref and observes pending then passed only for the exact head/target', async () => {
    let current = envelope({ targetSha: 'd'.repeat(40) })
    const fixture = harness({ envelope: () => current })

    expect(JSON.parse(await fixture.platform.execute(plan()))).toEqual({
      outcome: 'completed',
      observedSourceVersion: headSha,
      observedTargetVersion: targetSha,
      status: 'pending',
      checks: [],
    })

    current = envelope()
    expect(JSON.parse(await fixture.platform.execute(plan()))).toMatchObject({
      outcome: 'completed',
      observedSourceVersion: headSha,
      observedTargetVersion: targetSha,
      status: 'passed',
      checks: [{ checkRef: 'compile', status: 'passed' }],
    })
    expect(fixture.collectedInputs).toEqual([
      {
        adapterBindingRef: 'pipeline-adapter@7',
        headSha,
        targetSha,
        gateKeys: [],
      },
      {
        adapterBindingRef: 'pipeline-adapter@7',
        headSha,
        targetSha,
        gateKeys: [],
      },
    ])
    expect(fixture.cleanupCount()).toBe(2)
  })

  test('waits without fabricating a target or trusting an unavailable post-collection fence', async () => {
    const missingTarget = harness({ envelope: () => envelope() })
    expect(JSON.parse(await missingTarget.platform.execute(plan(null)))).toEqual({
      outcome: 'completed',
      observedSourceVersion: headSha,
      status: 'pending',
      checks: [],
    })
    expect(missingTarget.collectedInputs).toHaveLength(0)

    const unavailableFence = harness({ envelope: () => envelope(), refreshFails: true })
    expect(JSON.parse(await unavailableFence.platform.execute(plan()))).toMatchObject({
      outcome: 'completed',
      status: 'pending',
      checks: [],
    })
    expect(unavailableFence.collectedInputs).toHaveLength(1)
    expect(unavailableFence.cleanupCount()).toBe(1)
  })

  test('maps a stale provider snapshot back to monitoring instead of blocking the employee', async () => {
    const fixture = harness({
      envelope: () => envelope(),
      failure: {
        category: 'stale-input',
        code: 'adapter-exit-6',
        retryability: 'after-refresh',
        attemptOrdinal: 0,
        remediation: 'refresh MR facts',
        evidenceRef: null,
      },
    })
    expect(JSON.parse(await fixture.platform.execute(plan()))).toMatchObject({
      outcome: 'completed',
      status: 'pending',
      checks: [],
    })
    expect(fixture.collectedInputs).toHaveLength(1)
  })

  test('fails on a required gate even while another required gate is running, and ignores optional failures', async () => {
    const fixture = harness({
      envelope: () =>
        envelope({
          gates: [
            { ...passGate, gateKey: 'compile', status: 'fail', failureCategories: ['compile'] },
            { ...passGate, gateKey: 'test', status: 'running', finishedAt: null },
            { ...passGate, gateKey: 'advisory', required: false, status: 'fail' },
          ],
        }),
    })
    const failed = JSON.parse(await fixture.platform.execute(plan())) as {
      status: string
      checks: Array<{ checkRef: string; status: string }>
    }
    expect(failed.status).toBe('failed')
    expect(failed.checks).toEqual([
      expect.objectContaining({ checkRef: 'compile', status: 'failed' }),
      expect.objectContaining({ checkRef: 'test', status: 'running' }),
    ])
    expect(failed.checks.map((check) => check.checkRef)).not.toContain('advisory')
  })

  test('enforces the selected Adapter output budget while importing the staged sink', async () => {
    const fixture = harness({
      envelope: () => envelope(),
      stagedBytes: 2,
      outputBudget: { maxFiles: 1, maxFileBytes: 1, maxTotalBytes: 1 },
    })
    expect(JSON.parse(await fixture.platform.execute(plan()))).toMatchObject({
      outcome: 'blocked',
      explanation: expect.stringContaining('pipeline-evidence-import-failed'),
    })
    expect(fixture.cleanupCount()).toBe(1)
  })

  test('blocks complete evidence that declares no required gates', async () => {
    const fixture = harness({
      envelope: () => envelope({ gates: [{ ...passGate, required: false }] }),
    })
    expect(JSON.parse(await fixture.platform.execute(plan()))).toEqual({
      outcome: 'blocked',
      explanation: 'pipeline-required-gates-missing: 流水线证据未声明任何必需门禁',
    })
  })

  test('rejects failed redaction before any provider bytes enter the evidence store', async () => {
    const fixture = harness({
      envelope: () => envelope({ redaction: 'failed' }),
      stagedFiles: () => ({ 'logs/unredacted.log': 'Authorization: Bearer provider-secret\n' }),
    })
    expect(JSON.parse(await fixture.platform.execute(plan()))).toMatchObject({
      outcome: 'blocked',
      explanation: expect.stringContaining('pipeline-evidence-redaction-incomplete'),
    })
    expect(readdirSync(join(fixture.appHome, 'evidence', 'bundles'))).toHaveLength(0)
    expect(fixture.cleanupCount()).toBe(1)
  })

  test('a later green snapshot does not erase evidence referenced by an earlier round', async () => {
    const relativePath = 'logs/compile/failure.log'
    let stagedFiles: Readonly<Record<string, string>> = { [relativePath]: 'failed output\n' }
    let current = envelope({
      gates: [
        {
          ...passGate,
          status: 'fail',
          failureCategories: ['compile'],
          files: [{ fileId: 'compile/failure', relativePath }],
        },
      ],
    })
    const fixture = harness({ envelope: () => current, stagedFiles: () => stagedFiles })

    const failed = JSON.parse(await fixture.platform.execute(plan())) as {
      checks: Array<{ evidenceFiles: string[] }>
    }
    const failedEvidenceRef = failed.checks[0]!.evidenceFiles[0]!
    stagedFiles = { [relativePath]: 'passed output\n' }
    current = envelope({
      gates: [
        {
          ...passGate,
          files: [{ fileId: 'compile/pass', relativePath }],
        },
      ],
    })
    const passed = JSON.parse(await fixture.platform.execute(plan())) as {
      checks: Array<{ evidenceFiles: string[] }>
    }
    const passedEvidenceRef = passed.checks[0]!.evidenceFiles[0]!
    expect(passedEvidenceRef).not.toBe(failedEvidenceRef)

    const retained = join(
      fixture.appHome,
      'workspaces',
      'employee-cases',
      'case-pipeline',
      'scene',
      'workspace',
      failedEvidenceRef,
    )
    expect(existsSync(retained)).toBe(true)
    expect(readFileSync(retained, 'utf8')).toBe('failed output\n')
    expect(
      readFileSync(
        join(
          fixture.appHome,
          'workspaces',
          'employee-cases',
          'case-pipeline',
          'scene',
          'workspace',
          passedEvidenceRef,
        ),
        'utf8',
      ),
    ).toBe('passed output\n')
  })
})
