// RFC-398 T9 / §7.2–§7.5, §7.8: v0.12.3, v0.12.4, v0.12.5, v0.12.6, sqlite; strict pre-daemon checks, A1, task/restart/doctor and applicable alias/bridge negative proof.
import { setDefaultTimeout } from 'bun:test'
import { registerMatrixCase } from './helpers/releaseUpgrade/matrix'

setDefaultTimeout(240_000)
registerMatrixCase('15-v0_12_3-sqlite')
