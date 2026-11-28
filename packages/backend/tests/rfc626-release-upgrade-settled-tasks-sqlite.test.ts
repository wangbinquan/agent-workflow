// RFC-626 T14 (design §7「端到端（发布版升级矩阵 L1 的新种子）」「每一类处置的种子都跑完整的校验」「升级后可启动」):
// v0.19.2 / sqlite plus the overlay seed fixtures/release-upgrade/rfc626/settled-tasks.json, upgraded
// automatically: unfinished tasks whose old records cannot continue are ended as canceled (§3.2), their waiting runs, clarification and alert closed, the cancelable child cascaded; a complete waiting review is approved to done after the upgrade.
// Locks that the upgrade completes without refusing, that the conversion's twelve validation checks
// and eleven probes all pass, that the target matches the hand-written rfc626/oracle.json, and that
// the current daemon starts on it and serves the representative operation.
import { setDefaultTimeout } from 'bun:test'
import { registerResolutionCase } from './helpers/releaseUpgrade/rfc626'
import { settledTasksOperation } from './helpers/releaseUpgrade/rfc626Operations'

setDefaultTimeout(240_000)
registerResolutionCase('settled-tasks', 'sqlite', settledTasksOperation)
