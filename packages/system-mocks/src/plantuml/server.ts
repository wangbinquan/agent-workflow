import { inflateRawSync } from 'node:zlib'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { writeText } from '../core/http'

const PLANTUML_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'
const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function handlePlantuml(input: {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  body: Buffer
}): boolean {
  const prefix = '/renderer/plantuml/svg'
  if (!input.url.pathname.startsWith(prefix)) return false
  let source: string
  if (input.request.method === 'POST' && input.url.pathname === prefix) {
    source = input.body.toString('utf8')
  } else if (input.request.method === 'GET' && input.url.pathname.startsWith(`${prefix}/`)) {
    try {
      source = decodePlantuml(input.url.pathname.slice(prefix.length + 1))
    } catch {
      writeText(input.response, 400, 'invalid PlantUML encoding')
      return true
    }
  } else {
    writeText(input.response, 405, 'method not allowed')
    return true
  }
  if (!source.includes('@startuml') || !source.includes('@enduml')) {
    writeText(input.response, 422, 'PlantUML source must contain @startuml and @enduml')
    return true
  }
  const escaped = xmlEscape(source)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="120" viewBox="0 0 640 120"><title>system mock PlantUML</title><rect width="640" height="120" fill="#fff" stroke="#222"/><text x="16" y="28" font-family="monospace" font-size="14">system mock PlantUML renderer</text><desc>${escaped}</desc><text x="16" y="58" font-family="monospace" font-size="12">${xmlEscape(source.replace(/\s+/g, ' ').slice(0, 80))}</text></svg>`
  writeText(input.response, 200, svg, 'image/svg+xml; charset=utf-8', {
    'x-system-mock-source-shape': source.includes('->') ? 'sequence' : 'diagram',
  })
  return true
}

function decodePlantuml(encoded: string): string {
  let standard = ''
  for (const character of encoded) {
    const index = PLANTUML_ALPHABET.indexOf(character)
    if (index < 0) throw new Error('invalid alphabet')
    standard += STANDARD_ALPHABET[index]
  }
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4)
  return inflateRawSync(Buffer.from(padded, 'base64')).toString('utf8')
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;'
    if (character === '<') return '&lt;'
    if (character === '>') return '&gt;'
    if (character === '"') return '&quot;'
    return '&apos;'
  })
}
