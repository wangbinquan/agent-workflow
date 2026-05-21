// RFC-054 W1-1 — grep / count guard for opencode recording fixtures.
//
// LOCKS: RFC-054 W1-1 — fixture 数量 + magic header schema 守门。若维护者意外
// 删除 fixture 或忘记加 magic header（如手动改 ndjson 文件），此处直接 CI 红，
// 与 `opencode-recording-parser.test.ts` 的协议层断言互为表里。

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

function listFixtures(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()
}

function readHeader(file: string): RecordingHeader {
  const text = readFileSync(join(FIXTURE_DIR, file), 'utf-8')
  const firstNl = text.indexOf('\n')
  const firstLine = firstNl > 0 ? text.slice(0, firstNl) : text
  const parsed = JSON.parse(firstLine) as { __recording__?: RecordingHeader }
  if (!parsed.__recording__) {
    throw new Error(`${file}: first line missing __recording__ key`)
  }
  return parsed.__recording__
}

describe('opencode recording fixtures coverage', () => {
  const fixtures = listFixtures()

  test('at least 2 recording fixtures live in the directory', () => {
    // DoD W1-1: 2 个 recording 文件入仓。若数量降到 1，重录 / 重新跑 scripts/
    // record-opencode.ts 加回来；勿删除以"清理重复"。
    expect(fixtures.length).toBeGreaterThanOrEqual(2)
  })

  test('at least one fixture has expectedEnvelope set + at least one has null', () => {
    const headers = fixtures.map(readHeader)
    const withEnv = headers.filter((h) => h.expectedEnvelope !== null)
    const noEnv = headers.filter((h) => h.expectedEnvelope === null)
    // Parser-guard test branches on header.expectedEnvelope: we must keep
    // both paths exercised so a future opencode change to envelope text
    // extraction is caught either way.
    expect(withEnv.length).toBeGreaterThanOrEqual(1)
    expect(noEnv.length).toBeGreaterThanOrEqual(1)
  })

  test.each(fixtures.map((f) => [f]))('%s: magic header schema is well-formed', (file) => {
    const h = readHeader(file)
    expect(typeof h.opencodeVersion).toBe('string')
    expect(h.opencodeVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(typeof h.capturedAt).toBe('string')
    expect(h.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(typeof h.recordingId).toBe('string')
    expect(h.recordingId.length).toBeGreaterThan(0)
    expect(typeof h.prompt).toBe('string')
    expect(typeof h.cwd).toBe('string')
    expect(typeof h.agent).toBe('string')
    expect(h.expectedEnvelope === null || typeof h.expectedEnvelope === 'string').toBe(true)
    if (typeof h.expectedEnvelope === 'string') {
      expect(h.expectedEnvelope).toMatch(/<workflow-output>/)
      expect(h.expectedEnvelope).toMatch(/<\/workflow-output>/)
    }
  })

  test.each(fixtures.map((f) => [f]))('%s: filename embeds opencodeVersion prefix', (file) => {
    const h = readHeader(file)
    // Convention: `<version>-<recordingId>.ndjson`. Catches accidental
    // mismatch between filename and header (which would confuse maintainers
    // re-running the recording script later).
    expect(file.startsWith(`${h.opencodeVersion}-`)).toBe(true)
    expect(file.endsWith(`-${h.recordingId}.ndjson`)).toBe(true)
  })
})
