// Slow SQL must remain visible and also reach the bounded daemon log for diagnosis.
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { instrumentSlowStatements } from '@/db/client'
import { configureLogger, resetLoggerForTest, setLoggerStdoutWriterForTest } from '@/util/log'

test('the default slow SQL sink preserves CPU, SQL and stdout while persisting to the daemon log', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aw-slow-query-log-')),
    path = join(directory, 'daemon.log'),
    lines: string[] = []
  let value = 0
  const query = () => ({
    get() {
      for (let n = 0; n < 10000; n++) value += n
      return value
    },
  })
  const connection = { query, prepare: query, exec() {} }
  try {
    configureLogger({ logFile: path })
    setLoggerStdoutWriterForTest((line) => lines.push(line))
    instrumentSlowStatements(
      connection as unknown as Parameters<typeof instrumentSlowStatements>[0],
      0.0000001,
    )
    connection.query().get()
    // The SQL template is the first argument passed to the wrapped native API.
    const statement = (connection.query as (sql?: string) => { get(): number })(
      'SELECT diagnostic_only',
    )
    statement.get()
    const output = readFileSync(path, 'utf8')
    expect(output).toContain('[db-slow]')
    expect(output).toContain('(cpu ')
    expect(output).toContain('SELECT diagnostic_only')
    expect(lines.join('')).toBe(output)
  } finally {
    resetLoggerForTest()
    rmSync(directory, { recursive: true, force: true })
  }
})
