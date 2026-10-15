import { createHash } from 'node:crypto'
import type { CrewStationMutationFence } from './mutationFence'
import { createCrewStationPlatformApi, CrewStationApiError } from './platformApi'

interface ObjectUpload {
  readonly id: string
  readonly state: string
  readonly objectId: string | null
}
export interface HostedStoredObject {
  readonly id: string
  readonly revision: number
  readonly sha256: string
  readonly size: number
}
export interface CrewStationObjectStorage {
  put(reference: string, bytes: Uint8Array): Promise<HostedStoredObject>
  read(objectId: string): Promise<Uint8Array>
}

/** RFC-035 upload -> commit -> pin. Ambiguous PUT responses are reconciled
 * through the upload record before the bytes can be submitted again. */
export function createCrewStationObjectStorage(input: {
  readonly baseUrl: string
  readonly fence: CrewStationMutationFence
  readonly fetch?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
}): CrewStationObjectStorage {
  const fetcher = input.fetch ?? fetch
  const base = input.baseUrl.replace(/\/+$/, '')
  const api = createCrewStationPlatformApi({ baseUrl: base, fetch: fetcher })
  const sleep = input.sleep ?? ((ms) => Bun.sleep(ms))
  const check = async (response: Response): Promise<Response> => {
    if (!response.ok)
      throw new CrewStationApiError(
        response.status,
        'object-storage',
        `CrewStation object storage responded ${response.status}`,
        {},
      )
    return response
  }
  return {
    async put(reference, bytes) {
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const key = `aw-object:${createHash('sha256').update(`${reference}\0${sha256}`).digest('hex')}`
      let upload = await api.post<ObjectUpload>('/uploads', {
        requestKey: key,
        name: reference,
        size: bytes.byteLength,
        sha256,
        mediaType: 'application/octet-stream',
        fence: input.fence.current(),
      })
      const deadline = Date.now() + 1_800_000
      while (upload.state !== 'ready' || upload.objectId === null) {
        if (Date.now() >= deadline) throw new Error(`hosted-object-upload-pending: ${upload.id}`)
        if (upload.state === 'waiting') {
          try {
            const response = await check(
              await fetcher(`${base}/uploads/${upload.id}/content`, {
                method: 'PUT',
                body: new Blob([Uint8Array.from(bytes)]).stream(),
                redirect: 'error',
                headers: {
                  'content-type': 'application/octet-stream',
                  'content-length': String(bytes.byteLength),
                  'x-cs-object-fence': JSON.stringify(input.fence.current()),
                },
                signal: AbortSignal.timeout(1_800_000),
              }),
            )
            await response.body?.cancel()
          } catch (error) {
            if (
              error instanceof CrewStationApiError &&
              error.status < 500 &&
              error.status !== 409 &&
              error.status !== 429
            )
              throw error
            upload = await api.get<ObjectUpload>(`/uploads/${upload.id}`)
            await sleep(1_000)
            continue
          }
        }
        upload = await api.post<ObjectUpload>(`/uploads/${upload.id}/commit`, {
          requestKey: `${key}:commit`,
          fence: input.fence.current(),
        })
        if (upload.state === 'ready' && upload.objectId !== null) break
        if (upload.state === 'failed' || upload.state === 'aborted')
          throw new Error(`hosted-object-upload-failed: ${upload.id}`)
        await sleep(1_000)
        upload = await api.get<ObjectUpload>(`/uploads/${upload.id}`)
      }
      const object = await api.get<HostedStoredObject>(`/${upload.objectId}`)
      if (object.sha256 !== sha256 || object.size !== bytes.byteLength)
        throw new Error('hosted-object-receipt-mismatch')
      const response = await check(
        await fetcher(`${base}/${object.id}/references`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestKey: `${key}:pin`,
            ownerType: 'application',
            ownerId: reference,
            revision: object.revision,
            fence: input.fence.current(),
          }),
          signal: AbortSignal.timeout(30_000),
        }),
      )
      await response.body?.cancel()
      return object
    },
    async read(objectId) {
      const response = await check(
        await fetcher(`${base}/${encodeURIComponent(objectId)}/content`, {
          signal: AbortSignal.timeout(120_000),
          redirect: 'error',
        }),
      )
      return new Uint8Array(await response.arrayBuffer())
    },
  }
}
