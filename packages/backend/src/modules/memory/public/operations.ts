import type { MemoryCatalogCommands, MemoryDistillCommands, MemoryDistillWorker } from './commands'
import type { MemoryCatalogQueries, MemoryDistillQueries, MemoryInjectionQueries } from './queries'

export interface MemoryOperations {
  readonly distillCommands: MemoryDistillCommands
  readonly distillQueries: MemoryDistillQueries
  readonly distillWorker: MemoryDistillWorker
  readonly injectionQueries: MemoryInjectionQueries
  /** Bound once resource-scope authorization has joined the provider composition. */
  readonly catalog?: MemoryCatalogOperations
}

// RFC-434: the memory catalog contract, folded in from the former non-exact `public/catalog`.
export interface MemoryCatalogOperations {
  readonly queries: MemoryCatalogQueries
  readonly commands: MemoryCatalogCommands
}
