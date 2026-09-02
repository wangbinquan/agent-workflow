// RFC-044 — helpers for "what the distiller actually sees" context blocks.
//
// Two pure functions live here so the memoryDistiller loader stays focused on
// SQL fetches and the builder stays focused on prompt layout:
//
//   - renderSessionTreeToDistillerMd(tree) → markdown dialog string
//     Walks SessionTree.messages and renders each as a `**User**:` /
//     `**Assistant**:` / `**Tool** `name`:` block. Mirrors the visual hierarchy
//     RFC-027 SessionTab uses, in markdown so the distiller can read it.
//
//   - clipHeadTail(s, maxBytes) → head + tail merged by `[truncated N bytes]`
//     marker. UTF-8 byte-aware; head/tail slicing on byte boundaries may emit
//     one or two U+FFFD replacement chars but downstream model tolerates it.
//
// Both functions are byte-safe and pure: no DB / fs access. The loader in
// memoryDistiller.ts calls them sequentially: render → clip.

import type {
  SessionAssistantReasoning,
  SessionAssistantText,
  SessionMessage,
  SessionSubagentCall,
  SessionToolCall,
  SessionTree,
  SessionUserMessage,
} from '@agent-workflow/shared'

/**
 * Render a parsed SessionTree as plain markdown for the distiller's user
 * prompt. Tool inputs/outputs are fenced; long blobs are NOT truncated here —
 * the caller wraps the whole string with clipHeadTail using the configured
 * budget. Sub-agent calls inline their child transcript with `>` quote prefix
 * so the model sees the hierarchy without losing reading order.
 */
export function renderSessionTreeToDistillerMd(tree: SessionTree): string {
  const lines: string[] = []
  for (const msg of tree.messages) {
    appendMessage(lines, msg, 0)
  }
  return lines.join('\n').trimEnd()
}

function appendMessage(lines: string[], msg: SessionMessage, depth: number): void {
  const prefix = '> '.repeat(depth)
  const pushLine = (s: string): void => {
    if (s.length === 0) {
      lines.push(prefix.trimEnd())
    } else {
      lines.push(`${prefix}${s}`)
    }
  }
  switch (msg.kind) {
    case 'user':
      renderUser(pushLine, msg)
      break
    case 'assistant-text':
      renderAssistantText(pushLine, msg)
      break
    case 'assistant-reasoning':
      renderAssistantReasoning(pushLine, msg)
      break
    case 'tool-call':
      renderToolCall(pushLine, msg)
      break
    case 'subagent-call':
      renderSubagent(lines, msg, depth)
      break
  }
}

function renderUser(push: (s: string) => void, m: SessionUserMessage): void {
  push('**User**:')
  push(m.text)
  push('')
}

function renderAssistantText(push: (s: string) => void, m: SessionAssistantText): void {
  push('**Assistant**:')
  push(m.text)
  push('')
}

function renderAssistantReasoning(push: (s: string) => void, m: SessionAssistantReasoning): void {
  push('**Assistant (reasoning)**:')
  push(m.text)
  push('')
}

function renderToolCall(push: (s: string) => void, m: SessionToolCall): void {
  push(`**Tool** \`${m.toolName}\` (${m.status}):`)
  push('```')
  push(stringifyToolInput(m.input))
  push('```')
  if (m.output !== null && m.output.length > 0) {
    push(`**Tool result** \`${m.toolName}\`:`)
    push('```')
    push(m.output)
    push('```')
  }
  push('')
}

function renderSubagent(lines: string[], m: SessionSubagentCall, depth: number): void {
  const prefix = '> '.repeat(depth)
  const childName = m.childAgentName ?? 'subagent'
  lines.push(`${prefix}**Subagent** \`${childName}\` (${m.status}):`)
  lines.push(`${prefix}\`\`\``)
  lines.push(`${prefix}${stringifyToolInput(m.input)}`)
  lines.push(`${prefix}\`\`\``)
  if (m.child !== null) {
    for (const childMsg of m.child.messages) {
      appendMessage(lines, childMsg, depth + 1)
    }
  } else if (m.childOutputFallback !== null && m.childOutputFallback.length > 0) {
    lines.push(`${prefix}**Subagent fallback output**:`)
    lines.push(`${prefix}\`\`\``)
    lines.push(`${prefix}${m.childOutputFallback}`)
    lines.push(`${prefix}\`\`\``)
  }
  lines.push(prefix.trimEnd())
}

function stringifyToolInput(input: unknown): string {
  if (input === undefined || input === null) return '(no input)'
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

/**
 * Byte-aware clip: keeps the head and tail halves of `s` and joins them with
 * `... [truncated <N> bytes] ...` when the UTF-8 byte length exceeds
 * `maxBytes`. Reserves ~64 bytes for the marker so callers can compare the
 * result length against the budget without surprises.
 *
 * When `maxBytes <= 128` the function bypasses splitting entirely and
 * returns the original string — splitting that small would leave each side
 * with <32 bytes of useful content, which is worse than no clip.
 */
export function clipHeadTail(s: string, maxBytes: number): string {
  if (maxBytes <= 128) return s
  const buf = Buffer.from(s, 'utf8')
  if (buf.byteLength <= maxBytes) return s
  const markerBudget = 64
  const half = Math.floor((maxBytes - markerBudget) / 2)
  const head = buf.subarray(0, half).toString('utf8')
  const tail = buf.subarray(buf.byteLength - half).toString('utf8')
  const dropped = buf.byteLength - 2 * half
  return `${head}\n\n... [truncated ${dropped} bytes] ...\n\n${tail}`
}
