// Parses an opencode-style agent.md file (YAML frontmatter + markdown body)
// into a Partial<CreateAgent> suitable for prefilling the /agents/new form.
// RFC-018.
//
// Pure function: no IO, no exceptions. YAML parse errors and type mismatches
// are surfaced via the returned `warnings` array; the caller decides whether
// to apply the partial.

import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  AgentInputPortSchema,
  AgentOutputKindsMapSchema,
  AgentOutputWrapperPortNamesSchema,
  AgentRoleSchema,
  AgentSkillSelectorSchema,
  type AgentPermission,
  type AgentSkillSelector,
  type CreateAgent,
} from './schemas/agent'

export interface AgentMarkdownParseOptions {
  /** Filename stem (no extension) used when frontmatter has no `name`. */
  filenameStem?: string
}

export interface AgentMarkdownParseResult {
  partial: Partial<CreateAgent>
  /** RFC-223 (PR-1, Codex impl-gate P1-1): the parsed `skills:` list as PORTABLE,
   *  name-based selectors — NOT persisted `AgentSkillRef`s. An offline parser has
   *  no DB and cannot mint a skillId, so it must not stuff a name into
   *  `managed.skillId`; the import boundary resolves these selectors to id refs
   *  against the actor's ACL-visible set (services/agentRefs.ts) and never
   *  silently demotes a managed selector to a repo-local `project` ref. Absent
   *  when the source declared no (valid) `skills:` field. */
  skillSelectors?: AgentSkillSelector[]
  warnings: string[]
  /** Frontmatter keys not mapped to a first-class CreateAgent field; they end
   *  up in `partial.frontmatterExtra` and are listed here for UI display. */
  unrecognizedKeys: string[]
  /** True if the input had a (possibly malformed) `---` frontmatter block. */
  hadFrontmatter: boolean
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/

// Keys mapped to first-class CreateAgent fields (after deprecation handling).
// Anything else seen in frontmatter is routed into frontmatterExtra.
const KNOWN_KEYS = new Set<string>([
  'name',
  'description',
  'permission',
  'tools',
  // RFC-223 (PR-1): list of skill references (managed skill names or
  // {kind,name,ownerUsername?} objects). Parsed into portable selectors; a bare
  // name is resolved server-side and never silently demoted to a project ref.
  // Before
  // this key existed, an authored `skills:` fell through to frontmatterExtra.
  'skills',
  // RFC-022: list of agent names the imported agent depends on at runtime.
  // Must be a string[] of valid agent names; bad shapes demote to
  // frontmatterExtra with a warning (same pattern as `permission` / `tools`).
  'dependsOn',
  // RFC-028: list of MCP server names this agent needs at runtime. Same
  // shape policy as dependsOn — must be string[] of valid mcp names; bad
  // shapes demote to frontmatterExtra. Existence check happens server-side
  // at save time (services/agent.ts `validateMcpReferences`).
  'mcp',
  // RFC-031: list of opencode plugin names this agent needs at runtime.
  // Same shape policy as dependsOn / mcp. Existence + enabled check happens
  // server-side at save time (services/agent.ts `validatePluginReferences`).
  'plugins',
  // RFC-194: the existing agent port contract must enter the form as typed
  // fields. Keeping these keys out of frontmatterExtra also prevents reserved
  // sidecars from being promoted only after the form-level repair gate.
  'inputs',
  'outputs',
  'outputKinds',
  'role',
  'outputWrapperPortNames',
  // RFC-111 (Codex audit F6): runtime name this agent dispatches to. String
  // shape; the named runtime's existence is checked server-side at save time
  // (services/agent.ts), same policy as mcp / plugins.
  'runtime',
])

// Deliberately no uniqueness refine: imported legacy duplicates must reach the
// Ports editor's repair state instead of being hidden in frontmatterExtra.
const AgentOutputsImportSchema = z.array(z.string())

/** RFC-022: matches AGENT_NAME_RE in schemas/agent.ts so import-time and
 *  save-time validation agree on legal names. */
const AGENT_NAME_RE_LOCAL = /^[a-z0-9][a-z0-9_-]*$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function trimBody(body: string): string {
  return body.replace(/^[\s\r\n]+/, '').replace(/[\s\r\n]+$/, '')
}

function toolEntryToAction(enabled: unknown): 'allow' | 'deny' | null {
  if (enabled === true) return 'allow'
  if (enabled === false) return 'deny'
  return null
}

export function parseAgentMarkdown(
  raw: string,
  opts: AgentMarkdownParseOptions = {},
): AgentMarkdownParseResult {
  const warnings: string[] = []
  const partial: Partial<CreateAgent> = {}
  let skillSelectors: AgentSkillSelector[] | undefined

  const match = raw.match(FRONTMATTER_RE)
  const hadFrontmatter = match !== null

  let data: Record<string, unknown> = {}
  let body: string

  if (!match) {
    body = raw
  } else {
    body = match[2] ?? ''
    const yamlSrc = match[1] ?? ''
    let parsed: unknown
    try {
      parsed = parseYaml(yamlSrc)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`yaml-parse-failed: ${message}`)
      parsed = null
    }
    if (parsed === null || parsed === undefined) {
      data = {}
    } else if (!isPlainObject(parsed)) {
      warnings.push('frontmatter-not-object: top-level YAML must be a mapping; ignored')
      data = {}
    } else {
      data = parsed
    }
  }

  const extras: Record<string, unknown> = {}
  const unrecognizedKeys: string[] = []

  // description
  if (data.description !== undefined) {
    if (typeof data.description === 'string') {
      partial.description = data.description
    } else {
      extras.description = data.description
      warnings.push('description must be string; kept in frontmatterExtra')
    }
  }

  // RFC-194: route the existing agent port fields into their first-class form
  // state. A malformed field is preserved verbatim in frontmatterExtra with a
  // warning so import never silently drops authored data.
  if (data.inputs !== undefined) {
    const parsed = AgentInputPortSchema.array().safeParse(data.inputs)
    if (parsed.success) {
      partial.inputs = parsed.data
    } else {
      extras.inputs = data.inputs
      warnings.push('inputs must be an array of valid input ports; kept in frontmatterExtra')
    }
  }

  if (data.outputs !== undefined) {
    const parsed = AgentOutputsImportSchema.safeParse(data.outputs)
    if (parsed.success) {
      partial.outputs = parsed.data
    } else {
      extras.outputs = data.outputs
      warnings.push('outputs must be an array of strings; kept in frontmatterExtra')
    }
  }

  if (data.outputKinds !== undefined) {
    const parsed = AgentOutputKindsMapSchema.safeParse(data.outputKinds)
    if (parsed.success) {
      partial.outputKinds = parsed.data
    } else {
      extras.outputKinds = data.outputKinds
      warnings.push('outputKinds must map port names to registered kinds; kept in frontmatterExtra')
    }
  }

  if (data.role !== undefined) {
    const parsed = AgentRoleSchema.safeParse(data.role)
    if (parsed.success) {
      partial.role = parsed.data
    } else {
      extras.role = data.role
      warnings.push('role must be normal or aggregator; kept in frontmatterExtra')
    }
  }

  if (data.outputWrapperPortNames !== undefined) {
    const parsed = AgentOutputWrapperPortNamesSchema.safeParse(data.outputWrapperPortNames)
    if (parsed.success) {
      partial.outputWrapperPortNames = parsed.data
    } else {
      extras.outputWrapperPortNames = data.outputWrapperPortNames
      warnings.push(
        'outputWrapperPortNames must map port names to non-empty strings; kept in frontmatterExtra',
      )
    }
  }

  // RFC-111 (Codex audit F6): runtime — the runtime name this agent dispatches
  // to. Like description, a non-string / empty shape demotes to frontmatterExtra;
  // the named runtime's existence is validated server-side at save time
  // (services/agent.ts), same policy as mcp / plugins. Before this, `runtime`
  // wasn't in KNOWN_KEYS, so an authored `runtime:` silently fell through to
  // frontmatterExtra and never applied on import.
  if (data.runtime !== undefined) {
    if (isNonEmptyString(data.runtime)) {
      partial.runtime = data.runtime
    } else {
      extras.runtime = data.runtime
      warnings.push('runtime must be a non-empty string; kept in frontmatterExtra')
    }
  }

  // RFC-115: model / variant / temperature / steps / maxSteps are no longer
  // first-class agent fields — they moved onto the runtime profile in RFC-113
  // and the agent contract dropped them entirely in RFC-115. A legacy agent.md
  // that still carries any of them is NOT rejected: those keys are absent from
  // KNOWN_KEYS, so they fall through to the unrecognized-key catch-all below and
  // land in `frontmatterExtra` (surfaced in the import preview), never in
  // `partial`. This preserves the author's data without re-introducing the
  // dropped fields onto CreateAgent.
  //
  // RFC-130: `readonly` is likewise no longer an agent field — per-node worktree
  // isolation replaced readonly-based write serialization, so the flag was
  // deleted. It was never in KNOWN_KEYS (and never extracted into `partial`), so
  // an authored `readonly:` already demotes to frontmatterExtra via the same
  // catch-all; a legacy agent.md carrying it still imports without error.

  // tools + permission normalization
  const derivedPermission: AgentPermission = {}
  let toolsConsumed = false
  if (data.tools !== undefined) {
    if (isPlainObject(data.tools)) {
      for (const [tool, value] of Object.entries(data.tools)) {
        const action = toolEntryToAction(value)
        if (action === null) {
          warnings.push(
            `tools.${tool} must be boolean; entry dropped (use permission.${tool} explicitly)`,
          )
          continue
        }
        if (tool === 'write' || tool === 'edit' || tool === 'patch') {
          derivedPermission.edit = action
        } else {
          derivedPermission[tool] = action
        }
      }
      toolsConsumed = true
    } else {
      extras.tools = data.tools
      warnings.push('tools must be object; kept in frontmatterExtra')
    }
  }

  let explicitPermissionApplied = false
  if (data.permission !== undefined) {
    if (isPlainObject(data.permission)) {
      Object.assign(derivedPermission, data.permission)
      explicitPermissionApplied = true
    } else {
      extras.permission = data.permission
      warnings.push('permission must be an object; kept in frontmatterExtra')
    }
  }

  if (toolsConsumed || explicitPermissionApplied) {
    partial.permission = derivedPermission
  }

  // RFC-022: dependsOn — string[] of agent names. Demote bad shapes to
  // frontmatterExtra so the UI can still surface the raw value to the
  // author for manual fixing. We only enforce shape here (array of valid
  // name strings); existence + cycle checks belong to the save-time guard
  // in services/agentDeps.ts, which sees the full DB.
  if (data.dependsOn !== undefined) {
    if (Array.isArray(data.dependsOn)) {
      const cleaned: string[] = []
      const rejected: unknown[] = []
      for (const entry of data.dependsOn) {
        if (typeof entry === 'string' && AGENT_NAME_RE_LOCAL.test(entry)) {
          cleaned.push(entry)
        } else {
          rejected.push(entry)
        }
      }
      if (rejected.length > 0) {
        extras.dependsOn = data.dependsOn
        warnings.push('dependsOn entries must match [a-z0-9][a-z0-9_-]*; kept in frontmatterExtra')
      } else {
        // De-dupe while preserving author's listed order.
        const seen = new Set<string>()
        const ordered: string[] = []
        for (const n of cleaned) {
          if (seen.has(n)) continue
          seen.add(n)
          ordered.push(n)
        }
        partial.dependsOn = ordered
      }
    } else {
      extras.dependsOn = data.dependsOn
      warnings.push('dependsOn must be an array of agent names; kept in frontmatterExtra')
    }
  }

  // RFC-028: mcp — string[] of MCP server names. Same shape rules as
  // dependsOn. Existence/closure validation belongs to the save-time guard
  // in services/agent.ts (`validateMcpReferences`).
  if (data.mcp !== undefined) {
    if (Array.isArray(data.mcp)) {
      const cleaned: string[] = []
      const rejected: unknown[] = []
      for (const entry of data.mcp) {
        if (typeof entry === 'string' && AGENT_NAME_RE_LOCAL.test(entry)) {
          cleaned.push(entry)
        } else {
          rejected.push(entry)
        }
      }
      if (rejected.length > 0) {
        extras.mcp = data.mcp
        warnings.push('mcp entries must match [a-z0-9][a-z0-9_-]*; kept in frontmatterExtra')
      } else {
        const seen = new Set<string>()
        const ordered: string[] = []
        for (const n of cleaned) {
          if (seen.has(n)) continue
          seen.add(n)
          ordered.push(n)
        }
        partial.mcp = ordered
      }
    } else {
      extras.mcp = data.mcp
      warnings.push('mcp must be an array of MCP server names; kept in frontmatterExtra')
    }
  }

  // RFC-031: plugins — string[] of opencode plugin names. Same shape rules
  // as dependsOn / mcp. Existence + enabled validation belongs to the save-
  // time guard in services/agent.ts (`validatePluginReferences`).
  if (data.plugins !== undefined) {
    if (Array.isArray(data.plugins)) {
      const cleaned: string[] = []
      const rejected: unknown[] = []
      for (const entry of data.plugins) {
        if (typeof entry === 'string' && AGENT_NAME_RE_LOCAL.test(entry)) {
          cleaned.push(entry)
        } else {
          rejected.push(entry)
        }
      }
      if (rejected.length > 0) {
        extras.plugins = data.plugins
        warnings.push('plugins entries must match [a-z0-9][a-z0-9_-]*; kept in frontmatterExtra')
      } else {
        const seen = new Set<string>()
        const ordered: string[] = []
        for (const n of cleaned) {
          if (seen.has(n)) continue
          seen.add(n)
          ordered.push(n)
        }
        partial.plugins = ordered
      }
    } else {
      extras.plugins = data.plugins
      warnings.push('plugins must be an array of plugin names; kept in frontmatterExtra')
    }
  }

  // RFC-223 (PR-1, Codex impl-gate P1-1): skills — parsed into PORTABLE,
  // name-based `AgentSkillSelector`s (NOT persisted `AgentSkillRef`s). A bare name
  // string, and an explicit `{kind:'managed',name}` object, become MANAGED
  // selectors carrying the raw NAME (never stuffed into a `skillId`); an explicit
  // `{kind:'project',name}` becomes a PROJECT selector. The import boundary
  // resolves managed selectors to id refs against the actor's ACL-visible set and
  // never silently demotes a missing managed skill to a repo-local `project` ref —
  // a repo-local skill must be authored explicitly as `{kind:'project'}`. Bad
  // shapes demote the whole field to frontmatterExtra with a warning (mirror mcp /
  // plugins).
  if (data.skills !== undefined) {
    if (Array.isArray(data.skills)) {
      const cleaned: AgentSkillSelector[] = []
      let bad = false
      for (const entry of data.skills) {
        if (typeof entry === 'string' && AGENT_NAME_RE_LOCAL.test(entry)) {
          cleaned.push({ kind: 'managed', name: entry })
        } else {
          const parsed = AgentSkillSelectorSchema.safeParse(entry)
          if (!parsed.success) {
            bad = true
            break
          }
          cleaned.push(parsed.data)
        }
      }
      if (bad) {
        extras.skills = data.skills
        warnings.push(
          'skills entries must be skill names or portable {kind,name,ownerUsername?} refs; kept in frontmatterExtra',
        )
      } else {
        // De-dup preserving order by complete portable selector identity.
        // Same-name managed skills from different owners are distinct.
        const seen = new Set<string>()
        const ordered: AgentSkillSelector[] = []
        for (const sel of cleaned) {
          const key = JSON.stringify([
            sel.kind,
            sel.name,
            sel.kind === 'managed' ? (sel.ownerUsername ?? null) : null,
          ])
          if (seen.has(key)) continue
          seen.add(key)
          ordered.push(sel)
        }
        skillSelectors = ordered
      }
    } else {
      extras.skills = data.skills
      warnings.push('skills must be an array of skill names; kept in frontmatterExtra')
    }
  }

  // name: frontmatter.name > filename stem > unset
  if (data.name !== undefined) {
    if (isNonEmptyString(data.name)) {
      partial.name = data.name
    } else {
      extras.name = data.name
      warnings.push('name must be non-empty string; kept in frontmatterExtra')
    }
  }
  if (partial.name === undefined && isNonEmptyString(opts.filenameStem)) {
    partial.name = opts.filenameStem
  }

  // body → bodyMd (trim outer whitespace; preserve internal blank lines)
  const trimmedBody = trimBody(body)
  if (trimmedBody.length > 0) {
    partial.bodyMd = trimmedBody
  } else if (hadFrontmatter) {
    partial.bodyMd = ''
  }

  // Unrecognized keys → frontmatterExtra. Preserve insertion order for UI.
  for (const key of Object.keys(data)) {
    if (KNOWN_KEYS.has(key)) continue
    extras[key] = data[key]
    unrecognizedKeys.push(key)
  }
  if (Object.keys(extras).length > 0) {
    partial.frontmatterExtra = extras
  }

  return { partial, skillSelectors, warnings, unrecognizedKeys, hadFrontmatter }
}
