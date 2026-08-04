// `agent-workflow config get [key]` / `agent-workflow config set <key> <value>`
//
// Value parsing: tries JSON.parse first; on failure treats as string.
//   set maxConcurrentNodes 8                 -> 8 (number)
//   set theme dark                            -> "dark" (string)
//   set worktreeAutoGc '{"enabled":true}'    -> object
//
// Top-level keys only; for nested fields, set the whole nested object as JSON.

import { applyConfigPatch, loadConfig } from '@/config'
import { maskConfigForOutput } from '@/config/customProviderGate'
import { Paths } from '@/util/paths'

export function configGetCommand(args: string[]): { output: string } {
  // RFC-255: same masking the HTTP surface applies — printing config must not
  // print gateway credentials, whether or not a terminal is watching.
  const cfg = maskConfigForOutput(loadConfig(Paths.config))
  if (args.length === 0) {
    return { output: JSON.stringify(cfg, null, 2) + '\n' }
  }
  const key = args[0]
  if (key === undefined) {
    return { output: JSON.stringify(cfg, null, 2) + '\n' }
  }
  if (!(key in cfg)) {
    throw new Error(`unknown config key: ${key}`)
  }
  const value = (cfg as Record<string, unknown>)[key]
  return { output: formatValue(value) + '\n' }
}

export function configSetCommand(args: string[]): { output: string } {
  if (args.length < 2) {
    throw new Error('usage: agent-workflow config set <key> <value>')
  }
  const key = args[0]
  const rawValue = args[1]
  if (key === undefined || rawValue === undefined) {
    throw new Error('usage: agent-workflow config set <key> <value>')
  }
  const parsedValue = parseValue(rawValue)
  // RFC-255: the CLI writes the very same file the API does, so it must not be
  // a way around the API's provider validation (reserved ids, mask handling,
  // credential sealing). Routing this key through the CLI is refused outright
  // rather than half-validated: sealing here would need the secret key and
  // duplicate the route's gate.
  if (key === 'customProviders') {
    throw new Error(
      'config set customProviders is not supported — manage custom providers through the Settings UI or PUT /api/config, which seals credentials and validates provider ids',
    )
  }
  const updated = applyConfigPatch(Paths.config, { [key]: parsedValue })
  const newValue = (maskConfigForOutput(updated) as Record<string, unknown>)[key]
  return { output: `${key} = ${formatValue(newValue)}\n` }
}

/** Try JSON.parse(raw); on failure return raw unchanged as string. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}
