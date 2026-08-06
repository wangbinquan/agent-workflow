/**
 * RFC-256 — whether an OpenCode process may read the operator's own global
 * configuration, and what that means for credential resolution.
 *
 * RFC-224 sealed those roots off, which broke both the model probe (pickers
 * went blank for anything declared in a machine `opencode.json`) and execution
 * (`auth-invalid` for providers declared there). The env delta itself lives in
 * `hermetic.ts:machineConfigEnvOverrides`; this module owns the switch and the
 * credential consequence.
 */

import type { Config } from '@agent-workflow/shared'
import { loadConfig } from '@/config'
import { Paths } from '@/util/paths'
import type { StrictProviderAuth } from './hermetic'
import { resolveStrictProviderAuth } from './hermetic'

/** Test seam; production reads the daemon's own config file. */
export interface MachineConfigDependencies {
  loadDaemonConfig?: () => Pick<Config, 'inheritMachineOpencodeConfig'> | Record<string, unknown>
}

function readConfig(dependencies: MachineConfigDependencies): Record<string, unknown> {
  const load = dependencies.loadDaemonConfig ?? (() => loadConfig(Paths.config))
  return load() as Record<string, unknown>
}

/**
 * Defaults to ON — that is the behavior the platform had before RFC-224, and
 * restoring it is the whole point. An operator wanting the sealed posture back
 * sets the key to false explicitly.
 */
export function inheritsMachineOpencodeConfig(
  dependencies: MachineConfigDependencies = {},
): boolean {
  return readConfig(dependencies).inheritMachineOpencodeConfig !== false
}

export interface ResolvedProviderCredential {
  /**
   * Undefined means "let OpenCode resolve it" — reachable only with machine
   * config inheritance on, where a provider declared in the operator's own
   * `opencode.json` carries its own key (an inline `options.apiKey`, or their
   * auth store).
   */
  auth?: StrictProviderAuth
}

/**
 * Resolve the credential for a selected model, for all three planners.
 *
 * With inheritance on, the platform failing to find a key is NOT a failure:
 * it is not the party authenticating. Refusing to launch there was exactly the
 * regression RFC-256 exists to undo. With inheritance off there is nowhere
 * else to look, so the strict failure stands.
 */
export async function resolveProviderCredential(
  providerID: string,
  sourceEnv: Readonly<Record<string, string | undefined>>,
  dependencies: MachineConfigDependencies = {},
): Promise<ResolvedProviderCredential> {
  if (!inheritsMachineOpencodeConfig(dependencies)) {
    return { auth: await resolveStrictProviderAuth(providerID, sourceEnv) }
  }
  try {
    return { auth: await resolveStrictProviderAuth(providerID, sourceEnv) }
  } catch {
    return {}
  }
}
