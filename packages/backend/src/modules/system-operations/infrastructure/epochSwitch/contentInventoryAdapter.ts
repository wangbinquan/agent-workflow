import { captureContentManifest } from '@/platform/content/inventory/manifest'
import { createFreezeContentInventory } from '@/platform/content/inventory/freezeInventory'
import type { InventoryObjectReader } from '@/platform/content/inventory/objects'
import { resolve } from 'node:path'
import type { FreezeContentManifest } from '@/platform/persistence/migration/run/types'
import type { ContentInventoryPort } from '../../application/ports/epochSwitch'

export function createContentInventoryAdapter(
  input: {
    readonly objects?: InventoryObjectReader
    /**
     * RFC-626 §4.4: keep the last listing until the next step takes it (`takeCaptured`). Set by
     * the assembly of the automatic upgrade only, whose plan and execution steps run in one
     * process that ends with the upgrade. Elsewhere nothing is kept: a listing is the largest
     * object of an upgrade and nobody would take it.
     */
    readonly handOver?: boolean
  } = {},
): ContentInventoryPort {
  let captured: { readonly destination: string; readonly manifest: FreezeContentManifest } | null =
    null
  return {
    async capture(request) {
      captured = null
      const manifest = await captureContentManifest({ ...request, objects: input.objects })
      if (input.handOver) captured = { destination: resolve(request.destination), manifest }
      return manifest
    },
    takeCaptured(destination) {
      if (captured?.destination !== resolve(destination)) return null
      const { manifest } = captured
      captured = null
      return manifest
    },
    async open(request) {
      // RFC-626 §3.4 row 2b: `resolution` decides whether verification rechecks receipts that
      // register content as missing (it does not for an automatic upgrade).
      return createFreezeContentInventory({
        manifest: request.manifest,
        root: request.root,
        source: request.source,
        resolution: request.resolution,
        objects: input.objects,
      })
    },
  }
}
