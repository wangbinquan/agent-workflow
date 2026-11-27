import { expect } from 'bun:test'
import type { SupportedSourceManifest } from '@/platform/persistence/migration/supportedSources'

/** Compare every value without repeatedly expanding the manifest's shared DAG into a tree. */
export function expectCompleteSourceManifest(
  actual: SupportedSourceManifest,
  expected: SupportedSourceManifest,
): void {
  const { sources: actualSources, ...actualMetadata } = actual
  const { sources: expectedSources, ...expectedMetadata } = expected
  expect(actualMetadata).toEqual(expectedMetadata)
  expect(actualSources).toHaveLength(expectedSources.length)
  const references = new Map<object, object>()
  const shared = <T extends object>(original: T, copy: T, compare: () => void) => {
    const prior = references.get(original)
    if (prior) expect(prior).toBe(copy)
    else {
      references.set(original, copy)
      compare()
    }
  }
  for (let index = 0; index < expectedSources.length; index++) {
    const { contract, catalog, ...fields } = expectedSources[index]!
    const {
      contract: copiedContract,
      catalog: copiedCatalog,
      ...copiedFields
    } = actualSources[index]!
    expect(copiedFields).toEqual(fields)
    if (contract === null) expect(copiedContract).toBeNull()
    else {
      expect(copiedContract).not.toBeNull()
      shared(contract, copiedContract!, () => expect(copiedContract).toEqual(contract))
    }
    shared(catalog, copiedCatalog, () => {
      expect(copiedCatalog).toHaveLength(catalog.length)
      for (let entry = 0; entry < catalog.length; entry++)
        shared(catalog[entry]!, copiedCatalog[entry]!, () =>
          expect(copiedCatalog[entry]).toEqual(catalog[entry]),
        )
    })
  }
}
