// RFC-626 T14 (design §7「端到端（发布版升级矩阵 L1 的新种子）」「每一类处置的种子都跑完整的校验」「升级后可启动」):
// v0.19.2 / postgresql plus the overlay seed fixtures/release-upgrade/rfc626/set-aside.json, upgraded
// automatically: an undecodable row and a row already dangling in the old database are set aside, a removed creator is cleared and a removed adder becomes the system user (§3.3, §3.4 rows 11, 11b, 17).
// Locks that the upgrade completes without refusing, that the conversion's twelve validation checks
// and eleven probes all pass, that the target matches the hand-written rfc626/oracle.json, and that
// the current daemon starts on it and serves the representative operation.
import { setDefaultTimeout } from 'bun:test'
import { registerResolutionCase } from './helpers/releaseUpgrade/rfc626'
import { setAsideOperation } from './helpers/releaseUpgrade/rfc626Operations'

setDefaultTimeout(240_000)
registerResolutionCase('set-aside', 'postgresql', setAsideOperation)
