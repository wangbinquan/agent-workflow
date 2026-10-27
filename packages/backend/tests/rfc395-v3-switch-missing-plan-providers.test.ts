import { setDefaultTimeout } from 'bun:test'
import { describeV3SwitchJourney } from './helpers/rfc395V3SwitchJourney'

// A real backup and native switch or rollback take about 5 s per CI-scaled case; allow 20 s.
setDefaultTimeout(20000)
describeV3SwitchJourney('missing-at-plan')
