// RFC-218 — single source of truth translating an agent's declared input
// ports (RFC-166 `agent.inputs`) into the single-agent launch surface:
//
//   • the host snapshot's `inputs[]` (WorkflowInput defs the wizard renders
//     via DynamicInput and the engine's input nodes consume),
//   • the synthesized promptTemplate (uniform XML port envelope), and
//   • launch blockers (signal ports / names that cannot ride a template
//     token) that both the wizard (disable + reason) and `startAgentTask`
//     (400 before any side effect) enforce.
//
// Frontend form and backend snapshot MUST both consume this module — a forked
// second derivation is exactly the drift this repo's dedup audit keeps
// finding. Zero-port agents return null: callers stay on the RFC-165 legacy
// `description` path untouched (structural byte-compat, design.md §2.1).

import type { AgentInputPort } from './schemas/agent'
import type { WorkflowInput } from './schemas/workflow'
import { tryParseKind, type ParsedKind } from './kindParser'

/** Per-value wire cap (mirrors StartAgentTaskSchema description/inputs). */
export const AGENT_LAUNCH_INPUT_MAX_LEN = 65536

/** Where a `path<ext>` port's uploaded files land inside the task worktree. */
export function agentInputUploadDir(portName: string): string {
  return `.agent-inputs/${portName}`
}

export type AgentLaunchBlocker =
  | { kind: 'signal-port'; port: string }
  | { kind: 'invalid-port-name'; port: string; reason: 'not-a-token' | 'reserved-name' }

/**
 * WorkflowInput plus the launch-form transport fields. `presentation` /
 * `agentKind` / `maxLength` ride the WorkflowInputSchema passthrough — they
 * persist harmlessly inside the frozen host snapshot.
 */
export type DerivedLaunchInput = WorkflowInput & {
  presentation?: 'chips'
  /** The original declared kind string (hint display + debugging). */
  agentKind: string
  maxLength?: number
}

export interface AgentLaunchForm {
  inputs: DerivedLaunchInput[]
  promptTemplate: string
  blockers: AgentLaunchBlocker[]
}

// Template tokens must satisfy prompt.ts TEMPLATE_RE (`\w+`).
const TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// The dunder family is the runtime's reserved namespace: built-in tokens
// (`__repo_path__`, resolved BEFORE port values — a same-named port would be
// silently shadowed), deprecated tokens (render as ''), and system-channel
// port names all live here, and `__proto__` is a record poison key on top.
// Rejecting the whole family beats enumerating registries that keep growing
// (design.md D13). `constructor`/`prototype` are the remaining poison keys.
const RESERVED_DUNDER_RE = /^__[\s\S]*__$/
const POISON_KEYS = new Set(['constructor', 'prototype'])

function kindContainsSignal(p: ParsedKind): boolean {
  if (p.kind === 'base') return p.name === 'signal'
  if (p.kind === 'list') return kindContainsSignal(p.item)
  return false
}

/** Declared-input semantics: required unless the author says otherwise. */
export function agentPortRequired(port: AgentInputPort): boolean {
  return port.required !== false
}

/**
 * Launch blockers for a declared port set. Exported separately so the agent
 * editor (validateAgentPortState) can warn at authoring time with the same
 * predicate the launch path enforces.
 */
export function agentLaunchBlockers(ports: readonly AgentInputPort[]): AgentLaunchBlocker[] {
  const blockers: AgentLaunchBlocker[] = []
  for (const port of ports) {
    if (!TOKEN_RE.test(port.name)) {
      blockers.push({ kind: 'invalid-port-name', port: port.name, reason: 'not-a-token' })
    } else if (RESERVED_DUNDER_RE.test(port.name) || POISON_KEYS.has(port.name)) {
      blockers.push({ kind: 'invalid-port-name', port: port.name, reason: 'reserved-name' })
    }
    const parsed = tryParseKind(port.kind ?? 'string')
    if (parsed !== null && kindContainsSignal(parsed)) {
      blockers.push({ kind: 'signal-port', port: port.name })
    }
  }
  return blockers
}

function deriveOne(port: AgentInputPort): DerivedLaunchInput {
  const kindString = port.kind ?? 'string'
  const base: Pick<DerivedLaunchInput, 'key' | 'label' | 'required' | 'agentKind'> & {
    description?: string
  } = {
    key: port.name,
    label: port.name,
    required: agentPortRequired(port),
    agentKind: kindString,
    ...(port.description !== undefined ? { description: port.description } : {}),
  }
  const parsed = tryParseKind(kindString)

  // path<ext> → single-file upload; list<path<ext>> → multi-file upload.
  // Port wire value = newline-joined repo-relative paths (upload.ts packing).
  const pathKind =
    parsed !== null && parsed.kind === 'path'
      ? { multi: false as const, ext: parsed.ext }
      : parsed !== null && parsed.kind === 'list' && parsed.item.kind === 'path'
        ? { multi: true as const, ext: parsed.item.ext }
        : null
  if (pathKind !== null) {
    return {
      ...base,
      kind: 'upload',
      targetDir: agentInputUploadDir(port.name),
      ...(pathKind.ext === '*' ? {} : { accept: [`.${pathKind.ext}`] }),
      ...(pathKind.multi ? {} : { maxCount: 1 }),
      minCount: base.required === true ? 1 : 0,
    }
  }

  // list<string> / list<markdown> → one-item-per-entry chips, newline wire.
  if (
    parsed !== null &&
    parsed.kind === 'list' &&
    parsed.item.kind === 'base' &&
    (parsed.item.name === 'string' || parsed.item.name === 'markdown')
  ) {
    return {
      ...base,
      kind: 'text',
      presentation: 'chips',
      maxLength: AGENT_LAUNCH_INPUT_MAX_LEN,
    }
  }

  // string / markdown / anything else valid (e.g. nested lists) → multiline
  // text, value passed through verbatim. The agentKind hint tells the user
  // what shape the agent expects.
  return {
    ...base,
    kind: 'text',
    multiline: true,
    maxLength: AGENT_LAUNCH_INPUT_MAX_LEN,
  }
}

/**
 * The uniform XML port envelope (design.md §3, golden-locked). Every port —
 * one or many — goes through the same envelope; values are additionally
 * fenced by `<aw-input>` at render time (promptFencing), which is the actual
 * trust boundary. Byte-stable: do not reorder or reformat.
 */
export function buildAgentHostPromptTemplate(ports: readonly AgentInputPort[]): string {
  const lines = [
    'Your task inputs are provided in the XML port blocks below.',
    '',
    '<workflow-input>',
  ]
  for (const port of ports) {
    lines.push(`<port name="${port.name}">`, `{{${port.name}}}`, '</port>')
  }
  lines.push('</workflow-input>')
  return lines.join('\n')
}

/**
 * Derive the whole launch form for an agent. Returns null when the agent
 * declares no input ports — callers MUST fall back to the RFC-165 legacy
 * description path (this is what keeps zero-port agents byte-compatible).
 */
export function deriveAgentLaunchForm(
  ports: readonly AgentInputPort[] | undefined,
): AgentLaunchForm | null {
  if (ports === undefined || ports.length === 0) return null
  return {
    inputs: ports.map(deriveOne),
    promptTemplate: buildAgentHostPromptTemplate(ports),
    blockers: agentLaunchBlockers(ports),
  }
}
