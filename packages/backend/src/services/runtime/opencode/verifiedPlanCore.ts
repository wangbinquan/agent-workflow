// RFC-224 T19 — the single shared admission core for every verified OpenCode
// invocation. Business and framework-system plans may add different session
// semantics, but neither may independently assemble the official executable,
// hermetic store, bwrap capability, or filesystem-fallback proof.

import { isAbsolute, resolve } from 'node:path'
import { getSandboxProvider, type SandboxProvider } from '@/services/sandbox'
import {
  OPENCODE_FFF_CAPABILITY_CODEC,
  prepareHermeticOpencodeLayout,
  type HermeticOpencodeLayout,
} from './hermetic'
import {
  requireOfficialOpencodeBuild,
  snapshotOfficialOpencodeBinary,
  type OfficialOpencodeBuild,
} from './officialBuilds'
import { materializeFffCapabilityProbe, type MaterializedFffCapabilityProbe } from './fffCapability'
import { requireRootOwnedBwrap } from './sealedSubprocess'
import { executionIdentityFailure } from './failure'

export interface VerifiedOpencodePlanBoundary {
  platform?: NodeJS.Platform
  sandbox?: SandboxProvider | null
}

/**
 * A read-only, shared fail-closed preflight. Callers use this before touching
 * any run/store path; `buildVerifiedOpencodePlan` repeats it at admission so a
 * future caller cannot accidentally omit the boundary.
 */
export function assertVerifiedOpencodePlanBoundary(
  input: VerifiedOpencodePlanBoundary = {},
): SandboxProvider {
  const platform = input.platform ?? process.platform
  const sandbox = input.sandbox === undefined ? getSandboxProvider() : input.sandbox
  if (
    platform !== 'linux' ||
    sandbox === null ||
    sandbox.mode !== 'enforce' ||
    !sandbox.status.available ||
    sandbox.status.mechanism !== 'bwrap'
  ) {
    return executionIdentityFailure('execution-identity-sandbox-required')
  }
  return sandbox
}

export interface VerifiedOpencodePlanDependencies {
  snapshotBinary?: typeof snapshotOfficialOpencodeBinary
  requireBwrap?: () => Promise<string>
  officialBuild?: (
    version: string,
    platform: NodeJS.Platform,
    arch: string,
  ) => Readonly<OfficialOpencodeBuild>
}

export interface BuildVerifiedOpencodePlanInput {
  platform?: NodeJS.Platform
  arch?: string
  sandbox?: SandboxProvider | null
  appHome: string
  command: readonly string[]
  version: string
  storeRoot: string
  binaryPath: string
  fffProbeRoot: string
  expectedOfficialBuildDigest?: string
  random?: (size: number) => Uint8Array
  dependencies?: VerifiedOpencodePlanDependencies
}

export interface VerifiedOpencodePlanCore {
  layout: HermeticOpencodeLayout
  bwrapPath: string
  officialBuild: Readonly<OfficialOpencodeBuild>
  fffCapability: MaterializedFffCapabilityProbe
}

/**
 * Perform every admission step shared by business and system executions. The
 * returned objects are the only inputs either outer plan may use for its
 * verified launch manifest.
 */
export async function buildVerifiedOpencodePlan(
  input: BuildVerifiedOpencodePlanInput,
): Promise<VerifiedOpencodePlanCore> {
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const sandbox = assertVerifiedOpencodePlanBoundary({
    platform,
    ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
  })
  if (
    !isAbsolute(input.appHome) ||
    resolve(input.appHome) !== input.appHome ||
    input.appHome !== sandbox.appHome
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }

  const dependencies = input.dependencies ?? {}
  const build = (dependencies.officialBuild ?? requireOfficialOpencodeBuild)(
    input.version,
    platform,
    arch,
  )
  if (
    build.version !== input.version ||
    build.platform !== platform ||
    build.arch !== arch ||
    build.fffCapabilityCodec !== OPENCODE_FFF_CAPABILITY_CODEC ||
    !/^[0-9a-f]{64}$/.test(build.digest) ||
    (input.expectedOfficialBuildDigest !== undefined &&
      input.expectedOfficialBuildDigest !== build.digest)
  ) {
    return executionIdentityFailure('execution-identity-untrusted-binary')
  }

  const [layout, snapshotPath, bwrapPath] = await Promise.all([
    prepareHermeticOpencodeLayout(input.storeRoot),
    (dependencies.snapshotBinary ?? snapshotOfficialOpencodeBinary)({
      command: input.command,
      version: input.version,
      snapshotPath: input.binaryPath,
      platform,
      arch,
    }),
    (dependencies.requireBwrap ?? requireRootOwnedBwrap)(),
  ])
  if (snapshotPath !== input.binaryPath) {
    return executionIdentityFailure('execution-identity-untrusted-binary')
  }
  const fffCapability = await materializeFffCapabilityProbe({
    probeRoot: input.fffProbeRoot,
    bwrapPath,
    ...(input.random === undefined ? {} : { random: input.random }),
  })
  return { layout, bwrapPath, officialBuild: build, fffCapability }
}
