// RFC-027: normalized conversation-tree model for the NodeDetailDrawer
// Session tab. Re-parses persisted node_run_events into a structured
// SessionTree where assistant messages, tool calls, and subagent (task
// tool) invocations become first-class blocks with recursive nesting.
//
// The parser is a pure function: input is the raw event rows from the
// `node_run_events` table (already enriched with session_id /
// parent_session_id by the runner + sessionCapture), output is one
// SessionTree per root session. The frontend SessionTab consumes the
// tree directly; the backend `/session` endpoint serializes it.
//
// Payload dialects (per event row, sniffed by shape — a run's rows are
// homogeneous but the parser doesn't need to know which runtime wrote them):
//  - opencode NDJSON: `{type, sessionID, part: {type: 'text'|'reasoning'|'tool', …}}`
//    — the original RFC-027 format, handled by the `part`-based branches.
//  - Claude Code (RFC-111): raw `--output-format stream-json` stdout lines and
//    subagent transcript JSONL lines, both persisted verbatim. Shape:
//    `{type: 'assistant'|'user', message: {id, content: [block]|string},
//      parent_tool_use_id?, session_id|sessionId, …}` plus `system` linkage
//    events (`task_started`/`task_notification`). Verified hands-on against
//    claude 2.1.202 (2026-07-07): assistant events arrive one-per-content-block
//    (same message.id repeated), subagent turns are inlined into the root
//    stream tagged `parent_tool_use_id`, and the post-run transcript capture
//    re-persists the same turns under sessionId `agent-<taskId>` — the claude
//    pre-pass re-buckets the inline rows to that same key and dedups by
//    (message.id, block type, content) so live and captured rows fold into
//    one child tree. See `buildClaudeLinkage` below.

export type SessionMessageKind =
  | 'user'
  | 'assistant-text'
  | 'assistant-reasoning'
  | 'tool-call'
  | 'subagent-call'

export interface SessionUserMessage {
  kind: 'user'
  text: string
  ts: number
}

export interface SessionAssistantText {
  kind: 'assistant-text'
  text: string
  ts: number
  /** opencode messageID when known; null for tests / events that didn't expose one. */
  messageId: string | null
}

/**
 * Model thinking / chain-of-thought block. opencode emits these as
 * `part.type === 'reasoning'` (cli/cmd/run.ts:671) whenever the parent
 * runner is launched with `--thinking`. Stream deltas land as repeated
 * events with the same messageID, so the parser folds them with the
 * same last-write-wins merge used for assistant-text.
 */
export interface SessionAssistantReasoning {
  kind: 'assistant-reasoning'
  text: string
  ts: number
  messageId: string | null
}

export interface SessionToolCall {
  kind: 'tool-call'
  toolName: string
  callId: string
  status: 'pending' | 'running' | 'completed' | 'error'
  // Matches zod's z.unknown() inferred shape (optional). Always present
  // when written by the backend, but type stays optional so the
  // SessionViewResponseSchema → SessionTree assignment stays type-safe.
  input?: unknown
  /** Final tool output text (state.output) when completed; null otherwise. */
  output: string | null
  ts: number
  messageId: string | null
}

export interface SessionSubagentCall {
  kind: 'subagent-call'
  toolName: string
  callId: string
  status: 'pending' | 'running' | 'completed' | 'error'
  // Matches z.unknown() inferred shape (optional). See SessionToolCall.
  input?: unknown
  output: string | null
  ts: number
  messageId: string | null
  /** Child session id extracted from part.metadata.sessionID; null when capture missed. */
  childSessionId: string | null
  /** Recursive child tree (null when child events are not in the bucket map). */
  child: SessionTree | null
  /** AC-10 fallback: parent-side final tool output when child events are missing. */
  childOutputFallback: string | null
  /** Best-effort agent name for the child session (e.g. from input.subagent_type). */
  childAgentName: string | null
}

export type SessionMessage =
  | SessionUserMessage
  | SessionAssistantText
  | SessionAssistantReasoning
  | SessionToolCall
  | SessionSubagentCall

export interface SessionTree {
  sessionId: string
  parentSessionId: string | null
  agentName: string | null
  messages: SessionMessage[]
  /** False when this session's bucket is empty or contains a capture-failed marker. */
  captureComplete: boolean
}

export interface ParseSessionInputEvent {
  id: number
  ts: number
  /** Same enum as node_run_events.kind, plus the synthetic 'subagent_capture_failed' marker. */
  kind: string
  /** Bucket key; null events fall into the root bucket. */
  sessionId: string | null
  parentSessionId: string | null
  /** Raw JSON line (NDJSON from opencode stdout, or transcoder output). */
  payload: string
}

export interface ParseSessionInput {
  rootSessionId: string | null
  promptText: string | null
  startedAt: number | null
  primaryAgentName: string
  events: ParseSessionInputEvent[]
  /**
   * RFC-027 §UX merge — extra user prompts from sibling node_runs
   * sharing the same opencode session (e.g. RFC-026 inline clarify
   * reruns). Each entry becomes an additional SessionUserMessage in
   * the root tree, inserted at its `ts` so it interleaves correctly
   * with assistant events emitted between the prompts. The legacy
   * `promptText` field still seeds the FIRST user prompt; this array
   * carries the subsequent rounds.
   *
   * When this field is absent or empty, the parser preserves the
   * pre-RFC-027 §UX behavior of unshifting promptText to index 0
   * regardless of ts (legacy callers unchanged).
   */
  extraUserPrompts?: Array<{ text: string; ts: number }>
}

const UNKNOWN_SESSION_ID = '(unknown)'

/**
 * Pure parser: groups events by session_id and reconstructs the
 * conversation tree. See RFC-027 design.md §2.2 for the algorithm.
 *
 * Invariants:
 *  - Tool parts with the same callID are folded by last-write-wins;
 *    'task' tool parts upgrade to SessionSubagentCall.
 *  - Subagent recursion is bounded by the event bucket map — there is
 *    no unbounded loop even on malformed input.
 *  - The root tree always includes a leading SessionUserMessage when
 *    promptText is provided, even if events is empty.
 */
export function parseSessionTree(input: ParseSessionInput): SessionTree {
  const buckets = new Map<string, ParseSessionInputEvent[]>()
  const parentOf = new Map<string, string | null>()
  const captureFailed = new Set<string>()

  const rootKey = input.rootSessionId ?? deriveRootBucketKey(input.events)

  // Parse every payload once up front: the claude dialect needs a cross-event
  // linkage pre-pass (subagent re-bucketing), and build() reuses these parses
  // instead of JSON.parsing each payload a second time.
  const parsedByEvt = new Map<ParseSessionInputEvent, unknown>()
  for (const evt of input.events) {
    parsedByEvt.set(evt, safeJsonParse(evt.payload))
  }
  const claude = buildClaudeLinkage(input.events, parsedByEvt, rootKey)

  for (const evt of input.events) {
    // Claude inline subagent rows share the root session_id on the wire; the
    // linkage pre-pass re-homes them to their child bucket (`agent-<taskId>`)
    // so they merge with the post-run transcript capture rows.
    const key = claude.bucketOf.get(evt) ?? evt.sessionId ?? rootKey
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = []
      buckets.set(key, bucket)
    }
    bucket.push(evt)
    if (!parentOf.has(key)) {
      parentOf.set(key, evt.parentSessionId ?? null)
    }
    if (evt.kind === 'subagent_capture_failed') {
      // The marker payload carries the *child* session id whose capture
      // failed (or the parent id when we don't know the child).
      const target = readCaptureFailedTarget(evt.payload) ?? key
      captureFailed.add(target)
    }
  }

  // Claude child buckets hang off the bucket that owns their spawning
  // `tool_use` block (arbitrary nesting depth), overriding both the pump's
  // parent_session_id=null and the transcript capture's flat parent=root.
  for (const [childKey, parentKey] of claude.parentOverride) {
    parentOf.set(childKey, parentKey)
  }

  // Make sure each bucket is in stable (ts, id) order so downstream
  // folding is deterministic regardless of insert order (stdout +
  // post-run SQLite write into the same table out-of-order).
  for (const arr of buckets.values()) {
    arr.sort((a, b) => a.ts - b.ts || a.id - b.id)
  }

  const visited = new Set<string>()
  function build(
    sessionId: string,
    parentSessionId: string | null,
    agentHint: string | null,
  ): SessionTree {
    visited.add(sessionId)
    const bucket = buckets.get(sessionId) ?? []
    const messages: SessionMessage[] = []
    const tools = new Map<string, SessionToolCall | SessionSubagentCall>()
    const textsByMessageId = new Map<string, SessionAssistantText>()
    const reasoningByMessageId = new Map<string, SessionAssistantReasoning>()
    // Claude dialect: exact-duplicate guard for user-message text. The same
    // subagent prompt line can arrive from both the live stream and the
    // captured transcript (and is re-synthesized from task_started.prompt).
    const claudeUserSeen = new Set<string>()
    // Claude dialect: tool_result rows whose tool_use hasn't been seen yet.
    // The (ts, id) bucket sort can put a result first when the result row
    // carries its own ISO timestamp while the tool_use row got the pump's
    // arrival Date.now() (ms-level skew across the two clocks/sources).
    // Folded after the event loop instead of being silently dropped.
    const claudePendingResults = new Map<
      string,
      { output: string | null; isError: boolean; isAsyncLaunch: boolean }
    >()

    /**
     * Claude Code row handler (payloads without opencode's `part`). Ignores
     * the persisted row `kind` entirely — the pump/capture kinds are per-turn
     * approximations (e.g. a transcript's initial user-prompt line lands as
     * kind=tool_use) while the verbatim payload is authoritative.
     */
    const handleClaudeRow = (
      evt: ParseSessionInputEvent,
      parsed: Record<string, unknown>,
    ): void => {
      const turn = claudeTurnOf(parsed)
      if (turn === null) return // system/result/rate_limit/attachment/… rows render nothing

      if (turn.type === 'assistant') {
        const msgKeyBase = turn.messageId ?? `__anon__:${evt.id}`
        for (const block of claudeContentBlocks(turn.message)) {
          const blockType = typeof block.type === 'string' ? block.type : null
          if (blockType === 'thinking') {
            const text = typeof block.thinking === 'string' ? block.thinking : ''
            if (text === '') continue
            // Key includes the text so a captured-transcript duplicate of a
            // streamed block folds away (claude never re-emits a block with
            // different text under the same message id).
            const key = `c:${msgKeyBase}:reasoning:${text}`
            if (reasoningByMessageId.has(key)) continue
            const blockMsg: SessionAssistantReasoning = {
              kind: 'assistant-reasoning',
              text,
              ts: evt.ts,
              messageId: turn.messageId,
            }
            reasoningByMessageId.set(key, blockMsg)
            messages.push(blockMsg)
          } else if (blockType === 'text') {
            const text = typeof block.text === 'string' ? block.text : ''
            if (text === '') continue
            const key = `c:${msgKeyBase}:text:${text}`
            if (textsByMessageId.has(key)) continue
            const blockMsg: SessionAssistantText = {
              kind: 'assistant-text',
              text,
              ts: evt.ts,
              messageId: turn.messageId,
            }
            textsByMessageId.set(key, blockMsg)
            messages.push(blockMsg)
          } else if (blockType === 'tool_use') {
            const callId = typeof block.id === 'string' ? block.id : `__anon_call__:${evt.id}`
            // First writer wins: claude blocks are complete (not deltas), so a
            // later duplicate row (captured transcript) must not reset the
            // status/output a tool_result already folded in.
            if (tools.has(callId)) continue
            const toolName = typeof block.name === 'string' ? block.name : 'unknown'
            const inputVal = block.input ?? null
            if (toolName === 'Task' || toolName === 'Agent') {
              const childKey = claude.childKeyOf(callId)
              const blockMsg: SessionSubagentCall = {
                kind: 'subagent-call',
                toolName,
                callId,
                status: 'running',
                input: inputVal,
                output: null,
                ts: evt.ts,
                messageId: turn.messageId,
                childSessionId: buckets.has(childKey) ? childKey : null,
                child: null,
                childOutputFallback: null,
                childAgentName: pickSubagentAgentName(inputVal),
              }
              messages.push(blockMsg)
              tools.set(callId, blockMsg)
            } else {
              const blockMsg: SessionToolCall = {
                kind: 'tool-call',
                toolName,
                callId,
                status: 'running',
                input: inputVal,
                output: null,
                ts: evt.ts,
                messageId: turn.messageId,
              }
              messages.push(blockMsg)
              tools.set(callId, blockMsg)
            }
          }
          // Unknown block types (image, server_tool_use, …) are skipped.
        }
        return
      }

      // turn.type === 'user': tool results, or the subagent transcript's
      // initial prompt line (message.content is a plain string).
      const pushUser = (text: string): void => {
        if (text === '' || claudeUserSeen.has(text)) return
        claudeUserSeen.add(text)
        messages.push({ kind: 'user', text, ts: evt.ts })
      }
      const rawContent = turn.message.content
      if (typeof rawContent === 'string') {
        pushUser(rawContent)
        return
      }
      for (const block of claudeContentBlocks(turn.message)) {
        const blockType = typeof block.type === 'string' ? block.type : null
        if (blockType === 'tool_result') {
          const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null
          if (callId === null) continue
          const fold = {
            output: flattenClaudeToolResultContent(block.content),
            isError: block.is_error === true,
            isAsyncLaunch: turn.toolUseResult?.isAsync === true,
          }
          const target = tools.get(callId)
          if (target === undefined) {
            // tool_use not seen yet (result row sorted first) — fold later.
            claudePendingResults.set(callId, fold)
            continue
          }
          applyClaudeToolResult(target, fold)
        } else if (blockType === 'text') {
          pushUser(typeof block.text === 'string' ? block.text : '')
        }
      }
    }

    for (const evt of bucket) {
      const parsed = parsedByEvt.get(evt) ?? null
      if (parsed === null || !isRecord(parsed)) continue
      const part = parsed.part
      if (!isRecord(part)) {
        handleClaudeRow(evt, parsed)
        continue
      }
      const partType = typeof part.type === 'string' ? part.type : null

      if (partType === 'text' && evt.kind === 'text') {
        const text = typeof part.text === 'string' ? part.text : ''
        if (text === '') continue
        const messageId = pickMessageId(parsed, part)
        const key = messageId ?? `__anon__:${evt.id}`
        const existing = textsByMessageId.get(key)
        if (existing !== undefined) {
          existing.text = text
          existing.ts = evt.ts
        } else {
          const block: SessionAssistantText = {
            kind: 'assistant-text',
            text,
            ts: evt.ts,
            messageId,
          }
          textsByMessageId.set(key, block)
          messages.push(block)
        }
        continue
      }

      // RFC: reasoning parts (model thinking blocks) folded with the
      // same last-write-wins strategy as assistant-text. Empty deltas
      // (final part.text === '') are skipped so we never push hollow
      // "Thinking · 0 chars" blocks into the UI.
      if (partType === 'reasoning' && evt.kind === 'reasoning') {
        const text = typeof part.text === 'string' ? part.text : ''
        if (text === '') continue
        const messageId = pickMessageId(parsed, part)
        const key = messageId ?? `__anon__:${evt.id}`
        const existing = reasoningByMessageId.get(key)
        if (existing !== undefined) {
          existing.text = text
          existing.ts = evt.ts
        } else {
          const block: SessionAssistantReasoning = {
            kind: 'assistant-reasoning',
            text,
            ts: evt.ts,
            messageId,
          }
          reasoningByMessageId.set(key, block)
          messages.push(block)
        }
        continue
      }

      if (partType === 'tool' && evt.kind === 'tool_use') {
        const callId = typeof part.callID === 'string' ? part.callID : `__anon_call__:${evt.id}`
        const toolName = typeof part.tool === 'string' ? part.tool : 'unknown'
        const state = isRecord(part.state) ? part.state : {}
        const status = normalizeToolStatus(typeof state.status === 'string' ? state.status : null)
        const output = typeof state.output === 'string' ? state.output : null
        const input = state.input ?? null
        const messageId = pickMessageId(parsed, part)
        const ts = evt.ts

        const existing = tools.get(callId)
        if (toolName === 'task') {
          // opencode 1.15.x writes the spawned child sessionID at
          // `part.state.metadata.sessionId` (see opencode
          // packages/opencode/src/tool/task.ts:170-180 and
          // packages/opencode/src/session/prompt.ts:780-787 which
          // spreads ctx.metadata's `{title, metadata}` into part.state).
          // Earlier drafts of this parser looked at top-level
          // `part.metadata`, which never exists in real captures and made
          // every task tool_use render as "未能捕获子代理事件" even when
          // sessionCapture had successfully readback the child's events.
          // The top-level fallback is kept so test fixtures asserting the
          // legacy shape continue to pass.
          const stateMeta = isRecord(state.metadata) ? state.metadata : {}
          const partMeta = isRecord(part.metadata) ? part.metadata : {}
          const childSessionId = pickChildSessionId(stateMeta) ?? pickChildSessionId(partMeta)
          const childAgentName = pickSubagentAgentName(input)
          const block: SessionSubagentCall = {
            kind: 'subagent-call',
            toolName,
            callId,
            status,
            input,
            output,
            ts,
            messageId,
            childSessionId,
            child: null,
            childOutputFallback: output,
            childAgentName,
          }
          if (existing !== undefined) {
            // Replace in place to keep insertion order.
            replaceMessage(messages, existing, block)
          } else {
            messages.push(block)
          }
          tools.set(callId, block)
        } else {
          const block: SessionToolCall = {
            kind: 'tool-call',
            toolName,
            callId,
            status,
            input,
            output,
            ts,
            messageId,
          }
          if (existing !== undefined) {
            replaceMessage(messages, existing, block)
          } else {
            messages.push(block)
          }
          tools.set(callId, block)
        }
      }
    }

    // Claude: fold tool_result rows that sorted before their tool_use row
    // (Codex review P2). Only fills still-running calls — a call that already
    // folded a direct result keeps it (the pending copy is a duplicate).
    for (const [callId, fold] of claudePendingResults) {
      const target = tools.get(callId)
      if (target === undefined) continue
      if (target.status !== 'running' || target.output !== null) continue
      applyClaudeToolResult(target, fold)
    }

    // Claude: fold system task_notification results into their subagent-call
    // blocks. Async Agent launches complete through this lane (their
    // tool_result is only a launch ack, skipped above); sync calls already
    // completed via tool_result and only pick up a missing summary here.
    for (const blk of tools.values()) {
      if (blk.kind !== 'subagent-call') continue
      const link = claude.links.get(blk.callId)
      if (link === undefined) continue
      if (link.notifyStatus === 'completed' && blk.status !== 'error') {
        blk.status = 'completed'
      } else if (link.notifyStatus === 'failed' || link.notifyStatus === 'error') {
        blk.status = 'error'
      }
      if (link.notifySummary !== null && (blk.output === null || blk.output === '')) {
        blk.output = link.notifySummary
        blk.childOutputFallback = link.notifySummary
      }
    }

    // Claude: a child bucket built purely from inline stream rows has no
    // user-prompt line (the transcript capture is the only source of that
    // line, and it lands post-run). Synthesize it from task_started.prompt so
    // the live view reads as a complete conversation. The transcript's real
    // prompt line, when present, wins (claudeUserSeen also dedups the exact
    // same text arriving later).
    const childPrompt = claude.childPrompt.get(sessionId)
    if (childPrompt !== undefined && !messages.some((m) => m.kind === 'user')) {
      messages.unshift({ kind: 'user', text: childPrompt.text, ts: childPrompt.ts })
    }

    // RFC-048: surface orphan child sessions while the parent's `task`
    // tool_use part is still in flight. opencode 1.15.x emits the
    // `tool_use` envelope (carrying `state.metadata.sessionId`) only after
    // the subagent has produced some output — but the live SQLite poller
    // is already capturing the child's message/part rows. Without this
    // pass the child bucket exists in `buckets` but is never linked,
    // leaving the conversation flow stuck on the parent's reasoning/text
    // while the subagent is hard at work.
    //
    // We synthesize a placeholder `subagent-call` block for every child
    // sessionId whose `parent_id` points at this session and which is not
    // already represented by a real `task` tool_use. The placeholder's
    // `callId` is namespaced so a later refetch — when the real `tool_use`
    // arrives via stdout — replaces it through `replaceMessage` instead of
    // adding a duplicate (see the `__orphan__:` prefix path below).
    const claimedChildSessionIds = new Set<string>()
    for (const m of messages) {
      if (m.kind === 'subagent-call' && m.childSessionId !== null) {
        claimedChildSessionIds.add(m.childSessionId)
      }
    }
    const orphanChildren: Array<{ id: string; firstTs: number }> = []
    for (const [childId, parentId] of parentOf) {
      if (parentId !== sessionId) continue
      if (claimedChildSessionIds.has(childId)) continue
      if (visited.has(childId)) continue
      const childBucket = buckets.get(childId)
      if (childBucket === undefined || childBucket.length === 0) continue
      orphanChildren.push({ id: childId, firstTs: childBucket[0]!.ts })
    }
    orphanChildren.sort((a, b) => a.firstTs - b.firstTs || a.id.localeCompare(b.id))
    for (const orphan of orphanChildren) {
      const placeholder: SessionSubagentCall = {
        kind: 'subagent-call',
        toolName: 'task',
        callId: `__orphan__:${orphan.id}`,
        status: 'running',
        input: null,
        output: null,
        ts: orphan.firstTs,
        messageId: null,
        childSessionId: orphan.id,
        child: null,
        childOutputFallback: null,
        childAgentName: null,
      }
      const insertAt = messages.findIndex((m) => m.ts > orphan.firstTs)
      if (insertAt === -1) messages.push(placeholder)
      else messages.splice(insertAt, 0, placeholder)
    }

    // Resolve subagent children — recursive build, bounded by buckets map
    // and visited set (no cycles possible).
    for (const msg of messages) {
      if (msg.kind !== 'subagent-call') continue
      if (msg.childSessionId === null) continue
      if (visited.has(msg.childSessionId)) continue
      const childAgent = msg.childAgentName
      msg.child = build(msg.childSessionId, sessionId, childAgent)
    }

    const bucketIsEmpty = bucket.length === 0
    const captureMarker = captureFailed.has(sessionId)
    const captureComplete = !bucketIsEmpty && !captureMarker

    return {
      sessionId,
      parentSessionId,
      agentName: agentHint,
      messages,
      captureComplete,
    }
  }

  const tree = build(rootKey, null, input.primaryAgentName)

  const extras = input.extraUserPrompts ?? []
  if (extras.length === 0) {
    // Legacy path — promptText (when present) unshifted to index 0
    // regardless of ts. Preserves pre-RFC-027 §UX merge behavior so
    // every single-attempt caller sees no change.
    if (input.promptText !== null && input.promptText !== '') {
      const userMsg: SessionUserMessage = {
        kind: 'user',
        text: input.promptText,
        ts: input.startedAt ?? earliestTs(tree.messages) ?? 0,
      }
      tree.messages.unshift(userMsg)
    }
  } else {
    // RFC-027 §UX merge — when multiple sibling node_runs share an
    // opencode session, each round's user prompt becomes its own
    // SessionUserMessage interleaved with the assistant events by ts.
    const userMsgs: SessionUserMessage[] = []
    if (input.promptText !== null && input.promptText !== '') {
      userMsgs.push({
        kind: 'user',
        text: input.promptText,
        ts: input.startedAt ?? earliestTs(tree.messages) ?? 0,
      })
    }
    for (const p of extras) {
      userMsgs.push({ kind: 'user', text: p.text, ts: p.ts })
    }
    for (const um of userMsgs) {
      insertByTs(tree.messages, um)
    }
  }

  // Root is always captureComplete=true once any user prompt exists
  // (parent stdout is by definition captured); empty buckets only flip
  // captureComplete for genuine child sessions.
  if ((input.promptText !== null && input.promptText !== '') || extras.length > 0) {
    tree.captureComplete = true
  }

  return tree
}

/**
 * Insert a user message into `messages` at the first index whose
 * existing ts is greater. Keeps the array in stable (ts, insertion)
 * order — important when several user prompts share a ts boundary
 * with an assistant event (e.g. clarify reply emitted in the same ms).
 */
function insertByTs(messages: SessionMessage[], userMsg: SessionUserMessage): void {
  const idx = messages.findIndex((m) => m.ts > userMsg.ts)
  if (idx === -1) messages.push(userMsg)
  else messages.splice(idx, 0, userMsg)
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function deriveRootBucketKey(events: ParseSessionInputEvent[]): string {
  for (const e of events) {
    if (e.sessionId !== null) return e.sessionId
  }
  return UNKNOWN_SESSION_ID
}

function safeJsonParse(payload: string): unknown {
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function normalizeToolStatus(s: string | null): SessionToolCall['status'] {
  if (s === 'pending' || s === 'running' || s === 'completed' || s === 'error') return s
  return 'pending'
}

function pickMessageId(envelope: unknown, part: Record<string, unknown>): string | null {
  if (typeof part.messageID === 'string') return part.messageID
  if (isRecord(envelope) && typeof envelope['messageID'] === 'string')
    return envelope['messageID'] as string
  return null
}

function pickChildSessionId(meta: Record<string, unknown>): string | null {
  if (typeof meta['sessionID'] === 'string') return meta['sessionID'] as string
  if (typeof meta['sessionId'] === 'string') return meta['sessionId'] as string
  return null
}

function pickSubagentAgentName(input: unknown): string | null {
  if (!isRecord(input)) return null
  if (typeof input['subagent_type'] === 'string') return input['subagent_type'] as string
  if (typeof input['agent'] === 'string') return input['agent'] as string
  return null
}

function replaceMessage(
  messages: SessionMessage[],
  oldMsg: SessionMessage,
  newMsg: SessionMessage,
): void {
  const idx = messages.indexOf(oldMsg)
  if (idx >= 0) messages[idx] = newMsg
}

function earliestTs(messages: SessionMessage[]): number | null {
  let min: number | null = null
  for (const m of messages) {
    if (min === null || m.ts < min) min = m.ts
  }
  return min
}

function readCaptureFailedTarget(payload: string): string | null {
  const parsed = safeJsonParse(payload)
  if (!isRecord(parsed)) return null
  if (typeof parsed['sessionID'] === 'string') return parsed['sessionID'] as string
  if (typeof parsed['sessionId'] === 'string') return parsed['sessionId'] as string
  return null
}

// -----------------------------------------------------------------------------
// Claude Code dialect helpers (RFC-111 SessionTab parity)
// -----------------------------------------------------------------------------

/** One assistant/user turn row in either claude sub-dialect (stream / transcript). */
interface ClaudeTurn {
  type: 'assistant' | 'user'
  message: Record<string, unknown>
  messageId: string | null
  /** Non-null on inline subagent rows in the root stream. */
  parentToolUseId: string | null
  /** Rich result metadata: `tool_use_result` (stream) / `toolUseResult` (transcript). */
  toolUseResult: Record<string, unknown> | null
}

/**
 * Shape-sniff one parsed payload as a claude assistant/user turn. Returns null
 * for opencode rows (they carry `part`) and for claude rows that render
 * nothing (`system` / `result` / `rate_limit_event` / `attachment` / …).
 */
function claudeTurnOf(parsed: Record<string, unknown>): ClaudeTurn | null {
  if (isRecord(parsed.part)) return null
  const type = parsed.type
  if (type !== 'assistant' && type !== 'user') return null
  const message = parsed.message
  if (!isRecord(message)) return null
  const tur = parsed['tool_use_result'] ?? parsed['toolUseResult']
  return {
    type,
    message,
    messageId: typeof message.id === 'string' ? message.id : null,
    parentToolUseId:
      typeof parsed['parent_tool_use_id'] === 'string'
        ? (parsed['parent_tool_use_id'] as string)
        : null,
    toolUseResult: isRecord(tur) ? tur : null,
  }
}

/** `message.content` blocks (array form); [] for the plain-string prompt form. */
function claudeContentBlocks(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = message.content
  if (!Array.isArray(content)) return []
  return content.filter(isRecord)
}

/**
 * Fold one claude tool_result onto its tool-call / subagent-call block.
 * Async Agent launches ack immediately with placeholder metadata ("Async
 * agent launched successfully…"); the real completion arrives via the
 * system task_notification event (folded in build()'s post-pass), so those
 * keep the call running and drop the placeholder text.
 */
function applyClaudeToolResult(
  target: SessionToolCall | SessionSubagentCall,
  fold: { output: string | null; isError: boolean; isAsyncLaunch: boolean },
): void {
  if (target.kind === 'subagent-call' && fold.isAsyncLaunch) return
  target.status = fold.isError ? 'error' : 'completed'
  target.output = fold.output
  if (target.kind === 'subagent-call') target.childOutputFallback = fold.output
}

/** tool_result.content is either a plain string or [{type:'text', text}, …]. */
function flattenClaudeToolResultContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const texts: string[] = []
  for (const item of content) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
      texts.push(item.text)
    }
  }
  return texts.length > 0 ? texts.join('\n') : null
}

/** Cross-event facts about one claude subagent spawn, keyed by tool_use id. */
interface ClaudeSubagentLink {
  /** claude task/agent id → transcript bucket key `agent-<id>`. */
  agentId: string | null
  /** task_started.prompt — synthesized as the child's user message when the transcript line is absent. */
  prompt: string | null
  promptTs: number | null
  /** task_notification status/summary (async Agent completion lane). */
  notifyStatus: string | null
  notifySummary: string | null
}

interface ClaudeLinkage {
  /** toolUseId → link facts (task_started / task_notification / tool_use_result.agentId). */
  links: Map<string, ClaudeSubagentLink>
  /** Rows that move out of their wire bucket (inline subagent rows) → child bucket key. */
  bucketOf: Map<ParseSessionInputEvent, string>
  /** Child bucket key → bucket owning the spawning tool_use block. */
  parentOverride: Map<string, string>
  /** Child bucket key → synthetic user prompt (from task_started). */
  childPrompt: Map<string, { text: string; ts: number }>
  childKeyOf: (toolUseId: string) => string
}

/**
 * Pre-pass over all events building the claude subagent linkage:
 *
 *  1. Collect per-tool_use facts — `system/task_started` gives task_id
 *     (= transcript agent id) + prompt, `system/task_notification` gives the
 *     async completion status/summary, and user rows' `tool_use_result` /
 *     `toolUseResult` carry `agentId` for the sync lane.
 *  2. Compute each row's final bucket: rows tagged `parent_tool_use_id` move
 *     to their child bucket. The key is `agent-<agentId>` when known — the
 *     exact sessionId the post-run transcript capture writes — so live and
 *     captured rows merge; otherwise a `__claude_task__:<toolUseId>` synthetic.
 *  3. Record which bucket owns each tool_use block, so a child bucket's parent
 *     resolves to the session that actually spawned it (depth ≥ 2 safe). A
 *     row's own bucket depends only on its own `parent_tool_use_id`, so one
 *     pass suffices before parent resolution.
 *
 * Pure opencode inputs produce empty maps — zero behavior change.
 */
function buildClaudeLinkage(
  events: ParseSessionInputEvent[],
  parsedByEvt: Map<ParseSessionInputEvent, unknown>,
  rootKey: string,
): ClaudeLinkage {
  const links = new Map<string, ClaudeSubagentLink>()
  const ensureLink = (toolUseId: string): ClaudeSubagentLink => {
    let link = links.get(toolUseId)
    if (link === undefined) {
      link = {
        agentId: null,
        prompt: null,
        promptTs: null,
        notifyStatus: null,
        notifySummary: null,
      }
      links.set(toolUseId, link)
    }
    return link
  }

  const childToolUseIds = new Set<string>()

  // Pass 1 — linkage facts.
  for (const evt of events) {
    const parsed = parsedByEvt.get(evt)
    if (!isRecord(parsed) || isRecord(parsed.part)) continue
    if (parsed.type === 'system') {
      const subtype = parsed.subtype
      const toolUseId = typeof parsed['tool_use_id'] === 'string' ? parsed['tool_use_id'] : null
      if (toolUseId === null) continue
      if (subtype === 'task_started') {
        const link = ensureLink(toolUseId)
        if (link.agentId === null && typeof parsed['task_id'] === 'string') {
          link.agentId = parsed['task_id']
        }
        if (link.prompt === null && typeof parsed['prompt'] === 'string') {
          link.prompt = parsed['prompt']
          link.promptTs = evt.ts
        }
      } else if (subtype === 'task_notification') {
        const link = ensureLink(toolUseId)
        if (typeof parsed['status'] === 'string') link.notifyStatus = parsed['status']
        if (typeof parsed['summary'] === 'string') link.notifySummary = parsed['summary']
        if (link.agentId === null && typeof parsed['task_id'] === 'string') {
          link.agentId = parsed['task_id']
        }
      }
      continue
    }
    const turn = claudeTurnOf(parsed)
    if (turn === null) continue
    if (turn.parentToolUseId !== null) childToolUseIds.add(turn.parentToolUseId)
    if (turn.type !== 'user' || turn.toolUseResult === null) continue
    const agentId =
      typeof turn.toolUseResult['agentId'] === 'string' ? turn.toolUseResult['agentId'] : null
    if (agentId === null) continue
    // The rich result object sits on the row, not the block — only bind it
    // when the row carries exactly one tool_result (the observed shape).
    const resultIds = claudeContentBlocks(turn.message)
      .filter((b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
      .map((b) => b.tool_use_id as string)
    if (resultIds.length === 1) {
      const link = ensureLink(resultIds[0]!)
      if (link.agentId === null) link.agentId = agentId
    }
  }

  const childKeyOf = (toolUseId: string): string => {
    const agentId = links.get(toolUseId)?.agentId ?? null
    return agentId !== null ? `agent-${agentId}` : `__claude_task__:${toolUseId}`
  }

  // Pass 2 — final bucket per moved row + tool_use block ownership.
  const bucketOf = new Map<ParseSessionInputEvent, string>()
  const ownerBucketOfToolUse = new Map<string, string>()
  for (const evt of events) {
    const parsed = parsedByEvt.get(evt)
    if (!isRecord(parsed)) continue
    const turn = claudeTurnOf(parsed)
    if (turn === null) continue
    const home =
      turn.parentToolUseId !== null ? childKeyOf(turn.parentToolUseId) : (evt.sessionId ?? rootKey)
    if (turn.parentToolUseId !== null) bucketOf.set(evt, home)
    if (turn.type === 'assistant') {
      for (const block of claudeContentBlocks(turn.message)) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          ownerBucketOfToolUse.set(block.id, home)
        }
      }
    }
  }

  // Pass 3 — child parent overrides + synthetic prompts.
  for (const toolUseId of links.keys()) childToolUseIds.add(toolUseId)
  const parentOverride = new Map<string, string>()
  const childPrompt = new Map<string, { text: string; ts: number }>()
  for (const toolUseId of childToolUseIds) {
    const childKey = childKeyOf(toolUseId)
    parentOverride.set(childKey, ownerBucketOfToolUse.get(toolUseId) ?? rootKey)
    const link = links.get(toolUseId)
    if (link !== undefined && link.prompt !== null) {
      childPrompt.set(childKey, { text: link.prompt, ts: link.promptTs ?? 0 })
    }
  }

  return { links, bucketOf, parentOverride, childPrompt, childKeyOf }
}
