// Browser-safe SHA-256 for frontend hashing.
//
// SubtleCrypto is [SecureContext]-gated: `globalThis.crypto?.subtle` is
// `undefined` when the UI is served over plain http:// from a non-localhost
// host — the normal self-hosted deployment (single binary on a server,
// browser at http://<LAN-IP>:<port>). 2026-07-21 incident: the workflow
// editor's whole save pipeline (autosave, the ensureSaved barrier behind
// Validate / Launch, starter template hashing) died on `undefined.digest(...)`
// in exactly that environment. Frontend code must therefore never assume
// SubtleCrypto exists (the non-optional dereference spelling is banned by a
// source guard); route every digest through `sha256Hex`, which uses WebCrypto
// when present and otherwise falls back to the pure-JS FIPS 180-4
// implementation below. Correctness (NIST vectors + WebCrypto parity) and the
// spelling ban are locked by
// packages/frontend/tests/workflow-hash-insecure-context.test.ts.

export type Sha256Subtle = Pick<SubtleCrypto, 'digest'>

/** SHA-256 of `bytes` as lowercase hex; WebCrypto when available, else pure JS. */
export async function sha256Hex(
  bytes: Uint8Array,
  subtle: Sha256Subtle | undefined = globalThis.crypto?.subtle,
): Promise<string> {
  if (subtle === undefined) return bytesToHex(sha256DigestJs(bytes))
  // Copy into an owned ArrayBuffer so TS's BufferSource contract cannot see a
  // possible SharedArrayBuffer behind Uint8Array<ArrayBufferLike>.
  const owned = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(owned).set(bytes)
  const digest = await subtle.digest('SHA-256', owned)
  return bytesToHex(new Uint8Array(digest))
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

// FIPS 180-4 §4.2.2 round constants — first 32 bits of the fractional parts
// of the cube roots of the first 64 primes.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

// FIPS 180-4 §5.3.3 initial hash value — first 32 bits of the fractional
// parts of the square roots of the first 8 primes.
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

/** Pure-JS FIPS 180-4 SHA-256. Exported only for the parity/vector tests. */
export function sha256DigestJs(input: Uint8Array): Uint8Array {
  // Pad to a 64-byte multiple: message ‖ 0x80 ‖ zeros ‖ 64-bit BE bit length.
  const blockCount = ((input.byteLength + 8) >>> 6) + 1
  const padded = new Uint8Array(blockCount * 64)
  padded.set(input)
  padded[input.byteLength] = 0x80
  const view = new DataView(padded.buffer)
  // JS numbers hold the bit length exactly up to 2^53 bits (~1 PiB) — far
  // beyond anything the frontend ever hashes.
  const bitLength = input.byteLength * 8
  view.setUint32(padded.byteLength - 8, Math.floor(bitLength / 0x1_0000_0000), false)
  view.setUint32(padded.byteLength - 4, bitLength >>> 0, false)

  const state = new Uint32Array(H0)
  const w = new Uint32Array(64)
  for (let block = 0; block < blockCount; block += 1) {
    const base = block * 64
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(base + i * 4, false)
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!
      const w2 = w[i - 2]!
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }

    let a = state[0]!
    let b = state[1]!
    let c = state[2]!
    let d = state[3]!
    let e = state[4]!
    let f = state[5]!
    let g = state[6]!
    let h = state[7]!
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + ch + K[i]! + w[i]!) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    state[0] = (state[0]! + a) >>> 0
    state[1] = (state[1]! + b) >>> 0
    state[2] = (state[2]! + c) >>> 0
    state[3] = (state[3]! + d) >>> 0
    state[4] = (state[4]! + e) >>> 0
    state[5] = (state[5]! + f) >>> 0
    state[6] = (state[6]! + g) >>> 0
    state[7] = (state[7]! + h) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, state[i]!, false)
  return out
}
