export type Rfc349FunctionalEvidenceLane =
  | 'backend-main'
  | 'frontend-main'
  | 'e2e-main'
  | 'e2e-full'

export type Rfc349FunctionalEvidenceRequirementId =
  | 'provider-config-and-runtime'
  | 'dual-provider-behavior'
  | 'migration-api'
  | 'migration-cli'
  | 'settings-and-e2e'
  | 'fresh-target-and-upgrade'
  | 'backup'
  | 'restore'
  | 'doctor'
  | 'maintenance'
  | 'architecture-cutover'
  | 'schema-canonical-and-provenance'

export interface Rfc349FunctionalEvidenceOracle {
  readonly lane: Rfc349FunctionalEvidenceLane
  readonly testFile: string
  readonly testName: string
}

export interface Rfc349FunctionalEvidenceRequirement {
  readonly id: Rfc349FunctionalEvidenceRequirementId
  readonly oracles: readonly Rfc349FunctionalEvidenceOracle[]
}

/**
 * Closed RFC-349 T10-A evidence map. Each reference names an executable test,
 * not a prose-only claim. The owning contract test also proves that the file
 * is discovered by the corresponding sharded Main or full-E2E workflow.
 */
export const RFC349_T10_FUNCTIONAL_EVIDENCE = Object.freeze([
  {
    id: 'provider-config-and-runtime',
    oracles: [
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-config-provider-switch.test.ts',
        testName: 'SQLite -> PostgreSQL -> SQLite does not retain keys from the other variant',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-database-provider-runtime.test.ts',
        testName: 'a verified PostgreSQL generation builds one lazy external runtime',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-postgresql-runtime.test.ts',
        testName: 'shutdown is idempotent and every post-close capability fails closed',
      },
    ],
  },
  {
    id: 'dual-provider-behavior',
    oracles: [
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-dual-provider-behavior-oracle.test.ts',
        testName:
          'SQLite and PostgreSQL deep-equal CAS, lease/fence, idempotency, outbox, ordering and apply recovery',
      },
    ],
  },
  {
    id: 'migration-api',
    oracles: [
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-database-migration-operations.test.ts',
        testName: 'uses exact codecs, two critical permissions and one idempotency field',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-database-migration-operations.test.ts',
        testName: 'mounts artifact and bounded legacy reads as descriptor-backed HTTP routes',
      },
    ],
  },
  {
    id: 'migration-cli',
    oracles: [
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-database-cli.test.ts',
        testName: 'requires explicit --auto and projects every target constraint',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-database-cli.test.ts',
        testName: 'reports a live daemon before invoking a mutating command',
      },
    ],
  },
  {
    id: 'settings-and-e2e',
    oracles: [
      {
        lane: 'frontend-main',
        testFile: 'packages/frontend/tests/rfc349-database-settings.test.tsx',
        testName: 'duplicate Settings starts retain the shared canonical migration identity',
      },
      {
        lane: 'frontend-main',
        testFile: 'packages/frontend/tests/rfc349-database-settings.test.tsx',
        testName: 'all target constraints are modeled before submission and raw URLs are rejected',
      },
      {
        lane: 'e2e-main',
        testFile: 'e2e/rfc349-database-migration-settings.spec.ts',
        testName:
          'one click is idempotent, reload resumes, cutover closes rollback, and receipts remain downloadable',
      },
    ],
  },
  {
    id: 'fresh-target-and-upgrade',
    oracles: [
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-postgresql-migrator.test.ts',
        testName: 'atomically prepares an empty target and verifies the committed roster',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-postgresql-migrator.test.ts',
        testName: 'accepts only an exact already-applied baseline',
      },
      {
        lane: 'e2e-full',
        testFile: 'e2e/rfc319-ops-doctor-and-migrate.spec.ts',
        testName:
          'RFC-319 OPS-012: migrate 在发行二进制上真的把库建起来，应用条数与二进制自称嵌的条数逐一对上，且重跑不重复应用 @nightly',
      },
    ],
  },
  {
    id: 'backup',
    oracles: [
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-postgresql-provider-backup.test.ts',
        testName: 'packages live PostgreSQL rows and preserved legacy rows without db.sqlite',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-postgresql-admin-backup.test.ts',
        testName: 'prepares application assets then requests one provider backup',
      },
      {
        lane: 'e2e-main',
        testFile: 'e2e/ops-local-recovery.spec.ts',
        testName:
          'RFC-319 OPS-020 & CFG-31: a backup taken now can be armed and applied on the next boot, and an armed restore can be called off before it fires',
      },
    ],
  },
  {
    id: 'restore',
    oracles: [
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-logical-database-restore.test.ts',
        testName:
          'verifies both artifact areas and restores only active tables under a new operation',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-postgresql-admin-restore.test.ts',
        testName:
          'rejects a live non-empty target with stable operator guidance and stages nothing',
      },
      {
        lane: 'e2e-full',
        testFile: 'e2e/rfc319-ops-backup-restore-cli.spec.ts',
        testName:
          'RFC-319 OPS-019: restore --yes 冷恢复把库换回备份时点，并按 --no-safety-backup 决定留不留反悔的余地 @nightly',
      },
    ],
  },
  {
    id: 'doctor',
    oracles: [
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-database-operational-adapter.test.ts',
        testName: 'PostgreSQL owns contract/catalog/autovacuum probes without SQLite SQL',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-provider-doctor.test.ts',
        testName: 'lifecycle health projects PostgreSQL counts through the existing wording',
      },
      {
        lane: 'e2e-full',
        testFile: 'e2e/rfc319-ops-doctor-and-migrate.spec.ts',
        testName:
          'RFC-319 OPS-010: doctor 在编译二进制上跑完整套诊断——十一项逐条给结论、全绿退出 0，且不启动 daemon、不写回数据库 @nightly',
      },
    ],
  },
  {
    id: 'maintenance',
    oracles: [
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-system-maintenance-provider.test.ts',
        testName: 'retention deletes one bounded PostgreSQL slice behind the generation fence',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-maintenance-disk-provider.test.ts',
        testName: 'PostgreSQL reports catalog storage and never emits SQLite mechanisms',
      },
      {
        lane: 'frontend-main',
        testFile: 'packages/frontend/tests/rfc338-maintenance-settings.test.tsx',
        testName:
          'keyboard-selects daily, shows both field rules/errors, and saves the exact schedule',
      },
      {
        lane: 'e2e-main',
        testFile: 'e2e/rfc338-maintenance-settings.spec.ts',
        testName: 'compiled Worker is ready and daily scheduling remains usable at 390px',
      },
    ],
  },
  {
    id: 'architecture-cutover',
    oracles: [
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/architecture/rfc349-provider-cutover.test.ts',
        testName:
          'business, application, public and transport surfaces own ports instead of DB mechanisms',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/architecture/rfc349-provider-cutover.test.ts',
        testName:
          'daemon bootstrap selects the verified provider and mounts live migration admission',
      },
    ],
  },
  {
    id: 'schema-canonical-and-provenance',
    oracles: [
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/architecture/rfc349-schema-contract.test.ts',
        testName: 'every source table has one owner, stable key, codec and provider mapping',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-postgresql-schema.test.ts',
        testName: 'projects the exact 178-table active parity set',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/rfc349-postgresql-logical-target-finalization.test.ts',
        testName: 'checks cutover readiness on the advisory-lock session',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/architecture/rfc294-canonical-manifests.test.ts',
        testName: 'the seven canonical manifests and report are exact generated projections',
      },
      {
        lane: 'backend-main',
        testFile: 'packages/backend/tests/architecture/rfc294-canonical-manifests.test.ts',
        testName:
          'mutation: payload tampering changes the digest even when provenance metadata is untouched',
      },
    ],
  },
] as const satisfies readonly Rfc349FunctionalEvidenceRequirement[])

export const RFC349_T10_FUNCTIONAL_BACKEND_TEST_FILES = Object.freeze(
  Array.from(
    new Set(
      RFC349_T10_FUNCTIONAL_EVIDENCE.flatMap((requirement) =>
        requirement.oracles
          .filter((oracle) => oracle.lane === 'backend-main')
          .map((oracle) => oracle.testFile),
      ),
    ),
  ).sort(),
)

export const RFC349_T10_FUNCTIONAL_FRONTEND_TEST_FILES = Object.freeze(
  Array.from(
    new Set(
      RFC349_T10_FUNCTIONAL_EVIDENCE.flatMap((requirement) =>
        requirement.oracles
          .filter((oracle) => oracle.lane === 'frontend-main')
          .map((oracle) => oracle.testFile),
      ),
    ),
  ).sort(),
)

export const RFC349_T10_FUNCTIONAL_E2E_TEST_FILES = Object.freeze(
  Array.from(
    new Set(
      RFC349_T10_FUNCTIONAL_EVIDENCE.flatMap((requirement) =>
        requirement.oracles
          .filter((oracle) => oracle.lane === 'e2e-main' || oracle.lane === 'e2e-full')
          .map((oracle) => oracle.testFile),
      ),
    ),
  ).sort(),
)
