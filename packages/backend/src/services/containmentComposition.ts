import {
  ContainmentCoordinator,
  ContainmentProviderQualificationError,
  type SandboxMode,
} from '@/services/sandbox'
import type { SandboxStatus } from '@/services/sandbox/probe'
import { probeSandboxMechanism } from '@/services/sandbox/probe'
import {
  requireRootOwnedBwrap,
  type RootOwnedBwrapFailureReason,
} from '@/services/runtime/opencode/sealedSubprocess'

export interface BuiltinContainmentCoordinatorOptions {
  mode: SandboxMode
  appHome: string
  platform?: NodeJS.Platform
  /**
   * Discovery is diagnostic only. Exact capability strength is always supplied
   * by the provider qualification callbacks below.
   */
  discoveryStatus?: SandboxStatus
  bwrapPath?: string | null
  qualifyBwrapFilesystem?: () => Promise<string>
  qualifyBwrapFull?: (canonicalPath: string) => Promise<void>
  qualifySeatbelt?: () => Promise<void>
  bootId?: string
  now?: () => number
}

export function containmentMechanismForPlatform(
  platform: NodeJS.Platform,
): 'bwrap' | 'seatbelt' | null {
  if (platform === 'linux') return 'bwrap'
  if (platform === 'darwin') return 'seatbelt'
  return null
}

async function qualifyBwrap(
  trial: 'filesystem' | 'full',
  path: string | null | undefined,
): Promise<string> {
  let reason: RootOwnedBwrapFailureReason = 'provider-internal-error'
  try {
    return await requireRootOwnedBwrap(path, {
      trial,
      onFailure: (value) => {
        reason = value
      },
    })
  } catch {
    throw new ContainmentProviderQualificationError(reason)
  }
}

/**
 * The one production composition root for built-in containment providers.
 * Daemon, status, Runtime Test, CLI and doctor all receive coordinators built
 * from this exact provider qualification contract.
 */
export function createBuiltinContainmentCoordinator(
  options: BuiltinContainmentCoordinatorOptions,
): ContainmentCoordinator {
  const platform = options.platform ?? process.platform
  const mechanism = containmentMechanismForPlatform(platform)
  const status =
    options.discoveryStatus ??
    ({
      mechanism,
      available: false,
      detail:
        options.mode === 'off'
          ? 'containment disabled by config'
          : 'exact containment qualification pending',
    } satisfies SandboxStatus)

  return new ContainmentCoordinator({
    provider: {
      mode: options.mode,
      status,
      appHome: options.appHome,
    },
    ...(mechanism === 'bwrap'
      ? {
          qualifyBwrapFilesystem:
            options.qualifyBwrapFilesystem ?? (() => qualifyBwrap('filesystem', options.bwrapPath)),
          qualifyBwrapFull:
            options.qualifyBwrapFull ??
            (async (canonicalPath: string) => {
              await qualifyBwrap('full', canonicalPath)
            }),
        }
      : {}),
    ...(mechanism === 'seatbelt'
      ? {
          qualifySeatbelt:
            options.qualifySeatbelt ??
            (async () => {
              const qualified = await probeSandboxMechanism('darwin')
              if (!qualified.available) {
                throw new ContainmentProviderQualificationError('provider-trial-rejected')
              }
            }),
        }
      : {}),
    ...(options.bootId === undefined ? {} : { bootId: options.bootId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}
