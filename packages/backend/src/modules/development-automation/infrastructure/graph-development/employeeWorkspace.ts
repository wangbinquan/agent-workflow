import { z } from 'zod'
import {
  canonicalJson,
  PLATFORM_WORKSPACE_DIR,
  repositoryMaterializationCommit,
  type RepositoryContentBaseline,
} from '@agent-workflow/shared'
import type {
  EmployeeReactionRoundQueryPort,
  WorkspaceFailureClass,
} from '@/modules/digital-employee/public/types'
import type { EmployeeCaseWorkspaceParticipant } from '@/modules/source-control/public/types'
import { stableIdentityComponent } from '@/util/gitRef'
import { graphDigest } from '../../domain/graph-development/model'
import { sha256Hex } from '@/util/hash'
import { ValidationError } from '@/util/errors'
import type { GraphVerificationWorkspace } from '../../application/graph-development/verification'
import {
  GRAPH_DESIGN_AUTHORING_RULES,
  graphToolResultSchema,
} from '../../application/graph-development/toolContracts'
import { GRAPH_DEFAULT_PLANNING_BUDGET } from '../../domain/graph-development/selectViews'
import type { GraphEmployeeContext } from '../../application/graph-development/employeeCodec'
import { GRAPH_VIEW_CAPABILITIES } from '../../domain/graph-development/viewCapabilities'
import type { GraphDesignArtifacts } from '../../application/ports/graphDesignArtifacts'
import type { GraphDesignStore } from '../../application/ports/graphDesignStore'
import type { AutomationWorkspaceEffectsFactory } from '../../application/ports/automationWorkspaceEffects'
import type { GraphDesignCommands } from '../../application/graph-development/designCommands'
import {
  GraphReactionPlanSchema,
  graphReactionMaterial,
  graphWork,
} from '../../application/graph-development/reactionMaterial'
import { businessTreeSnapshot, validateWorkspaceOutcome } from '../workspaceValidator'
import {
  snapshotProtectedRoots,
  serializeProtectedRootSnapshot,
  reviveProtectedRootSnapshot,
} from '../protectedSnapshot'
import { GIT_METADATA_SKIP_PREFIXES } from '../attemptSupport'
import { withAutomationWorkspaceEffects } from '../automationWorkspaceEffects'

export interface GraphWorkspaceState extends GraphVerificationWorkspace {
  readonly baselineRepoPath: string
  readonly baseline: RepositoryContentBaseline
  readonly targetBranch: string
  readonly remoteHeadSha: string | null
  readonly workspacePath: string
}
export function createGraphEmployeeWorkspace(deps: {
  readonly appHome: string
  readonly factory: AutomationWorkspaceEffectsFactory
  readonly store: GraphDesignStore
  readonly artifacts: GraphDesignArtifacts
  readonly commands: GraphDesignCommands
  readonly rounds: EmployeeReactionRoundQueryPort
  readonly sourceControl: EmployeeCaseWorkspaceParticipant
  readonly repositoryPreparation: {
    prepare(input: {
      repositoryId: string
    }): Promise<{ id: string; localPath: string; defaultBranch: string | null }>
  }
  readonly inputArtifacts: { copyBlobTo(blobRef: string, target: string): void | Promise<void> }
  readonly consumeResult: (input: { planJson: string; outputJson: string }) => Promise<void>
  readonly verificationProfiles: () => Promise<readonly unknown[]>
}) {
  const factory = deps.factory
  async function resolveBaseline(repositoryId: string, targetBranch: string | null) {
    const repository = await deps.repositoryPreparation.prepare({ repositoryId })
    const baseline = await deps.sourceControl.resolveBaseline({
      baselineRepoPath: repository.localPath,
      preferredBranch: targetBranch ?? repository.defaultBranch,
      sourceBranch: null,
      allowUnborn: true,
    })
    if (!baseline.contentBaseline) throw new Error('graph-repository-baseline-missing')
    return { repository, baseline }
  }
  async function state(designId: string): Promise<GraphWorkspaceState> {
    const record = await deps.store.record(designId, 'workspace')
    if (!record || record.status !== 'ready') throw new Error('graph-workspace-not-ready')
    return JSON.parse(record.payloadJson) as GraphWorkspaceState
  }
  async function initialize(work: GraphEmployeeContext) {
    const existing = await deps.store.record(work.designId, 'workspace')
    if (existing?.status === 'ready') return await state(work.designId)
    const document = await deps.commands.document(work.designId)
    if (!document.repositoryBaseline) throw new Error('graph-repository-baseline-missing')
    const repository = await deps.repositoryPreparation.prepare({ repositoryId: work.repositoryId })
    const caseRoot = factory.resolve(
      factory.applicationRootReference ?? deps.appHome,
      'graph-development',
      stableIdentityComponent(work.caseId),
    )
    const workspace = await deps.sourceControl.materialize({
      caseRoot,
      baselineRepoPath: repository.localPath,
      baselineSha: repositoryMaterializationCommit(document.repositoryBaseline),
    })
    const entries: NonNullable<GraphVerificationWorkspace['uploadPlan']>['entries'][number][] = []
    const value: GraphWorkspaceState = {
      baselineRepoPath: repository.localPath,
      baseline: document.repositoryBaseline,
      targetBranch: work.request.targetBranch ?? repository.defaultBranch ?? 'main',
      remoteHeadSha:
        document.repositoryBaseline.kind === 'commit'
          ? document.repositoryBaseline.commitSha
          : null,
      workspacePath: workspace.workspacePath,
    }
    await withAutomationWorkspaceEffects(factory, async (effects) => {
      const root = factory.resolve(
        workspace.workspacePath,
        PLATFORM_WORKSPACE_DIR,
        'inputs',
        'graph',
      )
      await effects.createDirectory(root, true)
      await effects.writeText(factory.resolve(root, 'request.md'), work.request.body ?? '')
      for (const [index, upload] of work.request.uploads.entries()) {
        const relative =
          upload.placement === 'repository'
            ? upload.targetPath
            : `${PLATFORM_WORKSPACE_DIR}/inputs/graph/uploads/${index}-${stableIdentityComponent(upload.originalName)}`
        if (
          !relative ||
          relative.startsWith('/') ||
          relative.split(/[\\/]/).some((part) => part === '..' || part === '')
        )
          throw new Error('graph-upload-target-invalid')
        const target = factory.resolve(workspace.workspacePath, relative)
        if (upload.placement === 'repository') {
          const existing = await effects.exists(target)
          const same = existing && sha256Hex(await effects.readBytes(target)) === upload.sha256
          entries.push({
            targetPath: relative,
            contentPolicy: 'agent-editable',
            fileMode: 'regular',
            disposition: same ? 'already-present' : existing ? 'replace' : 'create',
            uploadSha256: upload.sha256,
          })
        }
        // Repository input files are explicit intake material, not speculative model output.
        await effects.createDirectory(factory.parent(target), true)
        await deps.inputArtifacts.copyBlobTo(
          upload.artifactRef.slice('employee-input:'.length),
          target,
        )
      }
    })
    const record = await deps.commands.beginRecord(work.designId, 'workspace', 'workspace', {
      baseline: document.repositoryBaseline,
      repositoryId: work.repositoryId,
    })
    const ready = { ...value, uploadPlan: { planDigest: graphDigest(entries), entries } }
    await deps.commands.finishRecord(record, 'ready', ready)
    return ready
  }
  const roots = (workspacePath: string) => ({
    'git-meta': factory.resolve(workspacePath, '.git'),
    evidence: factory.resolve(workspacePath, PLATFORM_WORKSPACE_DIR),
  })
  const skips = { 'git-meta': GIT_METADATA_SKIP_PREFIXES }
  return {
    state,
    initialize,
    resolveBaseline,
    async prepare(input: { planJson: string; attemptJson: string }) {
      const plan = GraphReactionPlanSchema.parse(JSON.parse(input.planJson))
      const material = await graphReactionMaterial(plan, deps)
      const workspace = await initialize(material.work)
      const attempt = z
        .object({ ordinal: z.number(), mode: z.string() })
        .passthrough()
        .parse(JSON.parse(input.attemptJson))
      const initial = (await deps.store.records(material.work.designId))
        .filter((row) => row.kind === 'scene' && row.id.startsWith(`scene:${plan.roundRef}:`))
        .sort((a, b) => Number(a.id.split(':').at(-1)) - Number(b.id.split(':').at(-1)))[0]
      const checkpointRoot = factory.resolve(
        factory.parent(factory.parent(workspace.workspacePath)),
        'checkpoints',
        stableIdentityComponent(plan.roundRef),
      )
      if (attempt.mode === 'fresh-scene') {
        const snapshot = initial
          ? (JSON.parse(initial.payloadJson) as { checkpointDigest?: string })
          : null
        if (!snapshot?.checkpointDigest) throw new Error('graph-workspace-checkpoint-missing')
        await deps.sourceControl.restore({
          caseRoot: factory.parent(workspace.workspacePath),
          baselineRepoPath: workspace.baselineRepoPath,
          baselineSha: repositoryMaterializationCommit(workspace.baseline),
          checkpointRoot,
          expectedCheckpointDigest: snapshot.checkpointDigest,
        })
      }
      const materialDirectory = `${PLATFORM_WORKSPACE_DIR}/inputs/graph/${stableIdentityComponent(plan.roundRef)}`
      const roundPath = factory.resolve(workspace.workspacePath, materialDirectory)
      const recordId = `scene:${plan.roundRef}:${attempt.ordinal}`
      const before = await deps.store.record(material.work.designId, recordId)
      if (!before && !initial) {
        await withAutomationWorkspaceEffects(factory, async (effects) => {
          await effects.createDirectory(roundPath, true)
          await effects.writeText(
            factory.resolve(roundPath, 'design.json'),
            canonicalJson(material.document),
          )
          if (material.basis)
            for (const file of material.basis.basis.files) {
              const target = factory.resolve(roundPath, file.path)
              await effects.createDirectory(factory.parent(target), true)
              await effects.writeText(target, file.content)
            }
        })
      }
      const projection = initial
        ? (
            JSON.parse(initial.payloadJson) as {
              projection: { materials: Record<string, unknown> }
            }
          ).projection
        : {
            materials: {
              document: material.document,
              request: material.request,
              capabilityCatalog: GRAPH_VIEW_CAPABILITIES,
              authoringRules: GRAPH_DESIGN_AUTHORING_RULES,
              planningBudget: GRAPH_DEFAULT_PLANNING_BUDGET,
              verificationProfiles: await deps.verificationProfiles(),
              basis: material.basis?.basis ?? null,
              // Workflow nodes run in their selected workspace; paths in the contract
              // must survive materialization into a different local or hosted root.
              materialDirectory,
              reviewDocumentPath: material.basis ? `${materialDirectory}/implementation.md` : null,
            },
          }
      if (!before) {
        const checkpoint = initial
          ? {
              checkpointDigest: (JSON.parse(initial.payloadJson) as { checkpointDigest: string })
                .checkpointDigest,
            }
          : await deps.sourceControl.checkpoint({
              workspacePath: workspace.workspacePath,
              checkpointRoot,
            })
        const pre = initial
          ? {
              ...(JSON.parse(initial.payloadJson) as object),
              projection,
              attemptJson: input.attemptJson,
            }
          : {
              ...checkpoint,
              protected: serializeProtectedRootSnapshot(
                await snapshotProtectedRoots(
                  roots(workspace.workspacePath),
                  { skipPrefixesByRoot: skips },
                  factory,
                ),
              ),
              business: [...(await businessTreeSnapshot(workspace.workspacePath, factory))],
              projection,
              planJson: input.planJson,
              attemptJson: input.attemptJson,
            }
        await deps.store.insertRecord({
          designId: material.work.designId,
          id: recordId,
          kind: 'scene',
          requestDigest: graphDigest(input),
          status: 'prepared',
          version: 1,
          payloadJson: canonicalJson(pre),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      }
      return {
        kind: 'repository' as const,
        workspacePath: workspace.workspacePath,
        baselineSha: repositoryMaterializationCommit(workspace.baseline),
        platformInputPaths: [`${PLATFORM_WORKSPACE_DIR}/inputs/graph`],
        contractProjectionJson: canonicalJson(
          before
            ? (JSON.parse(before.payloadJson) as { projection: unknown }).projection
            : projection,
        ),
      }
    },
    async validate(input: { roundRef: string; taskStatus: string; outputJson: string | null }) {
      const frozen = await deps.rounds.frozenPlan(input.roundRef)
      if (!frozen)
        return {
          ok: false as const,
          errorClass: 'infrastructure' as WorkspaceFailureClass,
          errorCode: 'graph-plan-missing',
          errorDetail: input.roundRef,
        }
      const plan = GraphReactionPlanSchema.parse(JSON.parse(frozen.planJson))
      const work = graphWork(plan),
        workspace = await state(work.designId)
      const scenes = (await deps.store.records(work.designId))
        .filter((row) => row.kind === 'scene' && row.id.startsWith(`scene:${input.roundRef}:`))
        .sort((a, b) => Number(b.id.split(':').at(-1)) - Number(a.id.split(':').at(-1)))
      const scene = scenes[0]
      if (!scene || !input.outputJson)
        return {
          ok: false as const,
          errorClass: 'infrastructure' as WorkspaceFailureClass,
          errorCode: 'graph-scene-output-missing',
          errorDetail: input.roundRef,
        }
      const snapshot = JSON.parse(scene.payloadJson) as {
        protected: ReturnType<typeof serializeProtectedRootSnapshot>
        business: [string, string][]
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(input.outputJson)
      } catch {
        return {
          ok: false as const,
          errorClass: 'semantic' as WorkspaceFailureClass,
          errorCode: 'graph-output-invalid',
          errorDetail: 'Expected business JSON',
        }
      }
      const result = graphToolResultSchema(plan.workItemRef).safeParse(parsed)
      if (!result.success)
        return {
          ok: false as const,
          errorClass: 'semantic' as WorkspaceFailureClass,
          errorCode: 'graph-output-invalid',
          errorDetail: result.error.message.slice(0, 4000),
        }
      const writing = plan.workItemRef === 'implement-change'
      const checked = await validateWorkspaceOutcome(
        {
          workspacePath: workspace.workspacePath,
          preProtected: reviveProtectedRootSnapshot(snapshot.protected),
          protectedRoots: roots(workspace.workspacePath),
          protectedSkipPrefixesByRoot: skips,
          preBusinessTree: new Map(snapshot.business),
          outcome: writing ? 'changed' : 'no-change',
          workspaceMode: writing ? 'edit-business-files' : 'read-only',
          writablePrefixes: [],
          preservePaths: [],
          editablePaths: [],
          budget: { maxChangedFiles: 10_000, maxTotalBytes: 128 * 1024 * 1024 },
        },
        factory,
      )
      if (!checked.ok)
        return {
          ok: false as const,
          errorClass: checked.kind as WorkspaceFailureClass,
          errorCode: `graph-workspace-${checked.code}`,
          errorDetail: checked.detail,
        }
      try {
        await deps.consumeResult({ planJson: frozen.planJson, outputJson: input.outputJson })
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error
        return {
          ok: false as const,
          errorClass: 'semantic' as WorkspaceFailureClass,
          errorCode: error.code,
          errorDetail: error.message.slice(0, 4000),
        }
      }
      return { ok: true as const }
    },
  }
}
