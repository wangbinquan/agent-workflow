// RFC-304 T35 — resolving a repository's monitor scripts from its framework.
//
// The mirror of `codeCapabilityHooks`: cell → binding → framework, then read
// `scripts_json` instead of `hooks_json`. Kept beside it rather than merged into
// it because the two answer opposite questions — "does this team have an
// optional gate here?" (usually no, and that is fine) versus "can this
// capability run at all?" (no scripts means no).
//
// ## Why a missing `collect` is a configuration fault, not an empty result
//
// Hooks resolve to an empty list when a repository has none, because most
// repositories never write one. Scripts cannot: the monitor's entire input is
// what `collect` returns, and a monitor with no `collect` has nothing to
// arbitrate. Returning "no scripts, carry on" would produce a cell that reports
// itself healthy and answers no event for the rest of its life — which is the
// single hardest failure to notice, because nothing anywhere goes red.

import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { capabilityTemplates, repoCapabilityConfig } from '@/db/schema'
import { SCRIPT_LANGUAGES, type ScriptLanguage } from '@agent-workflow/shared'
import {
  MONITOR_SCRIPTS,
  type MonitorScriptDefinition,
  type MonitorScriptName,
} from '@/modules/code-capability/application/monitorScripts'
import type { MonitorScriptSet } from '@/modules/code-capability/application/monitorLoop'

export type ResolvedMonitorScripts =
  | { ok: true; scripts: MonitorScriptSet }
  /** Actionable text; it reaches the matrix as a readiness issue. */
  | { ok: false; problem: string }

/**
 * The only way a stored string becomes a `ScriptLanguage`.
 *
 * Mirrors `readScriptLanguage` in shared, which does the same for a node's
 * field. Validated rather than cast because an unknown language reaches
 * `INTERPRETER_SPEC` as an undefined lookup and fails at spawn time with a
 * message about `undefined.argv` — which tells the author nothing about the
 * field they actually got wrong.
 */
function asScriptLanguage(value: unknown): ScriptLanguage | undefined {
  return typeof value === 'string' && (SCRIPT_LANGUAGES as readonly string[]).includes(value)
    ? (value as ScriptLanguage)
    : undefined
}

/**
 * Parse one entry of `scripts_json`.
 *
 * Returns the definition, or one sentence naming the field that is wrong —
 * the person who has to fix it is looking at a form, not a stack trace.
 */
function parseScript(name: MonitorScriptName, raw: unknown): MonitorScriptDefinition | string {
  if (typeof raw !== 'object' || raw === null) return `\`${name}\` is not an object`
  const entry = raw as Record<string, unknown>

  const script = entry.script
  if (typeof script !== 'string' || script.trim() === '') {
    return `\`${name}.script\` is missing or empty`
  }

  const language = asScriptLanguage(entry.language)
  if (language === undefined) {
    return `\`${name}.language\` must be one of ${SCRIPT_LANGUAGES.join(', ')}`
  }

  return {
    name,
    language,
    script,
    ...(typeof entry.env === 'object' && entry.env !== null
      ? { env: entry.env as Record<string, string> }
      : {}),
  }
}

/**
 * The monitor scripts configured for one repository's capability.
 *
 * `collect` is required; the other three are optional and each has a defined
 * absence (see `MonitorScriptSet`). Every failure comes back as one sentence
 * naming the field, because the person who has to fix it is looking at a form.
 */
export async function resolveMonitorScripts(
  db: DbClient,
  input: { repoId: string; capability: string },
): Promise<ResolvedMonitorScripts> {
  const [cell] = await db
    .select({ templateId: repoCapabilityConfig.templateId })
    .from(repoCapabilityConfig)
    .where(
      // `and(...)`, never `&&` — a JS `&&` between two drizzle conditions
      // evaluates to the second, silently dropping the repo filter and letting
      // one team's daemon-privileged scripts run on another team's merge
      // requests.
      and(
        eq(repoCapabilityConfig.repoId, input.repoId),
        eq(repoCapabilityConfig.capability, input.capability),
      ),
    )
  if (cell === undefined) return { ok: false, problem: 'this repository has no such capability' }
  if (cell.templateId == null) return { ok: false, problem: 'no binding is selected' }

  // RFC-309 — one hop. This used to be cell → binding → framework, and the
  // middle step could fail on its own ("the binding's framework no longer
  // exists"), which was a state a person could reach by deleting a row they did
  // not know anything pointed at. A merged template cannot be half-missing.
  const [framework] = await db
    .select({ scriptsJson: capabilityTemplates.scriptsJson })
    .from(capabilityTemplates)
    .where(eq(capabilityTemplates.id, cell.templateId))
  if (framework === undefined) {
    return { ok: false, problem: 'the selected template no longer exists' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(framework.scriptsJson)
  } catch {
    return { ok: false, problem: "the framework's scripts are not valid JSON" }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problem: "the framework's scripts must be an object keyed by script name" }
  }
  const entries = parsed as Record<string, unknown>

  const collectRaw = entries.collect
  if (collectRaw === undefined) {
    return {
      ok: false,
      problem: 'the framework defines no `collect` script, so there is nothing to read the MR with',
    }
  }
  const collect = parseScript('collect', collectRaw)
  if (typeof collect === 'string') return { ok: false, problem: collect }

  const scripts: MonitorScriptSet = { collect }
  for (const name of MONITOR_SCRIPTS) {
    if (name === 'collect') continue
    const raw = entries[name]
    if (raw === undefined) continue
    const definition = parseScript(name, raw)
    // An optional script that is PRESENT but malformed is a fault, not an
    // absence: silently ignoring it would run the default policy while the
    // author believes theirs is in force.
    if (typeof definition === 'string') return { ok: false, problem: definition }
    scripts[name] = definition
  }

  return { ok: true, scripts }
}
