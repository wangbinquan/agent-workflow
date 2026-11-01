// RFC-398 T9 / §7.2–§7.5, §7.8: v0.17.8, v0.17.9, v0.17.10, sqlite; strict pre-daemon checks, A1, task/restart/doctor and applicable alias/bridge negative proof.
import { setDefaultTimeout } from 'bun:test'
import { registerMatrixCase } from './helpers/releaseUpgrade/matrix'

setDefaultTimeout(240_000)
registerMatrixCase('33-v0_17_8-sqlite')
