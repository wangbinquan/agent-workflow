// RFC-395 I-a: codecs select semantics explicitly; no column-name inference.
export const CODECS = {
  id: { sqlite: 'text', postgresql: 'text', dataType: 'string' },
  text: { sqlite: 'text', postgresql: 'text', dataType: 'string' },
  enum: { sqlite: 'text', postgresql: 'text', dataType: 'string' },
  bool: { sqlite: 'integer', postgresql: 'boolean', dataType: 'boolean' },
  int: { sqlite: 'integer', postgresql: 'bigint', dataType: 'number' },
  bigint: { sqlite: 'integer', postgresql: 'bigint', dataType: 'bigint' },
  epochMs: { sqlite: 'integer', postgresql: 'bigint', dataType: 'number' },
  durationMs: { sqlite: 'integer', postgresql: 'bigint', dataType: 'number' },
  real: { sqlite: 'real', postgresql: 'double precision', dataType: 'number' },
  jsonText: { sqlite: 'text', postgresql: 'text', dataType: 'string' },
  jsonDoc: { sqlite: 'text', postgresql: 'jsonb', dataType: 'json' },
  rawJson: { sqlite: 'text', postgresql: 'text', dataType: 'string' },
  bytes: { sqlite: 'blob', postgresql: 'bytea', dataType: 'buffer' },
  seq: { sqlite: 'integer', postgresql: 'bigint', dataType: 'number' },
  identity: { sqlite: 'integer', postgresql: 'bigint', dataType: 'number' },
  slotKey: { sqlite: 'text', postgresql: 'text', dataType: 'string' },
} as const
export type CodecName = keyof typeof CODECS
export type CodecData<C extends CodecName> = C extends 'bool'
  ? boolean
  : C extends 'bigint'
    ? bigint
    : C extends 'int' | 'epochMs' | 'durationMs' | 'real' | 'seq' | 'identity'
      ? number
      : C extends 'bytes'
        ? Buffer
        : C extends 'jsonDoc'
          ? unknown
          : string
