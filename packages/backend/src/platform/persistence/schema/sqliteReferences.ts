// RFC-395 II-b: rebind SQL identifiers without changing quoted values or comments.
import { quoteSchemaIdentifier } from './expressions'

interface Token {
  readonly start: number
  readonly end: number
  readonly name?: string
  readonly text: string
}

export function rebindSqliteTableReferences(
  sql: string,
  table: string,
  replacement: string | null,
): string {
  const tokens: Token[] = []
  const pattern =
    /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|[\p{L}_][\p{L}\p{N}_$]*|\s+|./gu
  for (const match of sql.matchAll(pattern)) {
    const text = match[0]
    if (/^\s+$/.test(text) || text.startsWith('--') || text.startsWith('/*')) continue
    const name = text.startsWith('"')
      ? text.slice(1, -1).replaceAll('""', '"')
      : text.startsWith('`')
        ? text.slice(1, -1).replaceAll('``', '`')
        : text.startsWith('[')
          ? text.slice(1, -1)
          : /^[\p{L}_]/u.test(text)
            ? text
            : undefined
    tokens.push({ start: match.index, end: match.index + text.length, name, text })
  }
  const edits: { start: number; end: number; value: string }[] = []
  for (const [index, token] of tokens.entries()) {
    if (token.name?.toLowerCase() !== table.toLowerCase()) continue
    const next = tokens[index + 1]
    if (next?.text === '.' && tokens[index + 2]?.name !== undefined) {
      edits.push({
        start: token.start,
        end: replacement === null ? next.end : token.end,
        value: replacement === null ? '' : quoteSchemaIdentifier(replacement),
      })
    } else if (
      replacement !== null &&
      (tokens[index - 1]?.text.toUpperCase() === 'REFERENCES' ||
        (tokens[index - 1]?.text.toUpperCase() === 'TABLE' &&
          tokens[index - 2]?.text.toUpperCase() === 'CREATE'))
    ) {
      edits.push({ start: token.start, end: token.end, value: quoteSchemaIdentifier(replacement) })
    }
  }
  for (const edit of edits.reverse())
    sql = sql.slice(0, edit.start) + edit.value + sql.slice(edit.end)
  return sql
}
