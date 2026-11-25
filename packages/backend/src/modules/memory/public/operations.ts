import type { MemoryCatalogCommands } from './commands'
import type { MemoryCatalogQueries } from './queries'

// RFC-434: the memory catalog contract, folded in from the former non-exact `public/catalog`.
export interface MemoryCatalogOperations {
  readonly queries: MemoryCatalogQueries
  readonly commands: MemoryCatalogCommands
}
