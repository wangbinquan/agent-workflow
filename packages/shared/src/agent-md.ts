// Parses an opencode-style agent.md file (YAML frontmatter + markdown body)
// into a Partial<CreateAgent> suitable for prefilling the /agents/new form.
// RFC-018.
//
// Pure function: no IO, no exceptions. YAML parse errors and type mismatches
// are surfaced via the returned `warnings` array; the caller decides whether
// to apply the partial.

import { parse as parseYaml } from 'yaml'
import type { AgentPermission, CreateAgent } from './schemas/agent'

export interface AgentMarkdownParseOptions {
  /** Filename stem (no extension) used when frontmatter has no `name`. */
  filenameStem?: string
}

export interface AgentMarkdownParseResult {
  partial: Partial<CreateAgent>
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
  'model',
  'variant',
  'temperature',
  'steps',
  'maxSteps',
  'permission',
  'tools',
  // RFC-022: list of agent names the imported agent depends on at runtime.
  // Must be a string[] of valid agent names; bad shapes demote to
  // frontmatterExtra with a warning (same pattern as `permission` / `tools`).
  'dependsOn',
])

/** RFC-022: matches AGENT_NAME_RE in schemas/agent.ts so import-time and
 *  save-time validation agree on legal names. */
const AGENT_NAME_RE_LOCAL = /^[a-z0-9][a-z0-9_-]*$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
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

  // model
  if (data.model !== undefined) {
    if (isNonEmptyString(data.model)) {
      partial.model = data.model
    } else {
      extras.model = data.model
      warnings.push('model must be non-empty string; kept in frontmatterExtra')
    }
  }

  // variant
  if (data.variant !== undefined) {
    if (isNonEmptyString(data.variant)) {
      partial.variant = data.variant
    } else {
      extras.variant = data.variant
      warnings.push('variant must be non-empty string; kept in frontmatterExtra')
    }
  }

  // temperature
  if (data.temperature !== undefined) {
    if (isFiniteNumber(data.temperature)) {
      partial.temperature = data.temperature
    } else {
      extras.temperature = data.temperature
      warnings.push('temperature must be finite number; kept in frontmatterExtra')
    }
  }

  // steps
  let stepsFromFile: number | undefined
  if (data.steps !== undefined) {
    if (isPositiveInt(data.steps)) {
      stepsFromFile = data.steps
    } else {
      extras.steps = data.steps
      warnings.push('steps must be positive integer; kept in frontmatterExtra')
    }
  }

  // maxSteps (also a deprecated alias of `steps` in opencode)
  let maxStepsFromFile: number | undefined
  if (data.maxSteps !== undefined) {
    if (isPositiveInt(data.maxSteps)) {
      maxStepsFromFile = data.maxSteps
    } else {
      extras.maxSteps = data.maxSteps
      warnings.push('maxSteps must be positive integer; kept in frontmatterExtra')
    }
  }

  // steps ?? maxSteps coalesce (opencode normalize parity)
  if (stepsFromFile !== undefined) {
    partial.steps = stepsFromFile
  } else if (maxStepsFromFile !== undefined) {
    partial.steps = maxStepsFromFile
  }
  if (maxStepsFromFile !== undefined) {
    partial.maxSteps = maxStepsFromFile
  }

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

  return { partial, warnings, unrecognizedKeys, hadFrontmatter }
}
