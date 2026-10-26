// Bun's batch exec can continue after a constraint failure. Execute one statement
// at a time so the fixture caller sees the first error and owns rollback/close.
// This module stays Node-loadable; only the child executor imports bun:sqlite.
export function sqliteFixtureStatements(source: string): string[] {
  const statements: string[] = []
  let start = 0
  let quote = ''
  let comment: 'line' | 'block' | null = null
  let prefix: string[] = []
  let trigger = false
  let depth = 0
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!,
      next = source[i + 1]
    if (comment === 'line') {
      if (ch === '\n') comment = null
      continue
    }
    if (comment === 'block') {
      if (ch === '*' && next === '/') {
        comment = null
        i++
      }
      continue
    }
    if (quote) {
      if (ch === quote) {
        if (next === quote && quote !== ']') i++
        else quote = ''
      }
      continue
    }
    if (ch === '-' && next === '-') {
      comment = 'line'
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      comment = 'block'
      i++
      continue
    }
    if (["'", '"', '`', '['].includes(ch)) {
      quote = ch === '[' ? ']' : ch
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1
      while (end < source.length && /[A-Za-z_0-9]/.test(source[end]!)) end++
      const word = source.slice(i, end).toUpperCase()
      if (prefix.length < 3) prefix.push(word)
      trigger ||=
        prefix[0] === 'CREATE' &&
        (prefix[1] === 'TRIGGER' ||
          (['TEMP', 'TEMPORARY'].includes(prefix[1] ?? '') && prefix[2] === 'TRIGGER'))
      if (trigger) {
        if (word === 'BEGIN' || word === 'CASE') depth++
        if (word === 'END') depth--
      }
      i = end - 1
      continue
    }
    if (ch === ';' && (!trigger || depth === 0)) {
      const statement = source.slice(start, i + 1).trim()
      if (prefix.length) statements.push(statement)
      start = i + 1
      prefix = []
      trigger = false
    }
  }
  if (quote || comment === 'block' || depth !== 0)
    throw new Error('incomplete SQLite fixture statement')
  const tail = source.slice(start).trim()
  if (prefix.length) statements.push(tail)
  return statements
}

export function executeSqliteFixtureSql(db: { exec(sql: string): unknown }, source: string): void {
  for (const statement of sqliteFixtureStatements(source)) db.exec(statement)
}
