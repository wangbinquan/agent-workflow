import { canonicalSchemaJson } from '../../schema/canonical'
import { CanonicalLogicalValueSchema } from '../legacy/logicalDatabaseArtifact'
import type { CanonicalLogicalValue } from '../legacy/logicalDatabaseArtifact'
import type { EncodedKey, MigrationKey, TargetValue } from './types'
import { ConversionContractError } from './blockCodes'

export function encodeMigrationKey(table: string, key: MigrationKey): EncodedKey {
  if (!table || !key.length)
    throw new ConversionContractError('v2-invalid-key', 'table and key are required')
  for (const cell of key) CanonicalLogicalValueSchema.parse(cell)
  return `mk1:${canonicalSchemaJson([table, key])}`
}
export function decodeMigrationKey(encoded: EncodedKey | string): {
  table: string
  key: MigrationKey
} {
  if (!encoded.startsWith('mk1:'))
    throw new ConversionContractError('v2-invalid-key', 'unknown key version')
  const parsed: unknown = JSON.parse(encoded.slice(4))
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    !Array.isArray(parsed[1])
  )
    throw new ConversionContractError('v2-invalid-key', 'expected [table, key]')
  const key = parsed[1].map((cell) => CanonicalLogicalValueSchema.parse(cell))
  if (encodeMigrationKey(parsed[0], key) !== encoded)
    throw new ConversionContractError('v2-invalid-key', 'noncanonical key')
  return { table: parsed[0], key }
}
export function canonicalValue(value: TargetValue): CanonicalLogicalValue {
  if (value === null) return { type: 'null' }
  if (typeof value === 'string') return { type: 'text', value }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'bigint') return { type: 'integer', value: String(value) }
  if (value instanceof Uint8Array)
    return { type: 'bytes', value: Buffer.from(value).toString('base64') }
  if (!Number.isFinite(value))
    throw new ConversionContractError('v2-invalid-value', 'non-finite number')
  if (Object.is(value, -0)) return { type: 'real', value: '-0' }
  return Number.isSafeInteger(value)
    ? { type: 'integer', value: String(value) }
    : { type: 'real', value: String(value) }
}
