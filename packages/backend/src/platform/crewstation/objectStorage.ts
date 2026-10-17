import { timeoutSignal } from '@/util/timeoutSignal'
import type { CrewStationMutationFence } from './mutationFence'
import { createCrewStationPlatformApi, CrewStationApiError } from './platformApi'
import { createSha256DigestBuilder, sha256Hex } from '@/util/hash'

interface ObjectUpload {
  readonly id: string
  readonly state: string
  readonly objectId: string | null
}

/** An immutable CS object. The platform catalog revision is mutable CAS state
 * and never part of an AW reference; content identity is id + size + digest. */
export interface HostedStoredObject {
  readonly id: string
  readonly sha256: string
  readonly size: number
}

export interface HostedObjectStream {
  readonly sha256: string
  readonly size: number
  /** Reopened only when the platform confirms an upload still needs bytes. */
  open(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
}

export interface HostedObjectUploadOptions {
  /** Lifetime identity of the caller's durable intent. A repeated attempt with
   * the same value replays the same platform upload; a new lifetime never
   * collides with an earlier, possibly released, upload of the same bytes. */
  readonly attempt?: string
}

export interface CrewStationObjectStorage {
  put(reference: string, bytes: Uint8Array): Promise<HostedStoredObject>
  read(objectId: string): Promise<Uint8Array>
}

export interface CrewStationStreamObjectStorage extends CrewStationObjectStorage {
  /** Upload, commit and pin `reference` as an application owner of the object. */
  putStream(
    reference: string,
    content: HostedObjectStream,
    options?: HostedObjectUploadOptions,
  ): Promise<HostedStoredObject>
  /** Replays an interrupted upload without bytes. Returns the pinned object when
   * the platform already holds the committed bytes, or null when they never
   * arrived (no object exists, so no pin can exist for this upload). */
  resolve(
    reference: string,
    facts: { readonly sha256: string; readonly size: number },
    options?: HostedObjectUploadOptions,
  ): Promise<HostedStoredObject | null>
  /** Adds `reference` as one more application owner of an existing object. */
  retain(reference: string, object: HostedStoredObject): Promise<void>
  /** Removes `reference`; an object the platform no longer has is already released. */
  release(reference: string, object: HostedStoredObject): Promise<void>
  stat(objectId: string): Promise<HostedStoredObject>
  open(
    object: HostedStoredObject,
    range?: { readonly start: number; readonly end: number },
  ): Promise<ReadableStream<Uint8Array>>
}

const DIGEST = /^[a-f0-9]{64}$/
const OBJECT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
/** CS reference revisions belong to the application owner. Every AW owner
 * reference is a new, never re-activated identity, so the wire revision is a
 * protocol constant and never stored by AW. */
const REFERENCE_REVISION = 1

const digestOf = (value: string) => sha256Hex(value)

class SourceUnavailable extends Error {
  constructor() {
    super('hosted-object-source-unavailable')
    this.name = 'SourceUnavailable'
  }
}

/** Migration Jobs can verify immutable bytes before acquiring application
 * execution authority. They receive no object mutation capability. */
export function createCrewStationObjectReader(input: {
  readonly baseUrl: string
  readonly token?: string
  readonly fetch?: typeof fetch
}): Pick<CrewStationStreamObjectStorage, 'open' | 'stat'> {
  const deny = (): never => {
    throw new Error('object-reader-has-no-mutation-authority')
  }
  const storage = createCrewStationObjectStorage({
    ...input,
    ...(input.token
      ? {
          fetch: Object.assign(
            async (resource: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
              const url = new URL(resource instanceof Request ? resource.url : String(resource))
              const base = new URL(input.baseUrl)
              if (
                url.origin !== base.origin ||
                !(
                  url.pathname === base.pathname ||
                  url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')
                )
              )
                throw new Error('object-reader-authority-outside-original-source')
              const headers = new Headers(
                resource instanceof Request ? resource.headers : undefined,
              )
              new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
              headers.set('Authorization', `Bearer ${input.token}`)
              return (input.fetch ?? fetch)(resource, { ...init, headers, redirect: 'error' })
            },
            { preconnect: (input.fetch ?? fetch).preconnect },
          ) as typeof fetch,
        }
      : {}),
    fence: { current: deny, assertHeld: deny },
  })
  return { open: storage.open, stat: storage.stat }
}

/** RFC-035 upload -> commit -> pin. Ambiguous PUT responses are reconciled
 * through the upload record before the bytes can be submitted again. */
export function createCrewStationObjectStorage(input: {
  readonly baseUrl: string
  readonly fence: CrewStationMutationFence
  readonly fetch?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
}): CrewStationStreamObjectStorage {
  const fetcher = input.fetch ?? fetch
  const base = input.baseUrl.replace(/\/+$/, '')
  const api = createCrewStationPlatformApi({ baseUrl: base, fetch: fetcher })
  const sleep = input.sleep ?? ((ms) => Bun.sleep(ms))
  const check = async (response: Response): Promise<Response> => {
    if (!response.ok) {
      await response.body?.cancel()
      throw new CrewStationApiError(
        response.status,
        'object-storage',
        `CrewStation object storage responded ${response.status}`,
        {},
      )
    }
    return response
  }
  const assertFacts = (facts: { readonly sha256: string; readonly size: number }) => {
    if (!DIGEST.test(facts.sha256) || !Number.isSafeInteger(facts.size) || facts.size < 0)
      throw new Error('hosted-object-content-facts-invalid')
  }
  const reference = async (
    method: 'PUT' | 'DELETE',
    owner: string,
    object: HostedStoredObject,
    requestKey: string,
  ) => {
    const deadline = timeoutSignal(30_000)
    try {
      const response = await check(
        await fetcher(`${base}/${encodeURIComponent(object.id)}/references`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestKey,
            ownerType: 'application',
            ownerId: owner,
            revision: REFERENCE_REVISION,
            fence: input.fence.current(),
          }),
          signal: deadline.signal,
        }),
      )
      await response.body?.cancel()
    } finally {
      deadline.cancel()
    }
  }
  const uploadContent = async (
    owner: string,
    content: HostedObjectStream,
    options: HostedObjectUploadOptions | undefined,
  ): Promise<HostedStoredObject> => {
    const { sha256, size } = content
    assertFacts(content)
    const key = `aw-object:${digestOf(
      options?.attempt === undefined
        ? `${owner}\0${sha256}`
        : `${owner}\0${sha256}\0${options.attempt}`,
    )}`
    let upload = await api.post<ObjectUpload>('/uploads', {
      requestKey: key,
      name: owner,
      size,
      sha256,
      mediaType: 'application/octet-stream',
      fence: input.fence.current(),
    })
    const deadline = Date.now() + 1_800_000
    while (upload.state !== 'ready' || upload.objectId === null) {
      if (Date.now() >= deadline) throw new Error(`hosted-object-upload-pending: ${upload.id}`)
      if (upload.state === 'waiting') {
        // Failure to reopen the caller's source is not an ambiguous HTTP PUT.
        // A cold successor may hold only the durable facts of an upload.
        const body = await content.open()
        const transfer = timeoutSignal(1_800_000)
        try {
          const response = await check(
            await fetcher(`${base}/uploads/${upload.id}/content`, {
              method: 'PUT',
              body,
              redirect: 'error',
              headers: {
                'content-type': 'application/octet-stream',
                'content-length': String(size),
                'x-cs-object-fence': JSON.stringify(input.fence.current()),
              },
              signal: transfer.signal,
            }),
          )
          await response.body?.cancel()
          transfer.cancel()
        } catch (error) {
          transfer.cancel()
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
    if (object.sha256 !== sha256 || object.size !== size)
      throw new Error('hosted-object-receipt-mismatch')
    await reference('PUT', owner, object, `${key}:pin`)
    return { id: object.id, sha256: object.sha256, size: object.size }
  }
  const stat = async (objectId: string): Promise<HostedStoredObject> => {
    const object = await api.get<HostedStoredObject>(`/${encodeURIComponent(objectId)}`)
    return { id: object.id, sha256: object.sha256, size: object.size }
  }
  return {
    put(owner, bytes) {
      return uploadContent(
        owner,
        {
          sha256: sha256Hex(bytes),
          size: bytes.byteLength,
          open: () => new Blob([Uint8Array.from(bytes)]).stream(),
        },
        undefined,
      )
    },
    putStream: uploadContent,
    async resolve(owner, facts, options) {
      try {
        return await uploadContent(
          owner,
          {
            sha256: facts.sha256,
            size: facts.size,
            open: () => {
              throw new SourceUnavailable()
            },
          },
          options,
        )
      } catch (error) {
        if (error instanceof SourceUnavailable) return null
        throw error
      }
    },
    async retain(owner, object) {
      if (owner.length === 0 || !OBJECT_ID.test(object.id))
        throw new Error('hosted-object-retention-facts-invalid')
      assertFacts(object)
      const actual = await stat(object.id)
      if (actual.id !== object.id || actual.sha256 !== object.sha256 || actual.size !== object.size)
        throw new Error('hosted-object-retention-facts-mismatch')
      await reference(
        'PUT',
        owner,
        object,
        `aw-object-retain:${digestOf(`${owner}\0${object.id}`)}`,
      )
    },
    stat,
    async release(owner, object) {
      try {
        await reference(
          'DELETE',
          owner,
          object,
          `aw-object-release:${digestOf(`${owner}\0${object.id}`)}`,
        )
      } catch (error) {
        // An object which no longer exists has no references left to release.
        if (error instanceof CrewStationApiError && error.status === 404) return
        throw error
      }
    },
    async open(object, range) {
      if (
        range !== undefined &&
        (!Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.end) ||
          range.start < 0 ||
          range.end < range.start ||
          range.end >= object.size)
      )
        throw new Error('hosted-object-range-invalid')
      // The window bounds the whole transfer; it is cleared once the returned
      // stream ends, fails or is cancelled by its reader.
      const transfer = timeoutSignal(1_800_000)
      let response: Response
      try {
        response = await check(
          await fetcher(`${base}/${encodeURIComponent(object.id)}/content`, {
            ...(range === undefined
              ? {}
              : { headers: { range: `bytes=${range.start}-${range.end}` } }),
            signal: transfer.signal,
            redirect: 'error',
          }),
        )
      } catch (error) {
        transfer.cancel()
        throw error
      }
      const expectedLength = range === undefined ? object.size : range.end - range.start + 1
      if (
        response.status !== (range === undefined ? 200 : 206) ||
        response.headers.get('x-cs-object-sha256') !== object.sha256 ||
        response.headers.get('content-length') !== String(expectedLength) ||
        (range !== undefined &&
          response.headers.get('content-range') !==
            `bytes ${range.start}-${range.end}/${object.size}`) ||
        response.body === null
      ) {
        transfer.cancel()
        await response.body?.cancel()
        throw new Error('hosted-object-download-receipt-mismatch')
      }
      const reader = response.body.getReader()
      let received = 0
      const hash = range === undefined ? createSha256DigestBuilder() : undefined
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read()
            if (next.done) {
              transfer.cancel()
              if (
                received !== expectedLength ||
                (hash !== undefined && hash.digestHex() !== object.sha256)
              )
                throw new Error('hosted-object-download-content-mismatch')
              controller.close()
              return
            }
            received += next.value.byteLength
            if (received > expectedLength)
              throw new Error('hosted-object-download-content-mismatch')
            hash?.update(next.value)
            controller.enqueue(next.value)
          } catch (error) {
            transfer.cancel()
            await reader.cancel(error).catch(() => undefined)
            controller.error(error)
          }
        },
        cancel: (reason) => {
          transfer.cancel()
          return reader.cancel(reason)
        },
      })
    },
    async read(objectId) {
      const transfer = timeoutSignal(120_000)
      try {
        const response = await check(
          await fetcher(`${base}/${encodeURIComponent(objectId)}/content`, {
            signal: transfer.signal,
            redirect: 'error',
          }),
        )
        return new Uint8Array(await response.arrayBuffer())
      } finally {
        transfer.cancel()
      }
    },
  }
}
