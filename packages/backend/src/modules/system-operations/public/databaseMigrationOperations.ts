// RFC-349 — one descriptor set shared by Settings and HTTP. CLI calls the same
// application commands directly with a local authority context.

import { z } from 'zod'
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import { operationId } from '@/platform/operations/catalog'
import { zodOperationCodec } from '@/platform/operations/codecs'
import type {
  CommandOperationDescriptor,
  IdempotentCommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import type { DatabaseMigrationCommands } from './databaseMigrationCommands'
import type { DatabaseMigrationQueries } from './databaseMigrationQueries'
import {
  databaseMigrationListViewSchema,
  databaseMigrationOperationInputSchema,
  databaseMigrationPreflightInputSchema,
  databaseMigrationPreflightViewSchema,
  databaseMigrationStatusViewSchema,
  databaseRuntimeOverviewSchema,
  startDatabaseMigrationInputSchema,
  type DatabaseMigrationListView,
  type DatabaseMigrationOperationInput,
  type DatabaseMigrationPreflightInput,
  type DatabaseMigrationPreflightView,
  type DatabaseMigrationStatusView,
  type DatabaseRuntimeOverview,
  type StartDatabaseMigrationInput,
} from './databaseMigrationTypes'

const PERMISSIONS = Object.freeze(['settings:write', 'backup:run'] as const)
const ERRORS = Object.freeze([
  'validation-failed',
  'conflict',
  'internal-error',
] as const)
const emptyInputSchema = z.object({}).strict()

export interface DatabaseMigrationOperationDescriptors {
  readonly overview: QueryOperationDescriptor<Record<never, never>, DatabaseRuntimeOverview, QueryContext>
  readonly preflight: CommandOperationDescriptor<
    DatabaseMigrationPreflightInput,
    DatabaseMigrationPreflightView,
    CommandContext
  >
  readonly start: IdempotentCommandOperationDescriptor<
    StartDatabaseMigrationInput,
    DatabaseMigrationStatusView,
    CommandContext
  >
  readonly resume: CommandOperationDescriptor<
    DatabaseMigrationOperationInput,
    DatabaseMigrationStatusView,
    CommandContext
  >
  readonly cancel: CommandOperationDescriptor<
    DatabaseMigrationOperationInput,
    DatabaseMigrationStatusView,
    CommandContext
  >
  readonly rollback: CommandOperationDescriptor<
    DatabaseMigrationOperationInput,
    DatabaseMigrationStatusView,
    CommandContext
  >
  readonly finalize: CommandOperationDescriptor<
    DatabaseMigrationOperationInput,
    DatabaseMigrationStatusView,
    CommandContext
  >
  readonly get: QueryOperationDescriptor<
    DatabaseMigrationOperationInput,
    DatabaseMigrationStatusView,
    QueryContext
  >
  readonly list: QueryOperationDescriptor<Record<never, never>, DatabaseMigrationListView, QueryContext>
}

export function createDatabaseMigrationOperationDescriptors(input: {
  readonly commands: DatabaseMigrationCommands
  readonly queries: DatabaseMigrationQueries
}): DatabaseMigrationOperationDescriptors {
  const statusOutput = zodOperationCodec(
    'system-operations.database-migration-status.output.v1',
    databaseMigrationStatusViewSchema,
  )
  const operationInput = zodOperationCodec(
    'system-operations.database-migration-operation.input.v1',
    databaseMigrationOperationInputSchema,
  )
  const overview: DatabaseMigrationOperationDescriptors['overview'] = Object.freeze({
    id: operationId('system-operations.get-database-runtime.v1'),
    kind: 'query',
    contextKind: 'authenticated-query',
    summary: 'Read the live database provider and generation',
    permissions: PERMISSIONS,
    publicErrors: ERRORS,
    input: zodOperationCodec(
      'system-operations.get-database-runtime.input.v1',
      emptyInputSchema,
    ),
    output: zodOperationCodec(
      'system-operations.get-database-runtime.output.v1',
      databaseRuntimeOverviewSchema,
    ),
    invoke: (context: QueryContext) => input.queries.overview.execute(context),
  })
  const preflight: DatabaseMigrationOperationDescriptors['preflight'] = Object.freeze({
    id: operationId('system-operations.preflight-database-migration.v1'),
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Test an external PostgreSQL migration target',
    permissions: PERMISSIONS,
    publicErrors: ERRORS,
    input: zodOperationCodec(
      'system-operations.preflight-database-migration.input.v1',
      databaseMigrationPreflightInputSchema,
    ),
    output: zodOperationCodec(
      'system-operations.preflight-database-migration.output.v1',
      databaseMigrationPreflightViewSchema,
    ),
    invoke: (context: CommandContext, command: DatabaseMigrationPreflightInput) =>
      input.commands.preflight.execute(context, command),
  })
  const start: DatabaseMigrationOperationDescriptors['start'] = Object.freeze({
    id: operationId('system-operations.start-database-migration.v1'),
    kind: 'idempotent-command',
    contextKind: 'authenticated-command',
    summary: 'Migrate SQLite to PostgreSQL',
    permissions: PERMISSIONS,
    publicErrors: ERRORS,
    idempotencyKey: {
      field: 'idempotencyKey' as const,
      minLength: 8,
      maxLength: 256,
      pattern: /^[A-Za-z0-9._:-]+$/,
    },
    input: zodOperationCodec(
      'system-operations.start-database-migration.input.v1',
      startDatabaseMigrationInputSchema,
    ),
    output: statusOutput,
    invoke: (context: CommandContext, command: StartDatabaseMigrationInput) =>
      input.commands.start.execute(context, command),
  })
  const resume: DatabaseMigrationOperationDescriptors['resume'] = Object.freeze({
    id: operationId('system-operations.resume-database-migration.v1'),
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Resume a database migration',
    permissions: PERMISSIONS,
    publicErrors: ERRORS,
    input: operationInput,
    output: statusOutput,
    invoke: (context: CommandContext, command: DatabaseMigrationOperationInput) =>
      input.commands.resume.execute(context, command),
  })
  const cancel: DatabaseMigrationOperationDescriptors['cancel'] = Object.freeze({
    id: operationId('system-operations.cancel-database-migration.v1'),
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Cancel a database migration before cutover',
    permissions: PERMISSIONS,
    publicErrors: ERRORS,
    input: operationInput,
    output: statusOutput,
    invoke: (context: CommandContext, command: DatabaseMigrationOperationInput) =>
      input.commands.cancel.execute(context, command),
  })
  const rollback: DatabaseMigrationOperationDescriptors['rollback'] = Object.freeze({
    id: operationId('system-operations.rollback-database-migration.v1'),
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Roll back to SQLite before the first PostgreSQL live write',
    permissions: PERMISSIONS,
    publicErrors: ERRORS,
    input: operationInput,
    output: statusOutput,
    invoke: (context: CommandContext, command: DatabaseMigrationOperationInput) =>
      input.commands.rollback.execute(context, command),
  })
  const finalize: DatabaseMigrationOperationDescriptors['finalize'] = Object.freeze({
    id: operationId('system-operations.finalize-database-migration.v1'),
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Finalize a verified database migration',
    permissions: PERMISSIONS,
    publicErrors: ERRORS,
    input: operationInput,
    output: statusOutput,
    invoke: (context: CommandContext, command: DatabaseMigrationOperationInput) =>
      input.commands.finalize.execute(context, command),
  })
  const get: DatabaseMigrationOperationDescriptors['get'] = Object.freeze({
    id: operationId('system-operations.get-database-migration.v1'),
    kind: 'query',
    contextKind: 'authenticated-query',
    summary: 'Read one database migration',
    permissions: PERMISSIONS,
    publicErrors: ERRORS,
    input: operationInput,
    output: statusOutput,
    invoke: (context: QueryContext, query: DatabaseMigrationOperationInput) =>
      input.queries.get.execute(context, query),
  })
  const list: DatabaseMigrationOperationDescriptors['list'] = Object.freeze({
    id: operationId('system-operations.list-database-migrations.v1'),
    kind: 'query',
    contextKind: 'authenticated-query',
    summary: 'List database migrations',
    permissions: PERMISSIONS,
    publicErrors: ERRORS,
    input: zodOperationCodec(
      'system-operations.list-database-migrations.input.v1',
      emptyInputSchema,
    ),
    output: zodOperationCodec(
      'system-operations.list-database-migrations.output.v1',
      databaseMigrationListViewSchema,
    ),
    invoke: (context: QueryContext) => input.queries.list.execute(context),
  })
  return Object.freeze({ overview, preflight, start, resume, cancel, rollback, finalize, get, list })
}
