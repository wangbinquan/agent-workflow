// RFC-224 — runner/launcher control channel. Control frames are never stdout
// JSONL and must never be persisted as user-visible stderr.

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { PINNED_OPENCODE_VERSION, SessionIdSchema, parseDirectApiValue } from './directApiSchemas'
import { canonicalizeIdentity } from './executionIdentity'

export const CONTROL_LINE_PREFIX = 'AW_OPENCODE_CONTROL ' as const
export const CONTROL_ACK_PREFIX = 'AW_OPENCODE_ACK ' as const
export const MAX_CONTROL_LINE_BYTES = 1024 as const
export const MAX_CONTROL_ACK_BYTES = 256 as const

const NonceSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/)

export const SessionReadyMarkerSchema = z
  .object({
    kind: z.enum(['new', 'resume']),
    sessionId: SessionIdSchema,
    projectId: z.string().min(1).max(256),
    version: z.literal(PINNED_OPENCODE_VERSION),
    nodeRunId: z.string().min(1).max(256),
    leaseNonceDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type SessionReadyMarker = z.infer<typeof SessionReadyMarkerSchema>

export const ControlAckSchema = z
  .object({
    decision: z.enum(['ok', 'nack']),
    nonce: NonceSchema,
  })
  .strict()

export type ControlAck = z.infer<typeof ControlAckSchema>

export class ControlProtocolError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`OpenCode control protocol error: ${reason}`)
    this.name = 'ControlProtocolError'
    this.reason = reason
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function buildSessionReadyMarker(value: SessionReadyMarker): string {
  const marker = parseDirectApiValue(SessionReadyMarkerSchema, value, 'control-marker')
  const encoded = Buffer.from(canonicalizeIdentity(marker), 'utf8').toString('base64url')
  const line = `${CONTROL_LINE_PREFIX}session-ready ${encoded}`
  if (byteLength(line) > MAX_CONTROL_LINE_BYTES) {
    throw new ControlProtocolError('marker-budget-exceeded')
  }
  return line
}

export type ParsedControlLine =
  | { kind: 'stderr'; line: string }
  | { kind: 'session-ready'; marker: SessionReadyMarker }

export function parseControlLine(line: string): ParsedControlLine {
  if (!line.startsWith(CONTROL_LINE_PREFIX)) return { kind: 'stderr', line }
  if (line.includes('\n') || line.includes('\r') || byteLength(line) > MAX_CONTROL_LINE_BYTES) {
    throw new ControlProtocolError('malformed-marker')
  }
  const framePrefix = `${CONTROL_LINE_PREFIX}session-ready `
  if (!line.startsWith(framePrefix)) throw new ControlProtocolError('unknown-marker')
  const payload = line.slice(framePrefix.length)
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new ControlProtocolError('malformed-marker')
  }
  let value: unknown
  try {
    const bytes = Buffer.from(payload, 'base64url')
    if (bytes.toString('base64url') !== payload) {
      throw new Error('noncanonical-base64url')
    }
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ControlProtocolError('malformed-marker')
  }
  let marker: SessionReadyMarker
  try {
    marker = parseDirectApiValue(SessionReadyMarkerSchema, value, 'control-marker')
  } catch {
    throw new ControlProtocolError('malformed-marker')
  }
  // Canonical bytes make duplicate JSON keys, whitespace, and alternative key
  // order invalid instead of giving the runner two wire spellings to support.
  if (buildSessionReadyMarker(marker) !== line) {
    throw new ControlProtocolError('noncanonical-marker')
  }
  return { kind: 'session-ready', marker }
}

export class ControlMarkerTracker {
  #marker: SessionReadyMarker | null = null

  get marker(): SessionReadyMarker | null {
    return this.#marker
  }

  accept(line: string): ParsedControlLine {
    const parsed = parseControlLine(line)
    if (parsed.kind === 'stderr') return parsed
    if (this.#marker !== null) throw new ControlProtocolError('duplicate-marker')
    this.#marker = parsed.marker
    return parsed
  }
}

export function buildControlAck(value: ControlAck): string {
  const ack = parseDirectApiValue(ControlAckSchema, value, 'control-ack')
  return `${CONTROL_ACK_PREFIX}${ack.decision} ${ack.nonce}\n`
}

export function parseControlAck(content: string, expectedNonce?: string): ControlAck {
  if (byteLength(content) > MAX_CONTROL_ACK_BYTES || !content.endsWith('\n')) {
    throw new ControlProtocolError('malformed-ack')
  }
  const match = /^AW_OPENCODE_ACK (ok|nack) ([A-Za-z0-9_-]{32,128})\n$/.exec(content)
  if (match === null) throw new ControlProtocolError('malformed-ack')
  let ack: ControlAck
  try {
    ack = parseDirectApiValue(
      ControlAckSchema,
      { decision: match[1], nonce: match[2] },
      'control-ack',
    )
  } catch {
    throw new ControlProtocolError('malformed-ack')
  }
  if (expectedNonce !== undefined) {
    let expected: string
    try {
      expected = parseDirectApiValue(NonceSchema, expectedNonce, 'control-nonce')
    } catch {
      throw new ControlProtocolError('invalid-expected-nonce')
    }
    // Length is fixed to a narrow range but may differ; compare padded buffers
    // so the caller does not accidentally fall back to a prefix comparison.
    const actualBytes = Buffer.from(ack.nonce)
    const expectedBytes = Buffer.from(expected)
    if (
      actualBytes.byteLength !== expectedBytes.byteLength ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      throw new ControlProtocolError('nonce-mismatch')
    }
  }
  return ack
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

/**
 * Creates the private acknowledgement exactly once. The caller owns directory
 * creation/cleanup; this primitive guarantees no overwrite and no symlink
 * traversal for the final path component.
 */
export function writeControlAckExclusive(path: string, ack: ControlAck): void {
  const content = buildControlAck(ack)
  let fd: number | undefined
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    )
    writeFileSync(fd, content, { encoding: 'utf8' })
    fsyncSync(fd)
    const stat = fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new ControlProtocolError('unsafe-ack-file')
    }
  } catch (error) {
    if (error instanceof ControlProtocolError) throw error
    throw new ControlProtocolError('exclusive-ack-write-failed')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function readControlAck(path: string, expectedNonce: string): ControlAck {
  let fd: number | undefined
  try {
    const before = lstatSync(path)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > MAX_CONTROL_ACK_BYTES
    ) {
      throw new ControlProtocolError('unsafe-ack-file')
    }
    fd = openSync(path, constants.O_RDONLY | noFollowFlag())
    const opened = fstatSync(fd)
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_CONTROL_ACK_BYTES
    ) {
      throw new ControlProtocolError('ack-file-changed')
    }
    const content = readFileSync(fd, { encoding: 'utf8' })
    if (byteLength(content) > MAX_CONTROL_ACK_BYTES) {
      throw new ControlProtocolError('ack-budget-exceeded')
    }
    return parseControlAck(content, expectedNonce)
  } catch (error) {
    if (error instanceof ControlProtocolError) throw error
    throw new ControlProtocolError('ack-read-failed')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
