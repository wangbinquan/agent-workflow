// RFC-550 (RFC-294 S9): normalising a stored dispatch-route definition list; it sat on `public/types` with only
// this module's application using it.
import { dispatchRouteDefinitionsSchema } from './model'

export function normalizeDispatchRouteDefinitionsJson(inputJson: string): string | null {
  try {
    const parsed = dispatchRouteDefinitionsSchema.safeParse(JSON.parse(inputJson) as unknown)
    return parsed.success ? JSON.stringify(parsed.data) : null
  } catch {
    return null
  }
}
