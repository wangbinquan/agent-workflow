// RFC-054 W1-1 — parser-guard test for real opencode --format json recordings.
//
// LOCKS: RFC-054 W1-1 — opencode 协议解析器 (extractTextFromEvent /
// inferEventKind / accumulateTokens / extractLastEnvelope / parseEnvelope)
// 喂真 opencode 录制 ndjson 后行为契约。若 opencode 升级改了 stdout 事件 shape，
// 录制 fixture 重录时 (`bun run record:opencode`) 任何一条断言失败即提示协议
// 漂移——开发者必须或更新 fixture（[recording-refresh] commit）或修解析器。
//
// 录制 fixture 落在 packages/backend/tests/fixtures/opencode-recordings/
// 文件名 `<opencodeVersion>-<recordingId>.ndjson`。首行是 magic header
// `{"__recording__":{...}}`，后续行是 opencode stdout 原始 JSON 事件。
//
// 维护：`bun run record:opencode -- --prompt "..." --out "..." --id "..."`
// 详见 scripts/record-opencode.ts。

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { accumulateTokens, extractTextFromEvent, inferEventKind } from '../src/services/runner'
import { extractLastEnvelope, parseEnvelope } from '../src/services/envelope'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures', 'opencode-recordings')

interface RecordingHeader {
  opencodeVersion: string
  capturedAt: string
  recordingId: string
  prompt: string
  expectedEnvelope: string | null
  cwd: string
  agent: string
}

interface TokenUsage {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  total: number
}

interface ReplayResult {
  sessionIds: Set<string>
  capturedSessionId: string | null
  tokenUsage: TokenUsage
  eventKinds: string[]
  agentText: string[]
  rawEventCount: number
}

function loadRecording(file: string): { header: RecordingHeader; eventLines: string[] } {
  const text = readFileSync(join(FIXTURE_DIR, file), 'utf-8')
  const lines = text.split('\n').filter((l) => l.length > 0)
  if (lines.length < 2) {
    throw new Error(`${file}: recording must have a magic header + at least one event line`)
  }
  const firstLine = lines[0]!
  const headerRaw = JSON.parse(firstLine) as { __recording__?: RecordingHeader }
  if (!headerRaw.__recording__) {
    throw new Error(`${file}: first line is not a magic recording header`)
  }
  return { header: headerRaw.__recording__, eventLines: lines.slice(1) }
}

/** Replay opencode stdout events through the runner.ts protocol parsers. */
function replay(eventLines: string[]): ReplayResult {
  const sessionIds = new Set<string>()
  let capturedSessionId: string | null = null
  const tokenUsage: TokenUsage = {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    total: 0,
  }
  const eventKinds: string[] = []
  const agentText: string[] = []
  let rawEventCount = 0
  for (const line of eventLines) {
    rawEventCount++
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(line) as Record<string, unknown>
    } catch {
      throw new Error(`event line is not valid JSON: ${line.slice(0, 200)}`)
    }
    if (typeof evt.sessionID === 'string') {
      sessionIds.add(evt.sessionID)
      if (capturedSessionId === null) capturedSessionId = evt.sessionID
    }
    accumulateTokens(evt, tokenUsage)
    const text = extractTextFromEvent(evt)
    if (text !== null) agentText.push(text)
    eventKinds.push(inferEventKind(evt))
  }
  return { sessionIds, capturedSessionId, tokenUsage, eventKinds, agentText, rawEventCount }
}

function listFixtures(): string[] {
  let entries: string[]
  try {
    entries = readdirSync(FIXTURE_DIR)
  } catch (err) {
    throw new Error(
      `${FIXTURE_DIR} not readable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return entries.filter((f) => f.endsWith('.ndjson')).sort()
}

const fixtures = listFixtures()
if (fixtures.length === 0) {
  throw new Error(`no .ndjson recordings under ${FIXTURE_DIR}`)
}

for (const file of fixtures) {
  describe(`opencode recording: ${file}`, () => {
    const { header, eventLines } = loadRecording(file)
    const result = replay(eventLines)

    test('magic header has required fields', () => {
      expect(typeof header.opencodeVersion).toBe('string')
      expect(header.opencodeVersion).toMatch(/^\d+\.\d+\.\d+/)
      expect(typeof header.capturedAt).toBe('string')
      expect(header.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(typeof header.recordingId).toBe('string')
      expect(header.recordingId.length).toBeGreaterThan(0)
      expect(typeof header.prompt).toBe('string')
      // expectedEnvelope must be either a non-empty string or null
      if (header.expectedEnvelope !== null) {
        expect(typeof header.expectedEnvelope).toBe('string')
        expect(header.expectedEnvelope.length).toBeGreaterThan(0)
      }
    })

    test('recording is non-empty (event count > 0)', () => {
      expect(result.rawEventCount).toBeGreaterThan(0)
    })

    test('extracts a single non-empty sessionID consistent across all events', () => {
      expect(result.sessionIds.size).toBe(1)
      expect(result.capturedSessionId).not.toBeNull()
      expect(result.capturedSessionId!.length).toBeGreaterThan(0)
      // RFC-053 RFC-026 contract: sessionID prefix `ses_` survives across
      // both 1.14.x and 1.15.x; if opencode renames the prefix this breaks
      // upstream session-resume + session-view code paths first.
      expect(result.capturedSessionId).toMatch(/^ses_/)
    })

    test('contains step_start and step_finish events', () => {
      expect(result.eventKinds).toContain('step_start')
      expect(result.eventKinds).toContain('step_finish')
    })

    test('inferEventKind maps every event to a known kind (no unknown enum)', () => {
      const allowed = new Set([
        'tool_use',
        'text',
        'reasoning',
        'permission_asked',
        'error',
        'step_start',
        'step_finish',
      ])
      for (const k of result.eventKinds) {
        expect(allowed.has(k)).toBe(true)
      }
    })

    test('accumulates non-zero tokens (step_finish must carry usage)', () => {
      // Real opencode always emits non-zero `tokens.input` on step_finish; if
      // a future opencode drops or renames the field, this immediately
      // catches the protocol drift and our PerNodeMaxTotalTokens limits would
      // silently stop being enforced.
      expect(result.tokenUsage.input).toBeGreaterThan(0)
      expect(result.tokenUsage.total).toBeGreaterThan(0)
      // total must equal sum of components (the assertion in accumulateTokens)
      const sum =
        result.tokenUsage.input +
        result.tokenUsage.output +
        result.tokenUsage.cacheCreate +
        result.tokenUsage.cacheRead
      expect(result.tokenUsage.total).toBe(sum)
    })

    if (header.expectedEnvelope !== null) {
      test('extractLastEnvelope returns exactly the header.expectedEnvelope', () => {
        const combined = result.agentText.join('')
        const envelope = extractLastEnvelope(combined)
        expect(envelope).not.toBeNull()
        expect(envelope).toBe(header.expectedEnvelope)
      })

      test('parseEnvelope succeeds and binds declared outputs', () => {
        const combined = result.agentText.join('')
        const envelope = extractLastEnvelope(combined)!
        // The recording was driven with a workflow-output envelope whose only
        // port is `answer`; the parser needs to bind that port without
        // missing-port errors.
        const parsed = parseEnvelope(envelope, ['answer'])
        expect(parsed.missingDeclared).toEqual([])
        expect(parsed.undeclared).toEqual([])
        const answer = parsed.ports.get('answer')
        expect(answer).toBeDefined()
        expect(answer!.length).toBeGreaterThan(0)
      })
    } else {
      test('extractLastEnvelope returns null (no envelope in this recording)', () => {
        const combined = result.agentText.join('')
        const envelope = extractLastEnvelope(combined)
        expect(envelope).toBeNull()
      })
    }
  })
}
