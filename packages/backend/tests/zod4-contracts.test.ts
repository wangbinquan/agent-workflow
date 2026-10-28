// Dependency migration: real API error rendering and JSON Schema/MCP contracts.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ResourceDisplayNameSchema } from '@agent-workflow/shared'
import { errorHandler } from '../src/util/errors'
import { parseOr422 } from '../src/modules/development-automation/application/commands/commandInput'
import { parseEmployeeInput } from '../src/modules/digital-employee/application/inputValidation'
import { bodySchemasFor, KINDS_WITH_BODY_SCHEMAS, querySchemaFor } from '../src/mcp/resourceSchemas'
import { ALL_TOOLS } from '../src/mcp/tools'
import { toInputJsonSchema, withInputJsonSchema } from '../src/util/zodJsonSchema'
import { graphOutputInstructions } from '../src/modules/development-automation/application/graph-development/builtinResources'
import { GraphAssistOutputSchema } from '../src/modules/development-automation/application/graph-development/viewPlanning'
import zod3SchemaDigests from './fixtures/zod3-json-schema-digests.json'
import { schemaKeys } from '../src/modules/intent/domain/teaching/reconciliation'

// Golden digests were captured from the pre-upgrade sources with Zod 3.
// These are the ONLY normalized differences: non-validating default annotations,
// safe-integer limits (covered separately), redundant string-key constraints,
// disjoint tagged unions, primitive unions, and equivalent prefix regexes.
function normalizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonSchema)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (key === 'default') continue
    if (key === 'maximum' && item === Number.MAX_SAFE_INTEGER) continue
    if (key === 'minimum' && item === Number.MIN_SAFE_INTEGER) continue
    if (key === 'propertyNames' && JSON.stringify(item) === '{"type":"string"}') continue
    result[key] = normalizeJsonSchema(item)
  }
  if (JSON.stringify(result.additionalProperties) === '{}') result.additionalProperties = true
  if (Array.isArray(result.oneOf)) {
    result.anyOf = result.oneOf
    delete result.oneOf
  }
  const options = result.anyOf as Record<string, unknown>[] | undefined
  if (
    Array.isArray(options) &&
    options.every(
      (option) => Object.keys(option).length === 2 && 'type' in option && 'const' in option,
    ) &&
    new Set(options.map((option) => option.type)).size === 1
  ) {
    delete result.anyOf
    result.type = options[0]!.type
    result.enum = options.map((option) => option.const)
  } else if (
    Array.isArray(options) &&
    options.every((option) => Object.keys(option).length === 1 && 'type' in option)
  ) {
    delete result.anyOf
    result.type = options.map((option) => option.type)
  }
  if (typeof result.pattern === 'string' && result.pattern.startsWith('^repo')) {
    result.pattern = result.pattern.replace(/\.\*$/, '').replace('\\:', ':')
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

describe('Zod 4 API and schema contracts', () => {
  test('resource, graph and tool schemas retain their recorded normalized contracts', () => {
    const schemas: Record<string, unknown> = {}
    for (const kind of KINDS_WITH_BODY_SCHEMAS) {
      for (const [operation, schema] of Object.entries(bodySchemasFor(kind)))
        schemas[`resource/${kind}/${operation}`] = schema
    }
    schemas['query/memory'] = querySchemaFor('memory')
    for (const item of ['design-and-clarify', 'implement-change', 'review-design'] as const) {
      schemas[`graph/${item}`] = JSON.parse(graphOutputInstructions(item).split('\n')[1]!)
    }
    schemas['graph/assist'] = toInputJsonSchema(GraphAssistOutputSchema)
    for (const tool of ALL_TOOLS)
      schemas[`tool/${tool.name}`] = toInputJsonSchema(z.object(tool.inputSchema))
    const actual = Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [
        name,
        createHash('sha256')
          .update(JSON.stringify(normalizeJsonSchema(schema)))
          .digest('hex'),
      ]),
    )
    expect(actual).toEqual({
      ...zod3SchemaDigests,
      // RFC-396 H5 adds this tool after the Zod migration; all 75 historical digests stay intact.
      'tool/review_graph_limitations':
        '29772ea84af016441b4347043d9e816b4bbb4215e6e11516800e46cedfb38026',
    })
    expect(JSON.stringify(schemas)).not.toContain('"format":"starts_with"')
  })

  test('mission and employee input errors keep HTTP 422, application codes and UI issue fields', async () => {
    const app = new Hono()
    app.onError(errorHandler)
    const schema = z.object({ name: z.string(), entries: z.array(z.string()) })
    app.post('/mission', async (c) => c.json(parseOr422(schema, await c.req.json())))
    app.post('/employee', async (c) => c.json(parseEmployeeInput(schema, await c.req.json())))
    for (const path of ['/mission', '/employee']) {
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(response.status).toBe(422)
      const payload = await response.json()
      if (path === '/mission') {
        expect(payload).toEqual({
          ok: false,
          code: 'mission-input-invalid',
          message:
            'name: Invalid input: expected string, received undefined; entries: Invalid input: expected array, received undefined',
        })
      } else {
        expect(payload).toEqual({
          ok: false,
          code: 'validation-failed',
          message: 'Invalid input: expected string, received undefined',
          details: {
            issues: [
              {
                expected: 'string',
                code: 'invalid_type',
                path: ['name'],
                message: 'Invalid input: expected string, received undefined',
              },
              {
                expected: 'array',
                code: 'invalid_type',
                path: ['entries'],
                message: 'Invalid input: expected array, received undefined',
              },
            ],
          },
        })
      }
    }
  })

  test('raw format, enum and size issues preserve the application error envelope and UI fields', () => {
    const cases = [
      {
        schema: z.object({ value: z.string().email() }),
        value: 'bad',
        code: 'invalid_format',
        message: 'Invalid email address',
      },
      {
        schema: z.object({ value: z.enum(['one', 'two']) }),
        value: 'three',
        code: 'invalid_value',
        message: 'Invalid option: expected one of "one"|"two"',
      },
      {
        schema: z.object({ value: z.string().min(2) }),
        value: '',
        code: 'too_small',
        message: 'Too small: expected string to have >=2 characters',
      },
      {
        schema: z.object({ value: z.number().int() }),
        value: 1.5,
        code: 'invalid_type',
        message: 'Invalid input: expected int, received number',
      },
    ]
    for (const fixture of cases) {
      let error: unknown
      try {
        parseEmployeeInput<unknown>(fixture.schema, { value: fixture.value })
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({
        status: 422,
        code: 'validation-failed',
        message: fixture.message,
        details: { issues: [{ code: fixture.code, path: ['value'], message: fixture.message }] },
      })
    }
  })

  test('native JSON Schema retains preprocessed inputs, draft-07, optional fields and strip semantics', () => {
    expect(
      toInputJsonSchema(
        z.object({
          name: ResourceDisplayNameSchema,
          note: z.string().optional(),
          count: z.number().default(3),
        }),
      ),
    ).toMatchObject({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        note: { type: 'string' },
        count: { type: 'number', default: 3 },
      },
    })
    expect(
      toInputJsonSchema(z.object({ name: z.string() }).passthrough()).additionalProperties,
    ).toEqual({})
    expect(
      withInputJsonSchema(z.object({ name: z.string() })).parse({ name: 'ok', extra: true }),
    ).toEqual({ name: 'ok' })
    for (const kind of KINDS_WITH_BODY_SCHEMAS) {
      for (const schema of Object.values(bodySchemasFor(kind))) {
        const text = JSON.stringify(schema)
        expect(text).toContain('"properties"')
        expect(text).not.toContain('"$ref"')
        expect(text).not.toBe('{}')
      }
    }
    expect(querySchemaFor('memory')).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string' }, search: { type: 'string' } },
    })
    for (const item of ['design-and-clarify', 'implement-change', 'review-design'] as const) {
      const text = graphOutputInstructions(item)
      expect(text).toContain('"properties"')
      expect(text).not.toContain('"$ref"')
    }
    expect(toInputJsonSchema(GraphAssistOutputSchema).required).toEqual([
      'document',
      'candidates',
      'explanation',
    ])
  })

  test('schema teaching walks preprocess/transform/refine/default/brand wrappers without losing keys', () => {
    const object = z.object({ name: z.string() })
    for (const schema of [
      object.refine(() => true),
      object.transform((x) => x),
      z.preprocess((x) => x, object),
      object.optional(),
      object.nullable(),
      object.default({ name: 'default' }),
      object.brand('name'),
    ]) {
      expect(schemaKeys(schema)).toEqual(['name'])
    }
  })

  test('MCP SDK lists every production tool with complete input schemas and validates v4 inputs', async () => {
    const server = new McpServer({ name: 'zod4-test', version: '1' })
    for (const tool of ALL_TOOLS)
      server.registerTool(
        tool.name,
        { inputSchema: withInputJsonSchema(z.object(tool.inputSchema)) },
        async () => ({
          content: [],
        }),
      )
    const client = new Client({ name: 'zod4-test-client', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort())
      for (const tool of tools) {
        const definition = ALL_TOOLS.find((entry) => entry.name === tool.name)!
        expect(tool.inputSchema as unknown).toEqual(
          toInputJsonSchema(z.object(definition.inputSchema)),
        )
        expect(tool.inputSchema.type).toBe('object')
        expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(
          Object.keys(definition.inputSchema).sort(),
        )
      }
      expect((await client.callTool({ name: 'launch_task', arguments: {} })).isError).toBe(true)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
