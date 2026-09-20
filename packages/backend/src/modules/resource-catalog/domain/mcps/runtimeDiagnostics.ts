import { Buffer } from 'node:buffer'
import type { StartupVerificationResult } from '@agent-workflow/shared'
import { NotFoundError, ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
export interface McpDiagnosticSubject {
  readonly userId: string
  readonly canAudit: boolean
}
export interface McpDiagnosticRunOutcome {
  readonly status: string
  readonly nativeSessionIntegrityFailed?: boolean
}
type SessionRow = {
  readonly ownerUserId: string
  readonly nativeSessionState: 'pending' | 'ready' | 'unusable'
  readonly runtimeSessionId: string | null
  readonly continuationBlockedReason: string | null
}
type TurnRow = {
  readonly status:
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'canceled'
    | 'timed_out'
    | 'interrupted'
}
export const MCP_RUNTIME_TEST_IDLE_MS = 10 * 60_000
export const MCP_RUNTIME_TEST_TURN_TIMEOUT_MS = 10 * 60_000
export const MCP_RUNTIME_TEST_RECEIPT_MS = 24 * 60 * 60_000
export const MCP_RUNTIME_TEST_MAX_TURNS = 32
export const MCP_RUNTIME_TEST_MESSAGE_BYTES = 64 * 1024
export const MCP_RUNTIME_TEST_EVENT_ROWS = 20_000
export const MCP_RUNTIME_TEST_EVENT_BYTES = 16 * 1024 * 1024
export const MCP_RUNTIME_TEST_SINGLE_EVENT_BYTES = 1024 * 1024

export const AGENT_NAME = 'aw-mcp-runtime-test'
export const SYSTEM_PROMPT =
  'You are testing exactly one Model Context Protocol server. Use only the MCP tools made available to you. Explain observed capabilities and errors clearly. Before an obviously state-changing tool call that the user did not explicitly request, explain the risk and ask for confirmation. Never ask for filesystem, shell, web, subagent, skill, or other MCP access.'
export const STDERR_TAIL_BYTES = 256 * 1024
export const DEFAULT_CAPACITY = 2

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`
}

export function sha256(value: string | Uint8Array): string {
  return sha256Hex(value)
}

export function requestDigest(input: {
  expectedMcpConfigHash: string
  runtimeName: string | null
  message: string
  clientMessageId: string
}): string {
  return sha256(
    stableJson({
      expectedMcpConfigHash: input.expectedMcpConfigHash,
      runtimeName: input.runtimeName,
      messageDigest: sha256(input.message),
      clientMessageId: input.clientMessageId,
    }),
  )
}

export function ensureMessage(message: string): void {
  if (message.trim().length === 0) {
    throw new ValidationError('mcp-test-message-empty', 'message must not be empty')
  }
  if (Buffer.byteLength(message, 'utf8') > MCP_RUNTIME_TEST_MESSAGE_BYTES) {
    throw new ValidationError(
      'mcp-test-message-too-large',
      `message must not exceed ${MCP_RUNTIME_TEST_MESSAGE_BYTES} UTF-8 bytes`,
    )
  }
}

export function canResumeNativeSession(
  session: Pick<
    SessionRow,
    'nativeSessionState' | 'runtimeSessionId' | 'continuationBlockedReason'
  >,
): boolean {
  return (
    session.nativeSessionState === 'ready' &&
    session.runtimeSessionId !== null &&
    session.continuationBlockedReason === null
  )
}

export function assertSessionActor(
  row: SessionRow,
  actor: McpDiagnosticSubject,
  auditOnly = false,
): void {
  if (row.ownerUserId === actor.userId) return
  if (auditOnly && actor.canAudit) return
  throw new NotFoundError('mcp-test-session-not-found', 'MCP test session not found')
}

export function resultTurnStatus(
  result: McpDiagnosticRunOutcome,
  cancelRequested: boolean,
  sessionEnding: boolean,
  durableFailureCode: string | null,
): TurnRow['status'] {
  if (durableFailureCode === 'mcp-test-turn-timeout' || result.status === 'timeout') {
    return 'timed_out'
  }
  if (durableFailureCode === 'mcp-test-daemon-shutdown') return 'interrupted'
  if (cancelRequested) return sessionEnding ? 'interrupted' : 'canceled'
  if (result.status === 'ok') return 'succeeded'
  if (result.status === 'aborted') return 'interrupted'
  return 'failed'
}

export function applyPlaygroundVerification(
  turnStatus: TurnRow['status'],
  failureCode: string | null,
  verification: StartupVerificationResult | undefined,
): { turnStatus: TurnRow['status']; failureCode: string | null } {
  if (turnStatus !== 'succeeded' || verification === undefined) {
    return { turnStatus, failureCode }
  }
  if (verification.observation !== 'verified') {
    return { turnStatus: 'failed', failureCode: 'mcp-test-verification-unavailable' }
  }
  if (verification.mcpUnusable.length > 0) {
    return { turnStatus: 'failed', failureCode: 'mcp-test-mcp-unusable' }
  }
  return { turnStatus, failureCode }
}

export function resultFailureCode(
  result: McpDiagnosticRunOutcome,
  durableFailureCode: string | null,
): string | null {
  if (
    durableFailureCode === 'mcp-test-turn-timeout' ||
    durableFailureCode === 'mcp-test-daemon-shutdown'
  ) {
    return durableFailureCode
  }
  if (result.nativeSessionIntegrityFailed === true) return 'mcp-test-session-conflict'
  if (result.status === 'ok') return null
  return `mcp-test-${result.status}`
}
