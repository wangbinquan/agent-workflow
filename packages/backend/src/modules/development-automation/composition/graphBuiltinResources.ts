import {
  createGraphBuiltinCatalog,
  type GraphBuiltinCatalogInput,
} from '../application/graph-development/builtinCatalog'

/** All participants are supplied at construction; resource loading belongs to the application. */
export function composeGraphBuiltinResources(input: GraphBuiltinCatalogInput) {
  return createGraphBuiltinCatalog(input)
}
