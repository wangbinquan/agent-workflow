// Bootstrap binds one storage instance to live reads and the Settings owner.
// A selected source has a logical notification key and needs no local path.
import { createApplicationConfiguration } from '../application/applicationConfiguration'
import type {
  ApplicationConfigurationDependencies,
  ApplicationConfigurationPersistencePort,
} from '../application/ports/applicationConfiguration'
import type { DatabaseConfigurationPort } from '../application/ports/databaseConfiguration'
import { createFileApplicationConfiguration } from '../infrastructure/local/fileApplicationConfiguration'
import type { ApplicationConfigurationCommands } from '../public/commands'
import type { ApplicationConfigurationQueries } from '../public/queries'
import type { Config } from '@agent-workflow/shared'
import { notifyConfigApplied } from '@/services/configAppliedListeners'
import { configureLogger } from '@/util/log'

export interface ApplicationConfigurationBinding {
  readonly queries: ApplicationConfigurationQueries
  /** Present only for the original default file source. Selected readers may be async. */
  readonly synchronousQueries?: Readonly<{ read(): Config }>
  readonly databaseConfiguration: DatabaseConfigurationPort
  readonly notificationKey: string
  composeCommands(
    dependencies: Omit<ApplicationConfigurationDependencies, 'persistence' | 'applied'>,
  ): ApplicationConfigurationCommands
}

export function composeApplicationConfigurationBinding(
  input:
    | {
        readonly kind: 'selected'
        readonly persistence: ApplicationConfigurationPersistencePort
        readonly notificationKey: string
      }
    | {
        readonly kind: 'file'
        readonly configPath: string
        /** Preserve the existing explicitly injected read-only query override. */
        readonly queries?: ApplicationConfigurationQueries
      },
): ApplicationConfigurationBinding {
  const source =
    input.kind === 'selected'
      ? { persistence: input.persistence }
      : (() => {
          const persistence = createFileApplicationConfiguration(input.configPath)
          return {
            persistence,
            ...(input.queries === undefined
              ? { synchronousQueries: Object.freeze({ read: () => persistence.load() }) }
              : {}),
          }
        })()
  const { persistence } = source
  const notificationKey = input.kind === 'selected' ? input.notificationKey : input.configPath
  const queries =
    input.kind === 'file' && input.queries !== undefined
      ? input.queries
      : Object.freeze({ read: () => persistence.load() })
  return Object.freeze({
    queries,
    ...('synchronousQueries' in source ? { synchronousQueries: source.synchronousQueries } : {}),
    databaseConfiguration: Object.freeze({
      async read() {
        return (await persistence.load()).database
      },
      async write(database) {
        await persistence.applyPatch({ database })
      },
    } satisfies DatabaseConfigurationPort),
    notificationKey,
    composeCommands(
      dependencies: Omit<ApplicationConfigurationDependencies, 'persistence' | 'applied'>,
    ) {
      return createApplicationConfiguration({
        ...dependencies,
        persistence,
        applied: {
          notify: (config) => notifyConfigApplied(notificationKey, config),
          setLogLevel: (level) => configureLogger({ level }),
        },
      })
    },
  })
}
