// RFC-606 — the JSON-safe value types cross-module contracts may name (RFC-294 design §3.3: "JSON-safe value").
//
// A raw runtime event, a stored receipt section or any other document that is JSON by construction is typed as JSON here
// instead of `unknown`: consumers still narrow it, but it cannot hold a function, a class instance or `undefined`.
// The migration conversion types re-export the same `JsonValue`, so there is one definition.
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject

export interface JsonObject {
  readonly [key: string]: JsonValue
}
