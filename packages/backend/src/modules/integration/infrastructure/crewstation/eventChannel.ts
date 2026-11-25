// RFC-596 — the hosted event channel's two vocabularies. CrewStation's event-source configuration (`AW_EVENT_SOURCES`, a
// binding's `mode`) and the inbox rows (`cs_event_targets.mode`) name the admitting channel `crewstation`; Integration's
// business layer names it by what it does (`admit`). These two functions are the only translation, so the configuration
// and the persisted values keep their names and the business layer carries no deployment name.
import type { CrewStationEventChannel } from '../../application/ports/crewStationEventInbox'

/** A binding's mode, as configured and as stored on an inbox target row. */
export type CrewStationBindingMode = 'crewstation' | 'shadow'

const CHANNEL_OF_MODE = {
  crewstation: 'admit',
  shadow: 'shadow',
} as const satisfies Readonly<Record<CrewStationBindingMode, CrewStationEventChannel>>

const MODE_OF_CHANNEL = {
  admit: 'crewstation',
  shadow: 'shadow',
} as const satisfies Readonly<Record<CrewStationEventChannel, CrewStationBindingMode>>

export function eventChannelOfBindingMode(mode: CrewStationBindingMode): CrewStationEventChannel {
  return CHANNEL_OF_MODE[mode]
}

export function bindingModeOfEventChannel(
  channel: CrewStationEventChannel,
): CrewStationBindingMode {
  return MODE_OF_CHANNEL[channel]
}
