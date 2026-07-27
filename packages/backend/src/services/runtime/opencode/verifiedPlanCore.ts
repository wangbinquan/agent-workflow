// RFC-224 T19 — the single shared admission core for every verified OpenCode
// invocation. Business and framework-system plans may add different session
// semantics, but neither may independently assemble the runtime executable,
// hermetic store, containment capability, or filesystem-fallback proof.

import { isAbsolute, resolve } from 'node:path'
import { prepareHermeticOpencodeLayout, type HermeticOpencodeLayout } from './hermetic'
import { snapshotRuntimeOpencodeBinary } from './runtimeBinary'
import type { inspectRuntimeOpencodeBinary, RuntimeOpencodeBinaryIdentity } from './runtimeBinary'
import { materializeFffCapabilityProbe, type MaterializedFffCapabilityProbe } from './fffCapability'
import { executionIdentityFailure } from './failure'
import {
  type RuntimeChildProviderPlan,
  type RuntimeContainmentAdmission,
  type RuntimeContainmentReceipt,
} from './containment'

export interface VerifiedOpencodePlanDependencies {
  inspectBinary?: typeof inspectRuntimeOpencodeBinary
  snapshotBinary?: typeof snapshotRuntimeOpencodeBinary
}

export interface BuildVerifiedOpencodePlanInput {
  /** The only containment fact. Core never probes or re-decides policy. */
  admission: RuntimeContainmentAdmission
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
  const admission = input.admission
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

  // The provider-owned exact qualification already selected this canonical
  // child plan before any filesystem mutation. Core only materializes the FFF
  // attestation for the selected Linux topology; it never re-opens PATH or
  // changes the mode/topology decision.
  let bwrapPath: string | null = null
  if (admission.childProvider.providerId === 'linux-bwrap') {
    const admittedPath =
      typeof admission.childProvider.config === 'object' &&
      admission.childProvider.config !== null &&
      !Array.isArray(admission.childProvider.config) &&
      typeof admission.childProvider.config.bwrapPath === 'string'
        ? admission.childProvider.config.bwrapPath
        : null
    if (
      admittedPath === null ||
      !isAbsolute(admittedPath) ||
      resolve(admittedPath) !== admittedPath
    ) {
      return executionIdentityFailure('execution-identity-bootstrap-failed')
    }
    // Outer and child layers consume this exact coordinator-qualified path.
    bwrapPath = admittedPath
  }
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
