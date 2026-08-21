export type CustomObserverLanguage = 'bash' | 'node' | 'python'

export interface CustomObserverTemplateEvent {
  readonly eventKey: string
  readonly triggerParameters: {
    readonly fields: readonly { readonly fieldId: string }[]
  } | null
}

function eventKey(events: readonly CustomObserverTemplateEvent[]): string {
  return events[0]?.eventKey.trim() || 'status.changed'
}

function parameterKeys(event: CustomObserverTemplateEvent): string[] {
  return (
    event.triggerParameters?.fields.map(
      (field, index) => field.fieldId.trim() || `parameter_${index + 1}`,
    ) ?? []
  )
}

function nodeCases(events: readonly CustomObserverTemplateEvent[]): string {
  return events
    .map((event) => {
      const keys = parameterKeys(event)
      const result =
        keys.length === 0
          ? 'undefined'
          : `{
${keys.map((key) => `        ${JSON.stringify(key)}: subject.subjectRef, // TODO: replace with the source value`).join('\n')}
      }`
      return `    case ${JSON.stringify(event.eventKey)}:
      return ${result}`
    })
    .join('\n')
}

function nodeStarter(events: readonly CustomObserverTemplateEvent[]): string {
  const selectedEventKey = eventKey(events)
  return `import { readFileSync } from 'node:fs'

const input = JSON.parse(readFileSync(process.env.AW_EVENT_INPUT_FILE, 'utf8'))
const eventKey = ${JSON.stringify(selectedEventKey)}

function triggerParametersFor(eventKey, subject) {
  switch (eventKey) {
${nodeCases(events)}
    default:
      return undefined
  }
}

const observations = input.subjects.map((subject) => {
  const triggerParameters = triggerParametersFor(eventKey, subject)
  return {
    eventKey,
    subjectRef: subject.subjectRef,
    occurredAt: new Date().toISOString(),
    sourceEventKey: \`\${eventKey}:\${subject.subjectRef}\`,
    sourceEventRevision: 'replace-with-stable-source-revision',
    summary: \`\${subject.subjectRef} changed\`,
    ...(triggerParameters === undefined ? {} : { triggerParameters }),
  }
})

console.log(JSON.stringify({
  protocol: 'aw-event-observer@1',
  cursor: input.cursor,
  observations,
}))`
}

function pythonCases(events: readonly CustomObserverTemplateEvent[]): string {
  return events
    .map((event, index) => {
      const keys = parameterKeys(event)
      const result =
        keys.length === 0
          ? 'None'
          : `{${keys.map((key) => `${JSON.stringify(key)}: subject["subjectRef"]`).join(', ')}}`
      return `    ${index === 0 ? 'if' : 'elif'} event_key == ${JSON.stringify(event.eventKey)}:
        return ${result}`
    })
    .join('\n')
}

function pythonStarter(events: readonly CustomObserverTemplateEvent[]): string {
  const selectedEventKey = eventKey(events)
  return `import json
import os
from datetime import datetime, timezone

with open(os.environ["AW_EVENT_INPUT_FILE"], encoding="utf-8") as stream:
    input_envelope = json.load(stream)

event_key = ${JSON.stringify(selectedEventKey)}

def trigger_parameters_for(event_key, subject):
${pythonCases(events)}
    return None

observations = []
for subject in input_envelope["subjects"]:
    trigger_parameters = trigger_parameters_for(event_key, subject)
    observation = {
        "eventKey": event_key,
        "subjectRef": subject["subjectRef"],
        "occurredAt": datetime.now(timezone.utc).isoformat(),
        "sourceEventKey": f'{event_key}:{subject["subjectRef"]}',
        "sourceEventRevision": "replace-with-stable-source-revision",
        "summary": f'{subject["subjectRef"]} changed',
    }
    if trigger_parameters is not None:
        observation["triggerParameters"] = trigger_parameters
    observations.append(observation)

print(json.dumps({
    "protocol": "aw-event-observer@1",
    "cursor": input_envelope.get("cursor"),
    "observations": observations,
}))`
}

function jqCases(events: readonly CustomObserverTemplateEvent[]): string {
  return events
    .map((event, index) => {
      const keys = parameterKeys(event)
      const result =
        keys.length === 0
          ? 'null'
          : `{ ${keys.map((key) => `${JSON.stringify(key)}: $subject.subjectRef`).join(', ')} }`
      return `${index === 0 ? 'if' : 'elif'} $event_key == ${JSON.stringify(event.eventKey)} then ${result}`
    })
    .concat('else null end')
    .join('\n    ')
}

function bashStarter(events: readonly CustomObserverTemplateEvent[]): string {
  const selectedEventKey = eventKey(events)
  return `#!/usr/bin/env bash
set -euo pipefail

jq -c --arg event_key ${JSON.stringify(selectedEventKey)} '
  def trigger_parameters($event_key; $subject):
    ${jqCases(events)};
  . as $input |
  {
    protocol: "aw-event-observer@1",
    cursor: $input.cursor,
    observations: [
      $input.subjects[] |
      . as $subject |
      (trigger_parameters($event_key; $subject)) as $parameters |
      ({
        eventKey: $event_key,
        subjectRef: $subject.subjectRef,
        occurredAt: (now | todateiso8601),
        sourceEventKey: ($event_key + ":" + $subject.subjectRef),
        sourceEventRevision: "replace-with-stable-source-revision",
        summary: ($subject.subjectRef + " changed")
      } + if $parameters == null then {} else { triggerParameters: $parameters } end)
    ]
  }
' "\${AW_EVENT_INPUT_FILE:?AW_EVENT_INPUT_FILE is required}"`
}

export function customEventObserverStarter(
  language: CustomObserverLanguage,
  events: readonly CustomObserverTemplateEvent[],
): string {
  if (language === 'python') return pythonStarter(events)
  if (language === 'bash') return bashStarter(events)
  return nodeStarter(events)
}

export function syncManagedObserverSource(input: {
  readonly language: CustomObserverLanguage
  readonly source: string
  readonly templateManaged: boolean
  readonly events: readonly CustomObserverTemplateEvent[]
}): string {
  return input.templateManaged
    ? customEventObserverStarter(input.language, input.events)
    : input.source
}
