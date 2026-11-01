// RFC-398 T9 / §7.2–§7.5, §7.8: v0.18.9, v0.18.10, sqlite; strict pre-daemon checks, A1, task/restart/doctor and applicable alias/bridge negative proof.
import { setDefaultTimeout } from 'bun:test'
import { registerMatrixCase } from './helpers/releaseUpgrade/matrix'

setDefaultTimeout(240_000)
registerMatrixCase('43-v0_18_9-sqlite')
