// RFC-364: preserve observable budget and result precedence while moving the owners.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  ensureMessage,
  resultTurnStatus,
  resultFailureCode,
  canResumeNativeSession,
  MCP_RUNTIME_TEST_IDLE_MS,
  MCP_RUNTIME_TEST_TURN_TIMEOUT_MS,
  MCP_RUNTIME_TEST_RECEIPT_MS,
  MCP_RUNTIME_TEST_MAX_TURNS,
  MCP_RUNTIME_TEST_MESSAGE_BYTES,
  MCP_RUNTIME_TEST_EVENT_ROWS,
  MCP_RUNTIME_TEST_EVENT_BYTES,
  MCP_RUNTIME_TEST_SINGLE_EVENT_BYTES,
  DEFAULT_CAPACITY,
} from '@/modules/resource-catalog/domain/mcps/runtimeDiagnostics'

describe('RFC-364 MCP diagnostics policy', () => {
  test('UTF-8 message boundary and whitespace rejection preserve the existing wire budget', () => {
    expect(() => ensureMessage('x'.repeat(65536))).not.toThrow()
    expect(() => ensureMessage('😀'.repeat(16384))).not.toThrow()
    expect(() => ensureMessage('😀'.repeat(16384) + 'x')).toThrow(
      'message must not exceed 65536 UTF-8 bytes',
    )
    expect(() => ensureMessage(' \n\t ')).toThrow('message must not be empty')
    expect([
      MCP_RUNTIME_TEST_IDLE_MS,
      MCP_RUNTIME_TEST_TURN_TIMEOUT_MS,
      MCP_RUNTIME_TEST_RECEIPT_MS,
      MCP_RUNTIME_TEST_MAX_TURNS,
      MCP_RUNTIME_TEST_MESSAGE_BYTES,
      MCP_RUNTIME_TEST_EVENT_ROWS,
      MCP_RUNTIME_TEST_EVENT_BYTES,
      MCP_RUNTIME_TEST_SINGLE_EVENT_BYTES,
      DEFAULT_CAPACITY,
    ]).toEqual([600000, 600000, 86400000, 32, 65536, 20000, 16777216, 1048576, 2])
  })
  test('durable timeout/shutdown and cancellation still outrank a successful child result', () => {
    expect(resultTurnStatus({ status: 'ok' }, true, false, 'mcp-test-turn-timeout')).toBe(
      'timed_out',
    )
    expect(resultTurnStatus({ status: 'ok' }, true, false, 'mcp-test-daemon-shutdown')).toBe(
      'interrupted',
    )
    expect(resultTurnStatus({ status: 'ok' }, true, false, null)).toBe('canceled')
    expect(resultTurnStatus({ status: 'ok' }, true, true, null)).toBe('interrupted')
    expect(
      resultFailureCode(
        { status: 'ok', nativeSessionIntegrityFailed: true },
        'mcp-test-turn-timeout',
      ),
    ).toBe('mcp-test-turn-timeout')
    expect(resultFailureCode({ status: 'ok', nativeSessionIntegrityFailed: true }, null)).toBe(
      'mcp-test-session-conflict',
    )
    expect(
      canResumeNativeSession({
        nativeSessionState: 'ready',
        runtimeSessionId: 'native',
        continuationBlockedReason: null,
      }),
    ).toBe(true)
    expect(
      canResumeNativeSession({
        nativeSessionState: 'ready',
        runtimeSessionId: 'native',
        continuationBlockedReason: 'capture-incomplete',
      }),
    ).toBe(false)
  })
  test('application does not own process, filesystem, runtime configuration or a second writer', () => {
    const source = readFileSync(
      resolve(
        import.meta.dir,
        '../src/modules/resource-catalog/application/mcps/runtimeDiagnostics.ts',
      ),
      'utf8',
    )
    const code = ts
      .createPrinter({ removeComments: true })
      .printFile(ts.createSourceFile('application.ts', source, ts.ScriptTarget.Latest, true))
    expect(code).not.toMatch(/from ['"](?:node:(?:fs|path|child_process)|@\/config|@\/db\/)/)
    expect(code).not.toMatch(/\b(?:Bun|appHome|configPath|runSystemAgent|SERVICE_INSTANCES)\b/)
    expect(source).toContain('this.deps.persistence.recordSpawn(')
    expect(source).toContain('this.deps.persistence.settleTurn(')
    expect(source.indexOf("await sink.markTerminal('complete')")).toBeLessThan(
      source.indexOf('await result.verifyAfterCapture('),
    )
  })
})
