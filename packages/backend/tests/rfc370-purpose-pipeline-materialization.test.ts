// RFC-370: Windows typecheck exposed a stale pipeline store after purpose extraction.
// Lock the actual employee work item to its selected content receiver and async ACK.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import { composeDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { describeEachProvider } from './helpers/eachProvider'
import { held, MemoryPurposeContent } from './helpers/developmentPurpose'

const headSha = 'a'.repeat(40),
  targetSha = 'b'.repeat(40)
const unused = (): never => {
  throw new Error('unused pipeline fixture effect')
}

describeEachProvider('RFC-370 selected employee pipeline materialization', (harness) => {
  test('materializes the imported opaque bundle on the same receiver, awaits its ACK and then closes staging', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc370-selected-pipeline-'))
    const content = new MemoryPurposeContent()
    const allocated = content.staging.create()
    const stage = 'then' in allocated ? await allocated : allocated
    await stage.writeText({ relativeName: 'unit.log', text: 'unit passed\n' })
    const entered = held<void>(),
      ack = held<void>()
    let destination: string | undefined,
      bundleRef: string | undefined,
      settled = false
    const evidence: EvidenceArtifactPort = {
      ...content.evidence,
      async materializeBundle(ref, target) {
        expect(this).toBe(evidence)
        expect(content.bundles.has(ref)).toBe(true)
        bundleRef = ref
        destination = target
        entered.resolve()
        await ack.promise
        return [...content.bundles.get(ref)!.entries]
      },
    }
    const platform = composeDevelopmentEmployeePlatformWorkItems({
      db: harness.db,
      appHome,
      evidenceArtifacts: evidence,
      reactionRounds: { frozenPlan: unused, lastSettledRound: unused },
      repoRemote: { resolve: unused },
      mrEffects: { reply: unused, ensure: unused, observe: unused },
      sourceControl: {
        derive: unused,
        commit: unused,
        push: unused,
        checkpoint: unused,
        restore: unused,
        materialize: unused,
        rematerialize: unused,
        fetchRemoteHead: unused,
        importCommit: unused,
      },
      conflictMerge: { finish: unused },
      mrFacts: {
        async collect() {
          return {
            ok: true,
            snapshot: {
              state: 'opened',
              headSha,
              targetSha,
              targetBranch: 'main',
              draft: false,
              mergeableState: 'mergeable',
              approvalHold: false,
              mergedCommitSha: null,
              unresolvedReviewCount: 0,
              reviewThreads: [],
            },
          }
        },
      },
      pipelineEvidence: {
        async collect() {
          return {
            ok: true,
            staging: stage,
            outputBudget: { maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 2048 },
            envelope: {
              protocol: 'aw-adapter@1',
              operation: 'pipeline.collect',
              providerKey: 'selected',
              providerHeadSha: headSha,
              targetSha,
              completeness: 'complete',
              redaction: 'complete',
              gates: [
                {
                  gateKey: 'unit',
                  required: true,
                  status: 'pass',
                  runRef: 'run1',
                  attempt: 1,
                  finishedAt: '2026-10-07T00:00:00+00:00',
                  retryability: 'safe',
                  failureCategories: [],
                  files: [{ fileId: 'unit-log', relativePath: 'unit.log' }],
                },
              ],
            },
            cleanup: () => stage.close(),
          }
        },
        trigger: unused,
        rerun: unused,
      },
    })
    expect(existsSync(join(appHome, 'evidence'))).toBe(false)
    const pending = platform
      .execute({
        roundRef: 'round',
        executionNonce: 'c'.repeat(64),
        caseRef: { id: 'case-pipeline' },
        employeeTypeRef: { typeId: 'development', revision: 10 },
        triggeringEventRef: 'pipeline',
        workItemRef: 'collect-pipeline',
        connectionRef: { id: 'adapter', revision: 7 },
        externalWaitDeadlineMs: 60000,
        inputEnvelopeJson: JSON.stringify({
          contextsJson: JSON.stringify([
            {
              id: 'mr',
              revision: 1,
              typeId: 'development.merge-request',
              lifecycleState: 'active',
              artifactRefs: [],
              stateJson: JSON.stringify({
                status: 'active',
                mergeRequestRef: 'repo!42',
                headSha,
                targetSha,
                issueHandlingContextRef: 'issue',
                readyToMerge: false,
                repositoryRef: 'repo',
                providerMrRef: '42',
              }),
            },
          ]),
        }),
      })
      .finally(() => {
        settled = true
      })
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('work item ended before selected materialization')
        }),
      ])
      expect(settled).toBe(false)
      expect(content.stage(stage.reference).closed).toBe(false)
      expect(destination).toBe(
        join(
          appHome,
          'workspaces',
          'employee-cases',
          'case-pipeline',
          'scene',
          'workspace',
          PLATFORM_WORKSPACE_DIR,
          'pipeline',
          'case-pipeline',
          bundleRef!,
        ),
      )
      expect(existsSync(join(appHome, 'evidence'))).toBe(false)
    } finally {
      ack.resolve()
      try {
        const output = JSON.parse(await pending)
        expect(output.status).toBe('passed')
        expect(output.checks[0].evidenceFiles).toEqual([
          `${PLATFORM_WORKSPACE_DIR}/pipeline/case-pipeline/${bundleRef}/unit.log`,
        ])
        expect(content.stage(stage.reference).closed).toBe(true)
        expect(existsSync(join(appHome, 'evidence'))).toBe(false)
      } finally {
        rmSync(appHome, { recursive: true, force: true })
      }
    }
  })
})
