import type { MemoryDistillCommands, MemoryDistillWorker } from './commands'
import type { MemoryDistillQueries, MemoryInjectionQueries } from './queries'
import type { MemoryCatalogOperations } from './catalog'

export interface MemoryOperations {
  readonly distillCommands: MemoryDistillCommands
  readonly distillQueries: MemoryDistillQueries
  readonly distillWorker: MemoryDistillWorker
  readonly injectionQueries: MemoryInjectionQueries
  /** Bound once resource-scope authorization has joined the provider composition. */
  readonly catalog?: MemoryCatalogOperations
}
