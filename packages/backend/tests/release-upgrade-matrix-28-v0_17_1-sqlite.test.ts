// RFC-398 T9 / §7.2–§7.5, §7.8: v0.17.1, v0.17.2, sqlite; strict pre-daemon checks, A1, task/restart/doctor and applicable alias/bridge negative proof.
import { setDefaultTimeout } from 'bun:test'
import { registerMatrixCase } from './helpers/releaseUpgrade/matrix'

setDefaultTimeout(240_000)
registerMatrixCase('28-v0_17_1-sqlite')
