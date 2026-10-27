// RFC-395 Q-3: all before/after x switch/restore x provider cases for quiescing.
import { setDefaultTimeout } from 'bun:test'
import { describeQ3PhaseBoundary } from './helpers/rfc395Q3PhaseBoundary'

// A full freeze, conversion and interrupted restart take about 12 s per CI-scaled case; allow 40 s.
setDefaultTimeout(40000)
describeQ3PhaseBoundary('quiescing')
