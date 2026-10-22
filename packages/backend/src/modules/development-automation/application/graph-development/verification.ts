import {
  canonicalJson,
  GraphEvidenceBindingSchema,
  GraphTraceLinkSchema,
  repositoryMaterializationCommit,
  type GraphEvidenceBinding,
  type GraphImplementationBasis,
} from '@agent-workflow/shared'
import type {
  CandidateDeliveryParticipant,
  ChangeCandidateParticipant,
} from '@/modules/source-control/public/types'
import type { RepositoryRevisionContentFactory } from '@/modules/source-control/public/participants'
import { sha1Hex, sha256Hex } from '@/util/hash'
import { graphDigest, validateGraphDocument } from '../../domain/graph-development/model'
import { graphResultSchemas } from '../../domain/graph-development/toolContracts'
import { verificationProfileContentSchema } from '../../domain/verificationProfile'
import { runVerificationProfileWithEffects } from '../verificationRunner'
import type { VerificationProfilePersistence } from '../ports/configResourceStore'
import type { VerificationCommandEffectsFactory } from '../ports/verificationCommandEffects'
import type { GraphDesignArtifacts } from '../ports/graphDesignArtifacts'
import type { GraphDesignStore } from '../ports/graphDesignStore'
import type { EvidenceArtifactPort } from '../ports/evidenceArtifacts'
import type { GraphDesignCommands } from './designCommands'
import { verifyGraphBehavior } from './behaviorVerification'

export interface GraphVerificationWorkspace {
  readonly targetBranch?: string
  readonly uploadPlan?: Parameters<ChangeCandidateParticipant['derive']>[0]['uploadPlan']
  readonly workspacePath: string
  readonly baselineRepoPath: string
  readonly baseline: NonNullable<GraphImplementationBasis['document']['repositoryBaseline']>
}
export function createGraphVerification(deps: {
  readonly store: GraphDesignStore
  readonly commands: GraphDesignCommands
  readonly artifacts: GraphDesignArtifacts
  readonly candidates: ChangeCandidateParticipant & CandidateDeliveryParticipant
  readonly content: RepositoryRevisionContentFactory
  readonly profiles: VerificationProfilePersistence
  readonly verification: VerificationCommandEffectsFactory
  readonly evidence: EvidenceArtifactPort
}) {
  return {
    async run(input: {
      designId: string
      roundRef: string
      workspace: GraphVerificationWorkspace
    }) {
      const implementations = (await deps.store.links(input.designId))
        .filter((link) => link.id.startsWith('implementation:'))
        .sort((a, b) => b.createdAt - a.createdAt)
      const link = implementations[0]
      if (!link) throw new Error('graph-verification-implementation-missing')
      const implementation = JSON.parse(link.payloadJson) as {
        basisId: string
        basisDigest: string
        roundRef: string
        result: unknown
      }
      const basis = (await deps.commands.basis(input.designId, implementation.basisId)).basis
      if (basis.digest !== implementation.basisDigest)
        throw new Error('graph-verification-basis-mismatch')
      const result = graphResultSchemas['implement-change'].parse(implementation.result)
      const workspace = input.workspace
      const candidateInput = {
        baselineRepoPath: workspace.baselineRepoPath,
        baselineSha: repositoryMaterializationCommit(workspace.baseline),
        repositoryBaseline: workspace.baseline,
        overlayRoot: workspace.workspacePath,
        uploadPlan: workspace.uploadPlan,
      }
      const derived = await deps.candidates.derive({
        ...candidateInput,
        excludePolicyDigest: graphDigest(['.git', '.agent-workflow']),
        agentOutcomeRef: implementation.roundRef,
      })
      if (!derived.ok)
        return {
          candidateRef: null,
          candidateTreeOid: null,
          evidenceIds: [],
          passed: false,
          limitations: [`${derived.code}: ${derived.detail}`],
        }
      const candidate = derived.receipt
      const record = await deps.commands.beginRecord(
        input.designId,
        `verification:${input.roundRef}`,
        'verification',
        { candidate, basisDigest: basis.digest },
      )
      if (record.status === 'completed')
        return graphResultSchemas['verify-change'].parse(
          (JSON.parse(record.payloadJson) as { result: unknown }).result,
        )
      const environment = (await deps.verification.environment?.(workspace.workspacePath)) ?? null
      const evidenceIds: string[] = [],
        limitations = [...result.limitations]
      let passed = environment !== null && result.limitations.length === 0
      if (!environment) limitations.push('执行端未提供环境快照，证据不完整。')
      async function evidence(
        value: Omit<
          GraphEvidenceBinding,
          'basisDigest' | 'candidateTreeOid' | 'commitSha' | 'ci' | 'recordedAt'
        >,
      ) {
        const binding = GraphEvidenceBindingSchema.parse({
          ...value,
          basisDigest: basis.digest,
          candidateTreeOid: candidate.treeOid,
          commitSha: null,
          ci: null,
          recordedAt: record.createdAt,
        })
        await deps.store.insertLink({
          designId: input.designId,
          id: binding.id,
          kind: 'evidence',
          payloadJson: canonicalJson(binding),
          createdAt: record.createdAt,
        })
        evidenceIds.push(binding.id)
      }
      const structural = validateGraphDocument(basis.document)
      const structureId = `structure:${input.roundRef}`
      const previousStructure = (await deps.store.links(input.designId)).find(
        (link) => link.id === structureId,
      )
      const structureFiles = [
        {
          path: 'structure.json',
          content: canonicalJson({
            issues: structural,
            limitation:
              'Only typed design structure is checked; this does not prove implementation behavior.',
          }),
        },
      ]
      const savedStructure = previousStructure
        ? GraphEvidenceBindingSchema.parse(JSON.parse(previousStructure.payloadJson))
        : null
      if (
        savedStructure &&
        (!savedStructure.artifactRef ||
          !savedStructure.artifactDigest ||
          (await deps.artifacts.read(
            { artifactRef: savedStructure.artifactRef, digest: savedStructure.artifactDigest },
            'structure.json',
          )) !== structureFiles[0]!.content)
      )
        throw new Error('graph-verification-recovery-evidence-missing')
      const structureArtifact = savedStructure
        ? { artifactRef: savedStructure.artifactRef!, digest: savedStructure.artifactDigest! }
        : await deps.artifacts.put(structureFiles)
      await evidence({
        id: structureId,
        kind: 'structure',
        obligationIds: basis.obligationIds,
        readSet: basis.readSet,
        profileRef: null,
        environmentDigest: null,
        executionRef: null,
        artifactRef: structureArtifact.artifactRef,
        artifactDigest: structureArtifact.digest,
        result: structural.length ? 'failed' : 'passed',
        summary: structural.length ? '设计结构存在问题' : '设计结构检查通过',
        limitations: ['结构一致性不证明代码正确。'],
      })
      if (structural.length) passed = false
      const staged = await deps.candidates.stage(candidateInput)
      if (!staged.ok) throw new Error(`${staged.code}: ${staged.detail}`)
      try {
        if (staged.treeOid !== candidate.treeOid)
          throw new Error('graph-verification-candidate-drifted')
        const reader = deps.content.bind(staged.ws)
        const paths = [
          ...new Set(
            result.traceProposals
              .flatMap((trace) => [
                trace.path,
                ...(trace.testRef ? [trace.testRef.split('#')[0]!] : []),
              ])
              .concat(result.testRefs.map((ref) => ref.split('#')[0]!)),
          ),
        ]
        const files = await reader.readRevision({
          rev: candidate.treeOid,
          paths,
          maxBytes: 2 * 1024 * 1024,
        })
        const checkedElements = new Set<string>(),
          checkedTests = new Set<string>()
        for (const [index, trace] of result.traceProposals.entries()) {
          const file = files.get(trace.path)
          const element = basis.document.elements.find(
            (element) =>
              element.id === trace.elementId && basis.includedElementIds.includes(element.id),
          )
          const testFile = trace.testRef ? files.get(trace.testRef.split('#')[0]!) : null
          const testName = trace.testRef?.split('#').slice(1).join('#')
          if (
            !element ||
            file?.kind !== 'text' ||
            (trace.symbol && !file.content.includes(trace.symbol)) ||
            (trace.testRef &&
              (testFile?.kind !== 'text' || (testName && !testFile.content.includes(testName)))) ||
            (trace.obligationId && !basis.obligationIds.includes(trace.obligationId))
          ) {
            limitations.push(`追溯引用未通过候选内容核对：${trace.elementId} → ${trace.path}`)
            passed = false
            continue
          }
          const bytes = Buffer.from(file.content)
          const blob = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])
          const blobOid = candidate.treeOid.length === 64 ? sha256Hex(blob) : sha1Hex(blob)
          const verified = GraphTraceLinkSchema.parse({
            ...trace,
            id: `trace:${input.roundRef}:${index}`,
            candidateTreeOid: candidate.treeOid,
            blobOid,
            status: 'reference-checked',
          })
          await deps.store.insertLink({
            designId: input.designId,
            id: verified.id,
            kind: 'trace',
            payloadJson: canonicalJson(verified),
            createdAt: record.createdAt,
          })
          checkedElements.add(trace.elementId)
          if (trace.testRef) checkedTests.add(trace.testRef)
        }
        for (const element of basis.document.elements.filter(
          (element) =>
            element.kind === 'requirement' && basis.includedElementIds.includes(element.id),
        ))
          if (!checkedElements.has(element.id)) {
            passed = false
            limitations.push(`需求缺少有效代码追溯：${element.id}`)
          }
        const obligations = basis.document.obligations.filter((obligation) =>
          basis.obligationIds.includes(obligation.id),
        )
        const profileRefs = new Map(
          obligations.flatMap((obligation) =>
            obligation.verification.kind === 'execution'
              ? [
                  [
                    `${obligation.verification.profileRef.id}@${obligation.verification.profileRef.revision}`,
                    obligation.verification.profileRef,
                  ] as const,
                ]
              : [],
          ),
        )
        const profileDigests: Record<string, string> = {}
        for (const [key, ref] of profileRefs) {
          const revision = await deps.profiles.getRevision(ref.id, ref.revision)
          const covered = obligations.filter(
            (obligation) =>
              obligation.verification.kind === 'execution' &&
              obligation.verification.profileRef.id === ref.id &&
              obligation.verification.profileRef.revision === ref.revision,
          )
          const evidenceId = `execution:${input.roundRef}:${graphDigest(key).slice(0, 16)}`
          const previous = (await deps.store.links(input.designId)).find(
            (link) => link.id === evidenceId,
          )
          if (previous) {
            const saved = GraphEvidenceBindingSchema.parse(JSON.parse(previous.payloadJson))
            if (
              saved.basisDigest !== basis.digest ||
              saved.candidateTreeOid !== candidate.treeOid ||
              saved.profileRef?.digest !== revision?.contentDigest ||
              saved.environmentDigest !== (environment?.digest ?? null)
            )
              throw new Error('graph-verification-recovery-input-changed')
            if (
              !saved.artifactRef ||
              !saved.artifactDigest ||
              !(await deps.artifacts.read(
                { artifactRef: saved.artifactRef, digest: saved.artifactDigest },
                'execution.json',
              ))
            )
              throw new Error('graph-verification-recovery-evidence-missing')
            evidenceIds.push(saved.id)
            profileDigests[ref.id] = revision!.contentDigest
            if (saved.result !== 'passed') {
              passed = false
              limitations.push(`保留原执行结果：${key} / ${saved.result}`)
            }
            continue
          }
          const validTests = covered.every(
            (obligation) =>
              obligation.verification.kind === 'execution' &&
              obligation.verification.testRefs.length > 0 &&
              obligation.verification.testRefs.every((test) => checkedTests.has(test)),
          )
          let receipt: Awaited<ReturnType<typeof runVerificationProfileWithEffects>> | null = null
          const profile =
            revision && revision.contentDigest === ref.digest
              ? verificationProfileContentSchema.parse(JSON.parse(revision.contentJson))
              : null
          const behavior: Awaited<ReturnType<typeof verifyGraphBehavior>>[] = []
          if (profile && profile.steps.length && validTests) {
            const checking = await deps.candidates.stage(candidateInput)
            if (!checking.ok) throw new Error(`${checking.code}: ${checking.detail}`)
            try {
              if (checking.treeOid !== candidate.treeOid)
                throw new Error('graph-verification-candidate-drifted')
              receipt = await runVerificationProfileWithEffects(
                deps.verification.create({ evidence: deps.evidence }),
                { workspacePath: checking.ws, profile },
              )
            } finally {
              await checking.cleanup()
            }
            for (const obligation of covered)
              if (
                obligation.verification.kind === 'execution' &&
                obligation.verification.modelCheck
              ) {
                const checking = await deps.candidates.stage(candidateInput)
                if (!checking.ok) throw new Error(`${checking.code}: ${checking.detail}`)
                try {
                  if (checking.treeOid !== candidate.treeOid)
                    throw new Error('graph-verification-candidate-drifted')
                  behavior.push(
                    await verifyGraphBehavior({
                      document: basis.document,
                      check: obligation.verification.modelCheck,
                      workspaceRef: checking.ws,
                      effects: deps.verification.create({ evidence: deps.evidence }),
                    }),
                  )
                } finally {
                  await checking.cleanup()
                }
              }
          }
          const logs = await Promise.all(
            (receipt?.steps ?? []).flatMap((step, index) =>
              step.outputTailRef
                ? [
                    Promise.resolve(deps.evidence.contents.readText(step.outputTailRef)).then(
                      (content) => ({
                        path: `logs/${index}-output-tail.txt`,
                        content:
                          content ??
                          'Retained command output is unavailable. See execution.json for the original reference.',
                      }),
                    ),
                  ]
                : [],
            ),
          )
          const artifact = await deps.artifacts.put([
            ...logs,
            ...(await Promise.all(
              (receipt?.steps ?? []).flatMap((step, stepIndex) =>
                step.evidenceFiles.map(async (file, fileIndex) => {
                  const chunks: Buffer[] = []
                  let offset = 0
                  for (;;) {
                    const read = await deps.evidence.contents.readRange({
                      sha256: file.sha256,
                      offsetBytes: offset,
                      limitBytes: 4 * 1024 * 1024,
                    })
                    if (!read.ok)
                      throw new Error(`graph-report-unreadable:${file.path}:${read.code}`)
                    chunks.push(Buffer.from(read.bytes))
                    if (!read.truncated) break
                    if (read.nextOffset === null || read.nextOffset <= offset)
                      throw new Error('graph-report-range-not-advancing')
                    offset = read.nextOffset
                  }
                  const bytes = Buffer.concat(chunks)
                  if (bytes.length !== file.bytes || sha256Hex(bytes) !== file.sha256)
                    throw new Error(`graph-report-content-mismatch:${file.path}`)
                  const decoded = bytes.toString('utf8')
                  return {
                    path: `reports/${stepIndex}-${fileIndex}.json`,
                    content: canonicalJson({
                      kind: 'graph-retained-file',
                      sourcePath: file.path,
                      sha256: file.sha256,
                      bytes: file.bytes,
                      text: Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : null,
                      base64: bytes.toString('base64'),
                    }),
                  }
                }),
              ),
            )),
            {
              path: 'execution.json',
              content: canonicalJson({
                candidate,
                basisDigest: basis.digest,
                profile: ref,
                environment,
                receipt,
                behavior,
                testReferencesChecked: validTests,
              }),
            },
          ])
          const ok =
            receipt?.ok === true &&
            behavior.every((check) => check.result === 'passed') &&
            environment !== null
          if (!ok) {
            passed = false
            limitations.push(`校验未通过或未运行：${key}`)
          }
          profileDigests[ref.id] = revision?.contentDigest ?? ''
          const incomplete =
            behavior.some((check) => ['inconclusive', 'not-run'].includes(check.result)) ||
            !environment
          await evidence({
            id: `execution:${input.roundRef}:${graphDigest(key).slice(0, 16)}`,
            kind: 'execution',
            obligationIds: covered.map((o) => o.id),
            readSet: basis.readSet,
            profileRef: ref,
            environmentDigest: environment?.digest ?? null,
            executionRef: receipt ? `${input.roundRef}:${key}:${receipt.receiptDigest}` : null,
            artifactRef: artifact.artifactRef,
            artifactDigest: artifact.digest,
            result: receipt ? (ok ? 'passed' : incomplete ? 'inconclusive' : 'failed') : 'not-run',
            summary: `${key}: ${ok ? '执行通过' : receipt ? (incomplete ? '检查不完整' : '执行失败') : '未执行'}`,
            limitations: [
              ...(validTests
                ? [
                    '测试执行通过不代表已证明所有输入上的行为；环境快照不包含远端服务或未声明的外部依赖。',
                  ]
                : ['缺少有效测试引用或准确的 profile 版本。']),
              ...behavior.flatMap((check) => check.limitations),
            ],
          })
        }
        for (const obligation of obligations.filter(
          (obligation) => obligation.verification.kind === 'manual',
        )) {
          const acceptance = (await deps.store.links(input.designId))
            .filter((link) => link.kind === 'evidence')
            .map((link) => GraphEvidenceBindingSchema.parse(JSON.parse(link.payloadJson)))
            .filter(
              (e) =>
                e.kind === 'acceptance' &&
                e.basisDigest === basis.digest &&
                e.candidateTreeOid === candidate.treeOid &&
                e.obligationIds.includes(obligation.id),
            )
            .sort((a, b) => b.recordedAt - a.recordedAt || b.id.localeCompare(a.id))[0]
          const accepted = acceptance?.result === 'passed'
          if (!accepted) {
            passed = false
            limitations.push(`待人工验收：${obligation.id}`)
          }
        }
        const value = {
          candidateRef: candidate.candidateRef,
          candidateTreeOid: candidate.treeOid,
          evidenceIds,
          passed,
          limitations,
        }
        await deps.commands.finishRecord(record, 'completed', {
          candidate,
          basisId: basis.id,
          basisDigest: basis.digest,
          implementationRoundRef: implementation.roundRef,
          environmentDigest: environment?.digest ?? null,
          profileDigests,
          result: value,
        })
        return value
      } finally {
        await staged.cleanup()
      }
    },
  }
}
