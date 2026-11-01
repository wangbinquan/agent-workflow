// RFC-398 T9 / §7.2–§7.5, §7.8: v0.12.0, v0.12.1, v0.12.2, sqlite; strict pre-daemon checks, A1, task/restart/doctor and applicable alias/bridge negative proof.
import { setDefaultTimeout } from 'bun:test'
import { registerMatrixCase } from './helpers/releaseUpgrade/matrix'

setDefaultTimeout(240_000)
registerMatrixCase('14-v0_12_0-sqlite')
