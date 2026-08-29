/**
 * OpenAPI -> Frap requests.
 *
 * A pure transform: it takes a parsed document and produces a plan of folders
 * and requests, which the caller writes to disk. Keeping it free of the
 * filesystem is what makes the awkward parts - schema examples, $ref cycles,
 * Swagger 2.0's differences - testable without a workspace.
 *
 * Supports OpenAPI 3.0/3.1 and Swagger 2.0. Only JSON: a YAML document is
 * reported rather than half-parsed.
 */
import type { Auth, FrapRequest, KeyValue } from '../shared/types.ts'

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

/** How deep a schema is walked when building an example body. */
const MAX_EXAMPLE_DEPTH = 6

type Json = Record<string, unknown>

/** One request the import will create, and where it goes. */
export interface PlannedRequest {
  /** Folder name relative to the import target; empty means directly in it. */
  folder: string
  request: Partial<FrapRequest>
}

export interface OpenApiPlan {
  title: string
  version: string
  /** Server URLs the document declares, most preferred first. */
  servers: string[]
  /** Auth implied by the document's global security, for the target folder. */
  auth?: Auth
  requests: PlannedRequest[]
  warnings: string[]
}

export interface ParseOptions {
  /** Variable the server URL is bound to, e.g. `BASE_URL`. */
  baseVariable?: string
  /** Group operations into folders by their first tag. */
  groupByTag?: boolean
}

/* ------------------------------------------------------------------ */
/* Document access                                                     */
/* ------------------------------------------------------------------ */

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Resolves a local `#/...` reference.
 *
 * External and remote refs are not followed - there is nothing to follow them
 * against - so they come back undefined and the caller records a warning.
 */
function resolveRef(doc: Json, ref: string): Json | undefined {
  if (!ref.startsWith('#/')) return undefined
  let cursor: unknown = doc
  for (const rawPart of ref.slice(2).split('/')) {
    // JSON Pointer escaping.
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isObject(cursor)) return undefined
    cursor = cursor[part]
  }
  return isObject(cursor) ? cursor : undefined
}

/** Follows `$ref` until it lands on something concrete. */
function deref(doc: Json, node: unknown, seen = new Set<string>()): Json | undefined {
  if (!isObject(node)) return undefined
  const ref = asString(node.$ref)
  if (!ref) return node
  if (seen.has(ref)) return undefined
  seen.add(ref)
  return deref(doc, resolveRef(doc, ref), seen)
}

/* ------------------------------------------------------------------ */
/* Example bodies                                                      */
/* ------------------------------------------------------------------ */

const FORMAT_SAMPLES: Record<string, string> = {
  'date-time': '1970-01-01T00:00:00Z',
  date: '1970-01-01',
  uuid: '00000000-0000-0000-0000-000000000000',
  email: 'user@example.com',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '127.0.0.1',
  byte: 'ZXhhbXBsZQ=='
}

/**
 * Builds a placeholder value for a schema.
 *
 * A body of `{}` is no use to anyone, so this fills in the shape. Explicit
 * examples in the document always win over anything invented here.
 */
function exampleFor(doc: Json, schemaNode: unknown, depth = 0, seen = new Set<unknown>()): unknown {
  if (depth > MAX_EXAMPLE_DEPTH) return null
  const schema = deref(doc, schemaNode)
  if (!schema) return null

  // A schema that references itself would otherwise recurse forever.
  if (seen.has(schema)) return null
  const nested = new Set(seen).add(schema)

  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]

  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const branch = schema[key]
    if (!Array.isArray(branch) || branch.length === 0) continue
    if (key === 'allOf') {
      // Merge every branch, since allOf means "all of these at once".
      const merged: Json = {}
      for (const part of branch) {
        const value = exampleFor(doc, part, depth, nested)
        if (isObject(value)) Object.assign(merged, value)
      }
      return merged
    }
    return exampleFor(doc, branch[0], depth, nested)
  }

  // 3.1 allows a list of types; the first concrete one is good enough here.
  const rawType = schema.type
  const type = Array.isArray(rawType)
    ? asString(rawType.find((t) => t !== 'null'))
    : asString(rawType)

  if (type === 'object' || (!type && isObject(schema.properties))) {
    const out: Json = {}
    const properties = isObject(schema.properties) ? schema.properties : {}
    for (const [name, child] of Object.entries(properties)) {
      out[name] = exampleFor(doc, child, depth + 1, nested)
    }
    return out
  }
  if (type === 'array') {
    return [exampleFor(doc, schema.items, depth + 1, nested)]
  }
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return true
  if (type === 'null') return null
  if (type === 'string') {
    const format = asString(schema.format)
    return FORMAT_SAMPLES[format] ?? 'string'
  }
  // No type at all: an empty object is the least misleading placeholder.
  return type ? 'string' : {}
}

/* ------------------------------------------------------------------ */
/* Swagger 2.0                                                         */
/* ------------------------------------------------------------------ */

/**
 * Brings a Swagger 2.0 document close enough to 3.x that one code path
 * handles both: a server list, `components.securitySchemes`, and operations
 * whose body lives in `requestBody` rather than in `parameters`.
 */
function fromSwagger2(doc: Json, warnings: string[]): Json {
  const schemes = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes : ['https']
  const host = asString(doc.host)
  const basePath = asString(doc.basePath)
  const servers = host ? [{ url: `${asString(schemes[0])}://${host}${basePath}` }] : []
  if (!host && basePath) servers.push({ url: basePath })

  const paths = isObject(doc.paths) ? doc.paths : {}
  const converted: Json = {}

  for (const [route, itemNode] of Object.entries(paths)) {
    if (!isObject(itemNode)) continue
    const item: Json = {}
    for (const [key, opNode] of Object.entries(itemNode)) {
      if (!METHODS.includes(key.toLowerCase()) || !isObject(opNode)) {
        item[key] = opNode
        continue
      }
      const op: Json = { ...opNode }
      const params = Array.isArray(op.parameters) ? op.parameters : []
      const kept: unknown[] = []
      const formFields: unknown[] = []
      let bodySchema: unknown

      for (const param of params) {
        const resolved = deref(doc, param)
        if (!resolved) continue
        const where = asString(resolved.in)
        if (where === 'body') bodySchema = resolved.schema
        else if (where === 'formData') formFields.push(resolved)
        else kept.push(resolved)
      }

      op.parameters = kept
      const consumes = Array.isArray(op.consumes)
        ? op.consumes
        : Array.isArray(doc.consumes)
          ? doc.consumes
          : []
      const mediaType = asString(consumes[0]) || 'application/json'

      if (bodySchema !== undefined) {
        op.requestBody = { content: { [mediaType]: { schema: bodySchema } } }
      } else if (formFields.length) {
        const properties: Json = {}
        for (const field of formFields) {
          if (isObject(field)) properties[asString(field.name)] = field
        }
        op.requestBody = {
          content: {
            [mediaType.includes('form') ? mediaType : 'application/x-www-form-urlencoded']: {
              schema: { type: 'object', properties }
            }
          }
        }
      }
      item[key] = op
    }
    converted[route] = item
  }

  const securityDefinitions = isObject(doc.securityDefinitions) ? doc.securityDefinitions : {}
  if (Object.keys(securityDefinitions).length) {
    warnings.push('Swagger 2.0 security definitions were mapped to their OpenAPI 3 equivalents.')
  }

  return {
    ...doc,
    servers,
    paths: converted,
    components: { securitySchemes: securityDefinitions, schemas: doc.definitions ?? {} }
  }
}

/* ------------------------------------------------------------------ */
/* Security                                                            */
/* ------------------------------------------------------------------ */

/**
 * The auth a security requirement implies.
 *
 * Only the shapes Frap can actually send are mapped; OAuth2 and OpenID
 * Connect become a bearer token, because in practice that is what you paste
 * once you have been through their flow elsewhere.
 */
function authFor(doc: Json, requirement: unknown, warnings: string[]): Auth | undefined {
  if (!isObject(requirement)) return undefined
  const schemes = isObject(doc.components) && isObject(doc.components.securitySchemes)
    ? doc.components.securitySchemes
    : {}

  for (const name of Object.keys(requirement)) {
    const scheme = deref(doc, schemes[name])
    if (!scheme) continue
    const type = asString(scheme.type).toLowerCase()
    const httpScheme = asString(scheme.scheme).toLowerCase()

    if (type === 'http' && httpScheme === 'basic') {
      return { type: 'basic', username: '{{USERNAME}}', password: '{{PASSWORD}}' }
    }
    if (type === 'http' || type === 'oauth2' || type === 'openidconnect') {
      if (type !== 'http') {
        warnings.push(
          `Security scheme "${name}" is ${type}; set up as a bearer token you paste in.`
        )
      }
      return { type: 'bearer', token: '{{TOKEN}}' }
    }
    if (type === 'apikey') {
      const where = asString(scheme.in).toLowerCase()
      if (where === 'cookie') {
        warnings.push(`Security scheme "${name}" uses a cookie, which is not set up automatically.`)
        continue
      }
      return {
        type: 'apikey',
        key: asString(scheme.name) || 'X-API-Key',
        value: '{{API_KEY}}',
        in: where === 'query' ? 'query' : 'header'
      }
    }
    // Swagger 2.0 spells basic auth as its own type.
    if (type === 'basic') {
      return { type: 'basic', username: '{{USERNAME}}', password: '{{PASSWORD}}' }
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

/** `/users/{id}` -> `/users/{{id}}`, so path parameters become variables. */
function templatePath(route: string): string {
  return route.replace(/\{([^}/]+)\}/g, (_, name: string) => `{{${String(name).trim()}}}`)
}

/** Turns a parameter into a row, disabled when the spec says it is optional. */
function paramRow(doc: Json, param: Json): KeyValue {
  const schema = deref(doc, param.schema) ?? {}
  const example =
    param.example ?? schema.example ?? schema.default ?? (Array.isArray(schema.enum) ? schema.enum[0] : undefined)
  const name = asString(param.name)
  return {
    enabled: param.required === true,
    key: name,
    value: example === undefined ? `{{${name}}}` : String(example),
    ...(param.description ? { description: asString(param.description) } : {})
  }
}

/** The media type to send, and whether Frap has a body mode for it. */
function pickContent(content: Json): { mediaType: string; schema: unknown; example: unknown } | null {
  const types = Object.keys(content)
  if (!types.length) return null
  // JSON first, whatever else the document also offers.
  const preferred =
    types.find((t) => t.includes('json')) ??
    types.find((t) => t.includes('x-www-form-urlencoded')) ??
    types.find((t) => t.includes('form-data')) ??
    types[0]
  const media = isObject(content[preferred]) ? (content[preferred] as Json) : {}
  const examples = isObject(media.examples) ? media.examples : undefined
  const firstExample = examples
    ? (Object.values(examples).find(isObject) as Json | undefined)?.value
    : undefined
  return {
    mediaType: preferred,
    schema: media.schema,
    example: media.example ?? firstExample
  }
}

function bodyFor(
  doc: Json,
  operation: Json,
  warnings: string[],
  label: string
): Partial<FrapRequest>['body'] {
  const requestBody = deref(doc, operation.requestBody)
  if (!requestBody || !isObject(requestBody.content)) return { mode: 'none' }

  const picked = pickContent(requestBody.content)
  if (!picked) return { mode: 'none' }

  const value = picked.example ?? exampleFor(doc, picked.schema)

  if (picked.mediaType.includes('json')) {
    return { mode: 'json', text: JSON.stringify(value ?? {}, null, 2) }
  }
  if (picked.mediaType.includes('x-www-form-urlencoded')) {
    const rows: KeyValue[] = isObject(value)
      ? Object.entries(value).map(([key, v]) => ({
          enabled: true,
          key,
          value: v === null || v === undefined ? '' : String(v)
        }))
      : []
    return { mode: 'urlencoded', urlencoded: rows }
  }
  if (picked.mediaType.includes('form-data')) {
    const fields = isObject(value)
      ? Object.entries(value).map(([key, v]) => ({
          enabled: true,
          key,
          type: 'text' as const,
          value: v === null || v === undefined ? '' : String(v)
        }))
      : []
    return { mode: 'form', form: fields }
  }
  if (picked.mediaType.includes('xml')) {
    warnings.push(`${label}: XML body left empty - only a JSON example can be generated.`)
    return { mode: 'xml', text: '' }
  }

  return {
    mode: 'text',
    text: typeof value === 'string' ? value : '',
    contentType: picked.mediaType
  }
}

/** summary, then operationId, then the method and path. */
function nameFor(operation: Json, method: string, route: string): string {
  const summary = asString(operation.summary).trim()
  if (summary) return summary
  const operationId = asString(operation.operationId).trim()
  if (operationId) {
    // camelCase and snake_case both read better with spaces.
    return operationId
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return `${method.toUpperCase()} ${route}`
}

function docsFor(operation: Json, route: string, method: string): string | undefined {
  const parts = [
    `${method.toUpperCase()} ${route}`,
    asString(operation.description).trim(),
    asString(operation.operationId) ? `operationId: ${asString(operation.operationId)}` : '',
    operation.deprecated === true ? 'Deprecated in the specification.' : ''
  ].filter(Boolean)
  return parts.length > 1 ? parts.join('\n\n') : undefined
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/** Recognises a document Frap cannot read, with a message worth showing. */
export function assertParseable(text: string): Json {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Nothing to import.')
  if (!trimmed.startsWith('{')) {
    throw new Error(
      trimmed.startsWith('openapi:') || trimmed.startsWith('swagger:') || /^[\w-]+:\s/.test(trimmed)
        ? 'That looks like YAML. Frap imports OpenAPI as JSON - convert it first.'
        : 'That is not a JSON document.'
    )
  }
  let doc: unknown
  try {
    doc = JSON.parse(trimmed)
  } catch (err) {
    throw new Error(`Not valid JSON: ${(err as Error).message}`)
  }
  if (!isObject(doc)) throw new Error('That is not an OpenAPI document.')
  if (!doc.openapi && !doc.swagger) {
    throw new Error('No "openapi" or "swagger" version field - is this an OpenAPI document?')
  }
  return doc
}

export function parseOpenApi(text: string, options: ParseOptions = {}): OpenApiPlan {
  const warnings: string[] = []
  const raw = assertParseable(text)
  const isV2 = !raw.openapi && asString(raw.swagger).startsWith('2')
  const doc = isV2 ? fromSwagger2(raw, warnings) : raw

  const baseVariable = options.baseVariable?.trim() || 'BASE_URL'
  const groupByTag = options.groupByTag !== false

  const info = isObject(doc.info) ? doc.info : {}
  const servers = (Array.isArray(doc.servers) ? doc.servers : [])
    .map((s) => (isObject(s) ? asString(s.url) : ''))
    .filter(Boolean)

  const globalSecurity = Array.isArray(doc.security) ? doc.security : []
  const auth = globalSecurity.length ? authFor(doc, globalSecurity[0], warnings) : undefined

  const paths = isObject(doc.paths) ? doc.paths : {}
  const requests: PlannedRequest[] = []
  let order = 0

  for (const [route, itemNode] of Object.entries(paths)) {
    const item = deref(doc, itemNode)
    if (!item) continue

    // Parameters declared once for the whole path apply to every operation.
    const shared = Array.isArray(item.parameters) ? item.parameters : []

    for (const method of METHODS) {
      const operation = isObject(item[method]) ? (item[method] as Json) : null
      if (!operation) continue

      const label = `${method.toUpperCase()} ${route}`
      const params: KeyValue[] = []
      const headers: KeyValue[] = []

      for (const param of [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
        const resolved = deref(doc, param)
        if (!resolved) {
          warnings.push(`${label}: a parameter used an external $ref and was skipped.`)
          continue
        }
        const where = asString(resolved.in).toLowerCase()
        if (where === 'query') params.push(paramRow(doc, resolved))
        else if (where === 'header') headers.push(paramRow(doc, resolved))
        // Path parameters already appear in the URL as {{name}}, and cookie
        // parameters have nowhere sensible to go.
        else if (where === 'cookie') {
          warnings.push(`${label}: cookie parameter "${asString(resolved.name)}" was skipped.`)
        }
      }

      const opSecurity = Array.isArray(operation.security) ? operation.security : null
      const ownAuth = opSecurity?.length ? authFor(doc, opSecurity[0], warnings) : undefined
      // An operation that opts out of security entirely says so with `[]`.
      const optedOut = opSecurity !== null && opSecurity.length === 0

      const tags = Array.isArray(operation.tags) ? operation.tags.filter((t) => asString(t)) : []
      const folder = groupByTag && tags.length ? asString(tags[0]) : ''

      requests.push({
        folder,
        request: {
          name: nameFor(operation, method, route),
          order: ++order,
          method: method.toUpperCase(),
          url: `{{${baseVariable}}}${templatePath(route)}`,
          params,
          headers,
          body: bodyFor(doc, operation, warnings, label),
          ...(ownAuth ? { auth: ownAuth } : optedOut ? { auth: { type: 'none' as const } } : {}),
          ...(docsFor(operation, route, method) ? { docs: docsFor(operation, route, method) } : {})
        }
      })
    }
  }

  if (!requests.length) warnings.push('The document declares no operations.')
  if (!servers.length) {
    warnings.push(`No server URL in the document - set ${baseVariable} yourself.`)
  }

  return {
    title: asString(info.title).trim() || 'API',
    version: asString(info.version).trim(),
    servers,
    ...(auth ? { auth } : {}),
    requests,
    warnings
  }
}
