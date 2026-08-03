// RFC-234 (T1) — agent.md SERIALIZER, the inverse of ./agent-md.ts.
//
// Before this file the agent.md format was import-only (RFC-018 parser, no
// writer). The intent-builder dump layer needs a deterministic writer so a
// mounted agent can be shown to the intent system agent as a file. The writer
// emits frontmatter keys in KNOWN_KEYS order and round-trips through
// parseAgentMarkdown for name-shaped reference entries (locked by
// packages/shared/tests/agent-md-serialize.test.ts).
//
// Reference entries (`skills` / `dependsOn` / `mcp` / `plugins`) are plain
// strings supplied by the caller: real resource NAMES for export-style use,
// or opaque session handles (`res#agent#3`) for RFC-234 dumps — the writer is
// agnostic. Identity fields (ids, owners, usernames) are deliberately NOT part
// of the document shape (design §4 identity isolation).
//
// Pure function: no IO, browser-safe.

import { stringify as stringifyYaml } from 'yaml'
import type { AgentSkillSelector } from './schemas/agent'

export interface AgentMarkdownDocument {
  name: string
  description?: string
  permission?: Record<string, unknown>
  /** Managed selectors without ownerUsername serialize as bare name strings
   *  (the parser's preferred shape); project selectors keep object form. */
  skills?: AgentSkillSelector[] | string[]
  dependsOn?: string[]
  mcp?: string[]
  plugins?: string[]
  inputs?: Array<{ name: string; kind: string; required?: boolean; description?: string }>
  outputs?: string[]
  outputKinds?: Record<string, string>
  role?: 'normal' | 'aggregator'
  outputWrapperPortNames?: Record<string, string>
  runtime?: string
  /** RFC-252 G4 — 缺省 = 'deny'。 */
  network?: 'deny' | 'allow'
  frontmatterExtra?: Record<string, unknown>
  bodyMd?: string
}

/** Keys the writer owns, in emission order — mirrors KNOWN_KEYS in
 *  ./agent-md.ts (minus `tools`, which the parser folds into `permission`;
 *  the writer only ever emits the normalized `permission` form). */
const EMIT_ORDER = [
  'name',
  'description',
  'permission',
  'skills',
  'dependsOn',
  'mcp',
  'plugins',
  'inputs',
  'outputs',
  'outputKinds',
  'role',
  'outputWrapperPortNames',
  'runtime',
  'network',
] as const

function skillEntryToYaml(entry: AgentSkillSelector | string): unknown {
  if (typeof entry === 'string') return entry
  if (entry.kind === 'managed') {
    return entry.ownerUsername === undefined
      ? entry.name
      : { kind: 'managed', name: entry.name, ownerUsername: entry.ownerUsername }
  }
  return { kind: 'project', name: entry.name }
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined) return true
  if (Array.isArray(v)) return v.length === 0
  if (v !== null && typeof v === 'object') return Object.keys(v as object).length === 0
  return false
}

export function serializeAgentMarkdown(doc: AgentMarkdownDocument): string {
  const fm: Record<string, unknown> = {}
  const source: Record<string, unknown> = {
    name: doc.name,
    description: doc.description,
    permission: doc.permission,
    skills: doc.skills?.map(skillEntryToYaml),
    dependsOn: doc.dependsOn,
    mcp: doc.mcp,
    plugins: doc.plugins,
    inputs: doc.inputs,
    outputs: doc.outputs,
    outputKinds: doc.outputKinds,
    role: doc.role,
    outputWrapperPortNames: doc.outputWrapperPortNames,
    runtime: doc.runtime,
    network: doc.network,
  }
  for (const key of EMIT_ORDER) {
    const v = source[key]
    if (key !== 'name' && isEmptyValue(v)) continue
    fm[key] = v
  }
  // frontmatterExtra last; keys colliding with first-class fields are skipped —
  // duplicate YAML keys are invalid and the first-class value is authoritative.
  if (doc.frontmatterExtra !== undefined) {
    for (const [k, v] of Object.entries(doc.frontmatterExtra)) {
      if (k in fm || (EMIT_ORDER as readonly string[]).includes(k) || k === 'tools') continue
      fm[k] = v
    }
  }

  // yaml's block-scalar indentation guarantees no content line can be a bare
  // `---`, so the parser's frontmatter framing regex cannot be broken by data.
  const yaml = stringifyYaml(fm, { lineWidth: 0 })
  const body = (doc.bodyMd ?? '').replace(/^[\s\r\n]+/, '').replace(/[\s\r\n]+$/, '')
  return body.length > 0 ? `---\n${yaml}---\n\n${body}\n` : `---\n${yaml}---\n`
}
