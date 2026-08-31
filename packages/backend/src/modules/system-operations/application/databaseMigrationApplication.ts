import type { DatabaseMigrationCoordinatorPort } from './ports/databaseMigrationCoordinator'
import type { DatabaseMigrationCommands } from '../public/commands'
import type { DatabaseMigrationQueries } from '../public/queries'
import {
  databaseMigrationArtifactInputSchema,
  databaseMigrationArtifactViewSchema,
  databaseMigrationLegacyChunkInputSchema,
  databaseMigrationLegacyTableInputSchema,
  databaseMigrationLegacyTableViewSchema,
  databaseMigrationListViewSchema,
  databaseMigrationPreflightViewSchema,
  databaseMigrationStatusViewSchema,
  databaseRuntimeOverviewSchema,
} from '../public/types'

export interface DatabaseMigrationApplication {
  readonly commands: DatabaseMigrationCommands
  readonly queries: DatabaseMigrationQueries
}

export function createDatabaseMigrationApplication(
  coordinator: DatabaseMigrationCoordinatorPort,
): DatabaseMigrationApplication {
  const commands: DatabaseMigrationCommands = {
    preflight: {
      async execute(_context, input) {
        return databaseMigrationPreflightViewSchema.parse(await coordinator.preflight(input))
      },
    },
    start: {
      async execute(_context, input) {
        return databaseMigrationStatusViewSchema.parse(await coordinator.start(input))
      },
    },
    resume: {
      async execute(_context, input) {
        return databaseMigrationStatusViewSchema.parse(await coordinator.resume(input))
      },
    },
    cancel: {
      async execute(_context, input) {
        return databaseMigrationStatusViewSchema.parse(await coordinator.cancel(input))
      },
    },
    rollback: {
      async execute(_context, input) {
        return databaseMigrationStatusViewSchema.parse(await coordinator.rollback(input))
      },
    },
    finalize: {
      async execute(_context, input) {
        return databaseMigrationStatusViewSchema.parse(await coordinator.finalize(input))
      },
    },
  }
  const queries: DatabaseMigrationQueries = {
    overview: {
      async execute() {
        return databaseRuntimeOverviewSchema.parse(await coordinator.overview())
      },
    },
    get: {
      async execute(_context, input) {
        return databaseMigrationStatusViewSchema.parse(await coordinator.get(input))
      },
    },
    list: {
      async execute() {
        return databaseMigrationListViewSchema.parse({ operations: await coordinator.list() })
      },
    },
    readArtifact: {
      async execute(_context, input) {
        return databaseMigrationArtifactViewSchema.parse(
          await coordinator.readArtifact(databaseMigrationArtifactInputSchema.parse(input)),
        )
      },
    },
    inspectLegacyTable: {
      async execute(_context, input) {
        return databaseMigrationLegacyTableViewSchema.parse(
          await coordinator.inspectLegacyTable(
            databaseMigrationLegacyTableInputSchema.parse(input),
          ),
        )
      },
    },
    readLegacyChunk: {
      async execute(_context, input) {
        return databaseMigrationArtifactViewSchema.parse(
          await coordinator.readLegacyChunk(databaseMigrationLegacyChunkInputSchema.parse(input)),
        )
      },
    },
  }
  return Object.freeze({ commands: Object.freeze(commands), queries: Object.freeze(queries) })
}
