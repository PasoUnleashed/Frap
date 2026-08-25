/**
 * cURL interop, both directions.
 *
 * Export writes a multi-line command with every `{{VARIABLE}}` already
 * resolved against the active environment, so what you paste into a terminal
 * or a bug report is exactly what Frap would send.
 *
 * Import goes the other way: paste anything the browser devtools "Copy as
 * cURL" button produced and get a real request file back.
 */

import { randomUUID } from 'node:crypto'
import {
  FILE_FORMAT,
  type Auth,
  type FormField,
  type FrapRequest,
  type KeyValue,
  type RequestBody
} from '../shared/types.ts'
import type { MutableRequest } from './prepare.ts'

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** Single-quote for POSIX shells: the only character needing care is `'`. */
const q = (value: string): string => `'` + value.replace(/'/g, `'\\''`) + `'`

export interface CurlExportOptions {
  followRedirects: boolean
  validateTls: boolean
}

/**
 * Builds the command from the *resolved* request, so it reflects the active
 * environment. File-backed bodies stay as `@path` references rather than
 * being inlined, which keeps the command readable and re-runnable.
 */
export function toCurl(
  request: FrapRequest,
  mutable: MutableRequest,
  options: CurlExportOptions
): string {
  const parts: string[] = ['curl']

  if (mutable.method !== 'GET') parts.push(`--request ${mutable.method}`)
  parts.push(`--url ${q(mutable.url)}`)

  const headers = new Map(Object.entries(mutable.headers).filter(([k]) => k.trim()))
  const hasHeader = (name: string): boolean =>
    [...headers.keys()].some((k) => k.toLowerCase() === name)

  // Mirror the content type the engine would apply, so the command behaves
  // the same way when replayed.
  if (request.body.mode === 'form') {
    for (const key of [...headers.keys()]) {
      if (key.toLowerCase() === 'content-type') headers.delete(key)
    }
  } else if (mutable.body && mutable.bodyContentType && !hasHeader('content-type')) {
    headers.set('Content-Type', mutable.bodyContentType)
  }

  for (const [key, value] of headers) parts.push(`--header ${q(`${key}: ${value}`)}`)

  switch (request.body.mode) {
    case 'form':
      for (const field of request.body.form ?? []) {
        if (!field.enabled || !field.key.trim()) continue
        const spec =
          field.type === 'file'
            ? `${field.key}=@${field.value}`
            : `${field.key}=${field.value}`
        parts.push(`--form ${q(spec)}`)
      }
      break
    case 'binary':
      if (request.body.filePath) parts.push(`--data-binary ${q('@' + request.body.filePath)}`)
      break
    case 'none':
      break
    default:
      if (mutable.body) parts.push(`--data-raw ${q(mutable.body)}`)
  }

  if (options.followRedirects) parts.push('--location')
  if (!options.validateTls) parts.push('--insecure')
  parts.push('--compressed')

  return parts.join(' \\\n  ')
}

/* ------------------------------------------------------------------ */
/* Import: tokenising                                                  */
/* ------------------------------------------------------------------ */

/**
 * Splits a pasted command into argv.
 *
 * Handles the three continuation styles people paste (`\` from bash, `^` from
 * cmd, a backtick from PowerShell), single and double quotes, and backslash
 * escapes inside double quotes.
 */
export function tokenizeCurl(input: string): string[] {
  // Collapse line continuations first so the rest is a single logical line.
  const text = input
    .replace(/\\\r?\n/g, ' ')
    .replace(/\^\r?\n/g, ' ')
    .replace(/`\r?\n/g, ' ')
    .trim()

  const tokens: string[] = []
  let current = ''
  let has = false
  let i = 0

  const push = (): void => {
    if (has) tokens.push(current)
    current = ''
    has = false
  }

  while (i < text.length) {
    const c = text[i]

    if (c === "'") {
      has = true
      i++
      while (i < text.length && text[i] !== "'") current += text[i++]
      i++ // closing quote
      continue
    }

    if (c === '"') {
      has = true
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          const next = text[i + 1]
          // Only these are real escapes in a double-quoted shell string;
          // anything else keeps its backslash.
          current += '\\"$`'.includes(next) ? next : '\\' + next
          i += 2
          continue
        }
        current += text[i++]
      }
      i++
      continue
    }

    if (c === '\\' && i + 1 < text.length) {
      current += text[i + 1]
      has = true
      i += 2
      continue
    }

    if (/\s/.test(c)) {
      push()
      i++
      continue
    }

    current += c
    has = true
    i++
  }
  push()

  return tokens
}

/* ------------------------------------------------------------------ */
/* Import: parsing                                                     */
/* ------------------------------------------------------------------ */

/** Long options that take a value. */
const VALUE_FLAGS = new Set([
  '--request',
  '--header',
  '--data',
  '--data-raw',
  '--data-ascii',
  '--data-binary',
  '--data-urlencode',
  '--json',
  '--form',
  '--form-string',
  '--user',
  '--user-agent',
  '--referer',
  '--cookie',
  '--url',
  '--upload-file',
  '--range',
  '--connect-timeout',
  '--max-time',
  '--proxy',
  '--cert',
  '--key',
  '--output',
  '--write-out',
  '--resolve',
  '--retry'
])

/** Short options that take a value. */
const SHORT_VALUE = 'XHdFuAebTomw'

const SHORT_TO_LONG: Record<string, string> = {
  X: '--request',
  H: '--header',
  d: '--data',
  F: '--form',
  u: '--user',
  A: '--user-agent',
  e: '--referer',
  b: '--cookie',
  T: '--upload-file',
  L: '--location',
  k: '--insecure',
  I: '--head',
  G: '--get',
  s: '--silent',
  S: '--show-error',
  i: '--include',
  v: '--verbose',
  o: '--output'
}

interface ParsedFlags {
  method?: string
  url?: string
  headers: Array<[string, string]>
  data: string[]
  dataUrlencode: string[]
  forms: string[]
  user?: string
  uploadFile?: string
  isJson: boolean
  head: boolean
  get: boolean
  insecure: boolean
  location: boolean
}

function collectFlags(tokens: string[]): ParsedFlags {
  const out: ParsedFlags = {
    headers: [],
    data: [],
    dataUrlencode: [],
    forms: [],
    isJson: false,
    head: false,
    get: false,
    insecure: false,
    location: false
  }

  let i = 0
  // Skip a leading `curl`, and anything before it (e.g. a shell prompt).
  const start = tokens.findIndex((t) => t === 'curl' || t.endsWith('/curl') || t.endsWith('curl.exe'))
  i = start === -1 ? 0 : start + 1

  const apply = (flag: string, value?: string): void => {
    switch (flag) {
      case '--request':
        if (value) out.method = value.toUpperCase()
        break
      case '--url':
        if (value) out.url = value
        break
      case '--header':
        if (value) {
          const at = value.indexOf(':')
          if (at > 0) out.headers.push([value.slice(0, at).trim(), value.slice(at + 1).trim()])
        }
        break
      case '--data':
      case '--data-raw':
      case '--data-ascii':
      case '--data-binary':
        if (value !== undefined) out.data.push(value)
        break
      case '--json':
        if (value !== undefined) {
          out.data.push(value)
          out.isJson = true
        }
        break
      case '--data-urlencode':
        if (value !== undefined) out.dataUrlencode.push(value)
        break
      case '--form':
      case '--form-string':
        if (value !== undefined) out.forms.push(value)
        break
      case '--user':
        out.user = value
        break
      case '--user-agent':
        if (value) out.headers.push(['User-Agent', value])
        break
      case '--referer':
        if (value) out.headers.push(['Referer', value])
        break
      case '--cookie':
        if (value) out.headers.push(['Cookie', value])
        break
      case '--upload-file':
        out.uploadFile = value
        break
      case '--head':
        out.head = true
        break
      case '--get':
        out.get = true
        break
      case '--insecure':
        out.insecure = true
        break
      case '--location':
        out.location = true
        break
      default:
        break
    }
  }

  while (i < tokens.length) {
    const token = tokens[i]

    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      if (eq !== -1) {
        apply(token.slice(0, eq), token.slice(eq + 1))
        i++
        continue
      }
      if (VALUE_FLAGS.has(token)) {
        apply(token, tokens[++i])
        i++
        continue
      }
      apply(token)
      i++
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      // Short options bundle, e.g. `-sSL`, `-XPOST` or `-H 'a: b'`.
      for (let c = 1; c < token.length; c++) {
        const letter = token[c]
        const long = SHORT_TO_LONG[letter] ?? ''
        if (SHORT_VALUE.includes(letter)) {
          // The value is either glued on (`-XPOST`) or the next token.
          const inline = token.slice(c + 1)
          if (inline) apply(long, inline)
          else apply(long, tokens[++i])
          break
        }
        apply(long)
      }
      i++
      continue
    }

    // A bare argument is the URL.
    if (!out.url) out.url = token
    i++
  }

  return out
}

function decodeParams(search: string): KeyValue[] {
  const rows: KeyValue[] = []
  for (const pair of search.replace(/^\?/, '').split('&')) {
    if (!pair) continue
    const at = pair.indexOf('=')
    const key = at === -1 ? pair : pair.slice(0, at)
    const value = at === -1 ? '' : pair.slice(at + 1)
    rows.push({
      enabled: true,
      key: safeDecode(key),
      value: safeDecode(value)
    })
  }
  return rows
}

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

function parseFormField(spec: string): FormField | null {
  const at = spec.indexOf('=')
  if (at <= 0) return null
  const key = spec.slice(0, at)
  const raw = spec.slice(at + 1)
  if (raw.startsWith('@') || raw.startsWith('<')) {
    // `@path` uploads the file; `;type=` may follow.
    const [pathPart, ...rest] = raw.slice(1).split(';')
    const typeOption = rest.find((r) => r.startsWith('type='))
    return {
      enabled: true,
      key,
      type: 'file',
      value: pathPart,
      ...(typeOption ? { contentType: typeOption.slice(5) } : {})
    }
  }
  return { enabled: true, key, type: 'text', value: raw }
}

function prettyJson(text: string): { ok: boolean; text: string } {
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(text), null, 2) }
  } catch {
    return { ok: false, text }
  }
}

function nameFromUrl(url: string, method: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1]
    if (last && !/^\d+$/.test(last)) return `${method} ${decodeURIComponent(last)}`
    if (segments.length > 1) return `${method} ${decodeURIComponent(segments[segments.length - 2])}`
    return `${method} ${parsed.hostname}`
  } catch {
    return `${method} request`
  }
}

export interface ImportedCurl {
  request: FrapRequest
  /** Anything we recognised but could not represent, shown as a warning. */
  warnings: string[]
}

/**
 * Turns a pasted cURL command into a request.
 *
 * `scope` is the active environment. When `substitute` is on, any value that
 * exactly matches an environment variable is written back as `{{NAME}}`, which
 * is usually what you want after copying a request out of devtools.
 */
export function parseCurl(
  input: string,
  scope: Record<string, string> = {},
  substitute = true
): ImportedCurl {
  const warnings: string[] = []
  const tokens = tokenizeCurl(input)
  if (tokens.length === 0) throw new Error('Nothing to import')

  const flags = collectFlags(tokens)
  if (!flags.url) throw new Error('No URL found in that command')

  let urlText = flags.url
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlText)) urlText = 'https://' + urlText

  let parsedUrl: URL
  try {
    parsedUrl = new URL(urlText)
  } catch {
    throw new Error(`Could not parse the URL: ${flags.url}`)
  }

  const params = decodeParams(parsedUrl.search)

  /* -- body ------------------------------------------------------- */

  const body: RequestBody = { mode: 'none' }
  const dataParts = [
    ...flags.data,
    ...flags.dataUrlencode.map((d) => {
      const at = d.indexOf('=')
      if (at === -1) return encodeURIComponent(d)
      return `${d.slice(0, at)}=${encodeURIComponent(d.slice(at + 1))}`
    })
  ]
  const joined = dataParts.join('&')

  const headerValue = (name: string): string | undefined =>
    flags.headers.find(([k]) => k.toLowerCase() === name)?.[1]
  const contentType = (headerValue('content-type') ?? (flags.isJson ? 'application/json' : ''))
    .split(';')[0]
    .trim()
    .toLowerCase()

  if (flags.forms.length) {
    body.mode = 'form'
    body.form = flags.forms.map(parseFormField).filter((f): f is FormField => f !== null)
  } else if (flags.uploadFile) {
    body.mode = 'binary'
    body.filePath = flags.uploadFile
  } else if (joined) {
    if (flags.get) {
      // `-G` moves the data into the query string instead of the body.
      params.push(...decodeParams(joined))
    } else if (contentType === 'application/x-www-form-urlencoded') {
      body.mode = 'urlencoded'
      body.urlencoded = decodeParams(joined)
    } else if (contentType === 'application/json' || prettyJson(joined).ok) {
      body.mode = 'json'
      body.text = prettyJson(joined).text
    } else if (contentType.includes('xml')) {
      body.mode = 'xml'
      body.text = joined
    } else {
      body.mode = 'text'
      body.text = joined
      if (contentType) body.contentType = contentType
    }
  }

  /* -- method ------------------------------------------------------ */

  const method =
    flags.method ??
    (flags.head ? 'HEAD' : body.mode !== 'none' && !flags.get ? 'POST' : 'GET')

  /* -- auth -------------------------------------------------------- */

  let auth: Auth = { type: 'none' }
  const headers: KeyValue[] = []

  for (const [key, value] of flags.headers) {
    const lower = key.toLowerCase()
    if (lower === 'authorization') {
      const bearer = /^Bearer\s+(.+)$/i.exec(value)
      if (bearer) {
        auth = { type: 'bearer', token: bearer[1] }
        continue
      }
      const basic = /^Basic\s+(.+)$/i.exec(value)
      if (basic) {
        try {
          const decoded = Buffer.from(basic[1], 'base64').toString('utf8')
          const at = decoded.indexOf(':')
          if (at !== -1) {
            auth = { type: 'basic', username: decoded.slice(0, at), password: decoded.slice(at + 1) }
            continue
          }
        } catch {
          // Not decodable - keep it as a plain header.
        }
      }
    }
    // Set automatically by the engine; keeping them would only cause drift.
    if (lower === 'content-length' || lower === 'host') continue
    if (lower === 'content-type' && (body.mode === 'form' || body.mode === 'json')) continue
    headers.push({ enabled: true, key, value })
  }

  if (flags.user) {
    const at = flags.user.indexOf(':')
    auth =
      at === -1
        ? { type: 'basic', username: flags.user, password: '' }
        : { type: 'basic', username: flags.user.slice(0, at), password: flags.user.slice(at + 1) }
  }

  /* -- environment substitution ------------------------------------ */

  const origin = parsedUrl.origin
  let url = origin + parsedUrl.pathname

  if (substitute) {
    // Longest values first, so a base URL wins over a shorter fragment.
    const candidates = Object.entries(scope)
      .filter(([, value]) => value.length >= 4)
      .sort((a, b) => b[1].length - a[1].length)

    const replace = (text: string, wholeValueOnly: boolean): string => {
      for (const [name, value] of candidates) {
        if (wholeValueOnly) {
          if (text === value) return `{{${name}}}`
        } else if (text.includes(value)) {
          text = text.split(value).join(`{{${name}}}`)
        }
      }
      return text
    }

    url = replace(url, false)
    for (const row of params) row.value = replace(row.value, true)
    for (const row of headers) row.value = replace(row.value, true)
    if (auth.type === 'bearer' && auth.token) auth.token = replace(auth.token, true)
    if (auth.type === 'basic') {
      if (auth.username) auth.username = replace(auth.username, true)
      if (auth.password) auth.password = replace(auth.password, true)
    }
  }

  /* -- leftovers ---------------------------------------------------- */

  if (flags.insecure) {
    warnings.push('`--insecure` applies per workspace: turn off "Verify TLS certificates" in settings.')
  }
  if (tokens.some((t) => t === '--proxy' || t === '-x')) {
    warnings.push('Proxy settings were ignored.')
  }
  if (tokens.some((t) => t === '--cert' || t === '--key')) {
    warnings.push('Client certificates were ignored.')
  }

  const name = nameFromUrl(parsedUrl.toString(), method)

  return {
    warnings,
    request: {
      frap: FILE_FORMAT,
      id: randomUUID(),
      name,
      order: 0,
      method,
      url,
      params,
      headers,
      auth,
      body,
      scripts: { preRequest: '', postResponse: '' }
    }
  }
}
