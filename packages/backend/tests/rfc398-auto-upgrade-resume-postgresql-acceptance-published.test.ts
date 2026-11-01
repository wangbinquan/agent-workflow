// RFC-398 §7.6 / AC-4 (PostgreSQL): kill child / parent / both at `acceptance-published`; the session keeps its
// database allocations. One interruption point per file keeps each backend CI shard inside its
// budget; the shared body lives in helpers/rfc398AutoUpgradeResume.ts.
import { registerPostgresqlResumePoint } from './helpers/rfc398AutoUpgradeResume'

registerPostgresqlResumePoint('acceptance-published')
