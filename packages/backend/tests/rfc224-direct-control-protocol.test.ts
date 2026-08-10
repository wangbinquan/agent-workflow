// RFC-224 regression lock: session ownership is handed to the runner before
// the launcher may connect SSE/POST, over a strict private control protocol.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  ControlMarkerTracker,
  ControlProtocolError,
  buildControlAck,
  buildMcpReadinessMarker,
  buildSessionReadyMarker,
  parseControlAck,
  parseControlLine,
  readControlAck,
  writeControlAckExclusive,
} from '@/services/runtime/opencode/controlProtocol'
import { lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertWindowsFilePrivate, sealDirectoryOwnerOnly } from '@/util/win32Acl'

const nonce = 'A'.repeat(43)
const sessionID = 'ses_000000001001AAAAAAAAAAAAAA'
const leaseNonceDigest = 'a'.repeat(64)
const binaryDigest = 'b'.repeat(64)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-224 session-ready stderr control marker', () => {
  test('round-trips one canonical bounded MCP readiness frame before session-ready', () => {
    const marker = {
      kind: 'mcp-readiness' as const,
      unavailableLocal: [{ name: 'sdk-server', status: 'failed' as const }],
      unavailableRemote: [{ name: 'docs', status: 'missing' as const }],
    }
    const line = buildMcpReadinessMarker(marker)
    expect(parseControlLine(line)).toEqual({ kind: 'mcp-readiness', marker })
    const tracker = new ControlMarkerTracker()
    expect(tracker.accept(line)).toEqual({ kind: 'mcp-readiness', marker })
    expect(() => tracker.accept(line)).toThrow('duplicate-marker')
  })

  test('has one canonical byte representation and passes ordinary stderr through', () => {
    const marker = {
      kind: 'new' as const,
      sessionId: sessionID,
      projectId: 'project-1',
      reportedVersion: '1.18.3',
      binaryDigest,
      protocolCodec: 'opencode-direct-v1' as const,
      nodeRunId: 'run-1',
      leaseNonceDigest,
    }
    const line = buildSessionReadyMarker(marker)
    expect(line).toMatch(/^AW_OPENCODE_CONTROL session-ready [A-Za-z0-9_-]+$/)
    expect(line).not.toContain(nonce)
    expect(parseControlLine(line)).toEqual({ kind: 'session-ready', marker })
    expect(parseControlLine('ordinary diagnostic')).toEqual({
      kind: 'stderr',
      line: 'ordinary diagnostic',
    })
  })

  test('rejects unknown, malformed, noncanonical, and duplicate markers', () => {
    expect(() => parseControlLine('AW_OPENCODE_CONTROL future {}')).toThrow('unknown-marker')
    expect(() => parseControlLine('AW_OPENCODE_CONTROL session-ready !!!')).toThrow(
      'malformed-marker',
    )
    const marker = {
      kind: 'new' as const,
      sessionId: sessionID,
      projectId: 'project-1',
      reportedVersion: 'custom-fork',
      binaryDigest,
      protocolCodec: 'opencode-direct-v1',
      nodeRunId: 'run-1',
      leaseNonceDigest,
    } as const
    const canonical = buildSessionReadyMarker(marker)
    const noncanonicalPayload = Buffer.from(JSON.stringify(marker), 'utf8').toString('base64url')
    expect(() =>
      parseControlLine(`AW_OPENCODE_CONTROL session-ready ${noncanonicalPayload}`),
    ).toThrow('noncanonical-marker')
    const tracker = new ControlMarkerTracker()
    tracker.accept(canonical)
    expect(() => tracker.accept(canonical)).toThrow('duplicate-marker')
  })
})

describe('RFC-224 nonce-bound exclusive acknowledgement', () => {
  test('round-trips exact ok/nack frames and rejects a wrong nonce', () => {
    expect(buildControlAck({ decision: 'ok', nonce })).toBe(`AW_OPENCODE_ACK ok ${nonce}\n`)
    expect(parseControlAck(`AW_OPENCODE_ACK nack ${nonce}\n`, nonce)).toEqual({
      decision: 'nack',
      nonce,
    })
    const wrong = 'B'.repeat(43)
    expect(() => parseControlAck(`AW_OPENCODE_ACK ok ${wrong}\n`, nonce)).toThrow('nonce-mismatch')
  })

  test('creates a 0600 regular file exactly once and reads it without following symlinks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc224-control-'))
    roots.push(root)
    // RFC-254 T40b: in production the ACK is written into a store dir the launcher
    // already sealed; mirror that here so the write's win32 privacy proof has a
    // clean DACL to inherit (a raw %TEMP% may grant Users/AuthUsers). No-op POSIX.
    if (process.platform === 'win32') {
      expect((await sealDirectoryOwnerOnly(root)).trusted).toBe(true)
    }
    const ackPath = join(root, 'ack')
    writeControlAckExclusive(ackPath, { decision: 'ok', nonce })
    // POSIX proves privacy from the mode; win32 from the DACL (mode is synthesized).
    if (process.platform === 'win32') {
      expect(await assertWindowsFilePrivate(ackPath)).toEqual({ trusted: true })
    } else {
      expect(lstatSync(ackPath).mode & 0o777).toBe(0o600)
    }
    expect(readControlAck(ackPath, nonce)).toEqual({ decision: 'ok', nonce })
    expect(() => writeControlAckExclusive(ackPath, { decision: 'nack', nonce })).toThrow(
      'exclusive-ack-write-failed',
    )

    const link = join(root, 'ack-link')
    symlinkSync(ackPath, link)
    expect(() => readControlAck(link, nonce)).toThrow('unsafe-ack-file')
  })

  test('never exposes the expected nonce in protocol errors', () => {
    let error: unknown
    try {
      parseControlAck(`AW_OPENCODE_ACK ok ${'B'.repeat(43)}\n`, nonce)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ControlProtocolError)
    expect(String(error)).not.toContain(nonce)
  })
})
