import { expect } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  createCrewStationObjectStorage,
  type HostedStoredObject,
} from '@/platform/crewstation/objectStorage'

export function objectFixture() {
  type Upload = {
    id: string
    state: string
    objectId: string | null
    name: string
    size: number
    sha256: string
    bytes?: Uint8Array
  }
  const uploads = new Map<string, Upload>()
  const keys = new Map<string, string>()
  const stored = new Map<string, HostedStoredObject & { bytes: Uint8Array }>()
  const pins: string[] = []
  const releases: string[] = []
  const referenceRequests = new Map<string, string>()
  const references = new Map<string, 'active' | 'released'>()
  let loseNextPinReply = false
  let sequence = 0
  let tamper: 'body' | 'range' | undefined
  // The platform's upload record never carries the uploaded bytes (echoing a
  // multi-MiB Uint8Array through JSON costs seconds per upload).
  const wire = ({ bytes: _bytes, ...upload }: Upload) => upload
  const objectWire = ({ bytes: _bytes, ...object }: HostedStoredObject & { bytes: Uint8Array }) =>
    object
  const objects = createCrewStationObjectStorage({
    baseUrl: 'http://fixture/v3/objects',
    fence: {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      assertHeld: async () => undefined,
    },
    fetch: (async (url, init) => {
      const path = new URL(String(url)).pathname.slice('/v3/objects/'.length)
      if (path === 'uploads') {
        const body = JSON.parse(String(init!.body)) as Upload & { requestKey: string }
        let id = keys.get(body.requestKey)
        if (!id) {
          id = `01a13e6d-3e00-7000-9e3c-${(++sequence).toString(16).padStart(12, '0')}`
          keys.set(body.requestKey, id)
          uploads.set(id, { ...body, id, state: 'waiting', objectId: null })
        }
        return Response.json(wire(uploads.get(id)!))
      }
      if (path.startsWith('uploads/')) {
        const [, id, action] = path.split('/')
        const upload = uploads.get(id!)!
        if (action === 'content') {
          expect(new Headers(init!.headers).get('content-length')).toBe(String(upload.size))
          expect(init!.body).toBeInstanceOf(ReadableStream)
          upload.bytes = new Uint8Array(await new Response(init!.body).arrayBuffer())
          expect(upload.bytes.byteLength).toBe(upload.size)
          expect(createHash('sha256').update(upload.bytes).digest('hex')).toBe(upload.sha256)
          upload.state = 'uploaded'
        }
        if (action === 'commit') {
          stored.set(id!, {
            id: id!,
            size: upload.size,
            sha256: upload.sha256,
            bytes: upload.bytes!,
          })
          upload.state = 'ready'
          upload.objectId = id!
        }
        return Response.json(wire(upload))
      }
      const [id, action] = path.split('/')
      const object = stored.get(id!)
      if (!object)
        return Response.json({ error: 'not_found', message: 'not found' }, { status: 404 })
      if (action === 'references') {
        const pin = JSON.parse(String(init!.body)) as {
          ownerId: string
          revision: number
          requestKey: string
        }
        const digest = JSON.stringify([init!.method, pin.ownerId, pin.revision])
        const prior = referenceRequests.get(pin.requestKey)
        if (prior && prior !== digest)
          return Response.json(
            { error: 'request_key_conflict', message: 'frozen reference request changed' },
            { status: 409 },
          )
        if (prior) return Response.json(objectWire(object))
        const key = JSON.stringify([id, pin.ownerId, pin.revision])
        if (init!.method === 'PUT' && references.get(key) === 'released')
          return Response.json(
            { error: 'object_reference_retired', message: 'retired reference' },
            { status: 409 },
          )
        referenceRequests.set(pin.requestKey, digest)
        references.set(key, init!.method === 'DELETE' ? 'released' : 'active')
        if (init!.method === 'DELETE') releases.push(pin.ownerId)
        else pins.push(pin.ownerId)
        if (init!.method === 'PUT' && loseNextPinReply) {
          loseNextPinReply = false
          throw new TypeError('pin reply lost')
        }
        return Response.json(objectWire(stored.get(id!)!))
      }
      if (action === 'content') {
        const range = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/)
        const start = range ? Number(range[1]) : 0
        const end = range ? Number(range[2]) : object.size - 1
        const bytes = object.bytes.slice(start, end + 1)
        if (tamper === 'body' && bytes.length > 0) bytes[0] = bytes[0]! ^ 255
        return new Response(bytes, {
          status: range ? 206 : 200,
          headers: {
            'content-length': String(bytes.byteLength),
            'x-cs-object-sha256': object.sha256,
            ...(range
              ? {
                  'content-range': `bytes ${tamper === 'range' ? start + 1 : start}-${end}/${object.size}`,
                }
              : {}),
          },
        })
      }
      return Response.json(objectWire(object))
    }) as typeof fetch,
  })
  return {
    objects,
    stored,
    pins,
    releases,
    /** Active application references per object id (pins minus releases). */
    activeReferences: (objectId: string) =>
      [...references.entries()].filter(
        ([key, state]) => state === 'active' && (JSON.parse(key) as string[])[0] === objectId,
      ).length,
    /** Simulates platform-side removal of an object (for example after release). */
    remove: (objectId: string) => stored.delete(objectId),
    losePinReply: () => {
      loseNextPinReply = true
    },
    tamper: (value: typeof tamper) => {
      tamper = value
    },
  }
}
