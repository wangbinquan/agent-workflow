// RFC-310 PR-4 T46 —— transport parser（design.md §7.5 步骤 1-3）。
//
// stdout 全文 → 恰好一个 named-port frame → strict schema → exact match。
// 定界形式：`<agent-result nonce="...">…JSON…</agent-result>`。
//   - 与 script 节点的 `<workflow-output><port>` 显式不同形：两条通道语义
//     不同（last-wins vs exactly-one）、parser 不同，避免任何一侧的输出被
//     另一侧误吞；
//   - nonce 进开标签属性 **且** 进 JSON header：evidence/需求文本里预埋的
//     假 frame 拿不到本 attempt 的新 nonce，两处都对不上；
//   - 多 frame 不是 last-wins 而是直接拒（§7.5 步骤 1「exactly one」）。
// 失败产出 typed AgentProtocolRejection（结构化反馈素材）：不含 raw log；
// nonce mismatch 不回显期望值（nonce 是 secret，台账只存 digest）。

import { agentOutcomeEnvelopeSchema, type AgentOutcomeEnvelope } from '../../domain/agentEnvelope'
import { nonceDigestOf } from '../../domain/agentAttempt'

export interface AgentProtocolRejection {
  readonly code:
    | 'frame-missing'
    | 'frame-multiple'
    | 'frame-not-json'
    | 'schema-invalid'
    | 'nonce-mismatch'
    | 'action-run-mismatch'
    | 'input-digest-mismatch'
    | 'capability-mismatch'
  readonly jsonPointer: string | null
  readonly expected: string | null
  readonly observedSummary: string
}

/**
 * 对拍身份用 nonce 的 **digest**：明文 nonce 只在 launch 轮的 protocol block
 * 与 Agent 回显里存在（§7.1「台账持 digest」）；collect 发生在后续 reconcile
 * 轮，平台侧只有 attempt.nonceDigest。frame 里的明文由 Agent 回显，parser
 * 以 nonceDigestOf(明文) === nonceDigest 判定。
 */
export interface ExpectedFrameIdentity {
  readonly nonceDigest: string
  readonly actionRunRef: string
  readonly inputDigest: string
  readonly capabilityId: string
}

export type AgentFrameParseResult =
  | { readonly ok: true; readonly envelope: AgentOutcomeEnvelope }
  | { readonly ok: false; readonly rejection: AgentProtocolRejection }

const FRAME_RE = /<agent-result\s+nonce="([^"]*)"\s*>([\s\S]*?)<\/agent-result>/g

function reject(
  code: AgentProtocolRejection['code'],
  observedSummary: string,
  extras: { readonly jsonPointer?: string | null; readonly expected?: string | null } = {},
): AgentFrameParseResult {
  return {
    ok: false,
    rejection: {
      code,
      jsonPointer: extras.jsonPointer ?? null,
      expected: extras.expected ?? null,
      observedSummary: observedSummary.slice(0, 500),
    },
  }
}

function pointerOf(path: readonly (string | number)[]): string {
  return path.length === 0 ? '' : `/${path.map(String).join('/')}`
}

export function parseAgentFrame(
  stdout: string,
  expected: ExpectedFrameIdentity,
): AgentFrameParseResult {
  const frames = [...stdout.matchAll(FRAME_RE)]
  if (frames.length === 0) {
    return reject('frame-missing', 'no <agent-result> frame found in the output', {
      expected: 'exactly one <agent-result nonce="…">…</agent-result> frame',
    })
  }
  if (frames.length > 1) {
    return reject('frame-multiple', `${frames.length} <agent-result> frames found`, {
      expected: 'exactly one frame',
    })
  }
  const [, tagNonce, body] = frames[0]!
  if (nonceDigestOf(tagNonce ?? '') !== expected.nonceDigest) {
    return reject(
      'nonce-mismatch',
      'frame tag nonce does not match the one issued for this attempt',
    )
  }

  let json: unknown
  try {
    json = JSON.parse(body!.trim())
  } catch {
    return reject('frame-not-json', 'frame body is not valid JSON', {
      expected: 'a single JSON object matching the outcome schema',
    })
  }

  const parsed = agentOutcomeEnvelopeSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    return reject('schema-invalid', issue.message, {
      jsonPointer: pointerOf(issue.path),
      expected: 'a strict outcome envelope (unknown keys are rejected)',
    })
  }

  const envelope = parsed.data
  if (nonceDigestOf(envelope.nonce) !== expected.nonceDigest) {
    return reject(
      'nonce-mismatch',
      'envelope nonce does not match the one issued for this attempt',
      {
        jsonPointer: '/nonce',
      },
    )
  }
  if (envelope.actionRunRef !== expected.actionRunRef) {
    return reject('action-run-mismatch', `envelope actionRunRef is '${envelope.actionRunRef}'`, {
      jsonPointer: '/actionRunRef',
      expected: expected.actionRunRef,
    })
  }
  if (envelope.inputDigest !== expected.inputDigest) {
    return reject('input-digest-mismatch', `envelope inputDigest is '${envelope.inputDigest}'`, {
      jsonPointer: '/inputDigest',
      expected: expected.inputDigest,
    })
  }
  if (envelope.capabilityId !== expected.capabilityId) {
    return reject('capability-mismatch', `envelope capabilityId is '${envelope.capabilityId}'`, {
      jsonPointer: '/capabilityId',
      expected: expected.capabilityId,
    })
  }
  return { ok: true, envelope }
}
