import type { DigitalEmployeeAuthoringPersistence, TypePackageRecord } from './ports/authoringStore'
import type { EmployeeTypeRef } from '../domain/model'

function typeKey(ref: EmployeeTypeRef): string {
  return `${ref.typeId}@${ref.revision}`
}

/**
 * Dev-only view over the durable authoring persistence.
 *
 * Exact published package rows stay immutable on disk. When a Bun watch
 * generation changes a descriptor without changing its revision, this view
 * keeps that descriptor in memory for the lifetime of the generation instead
 * of rewriting the frozen row or aborting daemon startup.
 */
export function withTypePackageDraftOverlay<T extends DigitalEmployeeAuthoringPersistence>(
  store: T,
): T {
  const overlays = new Map<string, TypePackageRecord>()

  const overlay: DigitalEmployeeAuthoringPersistence = {
    ...store,
    async ensureTypePackage(input) {
      const key = typeKey(input.descriptor.typeRef)
      const persisted = (await store.listTypePackageRegistrations()).find(
        (record) => typeKey(record.typeRef) === key,
      )
      if (persisted !== undefined && persisted.descriptorDigest !== input.descriptorDigest) {
        overlays.set(key, input)
        return
      }

      await store.ensureTypePackage(input)
      overlays.delete(key)
    },
    async listTypePackages() {
      const registrations = await store.listTypePackageRegistrations()
      const packages: TypePackageRecord[] = []
      for (const registration of registrations) {
        const key = typeKey(registration.typeRef)
        const overlaid = overlays.get(key)
        if (overlaid !== undefined) {
          packages.push(overlaid)
          continue
        }
        const persisted = await store.getTypePackage(registration.typeRef)
        if (persisted === null) {
          throw new Error(`employee type package disappeared while listing: ${key}`)
        }
        packages.push(persisted)
      }
      return packages
    },
    async getTypePackage(ref) {
      return overlays.get(typeKey(ref)) ?? (await store.getTypePackage(ref))
    },
  }
  return { ...store, ...overlay }
}
