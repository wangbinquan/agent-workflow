// Platform persistence query vocabulary used by transitional bounded-context
// application code. Keeping the ORM constructors behind this platform edge
// avoids coupling application modules to the transport package while RFC-294
// W2 moves the remaining row projections into infrastructure adapters.
export { and, desc, eq, inArray, ne } from 'drizzle-orm'
