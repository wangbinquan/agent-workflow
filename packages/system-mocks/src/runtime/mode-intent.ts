// RFC-254 T28b — `intent` mode: the port of `stub-opencode-intent.sh` (RFC-234).
//
// Same CLI surface as `basic`, but the envelope speaks the intent protocol:
// a `summary` port plus a `changeset` port carrying create ops.
//
// The old `intent-workflow-opencode.sh` was a two-line launcher that exported
// `STUB_INTENT_VARIANT=workflow` and exec'd this stub. In the ported form that
// is not a separate mode at all — it is the same mode with the same variable,
// which is why the frozen contract listed it separately but the implementation
// does not need to. Its deliberate exclusion from the version-telemetry stub
// matrix is preserved by the fact that it never had its own version string.

import { emitTextEvent, parseInvocation, requireOutputOpen } from './skeleton'
import { existsSync, readFileSync } from 'node:fs'

const NAME = 'stub-opencode-intent'

const AGENT_CHANGESET =
  '{"$schema_version":1,"ops":[{"opId":"op-1","action":"create","resourceType":"agent","tempRef":"$new:e2e-auditor","payload":{"name":"e2e-auditor","description":"audits code for e2e","outputs":["findings"],"bodyMd":"You audit."}}]}'

const OVERLAPPING_WORKFLOW_CHANGESET =
  '{"$schema_version":1,"ops":[{"opId":"op-1","action":"create","resourceType":"agent","tempRef":"$new:e2e-workflow-worker","payload":{"name":"e2e-workflow-worker","description":"handles and reviews workflow requests","outputs":["draft","answer"],"bodyMd":"Complete the requested work."}},{"opId":"op-2","action":"create","resourceType":"workflow","tempRef":"$new:e2e-workflow","payload":{"name":"e2e-workflow-preview","description":"workflow graph preview fixture","definition":{"$schema_version":5,"inputs":[],"nodes":[{"id":"worker","kind":"agent-single","agentRef":"$new:e2e-workflow-worker","promptTemplate":"Produce a draft.","position":{"x":0,"y":0}},{"id":"reviewer","kind":"agent-single","agentRef":"$new:e2e-workflow-worker","promptTemplate":"Review the draft: {{draft}}","position":{"x":0,"y":0}},{"id":"final_output","kind":"output","ports":[{"name":"answer","bind":{"nodeId":"reviewer","portName":"answer"}}],"position":{"x":0,"y":0}}],"edges":[{"id":"worker_to_reviewer","source":{"nodeId":"worker","portName":"draft"},"target":{"nodeId":"reviewer","portName":"draft"}},{"id":"reviewer_to_output","source":{"nodeId":"reviewer","portName":"answer"},"target":{"nodeId":"final_output","portName":"answer"}}]}}}]}'

// RFC-254 freezes the legacy workflow stub byte-for-byte. RFC-302 opts into
// the all-overlapping input above explicitly, without rewriting that contract.
const WORKFLOW_CHANGESET = OVERLAPPING_WORKFLOW_CHANGESET.replace(
  '"position":{"x":0,"y":0}',
  '"position":{"x":20,"y":120}',
)
  .replace('"position":{"x":0,"y":0}', '"position":{"x":320,"y":120}')
  .replace('"position":{"x":0,"y":0}', '"position":{"x":640,"y":120}')

const NESTED_CYCLE_WORKFLOW_CHANGESET = JSON.stringify({
  $schema_version: 1,
  ops: [
    {
      opId: 'op-1',
      action: 'create',
      resourceType: 'agent',
      tempRef: '$new:e2e-nested-cycle-worker',
      payload: {
        name: 'e2e-nested-cycle-worker',
        description: 'nested cycle worker',
        outputs: ['out'],
        bodyMd: 'Traverse the loop.',
      },
    },
    {
      opId: 'op-2',
      action: 'create',
      resourceType: 'workflow',
      tempRef: '$new:e2e-nested-cycle-workflow',
      payload: {
        name: 'e2e-nested-cycle-workflow',
        description: 'nested wrapper and legal loop cycle fixture',
        definition: {
          $schema_version: 5,
          inputs: [],
          nodes: [
            {
              id: 'outer_loop',
              kind: 'wrapper-loop',
              nodeIds: ['git_scope'],
              maxIterations: 3,
              exitCondition: { kind: 'port-empty', nodeId: 'worker_a', portName: 'out' },
              position: { x: 0, y: 0 },
            },
            {
              id: 'git_scope',
              kind: 'wrapper-git',
              nodeIds: ['worker_a', 'worker_b'],
              position: { x: 0, y: 0 },
            },
            {
              id: 'worker_a',
              kind: 'agent-single',
              agentRef: '$new:e2e-nested-cycle-worker',
              promptTemplate: 'A receives {{feedback}}.',
              position: { x: 0, y: 0 },
            },
            {
              id: 'worker_b',
              kind: 'agent-single',
              agentRef: '$new:e2e-nested-cycle-worker',
              promptTemplate: 'B receives {{feedback}}.',
              position: { x: 0, y: 0 },
            },
          ],
          edges: [
            {
              id: 'a_to_b',
              source: { nodeId: 'worker_a', portName: 'out' },
              target: { nodeId: 'worker_b', portName: 'feedback' },
            },
            {
              id: 'b_to_a',
              source: { nodeId: 'worker_b', portName: 'out' },
              target: { nodeId: 'worker_a', portName: 'feedback' },
            },
          ],
        },
      },
    },
  ],
})

/**
 * RFC-319 B32 —— `STUB_INTENT_VARIANT=update` 变体：产出一条 **update** 操作。
 *
 * 提交策略步（「原地修改 vs 复制一份」）只在 changeset 里存在 update 操作时才
 * 出现，而此前所有 intent 变体产出的都是 create——那一整步因此没有任何 e2e
 * 能走到。
 *
 * update 的 `target` 必须是会话作用域的句柄（`res#<type>#<n>`），它由平台每轮
 * 现铸，stub 无法静态知道。句柄写在**工作目录里的清单文件**
 * （`inventory/agents.md`，形如 "- res#agent#1 `name` — …"，见
 * services/intent/dumpBuilder.ts:694），所以这里按名字从那份清单里认它——
 * 和真实模型读到的是同一份东西。
 */
function updateChangeset(prompt: string): string {
  // 目标名从**用户消息**里取（`rfc319-target:<name>`），不走环境变量：一个 daemon
  // 要服务多条用例，而 daemon 级的环境变量对所有会话是同一个值。
  //
  // 消息不在 CLI 提示词里，而在工作目录的 `INTENT.md`（实测：提示词只是壳，
  // 会话正文、清单、挂载全部落在工作目录里，真实模型也是从那里读的）。
  let intentDoc = ''
  try {
    intentDoc = readFileSync('INTENT.md', 'utf8')
  } catch {
    intentDoc = ''
  }
  const targetName =
    /rfc319-target:([A-Za-z0-9._-]+)/.exec(intentDoc)?.[1] ??
    /rfc319-target:([A-Za-z0-9._-]+)/.exec(prompt)?.[1] ??
    ''
  let inventory = ''
  try {
    inventory = readFileSync('inventory/agents.md', 'utf8')
  } catch {
    inventory = ''
  }
  const escaped = targetName.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = new RegExp(`(res#agent#\\d+)\\s+\`${escaped}\``).exec(inventory)
  if (found === null) {
    process.stderr.write(
      `${NAME}: no handle for ${JSON.stringify(targetName)} in inventory/agents.md\n`,
    )
    process.exit(4)
  }
  return JSON.stringify({
    $schema_version: 1,
    ops: [
      {
        opId: 'op-1',
        action: 'update',
        resourceType: 'agent',
        target: found[1],
        payload: {
          // 同名写回：intent 的 update **不支持改名**（服务端判
          // `intent-rename-unsupported`，改名要走副本上的 finalName 槽）。
          // 「谁被改了」因此靠 description / bodyMd 区分。
          name: targetName,
          description: 'updated by the e2e intent stub',
          outputs: ['answer'],
          bodyMd: 'Body rewritten by the e2e intent stub.',
        },
      },
    ],
  })
}

/**
 * RFC-319 —— `STUB_INTENT_VARIANT=questions`：先追问一轮，再产出 changeset。
 *
 * 意图构建器的**结构化追问**（`questions` 端口）与**资源挂载建议**（`requests` 端口）
 * 此前没有任何 stub 产出过，于是「AI 追问 → 用户作答」「AI 建议挂载 → 用户逐项批准」
 * 这两条用户面主路径在 e2e 里一次都没被走过（能力账本 INTENT-12 / 18 / 19）。
 *
 * 轮次判定读工作目录里的 `INTENT.md`——平台把会话历史逐轮渲染进去
 * （`services/intent/intentDoc.ts:120-144` 的 `### turn N (user/answers)` /
 * `- turn N (user/answers) [compacted]`），所以「用户已经答过了吗」这件事对 stub
 * 是可观测的，不需要跨进程状态文件。答过 ⇒ 回到正常的 changeset 轮。
 */
const CLARIFY_QUESTIONS = JSON.stringify([
  {
    id: 'q-scope',
    question: 'Which repositories should the auditor cover?',
    options: ['Only this repository', 'Every repository in the group'],
    multiSelect: false,
  },
  {
    id: 'q-sections',
    question: 'Which report sections must the auditor emit?',
    options: ['findings', 'severity', 'remediation'],
    multiSelect: true,
  },
])

/**
 * 三条挂载建议，覆盖候选解析的三种形态（`routes/intentSessions.ts:414-449` 按
 * **同类型同名**匹配 actor 可见资源）：调用方建两个同名工作流 ⇒ 多候选下拉；
 * 建一个同名代理 ⇒ 单候选直显；技能名故意不建 ⇒ 零候选告警。
 */
const MOUNT_REQUESTS = JSON.stringify([
  {
    resourceType: 'agent',
    name: 'e2e-intent-suggested-agent',
    reason: 'Reuse the existing auditor persona',
  },
  {
    resourceType: 'workflow',
    name: 'e2e-intent-suggested-workflow',
    reason: 'Start from the existing review pipeline',
  },
  {
    resourceType: 'skill',
    name: 'e2e-intent-missing-skill',
    reason: 'Apply the house audit checklist',
  },
])

function intentDocText(): string {
  try {
    return readFileSync('INTENT.md', 'utf8')
  } catch {
    return ''
  }
}

export async function run(argv: readonly string[]): Promise<void> {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode intent-build\n')
    process.exit(0)
  }
  const open = requireOutputOpen(call.prompt, NAME)

  const workflowVariant = process.env.STUB_INTENT_VARIANT === 'workflow'
  const layoutFixture = process.env.STUB_INTENT_LAYOUT_FIXTURE
  const updateVariant = process.env.STUB_INTENT_VARIANT === 'update'
  const changeset = updateVariant
    ? updateChangeset(call.prompt)
    : workflowVariant
      ? layoutFixture === 'overlap'
        ? OVERLAPPING_WORKFLOW_CHANGESET
        : layoutFixture === 'nested-cycle'
          ? NESTED_CYCLE_WORKFLOW_CHANGESET
          : WORKFLOW_CHANGESET
      : AGENT_CHANGESET
  const summary = updateVariant
    ? 'stub intent build: one agent update'
    : workflowVariant
      ? 'stub intent build: workflow preview'
      : 'stub intent build: one auditor agent'

  const holdFile = process.env.STUB_INTENT_HOLD_FILE
  if (holdFile !== undefined) {
    const deadline = Date.now() + 30_000
    while (existsSync(holdFile) && Date.now() < deadline) {
      await new Promise((releaseCheck) => setTimeout(releaseCheck, 25))
    }
    if (existsSync(holdFile)) {
      throw new Error(`stub intent hold was not released within 30000ms: ${holdFile}`)
    }
  } else {
    const delayMs = Number.parseInt(process.env.STUB_INTENT_DELAY_MS ?? '0', 10)
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
    }
  }

  // RFC-319 —— 失败注入：文件在就「跑完了但一个信封都没吐」，这正是产品的
  // `intent-envelope-missing` 分支（`services/intent/turnEngine.ts:721-730`）。
  // 用文件而不是环境变量，是因为一个 daemon 要连着跑「先失败 → 再重试成功」，
  // 而 daemon 级环境变量对整条会话是同一个值。
  const failFile = process.env.STUB_INTENT_FAIL_FILE
  if (failFile !== undefined && existsSync(failFile)) {
    emitTextEvent(`${NAME}: deliberate envelope-less turn (STUB_INTENT_FAIL_FILE)`)
    process.exit(0)
  }

  // RFC-319 —— 把「执行详情」的事件捕获推过 8 MiB 上限
  // （`services/intent/turnSession.ts:21,127-134`），让 `truncated` 这一态可观测。
  // 调用方须同时把 `intentBuilderStdoutCapBytes` 抬到信封仍能被解析的水位。
  const fillerBytes = Number.parseInt(process.env.STUB_INTENT_FILLER_BYTES ?? '0', 10)
  if (Number.isFinite(fillerBytes) && fillerBytes > 0) {
    const chunk = 'f'.repeat(1024 * 1024)
    for (let sent = 0; sent < fillerBytes; sent += chunk.length) emitTextEvent(chunk)
  }

  if (process.env.STUB_INTENT_VARIANT === 'questions') {
    const answered = /\(user\/(answers|mount-approval)\)/.test(intentDocText())
    const requests =
      process.env.STUB_INTENT_MOUNT_REQUESTS === '1'
        ? `\n  <port name="requests">${MOUNT_REQUESTS}</port>`
        : ''
    emitTextEvent(
      answered
        ? `${open}\n  <port name="summary">${summary}</port>\n  <port name="changeset">${changeset}</port>${requests}\n</workflow-output>`
        : `${open}\n  <port name="summary">stub intent build: clarification needed</port>\n  <port name="questions">${CLARIFY_QUESTIONS}</port>${requests}\n</workflow-output>`,
    )
    process.exit(0)
  }

  emitTextEvent(
    `${open}\n  <port name="summary">${summary}</port>\n  <port name="changeset">${changeset}</port>\n</workflow-output>`,
  )
  process.exit(0)
}
