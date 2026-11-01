// RFC-398 T9 / §7.2–§7.5, §7.8: v0.15.0, v0.15.1, sqlite; strict pre-daemon checks, A1, task/restart/doctor and applicable alias/bridge negative proof.
import { setDefaultTimeout } from 'bun:test'
import { registerMatrixCase } from './helpers/releaseUpgrade/matrix'

setDefaultTimeout(240_000)
registerMatrixCase('22-v0_15_0-sqlite')
