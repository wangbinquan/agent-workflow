// RFC-282 A3 (§4.3) — boot-time declaration self-check.
//
// A face a driver declared but never implemented is WORSE than an undeclared
// one — it makes the verification layer believe it is verifying (RFC-247's
// rationale, RFC-280 实现门 P2-D's lesson). So the daemon refuses to start
// unless every registered driver states a stance on every declaration face,
// its observation source is a legal value, and the disabled-resource policy
// table covers every disableable kind.
//
// The check is a PURE function over an injected driver list (设计门 P2-3: the
// DRIVERS map is a private const — without this seam there is no way to prove
// "a mock driver missing a face is refused"). Boot passes the real registry.

import {
  DISABLED_RESOURCE_POLICY,
  notModeledDisabledKinds,
  type DisableableResourceKind,
} from '@/services/execution/resourcePolicy'
import { emptyDeclaredManifest } from '@/services/execution/agentInjection'
import type { DeclarationFace, RuntimeDriver } from './types'

const LEGAL_OBSERVATIONS = new Set(['inventory-file', 'init-event', 'none'])
const LEGAL_FACE_SUPPORT = new Set(['supported', 'unsupported', 'unobservable'])
const DISABLEABLE_KINDS: readonly DisableableResourceKind[] = ['mcp', 'plugin', 'agent']

/** The face universe, derived from the runtime shape of the manifest itself so
 *  a driver compiled against a stale type union cannot pass. */
export function declarationFaceUniverse(): DeclarationFace[] {
  return Object.keys(emptyDeclaredManifest()) as DeclarationFace[]
}

export interface RuntimeDeclarationReport {
  readonly problems: readonly string[]
  /** 'not-modeled' policy entries — reported separately, never counted as a stance. */
  readonly notModeled: readonly string[]
}

export function verifyRuntimeDeclarations(
  drivers: readonly RuntimeDriver[],
): RuntimeDeclarationReport {
  const problems: string[] = []
  const universe = declarationFaceUniverse()
  for (const driver of drivers) {
    const caps = driver.capabilities as RuntimeDriver['capabilities'] | undefined
    if (caps === undefined || caps === null) {
      problems.push(`driver '${driver.kind}': capabilities missing`)
      continue
    }
    if (!LEGAL_OBSERVATIONS.has(caps.startupObservation)) {
      problems.push(
        `driver '${driver.kind}': startupObservation '${String(caps.startupObservation)}' is not one of inventory-file|init-event|none`,
      )
    }
    if (typeof caps.observationRequiresFreshRun !== 'boolean') {
      problems.push(`driver '${driver.kind}': observationRequiresFreshRun must be boolean`)
    }
    const faces = (caps.declarationFaces ?? {}) as Record<string, unknown>
    for (const face of universe) {
      const stance = faces[face]
      if (stance === undefined) {
        problems.push(`driver '${driver.kind}': declarationFaces missing a stance for '${face}'`)
      } else if (!LEGAL_FACE_SUPPORT.has(stance as string)) {
        problems.push(
          `driver '${driver.kind}': declarationFaces['${face}'] = '${String(stance)}' is not supported|unsupported|unobservable`,
        )
      }
    }
  }
  for (const kind of DISABLEABLE_KINDS) {
    if (DISABLED_RESOURCE_POLICY[kind] === undefined) {
      problems.push(`DISABLED_RESOURCE_POLICY: missing an entry for '${kind}'`)
    }
  }
  return {
    problems,
    notModeled: notModeledDisabledKinds().map(
      (kind) => `${kind}: ${DISABLED_RESOURCE_POLICY[kind].why}`,
    ),
  }
}

/** Boot wrapper: throw (refusing startup) on any problem; log-friendly report otherwise. */
export function assertRuntimeDeclarations(drivers: readonly RuntimeDriver[]): {
  notModeled: readonly string[]
} {
  const report = verifyRuntimeDeclarations(drivers)
  if (report.problems.length > 0) {
    throw new Error(
      `runtime driver declaration self-check failed (RFC-282 §4.3):\n  ${report.problems.join('\n  ')}`,
    )
  }
  return { notModeled: report.notModeled }
}
