/**
 * Turns a stored request plus the resolved variable scope into the exact bytes
 * that go on the wire.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FrapRequest, KeyValue } from '../shared/types.ts'
import { interpolate } from './interpolate.ts'
import type { PreparedRequest } from './http.ts'

const MIME_BY_EXT: Record<string, string> = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream'
}

const guessMime = (file: string): string =>
  MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

const enabled = (rows: KeyValue[] | undefined): KeyValue[] =>
  (rows ?? []).filter((r) => r.enabled && r.key.trim() !== '')

export interface PrepareContext {
  /** Workspace root, used to resolve relative file paths in bodies. */
  root: string
  scope: Record<string, string>
  /** Collects `{{names}}` that had no value, for a warning in the UI. */
  missing: Set<string>
  /**
   * Sent as User-Agent unless the request sets its own. Passed in rather than
   * written here, so the version can come from the running app and cannot
   * drift from package.json.
   */
  userAgent?: string
}

/** The mutable request shape scripts see as `frap.request`. */
export interface MutableRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  bodyContentType: string | null
}

function contentTypeFor(req: FrapRequest): string | null {
  if (req.body.contentType) return req.body.contentType
  switch (req.body.mode) {
    case 'json':
    case 'graphql':
      return 'application/json'
    case 'xml':
      return 'application/xml'
    case 'text':
      return 'text/plain'
    case 'urlencoded':
      return 'application/x-www-form-urlencoded'
    default:
      return null
  }
}

/**
 * Resolves variables and produces the plain object handed to the pre-request
 * script. Multipart and binary bodies stay on disk until after scripts run.
 */
export function toMutable(req: FrapRequest, ctx: PrepareContext): MutableRequest {
  const sub = (s: string): string => interpolate(s, ctx.scope, ctx.missing)

  let url = sub(req.url).trim()
  const params = enabled(req.params)
  if (params.length) {
    const query = params
      .map((p) => `${encodeURIComponent(sub(p.key))}=${encodeURIComponent(sub(p.value))}`)
      .join('&')
    url += (url.includes('?') ? '&' : '?') + query
  }

  const headers: Record<string, string> = {}
  for (const h of enabled(req.headers)) headers[sub(h.key)] = sub(h.value)

  switch (req.auth.type) {
    case 'bearer':
      headers.Authorization = `Bearer ${sub(req.auth.token ?? '')}`
      break
    case 'basic': {
      const pair = `${sub(req.auth.username ?? '')}:${sub(req.auth.password ?? '')}`
      headers.Authorization = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`
      break
    }
    case 'apikey': {
      const key = sub(req.auth.key ?? '')
      const value = sub(req.auth.value ?? '')
      if (key) {
        if (req.auth.in === 'query') url += (url.includes('?') ? '&' : '?') +
          `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
        else headers[key] = value
      }
      break
    }
    default:
      break
  }

  let body: string | null = null
  switch (req.body.mode) {
    case 'json':
    case 'text':
    case 'xml':
      body = sub(req.body.text ?? '')
      break
    case 'graphql': {
      let variables: unknown = {}
      const rawVars = sub(req.body.graphqlVariables ?? '').trim()
      if (rawVars) {
        try {
          variables = JSON.parse(rawVars)
        } catch (err) {
          throw new Error(`GraphQL variables are not valid JSON: ${(err as Error).message}`)
        }
      }
      body = JSON.stringify({ query: sub(req.body.text ?? ''), variables })
      break
    }
    case 'urlencoded':
      body = req.body.urlencoded?.length
        ? enabled(req.body.urlencoded)
            .map((p) => `${encodeURIComponent(sub(p.key))}=${encodeURIComponent(sub(p.value))}`)
            .join('&')
        : sub(req.body.text ?? '')
      break
    default:
      body = null
  }

  return {
    method: req.method.toUpperCase(),
    url,
    headers,
    body,
    bodyContentType: contentTypeFor(req)
  }
}

async function buildMultipart(
  req: FrapRequest,
  ctx: PrepareContext
): Promise<{ body: Buffer; contentType: string }> {
  const sub = (s: string): string => interpolate(s, ctx.scope, ctx.missing)
  const boundary = `----FrapBoundary${randomBytes(12).toString('hex')}`
  const parts: Buffer[] = []

  for (const field of req.body.form ?? []) {
    if (!field.enabled || !field.key.trim()) continue
    const name = sub(field.key)
    if (field.type === 'file') {
      const filePath = path.resolve(ctx.root, sub(field.value))
      const contents = await fs.readFile(filePath)
      const type = field.contentType || guessMime(filePath)
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; ` +
            `filename="${path.basename(filePath)}"\r\nContent-Type: ${type}\r\n\r\n`,
          'utf8'
        ),
        contents,
        Buffer.from('\r\n', 'utf8')
      )
    } else {
      const typeLine = field.contentType ? `Content-Type: ${field.contentType}\r\n` : ''
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n` +
            `${typeLine}\r\n${sub(field.value)}\r\n`,
          'utf8'
        )
      )
    }
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * Final step: applies whatever the pre-request script changed and reads any
 * file-backed body from disk.
 */
export async function finalize(
  req: FrapRequest,
  mutable: MutableRequest,
  ctx: PrepareContext
): Promise<PreparedRequest> {
  const headers = new Map<string, string>()
  for (const [key, value] of Object.entries(mutable.headers)) {
    if (key.trim()) headers.set(key, value)
  }

  const hasHeader = (name: string): boolean =>
    [...headers.keys()].some((k) => k.toLowerCase() === name)

  let body: Buffer | null = null

  if (req.body.mode === 'form') {
    const { body: buf, contentType } = await buildMultipart(req, ctx)
    body = buf
    // The boundary must match the body we just built, so it always wins.
    for (const key of [...headers.keys()]) {
      if (key.toLowerCase() === 'content-type') headers.delete(key)
    }
    headers.set('Content-Type', contentType)
  } else if (req.body.mode === 'binary') {
    const filePath = path.resolve(ctx.root, interpolate(req.body.filePath ?? '', ctx.scope, ctx.missing))
    body = await fs.readFile(filePath)
    if (!hasHeader('content-type')) {
      headers.set('Content-Type', req.body.contentType || guessMime(filePath))
    }
  } else if (mutable.body !== null && mutable.body !== '') {
    body = Buffer.from(mutable.body, 'utf8')
    if (!hasHeader('content-type') && mutable.bodyContentType) {
      headers.set('Content-Type', mutable.bodyContentType)
    }
  }

  if (!hasHeader('user-agent')) headers.set('User-Agent', ctx.userAgent || 'Frap')
  if (!hasHeader('accept')) headers.set('Accept', '*/*')
  if (!hasHeader('accept-encoding')) headers.set('Accept-Encoding', 'gzip, deflate, br')
  if (body && !hasHeader('content-length')) headers.set('Content-Length', String(body.length))

  return {
    method: mutable.method.toUpperCase(),
    url: mutable.url,
    headers: [...headers.entries()],
    body
  }
}
