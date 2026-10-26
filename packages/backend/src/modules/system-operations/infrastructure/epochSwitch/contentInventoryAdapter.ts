import { captureContentManifest } from '@/platform/content/inventory/manifest'
import { createFreezeContentInventory } from '@/platform/content/inventory/freezeInventory'
import type { InventoryObjectReader } from '@/platform/content/inventory/objects'
import type { ContentInventoryPort } from '../../application/ports/epochSwitch'

export function createContentInventoryAdapter(
  input: { readonly objects?: InventoryObjectReader } = {},
): ContentInventoryPort {
  return {
    capture: (request) => captureContentManifest({ ...request, objects: input.objects }),
    async open(request) {
      return createFreezeContentInventory({ ...request, objects: input.objects })
    },
  }
}
