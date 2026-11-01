// RFC-398 T9 / §7.2–§7.5, §7.8: v0.11.0, v0.11.1, v0.11.2, v0.11.3, sqlite; strict pre-daemon checks, A1, task/restart/doctor and applicable alias/bridge negative proof.
import { setDefaultTimeout } from 'bun:test'
import { registerMatrixCase } from './helpers/releaseUpgrade/matrix'

setDefaultTimeout(240_000)
registerMatrixCase('13-v0_11_0-sqlite')
