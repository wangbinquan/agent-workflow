import { setDefaultTimeout } from 'bun:test'
import { describeV3SwitchJourney } from './helpers/rfc395V3SwitchJourney'

// A real backup and native switch or rollback take about 31 s per CI-scaled case; allow 95 s.
setDefaultTimeout(95000)
describeV3SwitchJourney('rollback-before-activation-meta')
