// `agent-workflow config get [key]` / `agent-workflow config set <key> <value>`
//
// Value parsing: tries JSON.parse first; on failure treats as string.
//   set maxConcurrentNodes 8                 -> 8 (number)
//   set theme dark                            -> "dark" (string)
//   set worktreeAutoGc '{"enabled":true}'    -> object
//
// Top-level keys only; for nested fields, set the whole nested object as JSON.

import type { Config } from '@agent-workflow/shared'
import {
  composeFileCliConfiguration,
  type ApplicationConfigurationPersistencePort,
} from '@/modules/system-operations/composition/cliConfiguration'
import { Paths } from '@/util/paths'

export function configGetCommand(args: string[]): { output: string }
export function configGetCommand(
  args: string[],
  selected: Pick<ApplicationConfigurationPersistencePort, 'load'>,
): Promise<{ output: string }>
export function configGetCommand(
  args: string[],
  selected?: Pick<ApplicationConfigurationPersistencePort, 'load'>,
): { output: string } | Promise<{ output: string }> {
  if (selected !== undefined) return readSelectedConfiguration(args, selected)
  return formatConfigurationRead(args, composeFileCliConfiguration(Paths.config).load())
}

async function readSelectedConfiguration(
  args: string[],
  selected: Pick<ApplicationConfigurationPersistencePort, 'load'>,
): Promise<{ output: string }> {
  return formatConfigurationRead(args, await selected.load())
}

function formatConfigurationRead(args: string[], cfg: Config): { output: string } {
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

export function configSetCommand(args: string[]): { output: string }
export function configSetCommand(
  args: string[],
  selected: Pick<ApplicationConfigurationPersistencePort, 'applyPatch'>,
): Promise<{ output: string }>
export function configSetCommand(
  args: string[],
  selected?: Pick<ApplicationConfigurationPersistencePort, 'applyPatch'>,
): { output: string } | Promise<{ output: string }> {
  if (selected !== undefined) return writeSelectedConfiguration(args, selected)
  const { key, parsedValue } = parseConfigurationWrite(args)
  const updated = composeFileCliConfiguration(Paths.config).applyPatch({ [key]: parsedValue })
  return formatConfigurationWrite(key, updated)
}

async function writeSelectedConfiguration(
  args: string[],
  selected: Pick<ApplicationConfigurationPersistencePort, 'applyPatch'>,
): Promise<{ output: string }> {
  const { key, parsedValue } = parseConfigurationWrite(args)
  const updated = await selected.applyPatch({ [key]: parsedValue })
  return formatConfigurationWrite(key, updated)
}

function parseConfigurationWrite(args: string[]): { key: string; parsedValue: unknown } {
  if (args.length < 2) {
    throw new Error('usage: agent-workflow config set <key> <value>')
  }
  const key = args[0]
  const rawValue = args[1]
  if (key === undefined || rawValue === undefined) {
    throw new Error('usage: agent-workflow config set <key> <value>')
  }
  const parsedValue = parseValue(rawValue)
  return { key, parsedValue }
}

function formatConfigurationWrite(key: string, updated: Config): { output: string } {
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
