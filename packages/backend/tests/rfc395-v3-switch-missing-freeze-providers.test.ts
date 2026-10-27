import { setDefaultTimeout } from 'bun:test'
import { describeV3SwitchJourney } from './helpers/rfc395V3SwitchJourney'

// A real backup and native switch or rollback take about 11 s per CI-scaled case; allow 35 s.
setDefaultTimeout(35000)
describeV3SwitchJourney('missing-at-freeze')
