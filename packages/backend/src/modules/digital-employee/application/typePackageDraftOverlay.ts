import type { DigitalEmployeeAuthoringStore, TypePackageRecord } from './ports/authoringStore'
import type { EmployeeTypeRef } from '../domain/model'

function typeKey(ref: EmployeeTypeRef): string {
  return `${ref.typeId}@${ref.revision}`
}

/**
 * Dev-only view over the durable authoring store.
 *
 * Exact published package rows stay immutable on disk. When a Bun watch
 * generation changes a descriptor without changing its revision, this view
 * keeps that descriptor in memory for the lifetime of the generation instead
 * of rewriting the frozen row or aborting daemon startup.
 */
export function withTypePackageDraftOverlay(
  store: DigitalEmployeeAuthoringStore,
): DigitalEmployeeAuthoringStore {
  const overlays = new Map<string, TypePackageRecord>()

  return {
    ...store,
    ensureTypePackage(input) {
      const key = typeKey(input.descriptor.typeRef)
      const persisted = store
        .listTypePackageRegistrations()
        .find((record) => typeKey(record.typeRef) === key)
      if (persisted !== undefined && persisted.descriptorDigest !== input.descriptorDigest) {
        overlays.set(key, input)
        return
      }

      store.ensureTypePackage(input)
      overlays.delete(key)
    },
    listTypePackages() {
      return store.listTypePackageRegistrations().map((registration) => {
        const key = typeKey(registration.typeRef)
        const overlay = overlays.get(key)
        if (overlay !== undefined) return overlay

        const persisted = store.getTypePackage(registration.typeRef)
        if (persisted === null) {
          throw new Error(`employee type package disappeared while listing: ${key}`)
        }
        return persisted
      })
    },
    getTypePackage(ref) {
      return overlays.get(typeKey(ref)) ?? store.getTypePackage(ref)
    },
  }
}
