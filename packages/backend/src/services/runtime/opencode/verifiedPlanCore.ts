// RFC-224 T19 — the single shared admission core for every verified OpenCode
// invocation. Business and framework-system plans may add different session
// semantics, but neither may independently assemble the runtime executable,
// hermetic store, containment capability, or filesystem-fallback proof.

import { isAbsolute, resolve } from 'node:path'
import { getSandboxProvider, type SandboxProvider } from '@/services/sandbox'
import { prepareHermeticOpencodeLayout, type HermeticOpencodeLayout } from './hermetic'
import { snapshotRuntimeOpencodeBinary } from './runtimeBinary'
import type { inspectRuntimeOpencodeBinary, RuntimeOpencodeBinaryIdentity } from './runtimeBinary'
import { materializeFffCapabilityProbe, type MaterializedFffCapabilityProbe } from './fffCapability'
import { requireRootOwnedBwrap } from './sealedSubprocess'
import { executionIdentityFailure } from './failure'
import {
  admitRuntimeContainment,
  type RuntimeChildProviderPlan,
  type RuntimeContainmentAdmission,
  type RuntimeContainmentReceipt,
} from './containment'

export interface VerifiedOpencodePlanBoundary {
  sandbox?: SandboxProvider | null
}

/**
 * A read-only, shared fail-closed preflight. Callers use this before touching
 * any run/store path; `buildVerifiedOpencodePlan` repeats it at admission so a
 * future caller cannot accidentally omit the boundary.
 */
export function assertVerifiedOpencodePlanBoundary(
  input: VerifiedOpencodePlanBoundary = {},
): RuntimeContainmentAdmission {
  const sandbox = input.sandbox === undefined ? getSandboxProvider() : input.sandbox
  return admitRuntimeContainment(sandbox)
}

export interface VerifiedOpencodePlanDependencies {
  inspectBinary?: typeof inspectRuntimeOpencodeBinary
  snapshotBinary?: typeof snapshotRuntimeOpencodeBinary
  requireBwrap?: () => Promise<string>
}

export interface BuildVerifiedOpencodePlanInput {
  sandbox?: SandboxProvider | null
  appHome: string
  command: readonly string[]
  storeRoot: string
  binaryPath: string
  fffProbeRoot: string
  expectedBinaryDigest?: string
  random?: (size: number) => Uint8Array
  dependencies?: VerifiedOpencodePlanDependencies
}

export interface VerifiedOpencodePlanCore {
  layout: HermeticOpencodeLayout
  binaryIdentity: RuntimeOpencodeBinaryIdentity
  containment: RuntimeContainmentReceipt
  childProvider: RuntimeChildProviderPlan
  fffCapability: MaterializedFffCapabilityProbe | null
  readOnlySubtrees: readonly string[]
}

/**
 * Perform every admission step shared by business and system executions. The
 * returned objects are the only inputs either outer plan may use for its
 * verified launch manifest.
 */
export async function buildVerifiedOpencodePlan(
  input: BuildVerifiedOpencodePlanInput,
): Promise<VerifiedOpencodePlanCore> {
  const admission = assertVerifiedOpencodePlanBoundary({
    ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
  })
  const { sandbox } = admission
  if (
    !isAbsolute(input.appHome) ||
    resolve(input.appHome) !== input.appHome ||
    input.appHome !== sandbox.appHome
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }

  const dependencies = input.dependencies ?? {}
  if (
    input.expectedBinaryDigest !== undefined &&
    !/^[0-9a-f]{64}$/.test(input.expectedBinaryDigest)
  ) {
    return executionIdentityFailure('execution-identity-untrusted-binary')
  }

  // Linux's stronger namespace capability admission stays serialized ahead of
  // every filesystem mutation. Other providers own their own boot probe and
  // reach this core only through the capability receipt above.
  const bwrapPath =
    admission.childProvider.providerId === 'linux-bwrap'
      ? await (dependencies.requireBwrap ?? requireRootOwnedBwrap)()
      : null
  const [layout, binaryIdentity] = await Promise.all([
    prepareHermeticOpencodeLayout(input.storeRoot),
    (dependencies.snapshotBinary ?? snapshotRuntimeOpencodeBinary)({
      command: input.command,
      snapshotPath: input.binaryPath,
      ...(input.expectedBinaryDigest === undefined
        ? {}
        : { expectedDigest: input.expectedBinaryDigest }),
    }),
  ])
  if (
    binaryIdentity.snapshotPath !== input.binaryPath ||
    !/^[0-9a-f]{64}$/.test(binaryIdentity.digest) ||
    (input.expectedBinaryDigest !== undefined &&
      binaryIdentity.digest !== input.expectedBinaryDigest)
  ) {
    return executionIdentityFailure('execution-identity-untrusted-binary')
  }
  const fffCapability =
    bwrapPath === null
      ? null
      : await materializeFffCapabilityProbe({
          probeRoot: input.fffProbeRoot,
          bwrapPath,
          ...(input.random === undefined ? {} : { random: input.random }),
        })
  const childProvider: RuntimeChildProviderPlan =
    bwrapPath === null
      ? admission.childProvider
      : {
          providerId: 'linux-bwrap',
          config: { bwrapPath },
        }
  return {
    layout,
    binaryIdentity,
    containment: admission.receipt,
    childProvider,
    fffCapability,
    readOnlySubtrees: fffCapability?.readOnlySubtrees ?? [],
  }
}
