// RFC-284 T25（§4，审计 N10）—— multipart 启动编排主体自 routes/tasks.ts 迁入。
//
// 独立成模块（而非并入 launchMultipart.ts 解析骨架）：agentLaunch.ts 复用骨架
// 且身处 executor 运行链上游，编排体 import executor/task 会经
// launchMultipart⇄agentLaunch 闭合运行时环（no-circular 实抓过一次）。本模块
// 只被路由消费、无人回指——骨架保持叶子，编排在此持有全部重依赖。
// 两臂对拍（JSON/multipart 门检顺序与错误码不变）由 rfc107/rfc165/rfc248/
// rfc292 启动套件承担。

import {
  rejectRetiredStartTaskKeys,
  StartTaskSchema,
  UPLOAD_INPUTS_DIR,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { startExecution } from '@/services/execution/executor'
import {
  bufferUploadParts,
  collectUploadInputDefs,
  attachWorkspaceCleanupToMultipartError,
  parseMultipartLaunch,
  resolveUploadLimits,
} from '@/services/launchMultipart'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import {
  createLegacyTaskExecutionTopology,
  resolveSubagentLiveCapture,
} from '@/services/startTaskDeps'
import { assertWorkflowLaunchable } from '@/services/taskLaunchGate'
import { assertCanReplaySourceTask } from '@/services/taskCollab'
import {
  cleanupMaterializedSpace,
  materializeSpace,
  prepareWorkflowTriggerLaunch,
  resolveTaskGitCommitIdentity,
} from '@/services/task'
import { applyUploadsToWorktree, validateUploadPlan } from '@/services/upload'
import { buildWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'
import { assertWorkflowLaunchInputs } from '@/services/workflowLaunchInputs'
import { Paths } from '@/util/paths'
import { ConflictError, ValidationError } from '@/util/errors'

export interface MultipartLaunchDeps {
  db: DbClient
  secretBox?: SecretBox
  configPath: string
}

export async function handleMultipartTaskStart(
  req: Request,
  deps: MultipartLaunchDeps,
  actor: Actor,
) {
  // 1. Parse the form: JSON `payload` field + `files[<key>][]` parts (bytes
  // are NOT buffered yet — that waits for the defs membership check below).
  const { payloadJson, parts: uploadParts } = await parseMultipartLaunch(req)
  // RFC-099 (D6): reject payloads still carrying the removed assignments field.
  if (
    typeof payloadJson === 'object' &&
    payloadJson !== null &&
    Object.prototype.hasOwnProperty.call(payloadJson, 'assignments')
  ) {
    throw new ValidationError(
      'assignments-removed',
      'RFC-099 removed per-node assignments; task members answer reviews/clarifications now',
    )
  }
  // RFC-165 (F1): same raw-key gate as the JSON route (multipart payloads
  // are just as spoofable).
  {
    const retired = rejectRetiredStartTaskKeys(payloadJson)
    if (retired !== null) {
      const clientOwnedGitIdentity = retired === 'gitUserName' || retired === 'gitUserEmail'
      throw new ValidationError(
        clientOwnedGitIdentity ? 'task-git-identity-client-owned' : 'start-task-path-retired',
        clientOwnedGitIdentity
          ? `RFC-320 derives Git commit identity from the task creator; remove '${retired}'`
          : `RFC-165 retired path-mode launches; remove '${retired}' (push the repo to a real remote and register it, then launch by cachedRepoId)`,
      )
    }

    // RFC-248 H9（实现门 P1）：`sourceTaskId` 由调用方控制。重放前先确认
    // 他**看得见**那个任务——否则「能启动某工作流但看不见任务 X」的用户可以
    // 传 X 的 id，让服务端读出 X 冻结的仓库构成并按它物化，而且泄漏形式是
    // 「任务成功启动」，完全不像一次越权。不可见与不存在同形（都 404）。
    {
      const src = (payloadJson as { sourceTaskId?: unknown }).sourceTaskId
      if (typeof src === 'string' && src.length > 0) {
        await assertCanReplaySourceTask(deps.db, actor, src)
      }
    }
  }
  const parsed = StartTaskSchema.safeParse(payloadJson)
  if (!parsed.success) {
    throw new ValidationError('task-invalid', 'invalid task payload', {
      issues: parsed.error.issues,
    })
  }
  const startInput = parsed.data

  // 2. Resolve workflow → extract upload input declarations. RFC-099 (D3):
  // the launcher must be able to use the workflow; invisible == missing.
  const launchRuntime = resolveLaunchRuntimeConfig(deps.configPath)
  const workflow = await assertWorkflowLaunchable(deps.db, actor, startInput.workflowId)
  // RFC-199 G1: reject a stale launch guard against the SAME visible row we
  // just captured, before URL resolution can mint a cache row/worktree/branch.
  // startTask intentionally retains its own pre-materialize and final-tx
  // fences for races that occur after this route-level fast refusal.
  if (
    startInput.expectedWorkflowVersion !== undefined &&
    workflow.version !== startInput.expectedWorkflowVersion
  ) {
    throw new ConflictError(
      'workflow-version-mismatch',
      `workflow '${startInput.workflowId}' changed during launch (expected v${startInput.expectedWorkflowVersion}, now v${workflow.version})`,
      {
        expectedVersion: startInput.expectedWorkflowVersion,
        currentVersion: workflow.version,
      },
    )
  }
  const uploadDefs = collectUploadInputDefs(workflow.definition.inputs)

  // 3. Every bound part must target a declared upload input; only then are
  // bytes copied out of the form (impl-gate P2-4).
  const uploadFiles = await bufferUploadParts(uploadParts, uploadDefs)

  const routeLaunchDeps = {
    db: deps.db,
    schedulerDriver: createLegacyTaskExecutionTopology(deps.db).schedulerDriver,
    actorUserId: actor.user.id,
    ...(deps.secretBox !== undefined ? { secretBox: deps.secretBox } : {}),
    configPath: deps.configPath,
    ...launchRuntime,
    launchActor: actor,
  }
  const gitCommitIdentity = await resolveTaskGitCommitIdentity(routeLaunchDeps)
  const resolvedRouteLaunchDeps = { ...routeLaunchDeps, gitCommitIdentity }
  // RFC-292: freeze and scan root + call closure before repo resolution,
  // cloning, worktree creation or upload writes. startTask repeats this check
  // after the handoff to close the route/service race.
  const frozenClosureJson = await prepareWorkflowTriggerLaunch({
    deps: resolvedRouteLaunchDeps,
    workflowId: workflow.id,
    definition: workflow.definition,
  })

  // 4. Materialize the space first so we have a real path to write into.
  const appHome = Paths.root
  // RFC-248 D12: RFC-066 的「多仓 + 上传」禁令已解除——上传物落到任务根下的
  // 固定目录 `.agent-workflow/inputs/`，不属于任何成员仓（见 applyUploadsToWorktree
  // 的 inputsSubdir）。原本这里与 services/task.ts 各有一道 422 门，两处一并删除。
  // RFC-107 (Codex design-gate F1): run the SAME static workflow validation
  // startTask runs (services/task.ts) BEFORE resolving/cloning the repo. JSON
  // launches validate before any repo resolution; the multipart path
  // materializes the worktree before startTask, so without this an
  // invalid-but-visible workflow with an upload input would clone + populate
  // the gitRepoCache (network + a cache row) and only THEN fail validation —
  // diverging from JSON URL mode. Refuse up front so a bad workflow never
  // triggers a clone. startTask validates again; validateWorkflowDef is a pure,
  // side-effect-free function so the double check is cheap.
  {
    const validation = validateWorkflowDef(
      workflow.definition,
      await buildWorkflowValidationContext(deps.db, {
        definition: workflow.definition,
        currentWorkflow: { id: workflow.id, name: workflow.name },
        frozenClosureJson,
      }),
    )
    if (!validation.ok) {
      const errors = validation.issues.filter((i) => (i.severity ?? 'error') === 'error')
      throw new ValidationError(
        'workflow-invalid',
        `workflow '${startInput.workflowId}' failed static validation (${errors.length} error${errors.length === 1 ? '' : 's'}); fix issues before starting a task`,
        { issues: validation.issues },
      )
    }
  }
  // Upload paths do not exist in the payload yet; validate every other
  // authored input before materializing the workspace. validateUploadPlan
  // owns upload counts now, and startTask repeats the full map check after
  // applyUploadsToWorktree packs the server-written paths.
  assertWorkflowLaunchInputs(workflow.definition.inputs, startInput.inputs, {
    ignoreUploadInputs: true,
  })
  // RFC-107 (Codex impl-gate): validate the uploads (count / total + per-file
  // size / accept / min-max) BEFORE resolving or cloning the repo. Otherwise a
  // valid repoUrl + a bad upload would clone the repo and leave an orphan
  // worktree before applyUploadsToWorktree rejected it. The write phase re-runs
  // these checks; limits are resolved once and reused at step 5.
  const limits = resolveUploadLimits(deps.configPath)
  validateUploadPlan({ defs: uploadDefs, files: uploadFiles, limits })
  // RFC-165 (F3): resolve + materialize via the single tagged entry —
  // `materializeSpace` handles URL mode (clone into gitRepoCache), path mode
  // and scratch alike, resolving each source EXACTLY ONCE (RFC-107 D1-B is
  // internal to it) and carrying materialize failure in its `earlyError` arm
  // instead of throwing — so the failure handoff below mints ONE failed row
  // without re-resolving or re-materializing. Working branch + git identity
  // thread through exactly like the JSON path (RFC-107 F2/D5). A URL
  // clone/resolve failure still throws the same structured 4xx a JSON launch
  // would (no task row). scratch + uploads is a legal combination: the files
  // land in the fresh scratch repo.
  // RFC-248（实现门 P1）：预物化也要带上 `secretBox`。组成员一律按 `cachedRepoId`
  // 解析，私有仓的 URL 是**封存**的，没有 box 就解不开 ⇒
  // `cached-repo-credential-unavailable`。少了它，「私有仓组 + 上传」这条被 D12
  // 明确解禁的组合会必失败，而完全等价的 JSON 启动却能成功。
  const space = await materializeSpace(startInput, resolvedRouteLaunchDeps, appHome)
  const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
  if (space.earlyError !== null) {
    // Create a failed task row so the user sees the error. No files were
    // written (the workspace never fully existed; scratch already cleaned).
    const task = await startExecution(
      deps.db,
      actor,
      {
        kind: 'workflow',
        refId: startInput.workflowId,
        invoker: { type: 'user', launchKind: 'direct-multipart' },
        payload: startInput,
      },
      {
        ...resolvedRouteLaunchDeps,
        ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
        materializedSpace: space,
      },
    )
    return task
  }

  // 5. Write uploads + pack paths back into inputs[] (limits resolved at step 4).
  let inputsOut: Record<string, string>
  try {
    const result = await applyUploadsToWorktree({
      worktreePath: space.worktreePath,
      // RFC-248 D12: 多仓任务的上传物落到任务根下的固定目录，不属于任何成员仓。
      // 单仓不传 ⇒ 路径与今天字节级一致。
      // RFC-248 D12（实现门 P1）：按**空间类型**判定，不看仓数。组空间即便只展平出
      // 一个成员（sparse / 非根挂载），上传物也必须落在任务根下的保留目录——
      // 用 `repos.length > 1` 会让那种组把上传物写进成员仓的工作树。
      // 单仓 / scratch 不传 ⇒ 路径与今天字节级一致。
      ...(space.kind === 'group' ? { inputsSubdir: UPLOAD_INPUTS_DIR } : {}),
      defs: uploadDefs,
      files: uploadFiles,
      limits,
    })
    inputsOut = { ...startInput.inputs }
    for (const [key, paths] of result.packedByKey.entries()) {
      inputsOut[key] = paths.join('\n')
    }
  } catch (err) {
    // No task row owns this materialization. Consume the same explicit cleanup
    // lease startTask uses (normal linked worktree, scratch, or future shapes),
    // rather than guessing ownership from `space.kind`.
    const cleanup = await cleanupMaterializedSpace(space)
    throw attachWorkspaceCleanupToMultipartError(err, cleanup)
  }

  // 6. Hand off ownership to the launch (via the RFC-243 executor facade —
  // same startTask underneath). Its outer wrapper now covers every pre-commit
  // error (including the initial exact-version guard), so this call
  // intentionally sits outside the upload-write catch above.
  return await startExecution(
    deps.db,
    actor,
    {
      kind: 'workflow',
      refId: startInput.workflowId,
      invoker: { type: 'user', launchKind: 'direct-multipart' },
      payload: { ...startInput, inputs: inputsOut },
    },
    {
      ...resolvedRouteLaunchDeps,
      ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
      materializedSpace: space,
    },
  )
}
