/**
 * OpenAPI import.
 *
 * The parser is pure, so these exercise the awkward parts directly: schema
 * examples, $ref cycles, security mapping, and Swagger 2.0's differences.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOpenApi } from '../src/main/openapi.ts'

const doc = (extra: Record<string, unknown>): string =>
  JSON.stringify({ openapi: '3.0.0', info: { title: 'Demo', version: '1.0' }, ...extra })

/* -- shape ---------------------------------------------------------- */

test('an operation becomes a request', () => {
  const plan = parseOpenApi(
    doc({
      servers: [{ url: 'https://api.example.com/v1' }],
      paths: { '/users': { get: { summary: 'List users', tags: ['Users'] } } }
    })
  )
  assert.equal(plan.title, 'Demo')
  assert.deepEqual(plan.servers, ['https://api.example.com/v1'])
  assert.equal(plan.requests.length, 1)
  assert.equal(plan.requests[0].folder, 'Users')
  assert.equal(plan.requests[0].request.name, 'List users')
  assert.equal(plan.requests[0].request.method, 'GET')
  assert.equal(plan.requests[0].request.url, '{{BASE_URL}}/users')
})

test('path parameters become variables', () => {
  const plan = parseOpenApi(doc({ paths: { '/users/{userId}/pets/{petId}': { get: {} } } }))
  assert.equal(plan.requests[0].request.url, '{{BASE_URL}}/users/{{userId}}/pets/{{petId}}')
})

test('the base variable can be renamed', () => {
  const plan = parseOpenApi(doc({ paths: { '/x': { get: {} } } }), { baseVariable: 'HOST' })
  assert.equal(plan.requests[0].request.url, '{{HOST}}/x')
})

test('names fall back from summary to operationId to method and path', () => {
  const plan = parseOpenApi(
    doc({
      paths: {
        '/a': { get: { summary: 'Nice name' } },
        '/b': { get: { operationId: 'listAllWidgets' } },
        '/c': { get: {} }
      }
    })
  )
  const names = plan.requests.map((r) => r.request.name)
  assert.deepEqual(names, ['Nice name', 'list All Widgets', 'GET /c'])
})

test('every method on a path becomes its own request', () => {
  const plan = parseOpenApi(doc({ paths: { '/x': { get: {}, post: {}, delete: {} } } }))
  assert.deepEqual(
    plan.requests.map((r) => r.request.method),
    ['GET', 'POST', 'DELETE']
  )
})

test('grouping by tag can be turned off', () => {
  const plan = parseOpenApi(doc({ paths: { '/x': { get: { tags: ['Users'] } } } }), {
    groupByTag: false
  })
  assert.equal(plan.requests[0].folder, '')
})

/* -- parameters ----------------------------------------------------- */

test('query and header parameters land in their own tables', () => {
  const plan = parseOpenApi(
    doc({
      paths: {
        '/search': {
          get: {
            parameters: [
              { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
              { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
              { name: 'X-Trace', in: 'header', schema: { type: 'string' } }
            ]
          }
        }
      }
    })
  )
  const request = plan.requests[0].request
  assert.deepEqual(request.params, [
    { enabled: true, key: 'q', value: '{{q}}' },
    { enabled: false, key: 'page', value: '1' }
  ])
  assert.deepEqual(request.headers, [{ enabled: false, key: 'X-Trace', value: '{{X-Trace}}' }])
})

test('optional parameters arrive disabled, so the request works as-is', () => {
  const plan = parseOpenApi(
    doc({
      paths: {
        '/x': {
          get: { parameters: [{ name: 'opt', in: 'query', schema: { type: 'string' } }] }
        }
      }
    })
  )
  assert.equal(plan.requests[0].request.params?.[0].enabled, false)
})

test('parameters declared on the path apply to every operation', () => {
  const plan = parseOpenApi(
    doc({
      paths: {
        '/x': {
          parameters: [{ name: 'shared', in: 'query', required: true, schema: { type: 'string' } }],
          get: {},
          post: { parameters: [{ name: 'own', in: 'query', required: true, schema: {} }] }
        }
      }
    })
  )
  assert.deepEqual(plan.requests[0].request.params?.map((p) => p.key), ['shared'])
  assert.deepEqual(plan.requests[1].request.params?.map((p) => p.key), ['shared', 'own'])
})

/* -- bodies --------------------------------------------------------- */

test('a JSON body is filled in from the schema', () => {
  const plan = parseOpenApi(
    doc({
      paths: {
        '/users': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      age: { type: 'integer' },
                      active: { type: 'boolean' },
                      tags: { type: 'array', items: { type: 'string' } },
                      createdAt: { type: 'string', format: 'date-time' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    })
  )
  const body = plan.requests[0].request.body!
  assert.equal(body.mode, 'json')
  assert.deepEqual(JSON.parse(body.text!), {
    name: 'string',
    age: 0,
    active: true,
    tags: ['string'],
    createdAt: '1970-01-01T00:00:00Z'
  })
})

test('an explicit example beats anything generated from the schema', () => {
  const plan = parseOpenApi(
    doc({
      paths: {
        '/users': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { name: { type: 'string' } } },
                  example: { name: 'Ada' }
                }
              }
            }
          }
        }
      }
    })
  )
  assert.deepEqual(JSON.parse(plan.requests[0].request.body!.text!), { name: 'Ada' })
})

test('a $ref to a component schema is followed', () => {
  const plan = parseOpenApi(
    doc({
      components: {
        schemas: {
          User: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } }
        }
      },
      paths: {
        '/users': {
          post: {
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } }
            }
          }
        }
      }
    })
  )
  assert.deepEqual(JSON.parse(plan.requests[0].request.body!.text!), {
    id: '00000000-0000-0000-0000-000000000000'
  })
})

test('a self-referencing schema terminates instead of looping', () => {
  const plan = parseOpenApi(
    doc({
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: { name: { type: 'string' }, child: { $ref: '#/components/schemas/Node' } }
          }
        }
      },
      paths: {
        '/nodes': {
          post: {
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } }
            }
          }
        }
      }
    })
  )
  const body = JSON.parse(plan.requests[0].request.body!.text!)
  assert.equal(body.name, 'string')
  assert.equal(body.child, null)
})

test('allOf merges its branches', () => {
  const plan = parseOpenApi(
    doc({
      paths: {
        '/x': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { type: 'object', properties: { a: { type: 'string' } } },
                      { type: 'object', properties: { b: { type: 'integer' } } }
                    ]
                  }
                }
              }
            }
          }
        }
      }
    })
  )
  assert.deepEqual(JSON.parse(plan.requests[0].request.body!.text!), { a: 'string', b: 0 })
})

test('an enum uses its first value', () => {
  const plan = parseOpenApi(
    doc({
      paths: {
        '/x': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { type: 'string', enum: ['live', 'draft'] } }
                  }
                }
              }
            }
          }
        }
      }
    })
  )
  assert.deepEqual(JSON.parse(plan.requests[0].request.body!.text!), { status: 'live' })
})

test('a form-urlencoded body becomes editable rows', () => {
  const plan = parseOpenApi(
    doc({
      paths: {
        '/token': {
          post: {
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: {
                    type: 'object',
                    properties: { grant_type: { type: 'string', default: 'password' } }
                  }
                }
              }
            }
          }
        }
      }
    })
  )
  const body = plan.requests[0].request.body!
  assert.equal(body.mode, 'urlencoded')
  assert.deepEqual(body.urlencoded, [{ enabled: true, key: 'grant_type', value: 'password' }])
})

test('JSON is preferred when a body offers several media types', () => {
  const plan = parseOpenApi(
    doc({
      paths: {
        '/x': {
          post: {
            requestBody: {
              content: {
                'application/xml': { schema: { type: 'object' } },
                'application/json': { schema: { type: 'object', properties: { a: {} } } }
              }
            }
          }
        }
      }
    })
  )
  assert.equal(plan.requests[0].request.body!.mode, 'json')
})

/* -- security ------------------------------------------------------- */

test('global bearer security becomes folder auth', () => {
  const plan = parseOpenApi(
    doc({
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearerAuth: [] }],
      paths: { '/x': { get: {} } }
    })
  )
  assert.deepEqual(plan.auth, { type: 'bearer', token: '{{TOKEN}}' })
  // Requests inherit it rather than repeating it.
  assert.equal(plan.requests[0].request.auth, undefined)
})

test('an API key scheme keeps its header name', () => {
  const plan = parseOpenApi(
    doc({
      components: {
        securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } }
      },
      security: [{ key: [] }],
      paths: { '/x': { get: {} } }
    })
  )
  assert.deepEqual(plan.auth, {
    type: 'apikey',
    key: 'X-Api-Key',
    value: '{{API_KEY}}',
    in: 'header'
  })
})

test('an operation that opts out of security says so', () => {
  const plan = parseOpenApi(
    doc({
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearerAuth: [] }],
      paths: { '/public': { get: { security: [] } }, '/private': { get: {} } }
    })
  )
  assert.deepEqual(plan.requests[0].request.auth, { type: 'none' })
  assert.equal(plan.requests[1].request.auth, undefined)
})

test('basic auth is mapped to basic auth', () => {
  const plan = parseOpenApi(
    doc({
      components: { securitySchemes: { b: { type: 'http', scheme: 'basic' } } },
      security: [{ b: [] }],
      paths: { '/x': { get: {} } }
    })
  )
  assert.equal(plan.auth?.type, 'basic')
})

/* -- Swagger 2.0 ---------------------------------------------------- */

test('a Swagger 2.0 document imports, with its server assembled', () => {
  const plan = parseOpenApi(
    JSON.stringify({
      swagger: '2.0',
      info: { title: 'Legacy', version: '1' },
      host: 'api.example.com',
      basePath: '/v2',
      schemes: ['https'],
      paths: {
        '/pets': {
          post: {
            summary: 'Add a pet',
            parameters: [
              { name: 'body', in: 'body', schema: { $ref: '#/definitions/Pet' } },
              { name: 'limit', in: 'query', required: true, type: 'integer' }
            ]
          }
        }
      },
      definitions: { Pet: { type: 'object', properties: { name: { type: 'string' } } } }
    })
  )
  assert.deepEqual(plan.servers, ['https://api.example.com/v2'])
  const request = plan.requests[0].request
  assert.equal(request.name, 'Add a pet')
  assert.deepEqual(JSON.parse(request.body!.text!), { name: 'string' })
  // The body parameter became the body, and is not left in the query table.
  assert.deepEqual(request.params?.map((p) => p.key), ['limit'])
})

test('Swagger 2.0 formData becomes a form body', () => {
  const plan = parseOpenApi(
    JSON.stringify({
      swagger: '2.0',
      info: { title: 'L', version: '1' },
      paths: {
        '/upload': {
          post: {
            consumes: ['application/x-www-form-urlencoded'],
            parameters: [{ name: 'note', in: 'formData', type: 'string' }]
          }
        }
      }
    })
  )
  assert.equal(plan.requests[0].request.body!.mode, 'urlencoded')
  assert.deepEqual(plan.requests[0].request.body!.urlencoded?.map((r) => r.key), ['note'])
})

/* -- refusals ------------------------------------------------------- */

test('YAML is refused with a message that says why', () => {
  assert.throws(
    () => parseOpenApi('openapi: 3.0.0\ninfo:\n  title: X\n'),
    /looks like YAML/
  )
})

test('a document with no version field is refused', () => {
  assert.throws(() => parseOpenApi('{"paths":{}}'), /openapi.*swagger/i)
})

test('malformed JSON is refused with the parser error', () => {
  assert.throws(() => parseOpenApi('{ "openapi": '), /Not valid JSON/)
})

test('an empty paste is refused', () => {
  assert.throws(() => parseOpenApi('   '), /Nothing to import/)
})

/* -- warnings ------------------------------------------------------- */

test('a document with no operations warns rather than importing nothing silently', () => {
  const plan = parseOpenApi(doc({ paths: {} }))
  assert.equal(plan.requests.length, 0)
  assert.ok(plan.warnings.some((w) => w.includes('no operations')))
})

test('a missing server URL is called out', () => {
  const plan = parseOpenApi(doc({ paths: { '/x': { get: {} } } }))
  assert.ok(plan.warnings.some((w) => w.includes('BASE_URL')))
})

test('a cookie parameter is reported rather than dropped in silence', () => {
  const plan = parseOpenApi(
    doc({
      paths: {
        '/x': { get: { parameters: [{ name: 'sid', in: 'cookie', schema: { type: 'string' } }] } }
      }
    })
  )
  assert.ok(plan.warnings.some((w) => w.includes('cookie parameter "sid"')))
})

test('operations keep the document order', () => {
  const plan = parseOpenApi(
    doc({ paths: { '/a': { get: {} }, '/b': { get: {} }, '/c': { get: {} } } })
  )
  assert.deepEqual(
    plan.requests.map((r) => r.request.order),
    [1, 2, 3]
  )
})

test('the description becomes the docs tab', () => {
  const plan = parseOpenApi(
    doc({
      paths: {
        '/x': { get: { description: 'Returns everything.', operationId: 'getAll' } }
      }
    })
  )
  const docs = plan.requests[0].request.docs!
  assert.match(docs, /GET \/x/)
  assert.match(docs, /Returns everything\./)
  assert.match(docs, /operationId: getAll/)
})
