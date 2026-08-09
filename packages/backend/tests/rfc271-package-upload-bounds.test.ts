// RFC-271 adversarial resource-package bounds.
//
// These tests deliberately distinguish pre-inflate rejection from the old
// "inflate everything, then inspect byteLength" behaviour, and exercise both
// trusted Content-Length and streaming request-body paths at the Hono seam.

import { describe, expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { Zip, ZipPassThrough, zipSync, type Zippable } from 'fflate'
import { buildActor } from '../src/auth/actor'
import type { SecretBox } from '../src/auth/secretBox'
import type { DbClient } from '../src/db/client'
import {
  registerResourcePackageRoutes,
  RESOURCE_PACKAGE_BODY_MAX_BYTES,
} from '../src/routes/resourcePackages'
import { decodeZip, ZIP_LIMITS } from '../src/services/skill-zip'
import { errorHandler, ValidationError } from '../src/util/errors'

const LOCAL_FILE_HEADER = 0x04034b50
const CENTRAL_FILE_HEADER = 0x02014b50

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

function findSignature(bytes: Uint8Array, signature: number, from = 0): number {
  for (let offset = from; offset <= bytes.byteLength - 4; offset += 1) {
    if (readU32(bytes, offset) === signature) return offset
  }
  throw new Error(`ZIP signature 0x${signature.toString(16)} not found`)
}

function corruptFirstCompressedPayload(zip: Uint8Array): Uint8Array {
  const corrupted = zip.slice()
  const local = findSignature(corrupted, LOCAL_FILE_HEADER)
  const payload = local + 30 + readU16(corrupted, local + 26) + readU16(corrupted, local + 28)
  corrupted[payload] = corrupted[payload]! ^ 0xff
  return corrupted
}

function understateFirstEntrySize(zip: Uint8Array, claimedBytes: number): Uint8Array {
  const forged = zip.slice()
  const local = findSignature(forged, LOCAL_FILE_HEADER)
  const central = findSignature(forged, CENTRAL_FILE_HEADER)
  // Local header's uncompressed size and central directory's uncompressed size.
  writeU32(forged, local + 22, claimedBytes)
  writeU32(forged, central + 24, claimedBytes)
  return forged
}

function expectLimit(fn: () => unknown): ValidationError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).code).toBe('zip-limit-exceeded')
    return err as ValidationError
  }
  throw new Error('expected zip-limit-exceeded')
}

function expectDecodeFailure(fn: () => unknown): ValidationError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).code).toBe('zip-decode-failed')
    return err as ValidationError
  }
  throw new Error('expected zip-decode-failed')
}

function zipWithRawDuplicate(path: string): Uint8Array {
  const chunks: Uint8Array[] = []
  let failure: Error | null = null
  const archive = new Zip((err, chunk) => {
    if (err) failure = err
    else chunks.push(chunk)
  })
  for (const byte of [0x61, 0x62]) {
    const file = new ZipPassThrough(path)
    archive.add(file)
    file.push(new Uint8Array([byte]), true)
  }
  archive.end()
  if (failure !== null) throw failure
  return Buffer.concat(chunks)
}

function zipWithRawPath(path: string): Uint8Array {
  const chunks: Uint8Array[] = []
  let failure: Error | null = null
  const archive = new Zip((err, chunk) => {
    if (err) failure = err
    else chunks.push(chunk)
  })
  const file = new ZipPassThrough(path)
  archive.add(file)
  file.push(new Uint8Array([0x61]), true)
  archive.end()
  if (failure !== null) throw failure
  return Buffer.concat(chunks)
}

function routeApp(): Hono {
  const app = new Hono()
  const actor = buildActor({
    user: {
      id: 'upload-limit-admin',
      username: 'upload-limit-admin',
      displayName: 'Upload Limit Admin',
      role: 'admin',
      status: 'active',
    },
    source: 'daemon',
  })
  const injectActor: MiddlewareHandler = async (c, next) => {
    c.set('actor', actor)
    await next()
  }
  app.use('*', injectActor)
  app.onError(errorHandler)
  // Oversize requests must return from the body-limit handler before any route
  // dependency is touched. Deliberately inert dependencies make that boundary
  // observable: falling through would become a test failure rather than a DB IO.
  registerResourcePackageRoutes(app, {
    db: {} as DbClient,
    appHome: '/unused/resource-package-upload-limit-test',
    box: {} as SecretBox,
  })
  return app
}

function streamingRequest(path: string, contentType: string, contentLength?: string): Request {
  const chunk = new Uint8Array(1024 * 1024)
  let emittedBytes = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk)
      emittedBytes += chunk.byteLength
      if (emittedBytes > RESOURCE_PACKAGE_BODY_MAX_BYTES) controller.close()
    },
  })
  const headers = new Headers({ 'content-type': contentType })
  if (contentLength !== undefined) headers.set('content-length', contentLength)
  return new Request(`http://resource-package.test${path}`, {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

describe('RFC-271 ZIP inflate bounds', () => {
  test('declared per-entry overflow wins before corrupt earlier payload is inflated', () => {
    const zip = zipSync(
      {
        'first-corrupt.bin': new Uint8Array(256 * 1024),
        'second-oversized.bin': new Uint8Array(ZIP_LIMITS.perFileBytes + 1),
      },
      { level: 9 },
    )
    const err = expectLimit(() => decodeZip(corruptFirstCompressedPayload(zip)))
    expect(err.message).toContain('second-oversized.bin')
  })

  test('declared aggregate overflow is rejected before any entry output is allocated', () => {
    const sharedNineMiB = new Uint8Array(9 * 1024 * 1024)
    const files: Zippable = {}
    for (let index = 0; index < 8; index += 1) {
      files[`entry-${index}.bin`] = sharedNineMiB
    }
    const zip = zipSync(files, { level: 9 })
    const err = expectLimit(() => decodeZip(corruptFirstCompressedPayload(zip)))
    expect(err.message).toContain('total uncompressed size')
  })

  test('forged small size metadata cannot bypass the actual streamed-output limit', () => {
    const actual = new Uint8Array(12 * 1024 * 1024)
    const zip = zipSync({ 'forged-bomb.bin': actual }, { level: 9 })
    expect(zip.byteLength).toBeLessThan(32 * 1024)

    const forged = understateFirstEntrySize(zip, 1)
    const err = expectLimit(() => decodeZip(forged))
    expect(err.message).toContain('while inflating')
  })

  test('highly-compressible content inside the real limits still round-trips', () => {
    const actual = new Uint8Array(1024 * 1024)
    actual.fill(0x61)
    const zip = zipSync({ 'valid-high-ratio.bin': actual }, { level: 9 })
    const [entry] = decodeZip(zip)
    expect(entry?.size).toBe(actual.byteLength)
    expect(entry?.bytes()).toEqual(actual)
  })

  test('raw duplicate central-directory paths are rejected deterministically', () => {
    const err = expectDecodeFailure(() => decodeZip(zipWithRawDuplicate('same/path.bin')))
    expect(err.message).toBe("duplicate normalized zip entry path 'same/path.bin'")
  })

  test('backslash/slash aliases cannot collide after path normalisation', () => {
    const zip = zipSync({
      'alias\\path.bin': new Uint8Array([0x61]),
      'alias/path.bin': new Uint8Array([0x62]),
    })
    const err = expectDecodeFailure(() => decodeZip(zip))
    expect(err.message).toBe("duplicate normalized zip entry path 'alias/path.bin'")
  })

  test('a nameless ZIP entry is rejected instead of disappearing from decoded output', () => {
    const err = expectDecodeFailure(() => decodeZip(zipWithRawPath('')))
    expect(err.message).toBe('zip entry path is empty')
  })
})

describe('RFC-271 resource-package request body bounds', () => {
  test('oversized Content-Length fails fast on preview and commit without awaiting the body', async () => {
    const app = routeApp()
    for (const path of ['/api/resource-packages/preview', '/api/resource-packages/commit']) {
      // This stream never produces a byte or closes. Any attempt to read it
      // would hang; Content-Length must therefore produce the 413 directly.
      const body = new ReadableStream<Uint8Array>({ pull() {} })
      const request = new Request(`http://resource-package.test${path}`, {
        method: 'POST',
        headers: {
          'content-length': String(RESOURCE_PACKAGE_BODY_MAX_BYTES + 1),
          'content-type': 'application/octet-stream',
        },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      const response = await Promise.race([
        app.fetch(request),
        Bun.sleep(500).then(() => {
          throw new Error('body-limit handler tried to consume an oversized declared body')
        }),
      ])
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({
        ok: false,
        code: 'zip-limit-exceeded',
      })
      await request.body?.cancel()
    }
  })

  test('lengthless raw and multipart streams are both cut off at the byte limit', async () => {
    const cases = [
      ['/api/resource-packages/preview', 'application/octet-stream'],
      ['/api/resource-packages/commit', 'multipart/form-data; boundary=bounded-test'],
    ] as const

    for (const [path, contentType] of cases) {
      const response = await routeApp().fetch(streamingRequest(path, contentType))
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({
        ok: false,
        code: 'zip-limit-exceeded',
      })
    }
  })

  test('an understated Content-Length cannot bypass counting the actual stream', async () => {
    const request = streamingRequest(
      '/api/resource-packages/preview',
      'application/octet-stream',
      '1',
    )
    const response = await routeApp().fetch(request)
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'zip-limit-exceeded',
    })
  })

  test('malformed or unsafe Content-Length values are rejected without reading the body', async () => {
    for (const contentLength of ['-1', 'NaN', String(Number.MAX_SAFE_INTEGER + 1)]) {
      const body = new ReadableStream<Uint8Array>({ pull() {} })
      const request = new Request('http://resource-package.test/api/resource-packages/preview', {
        method: 'POST',
        headers: {
          'content-length': contentLength,
          'content-type': 'application/octet-stream',
        },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      const response = await Promise.race([
        routeApp().fetch(request),
        Bun.sleep(500).then(() => {
          throw new Error(`body-limit handler tried to consume malformed length '${contentLength}'`)
        }),
      ])
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({ code: 'zip-limit-exceeded' })
      await request.body?.cancel()
    }
  })
})
