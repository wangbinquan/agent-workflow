// RFC-455 — decode the private provider document of a package resource snapshot. Moved from
// `services/resourcePackage/providerReadPort.ts`; the read port and snapshot types that file declared are the same
// contracts as `./ports.ts`, which now holds the only copy.

import { ValidationError } from '@/util/errors'
import type { ResourcePackageResourceSnapshot } from './ports'

/** Decode the private provider document at the legacy algorithm edge. */
export function resourcePackageDocumentOf(
  snapshot: ResourcePackageResourceSnapshot,
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(snapshot.document)
  } catch {
    throw new ValidationError(
      'package-resource-snapshot-invalid',
      `stored ${snapshot.type} '${snapshot.id}' has an invalid package document`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(
      'package-resource-snapshot-invalid',
      `stored ${snapshot.type} '${snapshot.id}' has a non-object package document`,
    )
  }
  return {
    ...parsed,
    id: snapshot.id,
    name: snapshot.name,
    ownerUserId: snapshot.ownerUserId,
    visibility: snapshot.visibility,
    builtin: snapshot.builtin,
  }
}
