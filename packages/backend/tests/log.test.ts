import { rimrafDir } from './helpers/cleanup'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureLogger, createLogger, resetLoggerForTest } from '../src/util/log'

describe('logger', () => {
  let tmp: string
  let logFile: string
  let originalWrite: typeof process.stdout.write
  let captured: string

  beforeEach(() => {
    resetLoggerForTest()
    tmp = mkdtempSync(join(tmpdir(), 'aw-log-'))
    logFile = join(tmp, 'daemon.log')
    captured = ''
    originalWrite = process.stdout.write.bind(process.stdout)
    // Intercept stdout to assert on output without polluting test runner.
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    process.stdout.write = originalWrite
    rimrafDir(tmp)
    resetLoggerForTest()
  })

  test('emits human-readable line by default', () => {
    configureLogger({ level: 'info', logFile })
    const log = createLogger('demo')
    log.info('hello world', { taskId: 'T1', n: 3 })
    expect(captured).toContain('[demo] hello world')
    expect(captured).toContain('taskId=T1')
    expect(captured).toContain('n=3')
    expect(captured).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] INFO/)
  })

  test('level filter suppresses debug below info', () => {
    configureLogger({ level: 'info', logFile })
    const log = createLogger('demo')
    log.debug('hidden')
    log.info('shown')
    expect(captured).not.toContain('hidden')
    expect(captured).toContain('shown')
  })

  test('debug level reveals debug lines', () => {
    configureLogger({ level: 'debug', logFile })
    const log = createLogger('demo')
    log.debug('visible')
    expect(captured).toContain('visible')
  })

  test('JSON mode emits parseable JSON lines', () => {
    configureLogger({ level: 'info', logFile, jsonMode: true })
    const log = createLogger('demo')
    log.warn('something', { foo: 'bar' })
    const lines = captured.trim().split('\n')
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.level).toBe('warn')
    expect(parsed.service).toBe('demo')
    expect(parsed.message).toBe('something')
    expect(parsed.foo).toBe('bar')
    expect(typeof parsed.ts).toBe('string')
  })

  test('child logger appends service segment', () => {
    configureLogger({ level: 'info', logFile })
    const log = createLogger('root').child('sub')
    log.info('hello')
    expect(captured).toContain('[root.sub]')
  })

  test('writes to log file in addition to stdout', () => {
    configureLogger({ level: 'info', logFile })
    const log = createLogger('demo')
    log.info('to disk')
    expect(existsSync(logFile)).toBe(true)
    const onDisk = readFileSync(logFile, 'utf-8')
    expect(onDisk).toContain('to disk')
  })

  test('field formatting: quotes values containing spaces or quotes', () => {
    configureLogger({ level: 'info', logFile })
    const log = createLogger('demo')
    log.info('msg', { plain: 'hello', spaced: 'two words', quoted: 'has "quote"' })
    expect(captured).toContain('plain=hello')
    expect(captured).toMatch(/spaced="two words"/)
    expect(captured).toContain('quoted="has \\"quote\\""')
  })
})
