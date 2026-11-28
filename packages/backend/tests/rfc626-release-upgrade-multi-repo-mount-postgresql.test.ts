// RFC-626 T14 (design §7「端到端（发布版升级矩阵 L1 的新种子）」「每一类处置的种子都跑完整的校验」「升级后可启动」):
// v0.19.2 / postgresql plus the overlay seed fixtures/release-upgrade/rfc626/multi-repo-mount.json, upgraded
// automatically: a contradicting first mount leaves the task without mounts instead of an index the task-aggregate probe rejects (§9.8 T0-4).
// Locks that the upgrade completes without refusing, that the conversion's twelve validation checks
// and eleven probes all pass, that the target matches the hand-written rfc626/oracle.json, and that
// the current daemon starts on it and serves the representative operation.
import { setDefaultTimeout } from 'bun:test'
import { registerResolutionCase } from './helpers/releaseUpgrade/rfc626'
import { multiRepoMountOperation } from './helpers/releaseUpgrade/rfc626Operations'

setDefaultTimeout(240_000)
registerResolutionCase('multi-repo-mount', 'postgresql', multiRepoMountOperation)
