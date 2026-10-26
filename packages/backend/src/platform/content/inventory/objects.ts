import type {
  CrewStationStreamObjectStorage,
  HostedStoredObject,
} from '@/platform/crewstation/objectStorage'
import { isCrewStationApiError } from '@/platform/crewstation/platformApi'
import { contentByteFacts } from './treeDigest'

export type InventoryObjectReader = Pick<CrewStationStreamObjectStorage, 'stat' | 'open'>
export async function statInventoryObject(
  reader: Pick<InventoryObjectReader, 'stat'>,
  id: string,
): Promise<HostedStoredObject | null> {
  try {
    return await reader.stat(id)
  } catch (error) {
    if (isCrewStationApiError(error) && error.status === 404) return null
    throw error
  }
}
export async function readInventoryObject(
  reader: InventoryObjectReader,
  object: HostedStoredObject,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(await new Response(await reader.open(object)).arrayBuffer())
  const facts = contentByteFacts(bytes)
  if (facts.size !== object.size || facts.sha256 !== object.sha256)
    throw new Error('content-object-bytes-differ')
  return bytes
}
