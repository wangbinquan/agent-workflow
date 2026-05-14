// `agent-workflow config get [key]` / `agent-workflow config set <key> <value>`
//
// Value parsing: tries JSON.parse first; on failure treats as string.
//   set maxConcurrentNodes 8                 -> 8 (number)
//   set theme dark                            -> "dark" (string)
//   set worktreeAutoGc '{"enabled":true}'    -> object
//
// Top-level keys only; for nested fields, set the whole nested object as JSON.

import { applyConfigPatch, loadConfig } from '@/config'
import { Paths } from '@/util/paths'

export function configGetCommand(args: string[]): { output: string } {
  const cfg = loadConfig(Paths.config)
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
  const updated = applyConfigPatch(Paths.config, { [key]: parsedValue })
  const newValue = (updated as Record<string, unknown>)[key]
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
