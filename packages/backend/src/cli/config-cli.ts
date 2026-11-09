// `agent-workflow config get [key]` / `agent-workflow config set <key> <value>`
//
// Value parsing: tries JSON.parse first; on failure treats as string.
//   set maxConcurrentNodes 8                 -> 8 (number)
//   set theme dark                            -> "dark" (string)
//   set worktreeAutoGc '{"enabled":true}'    -> object
//
// Top-level keys only; for nested fields, set the whole nested object as JSON.
//
// RFC-474: the storage is injected — `main.ts` hands over the installation's configuration file composed by bootstrap
// (`composeConfigCommandPersistence()`); a selected deployment's storage goes through the same path. Reads and writes are
// awaited either way, and run with the storage itself as `this`.

import type { Config } from '@agent-workflow/shared'

/** The read half of the configuration storage (system-operations' `ApplicationConfigurationPersistencePort` satisfies it). */
export interface ConfigCommandReader {
  load(): Config | Promise<Config>
}

/** The write half: storage validates the patch and preserves unrelated settings. */
export interface ConfigCommandWriter {
  applyPatch(patch: unknown): Config | Promise<Config>
}

export async function configGetCommand(
  args: string[],
  storage: ConfigCommandReader,
): Promise<{ output: string }> {
  return formatConfigurationRead(args, await storage.load())
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

export async function configSetCommand(
  args: string[],
  storage: ConfigCommandWriter,
): Promise<{ output: string }> {
  const { key, parsedValue } = parseConfigurationWrite(args)
  const updated = await storage.applyPatch({ [key]: parsedValue })
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
