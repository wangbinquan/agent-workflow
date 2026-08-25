// RFC-310 functional journey model stand-in.
//
// This mode is intentionally capability-aware rather than a generic "answer"
// stub. It runs through the production TaskEngine -> WrapperRuntime ->
// NodeExecutor -> ExecutionKernel chain, edits the disposable action workspace,
// and emits the inner nonce-bound AgentOutcomeEnvelope on the declared
// `agent-result` port. The platform still owns diff validation, verification,
// commit/push/MR effects and readiness; the mock only stands in for the model.
//
// 它要同时站在**两套** Agent 协议前面（2026-08-25 补齐第二套）：
//
//   1. RFC-310 老协议 —— prompt 里带 `<agent-result nonce="…">` 与
//      actionRunRef / inputDigest / capabilityId，回执是端口里再套一层 nonce 帧。
//   2. 数字员工 v2 的 execution-contract 直接 JSON 协议（`inputMode:
//      'direct-json'`）—— prompt 末尾是 `INPUT_JSON` + 一行业务 JSON，回执直接
//      在声明的 workflow-output 端口里放一个平铺 JSON 对象，没有内层帧、没有 nonce
//      可回抄（后端构造见 `buildExecutionContractAgentPrompt`）。
//
// 只认第一套的后果不是「报错」而是**空洞绿**：v2 的 `analyze-implement` 每一轮都以
// `exit 2 / prompt is missing the RFC-310 agent-result identity` 失败并被退避重试，
// 而浏览器 journey 当时只断言「卡片渲染出来了」，于是连跑 7 次失败、两分钟里全绿。

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import {
  emitPromptForContractTest,
  emitTextEvent,
  envelope,
  parseInvocation,
  requireOutputOpen,
} from './skeleton'

const NAME = 'stub-development-agent'
const RESULT_PATH = 'digital-employee-result.txt'

/**
 * 需要预先创建的父目录；`null` 表示不需要建。
 *
 * `mkdirSync(dirname(p), { recursive: true })` 是个几乎人人都在用的惯用写法，但对
 * **裸文件名**它是一颗只在 Windows 上炸的雷：`dirname('a.txt')` 是 `'.'`，而
 * `mkdirSync('.', { recursive: true })` 在 POSIX 上是 no-op、在 Windows 上**抛
 * EEXIST**。2026-08-20 实撞：RFC-310 的全旅程 E2E 在 windows 那格红了两天，症状是
 * `opencode exited with code 1`——一个未捕获异常，而 stub 自己的失败是 exit 2，所以
 * 连"是不是 stub 的问题"都判断不了。真因 `EEXIST: file already exists, mkdir '.'`
 * 是给非零退出的回执补上 stderr 尾巴之后才第一次看见的。
 */
export function parentDirToCreate(filePath: string): string | null {
  const dir = dirname(filePath)
  return dir === '.' || dir === '' ? null : dir
}

function ensureParentDir(filePath: string): void {
  const dir = parentDirToCreate(filePath)
  if (dir !== null) mkdirSync(dir, { recursive: true })
}

interface RequirementManifest {
  files?: Array<{ fileId?: unknown }>
}

function fail(message: string): never {
  process.stderr.write(`${NAME}: ${message}\n`)
  process.exit(2)
}

function promptIdentity(prompt: string): {
  nonce: string
  actionRunRef: string
  inputDigest: string
  capabilityId: string
} {
  const nonce = [...prompt.matchAll(/<agent-result nonce="([^"]+)">/g)].at(-1)?.[1]
  const actionRunRef = [...prompt.matchAll(/"actionRunRef": "([^"]+)"/g)].at(-1)?.[1]
  const inputDigest = [...prompt.matchAll(/"inputDigest": "([^"]+)"/g)].at(-1)?.[1]
  const capabilityId = [...prompt.matchAll(/"capabilityId": "([^"]+)"/g)].at(-1)?.[1]
  if (
    nonce === undefined ||
    actionRunRef === undefined ||
    inputDigest === undefined ||
    capabilityId === undefined
  ) {
    fail('prompt is missing the RFC-310 agent-result identity')
  }
  return { nonce, actionRunRef, inputDigest, capabilityId }
}

function findRequirementManifest(root = '.agent-workflow/inputs/requirements'): string | null {
  if (!existsSync(root)) return null
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, 'requirement-manifest.json')
    if (existsSync(candidate)) return candidate
  }
  return null
}

function requirementItemRefs(): string[] {
  const path = findRequirementManifest()
  if (path === null) fail('requirement bundle manifest is not mounted')
  let manifest: RequirementManifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8')) as RequirementManifest
  } catch (error) {
    fail(`cannot parse mounted requirement manifest: ${String(error)}`)
  }
  const refs = (manifest.files ?? [])
    .map((file) => file.fileId)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  if (refs.length === 0) fail('mounted requirement manifest has no fileId entries')
  return refs
}

function feedbackRefs(prompt: string): Array<{
  threadRef: string
  revision: string
  body: string
}> {
  const lines = prompt.split(/\r?\n/)
  const out: Array<{ threadRef: string; revision: string; body: string }> = []
  let current: { threadRef: string; revision: string; body: string } | null = null
  const flush = (): void => {
    if (current === null) return
    out.push(current)
    current = null
  }
  for (const line of lines) {
    const match = /^review feedback ([^@\s]+)@([^\s(]+)(?: \([^)]*\))?: ?(.*)$/.exec(line)
    if (match !== null) {
      flush()
      current = { threadRef: match[1]!, revision: match[2]!, body: match[3] ?? '' }
      continue
    }
    if (current === null) continue
    if (line === '===== END UNTRUSTED DATA =====') {
      flush()
      continue
    }
    current.body += `\n${line}`
  }
  flush()
  if (out.length === 0) fail('feedback capability received no exact review feedback text')
  return out
}

function emitAgentResult(
  outerOpen: string,
  identity: ReturnType<typeof promptIdentity>,
  result: Record<string, unknown>,
  outcome: 'changed' | 'completed' = 'changed',
): void {
  const frame = `<agent-result nonce="${identity.nonce}">${JSON.stringify({
    protocolVersion: 1,
    nonce: identity.nonce,
    port: 'agent-result',
    actionRunRef: identity.actionRunRef,
    inputDigest: identity.inputDigest,
    capabilityId: identity.capabilityId,
    outcome,
    result,
  })}</agent-result>`
  emitTextEvent(envelope(outerOpen, [['agent-result', frame]]))
}

function boundActionContext<T>(prompt: string, label: string): T {
  const prefix = `- ${label}: `
  const line = prompt.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix))
  if (line === undefined) fail(`prompt is missing ${label}`)
  try {
    return JSON.parse(line.slice(prefix.length)) as T
  } catch (error) {
    fail(`cannot parse ${label}: ${String(error)}`)
  }
}

// --------------------------------------------------------------------------
// 数字员工 v2：execution-contract 的直接 JSON 协议
// --------------------------------------------------------------------------

/** v2 prompt 里业务输入所在的行标记。老协议用的是 `INPUT_ENVELOPE_JSON`，不会误命中。 */
const DIRECT_INPUT_MARKER = 'INPUT_JSON'
/** v2 prompt 里作者示例输出所在的行标记；只有 `outputMode: 'direct-json'` 才有。 */
const DIRECT_OUTPUT_EXAMPLE_MARKER = 'OUTPUT_SCHEMA_EXAMPLE_JSON'

/**
 * 取「单独成行的 `marker` 之后第一个配平的 JSON 对象」的原文。
 *
 * 三个刻意的选择：
 *
 * - **按整行匹配**，不是 `indexOf`：`INPUT_ENVELOPE_JSON`（老 envelope 协议的标记）
 *   与 `INPUT_JSON` 只差一个中缀，用子串匹配会把两套协议搅在一起。
 * - **取最后一个**标记：prompt 里可能夹带被引述的上游材料，而框架为本轮追加的那份
 *   永远在最后——这和 `skeleton.envelopeNonce` 的 last-match-wins 是同一条理由。
 * - **自己数括号**而不是 `JSON.parse(剩余全文)`：标记后面还跟着框架追加的
 *   `<workflow-output nonce="…">` 协议块，整体不是合法 JSON；示例块又是缩进过的多行
 *   JSON，按行截断同样不行。数括号时跳过字符串内的括号与转义，才不会被业务文案里的
 *   `{` / `"` 骗到。
 */
export function jsonBlockAfterMarker(prompt: string, marker: string): string | null {
  let searchFrom: number | null = null
  for (const match of prompt.matchAll(new RegExp(`^${marker}\\r?$`, 'gm'))) {
    searchFrom = (match.index ?? 0) + match[0].length
  }
  if (searchFrom === null) return null
  const open = prompt.indexOf('{', searchFrom)
  if (open === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = open; index < prompt.length; index += 1) {
    const char = prompt[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return prompt.slice(open, index + 1)
    }
  }
  return null
}

function parseDirectJson(raw: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    fail(`cannot parse ${label}: ${String(error)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} is not a JSON object`)
  }
  return value as Record<string, unknown>
}

/**
 * 结果要发到哪个端口，从 prompt 里的输出指令原样读出来。
 *
 * 不写死 `agent-result`：端口名是每份合同自己声明的（`agentOutputPort`），写死等于
 * 把「合同换了端口」这类回归变成一次沉默的空输出——平台只会说「没拿到结果」，
 * 而不会说「你发错端口了」。
 */
function directResultPort(prompt: string): string {
  const match = [...prompt.matchAll(/^Return only one JSON object through (\S+)\.\r?$/gm)].at(
    -1,
  )?.[1]
  if (match === undefined) fail('direct-JSON prompt does not name its result port')
  return match
}

/**
 * 递归列出平台挂载到工作区里的需求材料（相对 `directory` 的路径，字典序）。
 *
 * 目录不存在或为空一律 fail：`development.implement-change` 的整个前提就是「需求材料
 * 已经在工作区里」，材料没挂上却照样回一个 completed，等于把平台挂载环节的故障洗白
 * 成一次成功交付。
 */
function requirementMaterials(directory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    fail(`mounted requirement directory is missing: ${directory}`)
  }
  const found: string[] = []
  const walk = (relative: string): void => {
    const absolute = relative === '' ? directory : join(directory, relative)
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else found.push(next)
    }
  }
  walk('')
  if (found.length === 0) fail(`mounted requirement directory is empty: ${directory}`)
  return found
}

/**
 * 执行一轮 v2 直接 JSON 动作。
 *
 * 认动作靠的是 prompt 自己带的形状，而不是 contract id —— direct-json 的 prompt 里
 * **根本没有** contract id（`buildExecutionContractAgentPrompt` 的 direct-json 分支
 * 只写 `Action: <人类可读描述>`），所以模型能用来判断的信息就只有输入字段和作者示例
 * 输出的字段，stub 也只用这些。不认识的形状必须显式 fail 并把两边字段名打出来：
 * 静默回一个「差不多像」的对象只会把下一次协议漂移再变成一条空洞绿。
 */
function runDirectJsonAction(outerOpen: string, prompt: string, inputRaw: string): never {
  const exampleRaw = jsonBlockAfterMarker(prompt, DIRECT_OUTPUT_EXAMPLE_MARKER)
  if (exampleRaw === null) {
    fail(`direct-JSON prompt has no ${DIRECT_OUTPUT_EXAMPLE_MARKER} block`)
  }
  const input = parseDirectJson(inputRaw, DIRECT_INPUT_MARKER)
  const example = parseDirectJson(exampleRaw, DIRECT_OUTPUT_EXAMPLE_MARKER)
  const port = directResultPort(prompt)

  // `development.implement-change@2`（工作项 `analyze-implement`）：输入只有需求目录
  // （外加可选的已批准方案），输出是交付三件套。
  const deliveryShape =
    typeof example.commitMessage === 'string' &&
    typeof example.mergeRequestTitle === 'string' &&
    typeof example.mergeRequestDescription === 'string'
  const requirementsDirectory = input.requirementsDirectory
  if (deliveryShape && typeof requirementsDirectory === 'string' && input.threads === undefined) {
    const materials = requirementMaterials(requirementsDirectory)
    // 必须真的改一个业务文件：该合同的 workspacePolicy 是
    // `businessChangeOnOk: 'required'`，只回 JSON 不动工作区的话平台会判本轮失败。
    ensureParentDir(RESULT_PATH)
    writeFileSync(
      RESULT_PATH,
      [
        'Implemented by the RFC-310 digital employee system mock.',
        ...materials.map((item) => `requirement material: ${item}`),
        '',
      ].join('\n'),
      'utf8',
    )
    emitTextEvent(
      envelope(outerOpen, [
        [
          port,
          JSON.stringify({
            outcome: 'completed',
            commitMessage: 'implement the accepted requirement',
            mergeRequestTitle: 'Implement the accepted requirement',
            mergeRequestDescription: `Implemented the change from ${materials.length} mounted requirement material(s): ${materials.join(', ')}.`,
          }),
        ],
      ]),
    )
    process.exit(0)
  }

  fail(
    `unsupported direct-JSON action; input fields ${JSON.stringify(
      Object.keys(input).sort(),
    )}, result fields ${JSON.stringify(Object.keys(example).sort())}`,
  )
}

export function run(argv: readonly string[]): void {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode 999.0.0\n')
    process.exit(0)
  }
  emitPromptForContractTest(call.prompt)
  const outerOpen = requireOutputOpen(call.prompt, NAME)

  // 协议分流放在 `promptIdentity` 之前：老协议的失败信息（"missing the RFC-310
  // agent-result identity"）对 v2 prompt 毫无意义，正是它把真正的原因盖了两个月。
  const directInput = jsonBlockAfterMarker(call.prompt, DIRECT_INPUT_MARKER)
  if (directInput !== null) runDirectJsonAction(outerOpen, call.prompt, directInput)

  const identity = promptIdentity(call.prompt)

  if (identity.capabilityId === 'change.implement') {
    ensureParentDir(RESULT_PATH)
    writeFileSync(RESULT_PATH, 'Implemented by the RFC-310 digital employee system mock.\n', 'utf8')
    emitAgentResult(outerOpen, identity, {
      capabilityId: identity.capabilityId,
      summary: 'implemented the submitted requirement in the action workspace',
      requirementCoverage: requirementItemRefs().map((itemRef) => ({
        itemRef,
        disposition: 'implemented',
      })),
    })
    process.exit(0)
  }

  if (identity.capabilityId === 'mr.feedback.apply') {
    const feedback = feedbackRefs(call.prompt)
    appendFileSync(
      RESULT_PATH,
      feedback.map((row) => `Applied review feedback: ${row.body}\n`).join(''),
      'utf8',
    )
    emitAgentResult(outerOpen, identity, {
      capabilityId: identity.capabilityId,
      summary: 'applied every selected review feedback revision',
      feedback: feedback.map((row) => ({
        threadRef: row.threadRef,
        revision: row.revision,
        disposition: 'addressed',
      })),
    })
    process.exit(0)
  }

  if (identity.capabilityId === 'problem.classify') {
    const context = boundActionContext<{
      producerId: string
      evidenceDigest: string
      headSha: string
      allowedTypeIds: string[]
      subjectRefs: string[]
      requiredSubjectRefs: string[]
    }>(call.prompt, 'Problem classification context')
    const typeId = context.allowedTypeIds[0]
    if (typeId === undefined) fail('problem context has no allowed type')
    emitAgentResult(
      outerOpen,
      identity,
      {
        capabilityId: identity.capabilityId,
        producerId: context.producerId,
        evidenceDigest: context.evidenceDigest,
        headSha: context.headSha,
        complete: true,
        problems: context.requiredSubjectRefs.map((subjectRef, index) => ({
          problemRef: `${context.producerId}-${index + 1}`,
          typeId,
          subjectRefs: [subjectRef],
          summary: `Classified ${subjectRef} as ${typeId}.`,
        })),
      },
      'completed',
    )
    process.exit(0)
  }

  if (identity.capabilityId === 'approval.prepare') {
    const context = boundActionContext<{
      stepRunRef: string
      approvalType: string
      evidenceRefs: string[]
      requestedScopes: string[]
    }>(call.prompt, 'Approval preparation context')
    emitAgentResult(
      outerOpen,
      identity,
      {
        capabilityId: identity.capabilityId,
        stepRunRef: context.stepRunRef,
        approvalType: context.approvalType,
        title: `Approval for ${context.approvalType}`,
        bodyArtifactRef: `approval-body:${context.stepRunRef}`,
        evidenceRefs: context.evidenceRefs,
        requestedScopes: context.requestedScopes,
      },
      'completed',
    )
    process.exit(0)
  }

  fail(`unsupported RFC-310 capability ${JSON.stringify(identity.capabilityId)}`)
}
