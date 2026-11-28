import { closeSync, openSync, readSync } from 'node:fs'

/** Bytes read per call: large enough to be few calls, small enough to stay out of the way. */
const CHUNK_BYTES = 4 * 1024 * 1024
/** A turn of the event loop is given after this much has been read, so timers still run. */
const YIELD_BYTES = 256 * 1024 * 1024

/**
 * RFC-626 §4.7: feeds the bytes of files to a hash through one reused buffer.
 *
 * A read stream hands every chunk over in a buffer of its own. Here the same buffer is filled
 * again and again, so hashing a file costs four megabytes whatever its size, and one input
 * hashes a whole directory. Measured on 3.5 GB: 1.9 s and 24 MB of resident memory, against
 * 2.8 to 3.3 s and 59 MB for a read stream. (The upgrade's memory step around the backup was
 * first put down to the read stream; measured on its own it was not — see docs/dev-gotchas.md.)
 */
export interface FileDigestInput {
  /** Feeds every byte of `path` to `hash`, in order. */
  update(hash: { update(bytes: Uint8Array): unknown }, path: string): Promise<void>
}
export function createFileDigestInput(): FileDigestInput {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  let sinceYield = 0
  return {
    async update(hash, path) {
      const descriptor = openSync(path, 'r')
      try {
        for (;;) {
          const read = readSync(descriptor, buffer, 0, CHUNK_BYTES, null)
          if (read === 0) break
          hash.update(read === CHUNK_BYTES ? buffer : buffer.subarray(0, read))
          sinceYield += read
          if (sinceYield >= YIELD_BYTES) {
            sinceYield = 0
            await new Promise<void>((resume) => setImmediate(resume))
          }
        }
      } finally {
        closeSync(descriptor)
      }
    },
  }
}
