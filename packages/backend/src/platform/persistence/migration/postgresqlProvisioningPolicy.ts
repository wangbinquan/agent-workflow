// RFC-398 design §1 / §3: database naming and DDL belong to the provider adapter.
import { sha256Hex } from '@/util/hash'
export type PostgresqlAllocationKind = 'target' | 'scratch'
export interface PostgresqlDatabaseProperties {
  readonly major: number
  readonly encoding: string
  readonly provider: 'libc' | 'icu' | 'builtin'
  readonly collate: string
  readonly ctype: string
  readonly locale: string | null
  readonly icuRules: string | null
}

export function autoUpgradeDatabaseName(
  source: string,
  kind: PostgresqlAllocationKind,
  n: number,
  first: boolean,
): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('postgresql-allocation-number-invalid')
  const suffix = `_epoch2${kind === 'scratch' ? '_scratch' : ''}${first ? '' : `_${n}`}`
  let base = source
  if (Buffer.byteLength(base + suffix) > 63) {
    const hash = `_${sha256Hex(source).slice(0, 8)}`
    const points = Array.from(source)
    while (Buffer.byteLength(points.join('') + hash + suffix) > 63) points.pop()
    base = points.join('') + hash
  }
  return base + suffix
}

export const quotePostgresqlDatabaseIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`
const literal = (value: string): string =>
  `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`

export function createPostgresqlDatabaseStatement(input: {
  readonly database: string
  readonly source: PostgresqlDatabaseProperties
  readonly owner: string
}): string {
  const p = input.source
  if (![15, 16, 17, 18].includes(p.major)) throw new Error('postgresql-target-major-unsupported')
  if (p.encoding !== 'UTF8') throw new Error('postgresql-target-encoding')
  if (p.provider === 'builtin' && p.major < 17)
    throw new Error('postgresql-locale-provider-unsupported')
  const parts = [
    `CREATE DATABASE ${quotePostgresqlDatabaseIdentifier(input.database)}`,
    'TEMPLATE template0',
    "ENCODING 'UTF8'",
    `LOCALE_PROVIDER ${p.provider}`,
    `LC_COLLATE ${literal(p.collate)}`,
    `LC_CTYPE ${literal(p.ctype)}`,
  ]
  if (p.provider !== 'libc') {
    if (!p.locale) throw new Error('postgresql-locale-missing')
    parts.push(`${p.provider === 'icu' ? 'ICU_LOCALE' : 'BUILTIN_LOCALE'} ${literal(p.locale)}`)
  }
  if (p.provider === 'icu' && p.major >= 16 && p.icuRules !== null)
    parts.push(`ICU_RULES ${literal(p.icuRules)}`)
  parts.push(`OWNER ${quotePostgresqlDatabaseIdentifier(input.owner)}`)
  return `${parts.join(' ')};`
}

export function samePostgresqlDatabaseProperties(
  source: PostgresqlDatabaseProperties,
  target: PostgresqlDatabaseProperties,
): boolean {
  return (Object.keys(source) as (keyof PostgresqlDatabaseProperties)[]).every(
    (key) => source[key] === target[key],
  )
}
