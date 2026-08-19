// RFC-310 functional journey model stand-in.
//
// This mode is intentionally capability-aware rather than a generic "answer"
// stub. It runs through the production TaskEngine -> WrapperRuntime ->
// NodeExecutor -> ExecutionKernel chain, edits the disposable action workspace,
// and emits the inner nonce-bound AgentOutcomeEnvelope on the declared
// `agent-result` port. The platform still owns diff validation, verification,
// commit/push/MR effects and readiness; the mock only stands in for the model.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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

export function run(argv: readonly string[]): void {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode 999.0.0\n')
    process.exit(0)
  }
  emitPromptForContractTest(call.prompt)
  const outerOpen = requireOutputOpen(call.prompt, NAME)
  const identity = promptIdentity(call.prompt)

  if (identity.capabilityId === 'change.implement') {
    mkdirSync(dirname(RESULT_PATH), { recursive: true })
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
