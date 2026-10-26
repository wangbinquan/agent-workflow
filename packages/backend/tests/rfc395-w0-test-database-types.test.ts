// RFC-395 II-b W0: M-a implements; writer packages consume. Locks the complete baseline contract.
import { describe, expect, expectTypeOf, test } from 'bun:test'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/infrastructure/persistence/migrationMetaTables'
import type {
  CreateTestDb,
  CreateTestDbOptions,
  TestDatabase,
  TestDatabaseMetaTables,
} from './helpers/testDatabaseTypes'

describe('RFC-395 W0 test database types', () => {
  test('the baseline includes exactly the complete R2/V3 meta table set, including approvals', () => {
    const names: TestDatabaseMetaTables = [
      'schema_history',
      'first_write',
      'schema_transform_receipts',
      'generations',
      'migration_operations',
      'migration_runs',
      'migration_approvals',
      'migration_units',
      'migration_unit_sources',
      'migration_table_receipts',
      'migration_row_dispositions',
      'migration_history_restrictions',
      'migration_artifact_receipts',
      'migration_archives',
      'migration_records',
      'migration_identity_high_water',
      'migration_blocks',
      'migration_operator_inputs',
      'migration_receipt_exports',
      'activation_receipts',
      'switch_receipts',
    ]
    expect(EPOCH2_META_TABLES.map((table) => table.name)).toEqual([...names])
    expectTypeOf<TestDatabaseMetaTables['length']>().toEqualTypeOf<21>()
  })

  test('one async factory supports both providers and always returns a seeded target baseline', () => {
    expectTypeOf<CreateTestDbOptions['provider']>().toEqualTypeOf<'sqlite' | 'postgresql'>()
    expectTypeOf<Awaited<ReturnType<CreateTestDb>>>().toEqualTypeOf<TestDatabase>()
    expectTypeOf<TestDatabase['baseline']['schemaEpoch']>().toEqualTypeOf<2>()
    expectTypeOf<TestDatabase['baseline']['seeds']>().toEqualTypeOf<'install-only'>()
    expectTypeOf<TestDatabase['baseline']['binding']>().toEqualTypeOf<'epoch-2'>()
    expectTypeOf<
      Extract<CreateTestDbOptions, { provider: 'postgresql' }>['urlEnv']
    >().toEqualTypeOf<string>()
  })
})
