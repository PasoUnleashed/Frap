/**
 * The request engine.
 *
 * Uses node:http/node:https directly rather than fetch, because an API client
 * needs things fetch will not give you: per-phase timings, manual redirect
 * inspection, a per-request TLS-verification toggle and duplicate headers.
 */
import * as http from 'node:http'
import * as https from 'node:https'
import * as zlib from 'node:zlib'
import { URL } from 'node:url'
import type { FrapResponse, Timings } from '../shared/types.ts'

/** Guard against a runaway download eating all memory. */
const MAX_BODY_BYTES = 128 * 1024 * 1024

export interface PreparedRequest {
  method: string
  url: string
  headers: [string, string][]
  body: Buffer | null
}

export interface SendOptions {
  timeoutMs: number
  followRedirects: boolean
  maxRedirects: number
  validateTls: boolean
  signal?: AbortSignal
}

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-ndjson|graphql|x-www-form-urlencoded)|application\/[\w.+-]*\+(json|xml))/i

export function isTextualContentType(contentType: string): boolean {
  if (!contentType) return true
  return TEXTUAL.test(contentType.trim())
}

function decompress(buffer: Buffer, encoding: string): Buffer {
  if (buffer.length === 0) return buffer
  try {
    switch (encoding.trim().toLowerCase()) {
      case 'gzip':
      case 'x-gzip':
        return zlib.gunzipSync(buffer)
      case 'deflate':
        return zlib.inflateSync(buffer)
      case 'br':
        return zlib.brotliDecompressSync(buffer)
      case 'zstd':
        return typeof zlib.zstdDecompressSync === 'function'
          ? zlib.zstdDecompressSync(buffer)
          : buffer
      default:
        return buffer
    }
  } catch {
    // A corrupt or mislabelled body is more useful raw than as an error.
    return buffer
  }
}

function headerPairs(raw: string[]): [string, string][] {
  const out: [string, string][] = []
  for (let i = 0; i < raw.length; i += 2) out.push([raw[i], raw[i + 1]])
  return out
}

/** Node lower-cases header names but keeps duplicates, which we must preserve. */
function toNodeHeaders(pairs: [string, string][]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of pairs) {
    const existing = out[key]
    if (existing === undefined) out[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else out[key] = [existing, value]
  }
  return out
}

interface HopResult {
  status: number
  statusText: string
  httpVersion: string
  headers: [string, string][]
  body: Buffer
  location?: string
  timings: Omit<Timings, 'totalMs' | 'startedAt'>
}

function sendOnce(
  prep: PreparedRequest,
  opts: SendOptions,
  startedAt: number
): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    let url: URL
    try {
      url = new URL(prep.url)
    } catch {
      reject(new Error(`Invalid URL: ${prep.url || '(empty)'}`))
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new Error(`Unsupported protocol: ${url.protocol}`))
      return
    }

    const isTls = url.protocol === 'https:'
    const transport = isTls ? https : http
    const timings: HopResult['timings'] = {}
    const mark = (): number => Math.round(performance.now() - startedAt)

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isTls ? 443 : 80),
        path: url.pathname + url.search,
        method: prep.method,
        headers: toNodeHeaders(prep.headers),
        // Frap sends the request exactly as configured; redirects are followed
        // by the caller so each hop stays visible.
        ...(isTls ? { rejectUnauthorized: opts.validateTls } : {})
      },
      (res) => {
        timings.firstByteMs = mark()
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > MAX_BODY_BYTES) {
            req.destroy(new Error(`Response exceeded ${MAX_BODY_BYTES} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          const encoding = (res.headers['content-encoding'] as string) || ''
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            httpVersion: res.httpVersion,
            headers: headerPairs(res.rawHeaders),
            body: encoding ? decompress(raw, encoding) : raw,
            location: res.headers.location,
            timings
          })
        })
        res.on('error', reject)
      }
    )

    req.on('socket', (socket) => {
      if (socket.connecting === false) return // reused from the pool
      socket.once('lookup', () => {
        timings.dnsMs = mark()
      })
      socket.once('connect', () => {
        timings.connectMs = mark()
      })
      socket.once('secureConnect', () => {
        timings.tlsMs = mark()
      })
    })

    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new Error(`Timed out after ${opts.timeoutMs} ms`))
    })
    req.on('error', reject)

    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy(new Error('Cancelled'))
      } else {
        opts.signal.addEventListener('abort', () => req.destroy(new Error('Cancelled')), {
          once: true
        })
      }
    }

    if (prep.body && prep.body.length) req.write(prep.body)
    req.end()
  })
}

/** A redirect drops the body, and only 307/308 keep the original method. */
function nextHop(prep: PreparedRequest, hop: HopResult, location: string): PreparedRequest {
  const keepMethod = hop.status === 307 || hop.status === 308
  const method = keepMethod ? prep.method : prep.method === 'HEAD' ? 'HEAD' : 'GET'
  const target = new URL(location, prep.url)
  const sameOrigin = new URL(prep.url).origin === target.origin
  const headers = prep.headers.filter(([k]) => {
    const lower = k.toLowerCase()
    if (!keepMethod && (lower === 'content-type' || lower === 'content-length')) return false
    // Never leak credentials to a different origin.
    if (!sameOrigin && (lower === 'authorization' || lower === 'cookie')) return false
    return true
  })
  return { method, url: target.toString(), headers, body: keepMethod ? prep.body : null }
}

export async function sendHttp(
  prep: PreparedRequest,
  opts: SendOptions
): Promise<FrapResponse> {
  const startedAt = performance.now()
  const wallClockStart = Date.now()
  const redirects: string[] = []
  let current = prep
  let hop = await sendOnce(current, opts, startedAt)

  while (
    opts.followRedirects &&
    hop.status >= 300 &&
    hop.status < 400 &&
    hop.location &&
    redirects.length < opts.maxRedirects
  ) {
    redirects.push(current.url)
    current = nextHop(current, hop, hop.location)
    hop = await sendOnce(current, opts, startedAt)
  }

  const contentType = hop.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
  const textual = isTextualContentType(contentType.split(';')[0])

  return {
    status: hop.status,
    statusText: hop.statusText,
    httpVersion: hop.httpVersion,
    headers: hop.headers,
    bodyText: textual ? hop.body.toString('utf8') : '',
    bodyBase64: textual ? '' : hop.body.toString('base64'),
    isBinary: !textual,
    size: hop.body.length,
    contentType,
    finalUrl: current.url,
    redirects,
    timings: {
      startedAt: wallClockStart,
      ...hop.timings,
      totalMs: Math.round(performance.now() - startedAt)
    }
  }
}
