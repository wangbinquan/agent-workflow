import { ulid } from 'ulid'
import { createResourcePackageApplication } from '../application/package/packageApplication'
import type { ResourcePackageOwnedResourceLookupPort } from '../application/package/ports'
import {
  createResourcePackageStagedExecution,
  type ResourcePackageExecutionAdapter,
  type ResourcePackageTransport,
} from '../application/package/stagedExecution'
import { createResourcePackageOperationDescriptors } from './catalogOperationDescriptors'
import type { ResourcePackageCatalogModule } from '../public/operations'

export type { ResourcePackageProviderComposition } from './resourcePackageProvider'
// RFC-504: the staged-execution seam moved to application with the staging; re-exported for this file's existing consumers.
export type {
  ResourcePackageExecutionAdapter,
  ResourcePackageTransport,
} from '../application/package/stagedExecution'

export interface ComposedResourcePackageCatalog extends ResourcePackageCatalogModule {
  readonly transport: ResourcePackageTransport
}

export interface ResourcePackageAdapterCompositionDependencies {
  readonly execution: ResourcePackageExecutionAdapter
  readonly resources: ResourcePackageOwnedResourceLookupPort
  readonly id?: () => string
}

export function composeResourcePackageOperationsFromAdapters(
  deps: ResourcePackageAdapterCompositionDependencies,
): ComposedResourcePackageCatalog {
  // RFC-504: the one-shot staging is an application use case (createResourcePackageStagedExecution). One id source still serves
  // the staged handles, the export ids and the application's ids.
  const nextId = deps.id ?? ulid
  const { execution, transport } = createResourcePackageStagedExecution({
    execution: deps.execution,
    resources: deps.resources,
    id: nextId,
  })
  const application = createResourcePackageApplication({
    execution,
    ids: Object.freeze({ next: nextId }),
  })
  const operations = createResourcePackageOperationDescriptors(
    application.commands,
    application.queries,
  )
  return Object.freeze({
    commands: application.commands,
    queries: application.queries,
    operations,
    transport,
  })
}

export function composeResourcePackageOperations(
  deps: ResourcePackageAdapterCompositionDependencies,
): ComposedResourcePackageCatalog {
  return composeResourcePackageOperationsFromAdapters(deps)
}
