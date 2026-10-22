// Graph material uses the selected content and Case-workspace owners on both deployments.
import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import { bindEmployeeCaseWorkspaceParticipant } from '@/modules/source-control/composition'
import { createHostedEmployeeCaseWorkspaceOperations } from '@/modules/source-control/infrastructure/crewstation/employeeCaseWorkspace'
import {
  hostedWorkspaceReference,
  parseHostedWorkspaceReference,
} from '@/modules/source-control/infrastructure/crewstation/workspaceReference'
import { createFileAutomationWorkspaceEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileAutomationWorkspaceEffects'
import { composeCrewStationDevelopmentWorkspaces } from '@/modules/development-automation/composition/crewstationWorkspace'
import { createGraphEmployeeWorkspace } from '@/modules/development-automation/infrastructure/graph-development/employeeWorkspace'
import { graphEmployeeRuntimeCodec } from '@/modules/development-automation/domain/graph-development/employeeCodec'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { describeEachProvider } from './helpers/eachProvider'
import { graphFixture } from './helpers/graphDesign'
import { sha256Hex } from '@/util/hash'
import {
  bindChangeCandidateParticipant,
  bindCandidateDeliveryParticipant,
} from '@/modules/source-control/composition/repositoryCandidate'
import { createHostedRepositoryCandidateOperations } from '@/modules/source-control/infrastructure/crewstation/repositoryCandidate'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
function translate(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string' && (value === from || value.startsWith(from + '/')))
    return to + value.slice(from.length)
  if (Array.isArray(value)) return value.map((item) => translate(item, from, to))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, translate(item, from, to)]),
    )
  return value
}
describeEachProvider('RFC-396 selected workspace material and recovery', (harness) => {
  for (const deployment of ['standalone', 'hosted'] as const)
    test(`${deployment}: actual frozen material is readable and fresh-scene retry restores the original basis`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'rfc396-workspace-'))
      roots.push(root)
      const repository = join(root, 'repo')
      mkdirSync(repository)
      git(repository, 'init', '-q', '-b', 'main')
      writeFileSync(join(repository, 'app.txt'), 'baseline')
      writeFileSync(join(repository, '.gitignore'), 'explicit-upload.txt\n')
      git(repository, 'add', 'app.txt')
      git(repository, 'add', '.gitignore')
      git(
        repository,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=f@example.test',
        'commit',
        '-qm',
        'baseline',
      )
      const operations: string[] = []
      const helper: WorkspaceHelper = {
        async call<T>(_taskId: string, operation: string, value: unknown) {
          operations.push(operation)
          const result = await executeWorkspaceTaskImageOperation(
            operation,
            translate(value, '/work', root),
            undefined,
            root,
          )
          return translate(result, root, '/work') as T
        },
      }
      const physical = (ref: string) =>
        deployment === 'standalone'
          ? ref
          : (translate(parseHostedWorkspaceReference(ref).path, '/work', root) as string)
      const factory =
        deployment === 'standalone'
          ? createFileAutomationWorkspaceEffectsFactory()
          : composeCrewStationDevelopmentWorkspaces({
              helper,
              locate: parseHostedWorkspaceReference,
              reference: hostedWorkspaceReference,
              applicationRootReference: 'cs-workspace:task/',
              readFile: async (ref) => readFileSync(physical(ref)),
              writeFile: async (ref, bytes) => {
                const path = physical(ref)
                mkdirSync(dirname(path), { recursive: true })
                const raw = Buffer.from(bytes).toString()
                writeFileSync(
                  path,
                  ref.endsWith('.json')
                    ? JSON.stringify(translate(JSON.parse(raw), '/work', root))
                    : bytes,
                )
              },
            }).automationWorkspaceEffects
      const sourceControl =
        deployment === 'standalone'
          ? bindEmployeeCaseWorkspaceParticipant()
          : createHostedEmployeeCaseWorkspaceOperations({ helper }).operations
      const repoRef = deployment === 'standalone' ? repository : 'cs-workspace:task/repo'
      const resolved = await sourceControl.resolveBaseline({
        baselineRepoPath: repoRef,
        preferredBranch: 'main',
        sourceBranch: null,
        allowUnborn: true,
      })
      const f = await graphFixture(harness.db, resolved.contentBaseline!)
      const initial = JSON.parse(
        graphEmployeeRuntimeCodec.buildInitialCaseJson(
          JSON.stringify({
            caseRef: 'case-a',
            employeeRef: { id: 'employee', revision: 1 },
            workScopeJson: '{"kind":"task"}',
            intake: {
              kind: 'body-and-files',
              body: 'original request',
              target: { repositoryId: 'repo-a' },
              uploads: [
                {
                  blobRef: 'upload',
                  sha256: sha256Hex('user supplied reference'),
                  originalName: 'explicit-upload.txt',
                  placement: 'repository',
                  targetPath: 'explicit-upload.txt',
                },
                {
                  blobRef: 'upload',
                  sha256: '1'.repeat(64),
                  originalName: 'reference.md',
                  placement: 'temporary',
                  targetPath: null,
                },
              ],
            },
          }),
        ),
      )
      const work = { ...JSON.parse(initial.primaryContextJson), designId: 'design-a' }
      const document = await f.commands.document(work.designId)
      const basis = (
        await f.commands.preview(document.id, {
          requestId: 'basis',
          expectedRevision: document.revision,
          includedElementIds: ['booking'],
        })
      ).basis
      await f.commands.requestReview(document.id, { requestId: 'review', basisId: basis.id })
      const request = f.requests[0]!
      const plan = {
        roundRef: 'round',
        executionNonce: 'nonce',
        caseRef: { id: 'case-a' },
        employeeTypeRef: { typeId: 'graph-development', revision: 1 },
        workItemRef: 'review-design',
        inputEnvelopeJson: JSON.stringify({
          contextsJson: JSON.stringify([
            {
              id: 'context',
              typeId: 'graph-development.design-context',
              revision: 1,
              stateJson: JSON.stringify(work),
              artifactRefs: [],
            },
          ]),
          eventJson: JSON.stringify({
            eventId: 'event:review',
            payloadArtifactRef: request.payloadRef.artifactRef,
          }),
        }),
      }
      const upload = join(root, 'upload')
      writeFileSync(upload, 'user supplied reference')
      const workspace = createGraphEmployeeWorkspace({
        ...f,
        appHome: root,
        factory,
        sourceControl,
        rounds: {
          frozenPlan: async () => ({ caseId: 'case-a', planJson: JSON.stringify(plan) }),
          lastSettledRound: async () => null,
        },
        repositoryPreparation: {
          prepare: async () => ({ id: 'repo-a', localPath: repoRef, defaultBranch: 'main' }),
        },
        inputArtifacts: {
          copyBlobTo(_ref, target) {
            copyFileSync(upload, physical(target))
          },
        },
        consumeResult: async () => {},
        verificationProfiles: async () => [],
      })
      const first = await workspace.prepare({
        planJson: JSON.stringify(plan),
        attemptJson: JSON.stringify({ ordinal: 1, mode: 'fresh' }),
      })
      const projection = JSON.parse(first.contractProjectionJson)
      const state = await workspace.state(work.designId)
      expect(state.uploadPlan?.entries[0]?.targetPath).toBe('explicit-upload.txt')
      const candidateEffects =
        deployment === 'hosted' ? createHostedRepositoryCandidateOperations({ helper }) : undefined
      const candidate = bindChangeCandidateParticipant({ candidateEffects })
      const baselineSha =
        resolved.contentBaseline!.kind === 'commit'
          ? resolved.contentBaseline!.commitSha
          : resolved.contentBaseline!.materializationCommitSha
      const candidateInput = {
        baselineRepoPath: repoRef,
        baselineSha,
        repositoryBaseline: resolved.contentBaseline!,
        overlayRoot: first.workspacePath,
        uploadPlan: state.uploadPlan,
      }
      const derived = await candidate.derive({
        ...candidateInput,
        excludePolicyDigest: 'fixture',
        agentOutcomeRef: 'fixture',
      })
      expect(derived.ok).toBe(true)
      if (!derived.ok) throw new Error(derived.detail)
      const committed = await bindCandidateDeliveryParticipant({ candidateEffects }).commit({
        ...candidateInput,
        missionId: 'graph-upload',
        expectedTreeOid: derived.receipt.treeOid,
        summarySource: 'Preserve explicit upload',
      })
      expect(committed.ok).toBe(true)
      if (!committed.ok) throw new Error(committed.detail)
      expect(git(repository, 'show', `${committed.commitSha}:explicit-upload.txt`)).toBe(
        'user supplied reference',
      )
      expect(projection.materials.reviewDocumentPath).toMatch(/^\.agent-workflow\/inputs\/graph\//)
      expect(
        readFileSync(
          join(physical(first.workspacePath), projection.materials.reviewDocumentPath),
          'utf8',
        ),
      ).toBe(basis.files.find((file) => file.path === 'implementation.md')!.content)
      writeFileSync(
        join(physical(first.workspacePath), 'app.txt'),
        'discard this retry partial output',
      )
      const changed = structuredClone(document)
      changed.elements[0]!.description = 'later semantic edit'
      await f.commands.change(document.id, {
        requestId: 'later',
        expectedRevision: document.revision,
        document: changed,
      })
      const restored = await workspace.prepare({
        planJson: JSON.stringify(plan),
        attemptJson: JSON.stringify({ ordinal: 2, mode: 'fresh-scene' }),
      })
      expect(readFileSync(join(physical(restored.workspacePath), 'app.txt'), 'utf8')).toBe(
        'baseline',
      )
      expect(JSON.parse(restored.contractProjectionJson).materials.basis.digest).toBe(basis.digest)
      expect(
        (await workspace.validate({ roundRef: 'round', taskStatus: 'done', outputJson: '{broken' }))
          .ok,
      ).toBe(false)
      if (deployment === 'hosted') {
        expect(operations).toContain('employee-case')
        expect(operations.some((op) => op.includes('development'))).toBe(true)
      }
    }, 30_000)
})
