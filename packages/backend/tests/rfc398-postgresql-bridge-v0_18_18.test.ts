// RFC-398 §3.8/§7.6: the original PostgreSQL logical bridge for v0.18.18. One released source per
// file keeps each backend CI shard inside its budget; the cases live in
// helpers/rfc398PostgresqlBridge.ts.
import { registerBridgeRelease } from './helpers/rfc398PostgresqlBridge'

registerBridgeRelease('v0.18.18')
