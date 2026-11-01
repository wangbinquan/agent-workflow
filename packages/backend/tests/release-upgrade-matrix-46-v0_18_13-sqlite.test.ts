// RFC-398 T9 / §7.2–§7.5, §7.8: v0.18.13, sqlite; strict pre-daemon checks, A1, task/restart/doctor and applicable alias/bridge negative proof.
import { setDefaultTimeout } from 'bun:test'
import { registerMatrixCase } from './helpers/releaseUpgrade/matrix'

setDefaultTimeout(240_000)
registerMatrixCase('46-v0_18_13-sqlite')
