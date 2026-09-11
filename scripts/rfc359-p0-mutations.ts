// RFC-359 AC7: current green -> exact historical regressions red -> current green.
// Only Bun/Node builtins are used by this runner. The subprocess preload replaces
// real exports in memory; all selected tests use their existing real DB harness.
// Usage: bun scripts/rfc359-p0-mutations.ts --providers sqlite,postgresql
//        --output-dir test-results/rfc359-p0-mutations
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

type Provider = 'sqlite' | 'postgresql'
interface TestCase {
  readonly file: string
  readonly suite: string
  readonly name: string
}
interface ExpectedFailure {
  readonly test: TestCase
  readonly diagnostics: readonly RegExp[]
}
export interface Phase {
  readonly id: string
  readonly mutation?: string
  readonly passes: readonly TestCase[]
  readonly failures: readonly ExpectedFailure[]
}

const clarifyTurn: TestCase = {
  file: 'packages/backend/tests/rfc359-t7e-workgroup-clarify-ask-gate.test.ts',
  suite: 'RFC-359 T7e —— 工作组反问许可（clarify ask gate）',
  name: 'P0-12 实际回合：worker 收到反问协议与持久化 nonce，awaiting 结果把 assignment 停在 awaiting_human',
}
const spentBudget: TestCase = {
  ...clarifyTurn,
  name: 'P0-12 实际回合：同 assignment 已问满预算，worker 不再收到反问邀请且仍能交付',
}
const finalize: TestCase = {
  file: 'packages/backend/tests/rfc359-t2b-clarify-decision.test.ts',
  suite: 'RFC-359 T2b —— 快速澄清决定命令（clarifyDecisions）',
  name: '整轮 finalize：round answered、澄清 node_run done、self 条目 sealed+dispatched、铸 clarify-answer rerun、回执 + 事件 + 蒸馏入队',
}
const staleClarify: TestCase = {
  ...finalize,
  name: 'P0-5（T5）：澄清 node_run 已离开 awaiting_human 时整轮 seal 仍成功——CAS 安全 no-op，不 409、答案不回滚',
}
const deferred: TestCase = {
  file: 'packages/backend/tests/rfc359-t1-deferred-question-dispatch.test.ts',
  suite: 'RFC-359 T1 —— 延迟提问自动派发（P0-7）',
  name: '混批 defer 盖列 → 承接 rerun done 后 autoDispatch 补发（__system__）并铸造 rerun',
}
const park: TestCase = {
  ...deferred,
  name: 'park 投影：未派发的 designer 条目让其 home 停车；派发后释放',
}
const rootExecution: TestCase = {
  file: 'packages/backend/tests/rfc359-w5-t21b-execution-chain.test.ts',
  suite: 'RFC-359 W5-T21b real root launch -> TaskEngine -> node -> done',
  name: 'persists task launch, runs the agent subprocess, projects output and releases its owner',
}
const corruptWorkflowDelete: TestCase = {
  file: 'packages/backend/tests/rfc359-t6-corrupt-workflow-delete.test.ts',
  suite: 'RFC-359 T6 —— 定义损坏的工作流可删（P0-6）',
  name: '坏 JSON 定义：owner 走目录删除命令成功，行消失',
}
const staleCorruptWorkflowDelete: TestCase = {
  ...corruptWorkflowDelete,
  name: '版本不匹配：坏定义的行也只报 409 stale，不 422',
}
const workflowRepositoryControl: TestCase = {
  file: 'packages/backend/tests/rfc359-w12-workflow-codec-conformance.test.ts',
  suite: 'RFC-359 W12 —— workflow codec',
  name: '真实仓库 create/get/save/replay/stale 的回执与持久化投影一致',
}
const legacyAgent: TestCase = {
  file: 'packages/backend/tests/rfc359-w14-legacy-mission-execution.test.ts',
  suite: 'RFC-359 P0-9 legacy mission real execution',
  name: 'agent action reaches done and its terminal observer settles the legacy attempt',
}
const legacyScript: TestCase = {
  ...legacyAgent,
  name: 'script action reaches done and its terminal observer settles the legacy attempt',
}
const skillBootRecovery: TestCase = {
  file: 'packages/backend/tests/rfc359-t7d-postgresql-skill-catalog-boot.test.ts',
  suite: 'RFC-359 T7d —— 技能启动屏障在两个引擎上各跑一遍',
  name: 'P0-11 非空启动：原 boot 屏障回收崩溃 reservation 和锁，真实同名创建恢复',
}
const skillBootReverify: TestCase = {
  ...skillBootRecovery,
  name: 'P0-11 非空启动：原 boot 重验健康快照并恢复本次启动的目录可用状态',
}
const driverEffectRelease: TestCase = {
  file: 'packages/backend/tests/rfc359-t7b-driver-release-settles-effects.test.ts',
  suite: 'RFC-359 T7b —— 驱动释放清算 process effect（P0-10）',
  name: '有 spawn receipt 且 run 已终态 → effect succeeded、fence 释放、owner released、intent completed',
}
const taskBootRecovery: TestCase = {
  file: 'packages/backend/tests/rfc359-w3-t4-boot-recovery.test.ts',
  suite: 'RFC-359 W3-T4 —— boot 恢复四步（P0-3 / P0-4）',
  name: 'P0-3 实际启动恢复调用释放前代 owner，持久终态后新意图可继续认领',
}
const revokedOwnerReconcile: TestCase = {
  ...taskBootRecovery,
  name: 'P0-4 前代 owner 已真实撤销时，周期回收仍写入任务和节点终态',
}
const emptyTaskBootRecovery: TestCase = {
  ...taskBootRecovery,
  name: '没有孤儿时四步都是 no-op',
}
const revokedOwnerAutomaticRepair: TestCase = {
  file: 'packages/backend/tests/rfc359-w8-auto-repair-conformance.test.ts',
  suite: 'RFC-359 manual and automatic repair share the same engine',
  name: 'P0-4 S4：前代 owner 已真实撤销时，自动修复仍落库并发出一次 resume',
}
const ambientOwnerContext: TestCase = {
  file: 'packages/backend/tests/rfc359-t7-owner-fences.test.ts',
  suite: 'RFC-359 T7 —— owner 围栏同一规则（P0-1 / P0-2）',
  name: 'P0-1：drive 上下文内不传 executionContext 的节点写入按 owner token 放行',
}
const explicitOwnerContext: TestCase = {
  ...ambientOwnerContext,
  name: 'P0-1：显式 executionContext 仍然优先于环境上下文',
}
const heartbeatEffect: TestCase = {
  ...ambientOwnerContext,
  name: 'P0-2：心跳推进 revision / lease 之后，attach 时冻结的 token 仍能开 effect 并结算',
}
const unchangedEffectOwner: TestCase = {
  ...ambientOwnerContext,
  name: 'P0-2：没有心跳时，同一真实工厂仍创建并结算非空 effect 和资源围栏',
}
const questionDecision: TestCase = {
  file: 'packages/backend/tests/rfc359-t2-question-dispatch-command.test.ts',
  suite: 'RFC-359 T2a —— 问题派发命令端口',
  name: '决定 + 派发 + rerun 铸造 + receipt 一起落地；同 key 重放返回同一 receipt',
}
const reviewDecision: TestCase = {
  file: 'packages/backend/tests/rfc359-t2c-review-decision.test.ts',
  suite: 'RFC-359 T2c —— 评审决定命令（reviewDecisions）',
  name: 'approve：评审 run done、doc_version approved、approved_doc + approval_meta 落 outputs、回执 + 决定事件',
}
const collaborationDraft: TestCase = {
  file: 'packages/backend/tests/rfc359-w12-collaboration-composition.test.ts',
  suite: 'RFC-359 W12 — collaboration route composition',
  name: 'clarify.saveDraft —— 逐题草稿 + 归属落库，重复保存后写胜出',
}
const currentCases = [
  clarifyTurn,
  spentBudget,
  finalize,
  staleClarify,
  deferred,
  park,
  rootExecution,
  corruptWorkflowDelete,
  staleCorruptWorkflowDelete,
  workflowRepositoryControl,
  legacyAgent,
  legacyScript,
  skillBootRecovery,
  skillBootReverify,
  driverEffectRelease,
  taskBootRecovery,
  revokedOwnerReconcile,
  emptyTaskBootRecovery,
  revokedOwnerAutomaticRepair,
  ambientOwnerContext,
  explicitOwnerContext,
  heartbeatEffect,
  unchangedEffectOwner,
  questionDecision,
  reviewDecision,
  collaborationDraft,
]

export const PHASES: readonly Phase[] = [
  { id: 'current-before', passes: currentCases, failures: [] },
  {
    id: 'p0-12-protocol',
    mutation: 'p0-12-protocol',
    passes: [spentBudget],
    failures: [
      {
        test: clarifyTurn,
        diagnostics: [
          /error: expect\(received\)\.toContain\(expected\)/,
          /Expected to contain: "<workflow-clarify>"/,
          /Received: "## Workgroup output protocol\\nThis is the worker turn\./,
          /rfc359-t7e-workgroup-clarify-ask-gate\.test\.ts:\d+:\d+/,
        ],
      },
    ],
  },
  {
    id: 'p0-12-budget',
    mutation: 'p0-12-budget',
    passes: [clarifyTurn],
    failures: [
      {
        test: spentBudget,
        diagnostics: [
          /expect\(worker\.clarifyEnabled\)\.toBe\(false\)/,
          /error: expect\(received\)\.toBe\(expected\)/,
          /Expected: false\s+Received: true/,
          /rfc359-t7e-workgroup-clarify-ask-gate\.test\.ts:\d+:\d+/,
        ],
      },
    ],
  },
  {
    id: 'p0-5',
    mutation: 'p0-5',
    passes: [finalize],
    failures: [
      {
        test: staleClarify,
        diagnostics: [
          /ConflictError: node_run \S+ is terminal \('failed'\); refuse to overwrite \(clarify-deferred-answer\)/,
          /code: "illegal-node-run-transition"/,
          /at setNodeRunStatusTx \([^\n]*nodeRunLifecycleTransition\.ts:\d+:\d+\)/,
        ],
      },
    ],
  },
  {
    id: 'p0-6',
    mutation: 'p0-6',
    passes: [workflowRepositoryControl],
    failures: [
      {
        test: corruptWorkflowDelete,
        diagnostics: [
          /ValidationError: stored definition is not JSON/,
          /status: 422/,
          /code: "workflow-definition-corrupt"/,
          /error: "JSON Parse error: Unexpected EOF"/,
          /at workflowFromPersistenceRow \([^\n]*workflowPersistence\.ts:\d+:\d+\)/,
        ],
      },
      {
        test: staleCorruptWorkflowDelete,
        diagnostics: [
          /error: expect\(received\)\.toMatchObject\(expected\)/,
          /^-\s+"status": 409,?$/m,
          /^\+ \[ValidationError: stored definition is not JSON\]$/m,
          /rfc359-t6-corrupt-workflow-delete\.test\.ts:\d+:\d+/,
        ],
      },
    ],
  },
  {
    id: 'p0-7',
    mutation: 'p0-7',
    passes: [park],
    failures: [
      {
        test: deferred,
        diagnostics: [
          /error: deferred-question-dispatcher-not-bound/,
          /at autoDispatchDeferredQuestions \([^\n]*rfc359-p0-mutations\.ts:\d+:\d+\)/,
          /rfc359-t1-deferred-question-dispatch\.test\.ts:\d+:\d+/,
        ],
      },
      {
        test: rootExecution,
        diagnostics: [
          /error: deferred-question-dispatcher-not-bound/,
          /expect\(task, task\?\.errorMessage \?\? undefined\)\.toMatchObject\(/,
          /^-\s+"status": "done",?$/m,
          /^\+\s+"status": "failed",?$/m,
          /^\+\s+"errorMessage": "deferred-question-dispatcher-not-bound",?$/m,
          /rfc359-w5-t21b-execution-chain\.test\.ts:\d+:\d+/,
        ],
      },
    ],
  },
  {
    id: 'p0-9-launchers',
    mutation: 'p0-9-launchers',
    passes: [rootExecution],
    failures: [legacyAgent, legacyScript].map((test, index) => ({
      test,
      diagnostics: [
        new RegExp(
          `error: \\{"blockCode":"${index === 0 ? 'agent' : 'script'}-launcher-not-wired"\\}`,
        ),
        /^-\s+"handled": "action-launched",?$/m,
        /^\+\s+"handled": "action-launch-failed",?$/m,
        /^-\s+"stop": "async-boundary",?$/m,
        /^\+\s+"stop": "failed-or-blocked",?$/m,
        /rfc359-w14-legacy-mission-execution\.test\.ts:\d+:\d+/,
      ],
    })),
  },
  {
    id: 'p0-9-terminal-observer',
    mutation: 'p0-9-terminal-observer',
    passes: [rootExecution],
    failures: [legacyAgent, legacyScript].map((test) => ({
      test,
      diagnostics: [
        /expect\(settlement\)\.toEqual\(/,
        /error: expect\(received\)\.toEqual\(expected\)/,
        /^-\s+"attemptStatus": "validated",?$/m,
        /^\+\s+"attemptStatus": "claimed",?$/m,
        /^\+\s+"wakeDeliveryKeys": \[\],?$/m,
        /rfc359-w14-legacy-mission-execution\.test\.ts:\d+:\d+/,
      ],
    })),
  },
  {
    id: 'p0-11-barrier',
    mutation: 'p0-11-barrier',
    passes: [skillBootReverify],
    failures: [
      {
        test: skillBootRecovery,
        diagnostics: [
          /expect\(\(await listActiveOps\(db\)\)\.map\(\(op\) => op\.phase\)\)\.toEqual\(\[\]\)/,
          /error: expect\(received\)\.toEqual\(expected\)/,
          /^- \[\]$/m,
          /^\+\s+"intent",?$/m,
          /rfc359-t7d-postgresql-skill-catalog-boot\.test\.ts:\d+:\d+/,
        ],
      },
    ],
  },
  {
    id: 'p0-11-reverify',
    mutation: 'p0-11-reverify',
    passes: [skillBootRecovery],
    failures: [
      {
        test: skillBootReverify,
        diagnostics: [
          /expect\(isSkillBootVerified\(skill\.id\)\)\.toBe\(true\)/,
          /error: expect\(received\)\.toBe\(expected\)/,
          /Expected: true\s+Received: false/,
          /rfc359-t7d-postgresql-skill-catalog-boot\.test\.ts:\d+:\d+/,
        ],
      },
    ],
  },
  {
    id: 'p0-10-unsettled-release',
    mutation: 'p0-10-unsettled-release',
    passes: [skillBootRecovery],
    failures: [
      {
        test: driverEffectRelease,
        diagnostics: [
          /\[rfc359-p0-10-state\] \{"taskId":"([^"]+)","ownerState":"claimed","unresolvedEffectCount":1\}\n[\s\S]*TaskExecutionError: task '\1' still has unresolved effects or resource holds/,
          /code: "task-execution-recovery-required"/,
          /^[ \t]*at (?:<anonymous> \((?:\/(?:[^/\r\n()<>]+\/)*|(?:\.\.?\/)+)?packages\/backend\/src\/modules\/task-execution\/infrastructure\/taskOwnershipPersistence\.ts:\d+:\d+\)|(?:\/(?:[^/\r\n()<>]+\/)*|(?:\.\.?\/)+)?packages\/backend\/src\/modules\/task-execution\/infrastructure\/taskOwnershipPersistence\.ts:\d+:\d+)[ \t]*$/m,
        ],
      },
    ],
  },
  {
    id: 'p0-3-boot-omitted',
    mutation: 'p0-3-boot-omitted',
    passes: [rootExecution],
    failures: [
      {
        test: taskBootRecovery,
        diagnostics: [
          /expect\(recoveredOwner\?\.state\)\.toBe\('released'\)/,
          /error: expect\(received\)\.toBe\(expected\)/,
          /Expected: "released"\s+Received: "claimed"/,
          /rfc359-w3-t4-boot-recovery\.test\.ts:\d+:\d+/,
        ],
      },
    ],
  },
  {
    id: 'p0-4-revoked-reconcile',
    mutation: 'p0-4-revoked-reconcile',
    passes: [emptyTaskBootRecovery],
    failures: [
      {
        test: revokedOwnerReconcile,
        diagnostics: [
          /expect\(state\)\.toEqual\(/,
          /error: expect\(received\)\.toEqual\(expected\)/,
          /^\s+"ownerState": "revoked",?$/m,
          /^\+\s+"reapedRuns": \[\],?$/m,
          /^\+\s+"reapedTasks": \[\],?$/m,
          /^-\s+"runStatus": "interrupted",?$/m,
          /^-\s+"taskStatus": "interrupted",?$/m,
          /^\+\s+"runStatus": "running",?$/m,
          /^\+\s+"taskStatus": "running",?$/m,
          /rfc359-w3-t4-boot-recovery\.test\.ts:\d+:\d+/,
        ],
      },
      {
        test: revokedOwnerAutomaticRepair,
        diagnostics: [
          /expect\(state\)\.toEqual\(/,
          /error: expect\(received\)\.toEqual\(expected\)/,
          /^\+\s+"auditOutcome": "apply-failed",?$/m,
          /^\+\s+"auditOutcomeMessage": "ownerless task mutation refused durable owner for '(?<s4TaskId>task-[^']+)'",[\s\S]*^ {4}"taskId": "\k<s4TaskId>",?$/m,
          /^\+\s+"eventTypes": \[\],?$/m,
          /^-\s+"lifecycleRevision": 2,?$/m,
          /^\+\s+"lifecycleRevision": 1,?$/m,
          /^\s+"nodeRunStatus": "pending",?$/m,
          /^\s+"ownerState": "revoked",?$/m,
          /^\+\s+"repaired": \[\],?$/m,
          /^\+\s+"resolvedAt": null,?$/m,
          /^\+\s+"resumed": \[\],?$/m,
          /^\+\s+"skipped": \[$/m,
          /^\+\s+"reason": "apply-failed-or-lease-held",?$/m,
          /^-\s+"taskStatus": "interrupted",?$/m,
          /^\+\s+"taskStatus": "pending",?$/m,
          /rfc359-w8-auto-repair-conformance\.test\.ts:\d+:\d+/,
        ],
      },
    ],
  },
  {
    id: 'p0-1-ambient-context',
    mutation: 'p0-1-ambient-context',
    passes: [explicitOwnerContext],
    failures: [
      {
        test: ambientOwnerContext,
        diagnostics: [
          /^\[rfc359-p0-1-call\] \{"taskId":"(?<ambientTaskId>t7_[0-9A-HJKMNP-TV-Z]{26})","explicitContext":false,"ambientTaskId":"\k<ambientTaskId>"\}\n[\s\S]*^TaskExecutionError: ownerless task mutation refused durable owner for '\k<ambientTaskId>'$/m,
          /^\s+status: 409,$/m,
          /^\s+code: "task-execution-stale-owner"$/m,
          /at assertTaskOwnerlessTx \(rfc359-p0-mutation:ambient-owner-context:\d+:\d+\)/,
        ],
      },
    ],
  },
  {
    id: 'p0-2-owner-snapshot',
    mutation: 'p0-2-owner-snapshot',
    passes: [unchangedEffectOwner],
    failures: [
      {
        test: heartbeatEffect,
        diagnostics: [
          /^\[rfc359-p0-2-snapshot\] \{"taskId":"(?<effectTaskId>t7_[0-9A-HJKMNP-TV-Z]{26})","tokenRevision":\d+,"rowRevision":\d+,"tokenLeaseUntil":\d+,"rowLeaseUntil":\d+\}\n[\s\S]*^TaskExecutionError: task '\k<effectTaskId>' mutation was fenced$/m,
          /^\s+status: 409,$/m,
          /^\s+code: "task-execution-stale-owner"$/m,
          /at assertHistoricalEffectOwner \(rfc359-p0-mutation:effect-owner-snapshot:\d+:\d+\)/,
        ],
      },
    ],
  },
  {
    id: 'p0-8-command-omission',
    mutation: 'p0-8-command-omission',
    passes: [collaborationDraft],
    failures: [
      {
        test: questionDecision,
        diagnostics: [
          /^error: collaboration question dispatch command is not composed$/m,
          /at requireQuestionDispatchCommand \(rfc359-p0-mutation:collaboration-command-omission:\d+:\d+\)/,
          /at dispatchTaskQuestions \([^\n]*collaboration\/public\/commands\.ts:\d+:\d+\)/,
          /rfc359-t2-question-dispatch-command\.test\.ts:\d+:\d+/,
        ],
      },
      {
        test: finalize,
        diagnostics: [
          /^error: collaboration clarify decision command is not composed$/m,
          /at requireClarifyDecisionCommand \(rfc359-p0-mutation:collaboration-command-omission:\d+:\d+\)/,
          /at submitClarifyDecision \([^\n]*collaboration\/public\/commands\.ts:\d+:\d+\)/,
          /rfc359-t2b-clarify-decision\.test\.ts:\d+:\d+/,
        ],
      },
      {
        test: reviewDecision,
        diagnostics: [
          /^error: collaboration review decision command is not composed$/m,
          /at requireReviewDecisionCommand \(rfc359-p0-mutation:collaboration-command-omission:\d+:\d+\)/,
          /at submitReviewDecision \([^\n]*collaboration\/public\/commands\.ts:\d+:\d+\)/,
          /rfc359-t2c-review-decision\.test\.ts:\d+:\d+/,
        ],
      },
    ],
  },
  { id: 'current-after', passes: currentCases, failures: [] },
]

function fullName(test: TestCase, provider: Provider): string {
  return `${test.suite} [${provider}] > ${test.name}`
}

/** Reject arbitrary exit 1, hook/import errors, missing tests and wrong assertions. */
export function validatePhaseLog(raw: string, exitCode: number, phase: Phase, provider: Provider) {
  const log = stripVTControlCharacters(raw)
  const events: { status: string; name: string; precedingOutput: string }[] = []
  let previousEnd = 0
  for (const match of log.matchAll(/^\((pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+(?:ms|s)\])?$/gm)) {
    events.push({
      status: match[1]!,
      name: match[2]!,
      precedingOutput: log.slice(previousEnd, match.index),
    })
    previousEnd = match.index + match[0].length
  }
  const reasons: string[] = []
  const expectedPasses = phase.passes.map((test) => fullName(test, provider)).sort()
  const expectedFailures = phase.failures.map(({ test }) => fullName(test, provider)).sort()
  const actualPasses = events
    .filter((event) => event.status === 'pass')
    .map((event) => event.name)
    .sort()
  const actualFailures = events
    .filter((event) => event.status === 'fail')
    .map((event) => event.name)
    .sort()
  if (JSON.stringify(actualPasses) !== JSON.stringify(expectedPasses))
    reasons.push('passing test names differ')
  if (JSON.stringify(actualFailures) !== JSON.stringify(expectedFailures))
    reasons.push('failing test names differ')
  if (events.some((event) => event.status === 'skip' || event.status === 'todo'))
    reasons.push('unexpected skip/todo')
  const expectedExitCode = phase.failures.length === 0 ? 0 : 1
  if (exitCode !== expectedExitCode) reasons.push(`exit ${exitCode}, expected ${expectedExitCode}`)
  if (/# Unhandled error between tests|^\s+[1-9]\d* errors?$/m.test(log))
    reasons.push('setup/import/unhandled error')
  if (/^error:[^\n]*\btimed out\b|^TimeoutError:/im.test(log))
    reasons.push('unexpected timeout failure')
  const summaryCount = (label: string): number | undefined => {
    const matches = [...log.matchAll(new RegExp(`^\\s+(\\d+) ${label}$`, 'gm'))]
    return matches.length === 1 ? Number(matches[0]![1]) : undefined
  }
  const summary = {
    pass: summaryCount('pass'),
    fail: summaryCount('fail'),
    expects: summaryCount('expect\\(\\) calls'),
  }
  if (summary.pass !== expectedPasses.length || summary.fail !== expectedFailures.length)
    reasons.push('summary differs')
  if (summary.expects === undefined || summary.expects === 0)
    reasons.push('missing assertion count')
  const markers = [...log.matchAll(/^\[rfc359-p0-mutation\] installed=(.+)$/gm)].map(
    (match) => match[1],
  )
  if (JSON.stringify(markers) !== JSON.stringify(phase.mutation ? [phase.mutation] : []))
    reasons.push('mutation preload marker differs')
  const releaseWitnesses = [...log.matchAll(/^\[rfc359-p0-10-state\] (.+)$/gm)]
  if (releaseWitnesses.length !== (phase.mutation === 'p0-10-unsettled-release' ? 1 : 0))
    reasons.push('durable release witness count differs')
  const ambientWitnesses = [...log.matchAll(/^\[rfc359-p0-1-call\] (.+)$/gm)]
  if (ambientWitnesses.length !== (phase.mutation === 'p0-1-ambient-context' ? 1 : 0))
    reasons.push('ambient owner call witness count differs')
  const effectSnapshots = [...log.matchAll(/^\[rfc359-p0-2-snapshot\] (.+)$/gm)]
  if (effectSnapshots.length !== (phase.mutation === 'p0-2-owner-snapshot' ? 1 : 0))
    reasons.push('effect owner snapshot witness count differs')
  if (phase.mutation === 'p0-2-owner-snapshot' && effectSnapshots.length === 1) {
    const snapshot =
      /^\{"taskId":"t7_[0-9A-HJKMNP-TV-Z]{26}","tokenRevision":(\d+),"rowRevision":(\d+),"tokenLeaseUntil":(\d+),"rowLeaseUntil":(\d+)\}$/.exec(
        effectSnapshots[0]![1]!,
      )
    const values = snapshot?.slice(1).map(Number)
    if (
      values === undefined ||
      !values.every((value) => Number.isSafeInteger(value) && value > 0) ||
      values[1]! <= values[0]! ||
      values[3]! <= values[2]!
    )
      reasons.push('effect owner snapshot does not show the actual heartbeat advance')
  }
  for (const failure of phase.failures) {
    const name = fullName(failure.test, provider)
    const event = events.find((item) => item.status === 'fail' && item.name === name)
    for (const diagnostic of failure.diagnostics) {
      if (!event || !diagnostic.test(event.precedingOutput))
        reasons.push(`${failure.test.name}: missing ${diagnostic}`)
    }
  }
  return {
    valid: reasons.length === 0,
    reasons,
    expectedPasses,
    expectedFailures,
    actualPasses,
    actualFailures,
    summary,
  }
}

function parseOptions(args: readonly string[]) {
  let providers: Provider[] = ['sqlite', 'postgresql']
  let outputDir = 'test-results/rfc359-p0-mutations'
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!
    const value = args[index + 1]
    if (seen.has(flag) || value === undefined || value.startsWith('--'))
      throw new Error(`Invalid option ${flag}`)
    seen.add(flag)
    if (flag === '--output-dir' && value.length > 0) outputDir = value
    else if (flag === '--providers') {
      providers = value.split(',').map((name) => {
        if (name !== 'sqlite' && name !== 'postgresql') throw new Error(`Unknown provider ${name}`)
        return name
      })
      if (new Set(providers).size !== providers.length) throw new Error('Duplicate providers')
    } else throw new Error(`Unknown option ${flag}`)
  }
  return { providers, outputDir: resolve(outputDir) }
}

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = 'packages/backend/tests/fixtures/rfc359-p0-mutations.ts'
/** The mutation run fingerprints these before and after, so a run that edited its own
 *  targets is reported as failed. `rfc359-w14-p0-mutation-verdict` asserts every entry
 *  still exists — a file deleted elsewhere used to surface only as an ENOENT inside the
 *  real-PostgreSQL lane, long after the deleting commit was pushed. */
export const sourceFiles = [
  'packages/backend/src/modules/resource-catalog/application/workgroups/workgroupProtocol.ts',
  'packages/backend/src/modules/collaboration/infrastructure/workgroupClarifyAskGate.ts',
  'packages/backend/src/modules/collaboration/infrastructure/clarify/seal.ts',
  'packages/backend/src/modules/collaboration/infrastructure/taskDagCollaborationOperations.ts',
  'packages/backend/src/modules/task-execution/infrastructure/nodeRunLifecyclePersistence.ts',
  'packages/backend/src/modules/task-execution/infrastructure/nodeRunLifecycleTransition.ts',
  'packages/backend/src/modules/task-execution/infrastructure/nodeExecutionPersistence.ts',
  'packages/backend/src/modules/task-execution/application/taskExecutionContext.ts',
  'packages/backend/src/modules/task-execution/application/taskExecutionError.ts',
  'packages/backend/src/modules/task-execution/domain/ownership.ts',
  'packages/backend/src/platform/persistence/batchInsert.ts',
  'packages/backend/src/util/errors.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskDriverRelease.ts',
  'packages/backend/src/modules/task-execution/infrastructure/inMemoryTaskRuntimeRegistry.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskOwnershipPersistence.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskExecutionIntentTerminalPersistence.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskExecutionIntentTerminalSequence.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskExecutionEffectPersistence.ts',
  'packages/backend/src/modules/task-execution/infrastructure/effectQuiescence.ts',
  'packages/backend/src/modules/task-execution/composition/taskExecutionPersistence.ts',
  'packages/backend/src/modules/task-execution/composition.ts',
  'packages/backend/src/modules/task-execution/composition/taskLifecycleRepair.ts',
  'packages/backend/src/modules/task-execution/composition/bootRecovery.ts',
  'packages/backend/src/modules/task-execution/application/recoverTaskExecutions.ts',
  'packages/backend/src/modules/task-execution/infrastructure/ownedTaskExecution.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskExecutionRecovery.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskRecoveryOperations.ts',
  'packages/backend/src/modules/task-execution/infrastructure/postgresqlTaskRouteRepairOperations.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskLifecycleAutoRepairCommand.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskRuntimeLifecyclePersistence.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskLifecycleWriteSequence.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskLifecycleCommittedEvents.ts',
  'packages/backend/src/platform/persistence/sqlite/taskLifecycle.ts',
  'packages/backend/src/platform/persistence/transactionProgram.ts',
  'packages/backend/src/platform/events/committed/append.ts',
  'packages/backend/src/platform/events/committed/appendProgram.ts',
  'packages/backend/src/platform/events/committed/appendShared.ts',
  'packages/backend/src/services/orphanReconcile.ts',
  'packages/backend/src/services/orphans.ts',
  'packages/backend/src/services/autoRepair.ts',
  'packages/backend/src/services/taskAlerts.ts',
  'packages/backend/src/services/recoveryBreaker.ts',
  'packages/backend/src/services/recovery.ts',
  'packages/backend/src/services/lifecycleInvariants.ts',
  'packages/backend/src/services/stuckTaskDetector.ts',
  'packages/backend/src/modules/resource-catalog/infrastructure/workflowRepository.ts',
  'packages/backend/src/modules/resource-catalog/infrastructure/workflowPersistence.ts',
  'packages/backend/src/modules/development-automation/composition.ts',
  'packages/backend/src/modules/development-automation/composition/executionTerminalObserver.ts',
  'packages/backend/src/modules/development-automation/application/agentActionOrchestrator.ts',
  'packages/backend/src/modules/resource-catalog/composition/skillCatalogBoot.ts',
  'packages/backend/src/modules/resource-catalog/infrastructure/skillCatalogBootAdapter.ts',
  'packages/backend/src/modules/resource-catalog/infrastructure/legacy/skillIdentityMigration.ts',
  'packages/backend/src/modules/resource-catalog/infrastructure/legacy/skillBootVerify.ts',
  'packages/backend/src/modules/task-execution/domain/executionEffect.ts',
  'packages/backend/src/modules/collaboration/composition/commandContext.ts',
  'packages/backend/src/modules/collaboration/composition/collaborationRouteOperations.ts',
  'packages/backend/src/modules/collaboration/public/commands.ts',
  'packages/backend/src/modules/collaboration/infrastructure/questionDispatchCommand.ts',
  'packages/backend/src/modules/collaboration/infrastructure/clarifyDecisionCommand.ts',
  'packages/backend/src/modules/collaboration/infrastructure/reviewDecisionCommand.ts',
  'packages/backend/src/modules/collaboration/infrastructure/collaborationRouteOperations.ts',
  'packages/backend/src/modules/collaboration/infrastructure/clarify/service.ts',
  'packages/backend/src/modules/collaboration/infrastructure/clarifyRounds.ts',
  'packages/backend/tests/helpers/questionDispatchFixture.ts',
  'packages/backend/tests/helpers/reviewDecisionFixture.ts',
  'packages/backend/src/platform/persistence/postgresqlMigrationSequence.ts',
  'packages/backend/src/platform/persistence/postgresqlMigrationHistory.ts',
  'packages/backend/src/platform/persistence/postgresqlMigrator.ts',
  'packages/backend/src/db/schema.ts',
  'packages/backend/db/postgresql-migrations/meta/0000_rfc349_baseline.plan.json',
  'packages/backend/db/postgresql-migrations/0001_rfc359_task_coverage_indexes.sql',
  'packages/backend/db/postgresql-migrations/meta/0001_rfc359_task_coverage_indexes.upgrade.json',
  'packages/backend/db/postgresql-migrations/0000_rfc349_baseline.sql',
  'packages/backend/db/postgresql-migrations/meta/_journal.json',
  'packages/backend/db/migrations/0225_rfc359_task_count_indexes.sql',
  'packages/backend/db/migrations/meta/_journal.json',
  'packages/backend/tests/migration-freeze.ts',
  'packages/backend/tests/helpers/eachProvider.ts',
  'packages/backend/tests/helpers/eachProviderTaskExecution.ts',
  ...new Set(currentCases.map((test) => test.file)),
  fixture,
  'scripts/rfc359-p0-mutations.ts',
]
function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}
function sourceHashes() {
  return Object.fromEntries(
    sourceFiles.map((file) => [file, hash(readFileSync(join(repository, file)))]),
  )
}

async function runPhase(provider: Provider, phase: Phase, outputDir: string) {
  const tests = [...phase.passes, ...phase.failures.map(({ test }) => test)]
  const pattern = `(?:${tests.map((test) => test.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`
  const command = [
    process.execPath,
    'test',
    ...new Set(tests.map((test) => test.file)),
    '--test-name-pattern',
    pattern,
  ]
  if (phase.mutation) command.push('--preload', join(repository, fixture))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AW_TEST_PROVIDERS: provider,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  }
  delete env['RFC359_P0_MUTATION']
  if (phase.mutation) env['RFC359_P0_MUTATION'] = phase.mutation
  const logPath = join(outputDir, `${provider}-${phase.id}.log`)
  const descriptor = openSync(logPath, 'w')
  const started = Date.now()
  let exitCode: number
  let signalCode: NodeJS.Signals | null
  try {
    const child = Bun.spawn(command, {
      cwd: repository,
      env,
      stdin: 'ignore',
      stdout: descriptor,
      stderr: descriptor,
      // Whole-process watchdog only. Existing case/hook timeouts are unchanged.
      timeout: 300_000,
    })
    exitCode = await child.exited
    signalCode = child.signalCode
  } finally {
    closeSync(descriptor)
  }
  const raw = readFileSync(logPath, 'utf8')
  const verdict = validatePhaseLog(raw, exitCode, phase, provider)
  if (signalCode !== null) {
    verdict.valid = false
    verdict.reasons.push(`process terminated with ${signalCode}`)
  }
  return {
    provider,
    phase: phase.id,
    mutation: phase.mutation ?? null,
    command,
    exitCode,
    signalCode,
    durationMs: Date.now() - started,
    logPath,
    logSha256: hash(raw),
    ...verdict,
  }
}

async function main(): Promise<void> {
  const { providers, outputDir } = parseOptions(process.argv.slice(2))
  mkdirSync(outputDir, { recursive: true })
  const results: Awaited<ReturnType<typeof runPhase>>[] = []
  const failures: string[] = []
  const before = sourceHashes()
  const startedAt = new Date().toISOString()
  const save = (finished: boolean) => {
    const after = sourceHashes()
    const unchanged = JSON.stringify(before) === JSON.stringify(after)
    writeFileSync(
      join(outputDir, 'results.json'),
      JSON.stringify(
        {
          version: 1,
          startedAt,
          finishedAt: finished ? new Date().toISOString() : null,
          bunVersion: Bun.version,
          providers,
          expectedCaseExecutionsPerProvider: PHASES.reduce(
            (count, phase) => count + phase.passes.length + phase.failures.length,
            0,
          ),
          status: finished ? (failures.length === 0 && unchanged ? 'passed' : 'failed') : 'running',
          sourceFilesUnchanged: unchanged,
          sourceHashesBefore: before,
          sourceHashesAfter: after,
          failures,
          results,
        },
        null,
        2,
      ) + '\n',
    )
    return unchanged
  }
  save(false)
  for (const provider of providers) {
    for (const phase of PHASES) {
      console.log(`[rfc359-p0] ${provider} ${phase.id}`)
      try {
        const result = await runPhase(provider, phase, outputDir)
        results.push(result)
        if (!result.valid) failures.push(`${provider}/${phase.id}: ${result.reasons.join('; ')}`)
        save(false)
        // Missing PostgreSQL configuration fails this real baseline. Never skip
        // it or count later import/setup errors as successful mutations.
        if (phase.id === 'current-before' && !result.valid) break
      } catch (error) {
        failures.push(
          `${provider}/${phase.id}: ${error instanceof Error ? error.stack : String(error)}`,
        )
        save(false)
        if (phase.id === 'current-before') break
      }
    }
  }
  const unchanged = save(true)
  if (failures.length > 0 || !unchanged) {
    console.error(`[rfc359-p0] failed; see ${join(outputDir, 'results.json')}`)
    process.exitCode = 1
  } else console.log(`[rfc359-p0] passed; see ${join(outputDir, 'results.json')}`)
}

if (import.meta.main) await main()
