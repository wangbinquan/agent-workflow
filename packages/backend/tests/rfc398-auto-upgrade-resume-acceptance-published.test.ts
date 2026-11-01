// RFC-398 §7.6 / AC-4: SIGKILL child / parent / both at `acceptance-published`, then `start` again. One
// interruption point per file keeps each backend CI shard inside its budget; the matrix and the
// shared body live in helpers/rfc398AutoUpgradeResume.ts.
import { registerResumePoint } from './helpers/rfc398AutoUpgradeResume'

registerResumePoint('acceptance-published')
