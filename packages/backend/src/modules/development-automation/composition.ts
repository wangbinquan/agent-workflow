// development-automation 装配入口（RFC-310）。
//
// 仅装配点可 import 本文件；它只做实例化与注入——不查 DB、无业务 if/switch、
// 不翻译 DTO（RFC-294 §2；本文件的「无业务分支」由 rfc310-architecture-lock
// 文本扫描强制）。消费者账本在 rfc310-architecture-lock.test.ts，增删一条都要
// 显式修订。PR-3 起真实装配：EvidenceStore、requirement materializer、upload
// placement、reconciler deps 与 sweep/recover 用例的读侧绑定。
// requirementSource（外部取件 runner）由装配点注入——它由 integration 模块
// 组装（modules/integration/composition/requirementSource.ts），本文件不得
// 跨 context import 其内部（rfc294 preflight 债务账本为空增长）。
// Agent launcher / MR·pipeline collector 端口随 PR-5/PR-6/PR-7 注入。

import { join } from 'node:path'

import type { DbClient } from '@/db/client'
import {
  runMissionReconcile,
  type ReconcileDeps,
  type ReconcileOutcome,
} from './application/missionReconciler'
import { recoverMissions } from './application/missionRecovery'
import { sweepMissionWakes } from './application/missionWakeSweep'
import type {
  AgentActionLauncherPort,
  ChangeCandidatePort,
  ReconcilerPorts,
} from './application/ports/reconcilerPorts'
import {
  createAttemptContextStore,
  createWorkspaceValidationAdapter,
} from './infrastructure/attemptSupport'
import { discardWorkspace, materializeActionWorkspace } from './infrastructure/actionWorkspace'
import { EvidenceStore } from './infrastructure/evidenceStore'
import { resolveActionBaseline } from './infrastructure/gitBaselineReader'
import {
  createRequirementMaterializer,
  type RequirementMaterializer,
  type RequirementSourceRunnerDep,
} from './infrastructure/requirementMaterializer'
import { createSqliteAdmissionLookup } from './infrastructure/sqliteAdmissionLookup'
import {
  createSqliteFactSnapshotReader,
  listFencedMissionIds,
  listPreparedEffectRows,
  listUnconsumedWakeHintMissionIds,
  missionEpochsOf,
} from './infrastructure/sqliteReconcilerReaders'
import { createSqliteMissionStore } from './infrastructure/sqliteMissionStore'
import { createSqliteActionTemplateStore } from './infrastructure/sqliteConfigResourceStore'
import { readUploadPlan } from './infrastructure/sqliteUploadPlanStore'
import { createSqliteUploadSessionStore } from './infrastructure/sqliteUploadSessionStore'
import { createUploadPlacementProvider } from './infrastructure/uploadPlacement'

export interface DevelopmentAutomationModule {
  readonly materializer: RequirementMaterializer
  readonly evidence: EvidenceStore
  reconcile(missionId: string): Promise<ReconcileOutcome>
  /** 30s 级 sweep：到期 durable wake（fireWake CAS 认领）+ 未消费 wake hint。 */
  sweepWakes(): Promise<{ reconciled: number }>
  /** hourly：未 claim 上传的 TTL 回收。 */
  sweepUploads(): { swept: number }
  /** daemon 启动恢复：fence 悬挂 / epoch 过期 effect / 到期 wake。 */
  recover(): Promise<{ settledFences: number; invalidatedEffects: number; firedWakes: number }>
}

export function composeDevelopmentAutomation(deps: {
  readonly db: DbClient
  readonly appHome: string
  /** integration 模块组装的外部需求源 runner；不注入 = 外部取件诚实 blocked。 */
  readonly requirementSource?: RequirementSourceRunnerDep
  /** task-execution 模块组装的 agent 执行 runner；不注入 = 动作发射诚实 blocked。 */
  readonly agentLauncher?: AgentActionLauncherPort
  /** source-control 模块组装的 candidate 派生；不注入 = changed 结算诚实 blocked。 */
  readonly changeCandidate?: ChangeCandidatePort
}): DevelopmentAutomationModule {
  const now = (): number => Date.now()
  const store = createSqliteMissionStore(deps.db)
  const lookup = createSqliteAdmissionLookup(deps.db)
  const snapshots = createSqliteFactSnapshotReader(deps.db)
  const evidence = new EvidenceStore(join(deps.appHome, 'evidence'))
  const materializer = createRequirementMaterializer({
    db: deps.db,
    store,
    snapshots,
    evidence,
    stagingRoot: join(deps.appHome, 'evidence', 'staging'),
    ...(deps.requirementSource === undefined ? {} : { source: deps.requirementSource }),
    now,
  })
  const uploads = createSqliteUploadSessionStore(deps.db)
  const seedsRoot = join(deps.appHome, 'evidence', 'seeds')
  const templates = createSqliteActionTemplateStore(deps.db)
  const ports: ReconcilerPorts = {
    requirementMaterialize: materializer,
    uploadPlacement: createUploadPlacementProvider({
      db: deps.db,
      evidence,
      seedsRoot,
      now,
    }),
    ...(deps.agentLauncher === undefined ? {} : { agentLauncher: deps.agentLauncher }),
    ...(deps.changeCandidate === undefined ? {} : { changeCandidate: deps.changeCandidate }),
    actionBaseline: { resolve: resolveActionBaseline(deps.db) },
    actionWorkspace: {
      materialize: (input) =>
        materializeActionWorkspace(
          { evidence, seedsRoot, workspacesRoot: join(deps.appHome, 'workspaces', 'actions') },
          input,
        ),
      discard: discardWorkspace,
    },
    uploadPlanReader: { read: (planId) => readUploadPlan(deps.db, planId) },
    attemptContext: createAttemptContextStore(evidence),
    actionTemplates: {
      content: (id, revision) => {
        const row = templates.getRevision(id, revision)
        return row === null ? null : (JSON.parse(row.contentJson) as unknown)
      },
    },
    workspaceValidation: createWorkspaceValidationAdapter(),
  }
  const reconcileDeps: ReconcileDeps = { store, lookup, snapshots, ports, now }

  return {
    materializer,
    evidence,
    reconcile: (missionId) => runMissionReconcile(reconcileDeps, missionId),
    sweepWakes: () =>
      sweepMissionWakes(reconcileDeps, {
        listUnconsumedWakeHintMissionIds: () => listUnconsumedWakeHintMissionIds(deps.db),
      }),
    sweepUploads: () => ({ swept: uploads.sweepExpired(now()) }),
    recover: () =>
      recoverMissions(reconcileDeps, {
        listFencedMissionIds: () => listFencedMissionIds(deps.db),
        listPreparedEffectRows: () => listPreparedEffectRows(deps.db),
        missionEpochsOf: (ids) => missionEpochsOf(deps.db, ids),
      }),
  }
}
