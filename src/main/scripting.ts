/**
 * The pre-request / post-response script sandbox.
 *
 * Scripts run in a node:vm context in the main process. The body is wrapped in
 * an async IIFE so `await` works, which is what makes `frap.env.set` after a
 * token fetch, or an async assertion, natural to write.
 *
 * Environment writes are buffered here and flushed to the .env file in one
 * pass once the script finishes, so a script that throws halfway does not
 * leave the file half-updated.
 */
import * as vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import type { FrapResponse, LogEntry, TestResult } from '../shared/types.ts'
import type { MutableRequest } from './prepare.ts'

export const SCRIPT_TIMEOUT_MS = 30_000

export interface EnvWriteRecord {
  key: string
  value: string | null
}

export interface ScriptContext {
  phase: 'pre' | 'post'
  /** Resolved variables; script writes update this in place. */
  scope: Record<string, string>
  /** Session-scoped values that never touch disk. */
  vars: Map<string, string>
  request: MutableRequest
  response?: FrapResponse
  /** Populated as the script calls `frap.env.set` / `frap.env.unset`. */
  envWrites: EnvWriteRecord[]
  logs: LogEntry[]
  tests: TestResult[]
  /** Set by `frap.skipRequest()` in a pre-request script. */
  skipped?: boolean
}

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

function stringify(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  )
}

interface Matchers {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toBeTruthy(): void
  toBeFalsy(): void
  toBeDefined(): void
  toBeUndefined(): void
  toBeNull(): void
  toContain(needle: unknown): void
  toMatch(pattern: RegExp | string): void
  toHaveProperty(key: string, expected?: unknown): void
  toHaveLength(length: number): void
  toBeGreaterThan(n: number): void
  toBeGreaterThanOrEqual(n: number): void
  toBeLessThan(n: number): void
  toBeLessThanOrEqual(n: number): void
  toBeOneOf(values: unknown[]): void
  toBeTypeOf(type: string): void
  readonly not: Matchers
}

function makeExpect(actual: unknown, negated = false): Matchers {
  const check = (pass: boolean, message: string, inverse: string): void => {
    if (pass === negated) throw new Error(negated ? inverse : message)
  }
  const a = stringify(actual)

  const matchers: Matchers = {
    toBe: (expected) =>
      check(Object.is(actual, expected), `expected ${a} to be ${stringify(expected)}`,
        `expected ${a} not to be ${stringify(expected)}`),
    toEqual: (expected) =>
      check(deepEqual(actual, expected), `expected ${a} to equal ${stringify(expected)}`,
        `expected ${a} not to equal ${stringify(expected)}`),
    toBeTruthy: () =>
      check(Boolean(actual), `expected ${a} to be truthy`, `expected ${a} not to be truthy`),
    toBeFalsy: () =>
      check(!actual, `expected ${a} to be falsy`, `expected ${a} not to be falsy`),
    toBeDefined: () =>
      check(actual !== undefined, `expected value to be defined`, `expected value to be undefined`),
    toBeUndefined: () =>
      check(actual === undefined, `expected ${a} to be undefined`, `expected value to be defined`),
    toBeNull: () =>
      check(actual === null, `expected ${a} to be null`, `expected ${a} not to be null`),
    toContain: (needle) => {
      const pass =
        typeof actual === 'string'
          ? actual.includes(String(needle))
          : Array.isArray(actual) && actual.some((item) => deepEqual(item, needle))
      check(pass, `expected ${a} to contain ${stringify(needle)}`,
        `expected ${a} not to contain ${stringify(needle)}`)
    },
    toMatch: (pattern) => {
      const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern))
      check(re.test(String(actual)), `expected ${a} to match ${re}`,
        `expected ${a} not to match ${re}`)
    },
    toHaveProperty: (key, expected) => {
      const parts = key.split('.')
      let cursor: unknown = actual
      let found = true
      for (const part of parts) {
        if (cursor === null || typeof cursor !== 'object' || !(part in (cursor as object))) {
          found = false
          break
        }
        cursor = (cursor as Record<string, unknown>)[part]
      }
      const pass = found && (expected === undefined || deepEqual(cursor, expected))
      check(pass,
        `expected value to have property ${key}` +
          (expected === undefined ? '' : ` equal to ${stringify(expected)}, got ${stringify(cursor)}`),
        `expected value not to have property ${key}`)
    },
    toHaveLength: (length) => {
      const actualLength = (actual as { length?: number })?.length
      check(actualLength === length, `expected length ${actualLength} to be ${length}`,
        `expected length not to be ${length}`)
    },
    toBeGreaterThan: (n) =>
      check(Number(actual) > n, `expected ${a} to be greater than ${n}`,
        `expected ${a} not to be greater than ${n}`),
    toBeGreaterThanOrEqual: (n) =>
      check(Number(actual) >= n, `expected ${a} to be >= ${n}`, `expected ${a} not to be >= ${n}`),
    toBeLessThan: (n) =>
      check(Number(actual) < n, `expected ${a} to be less than ${n}`,
        `expected ${a} not to be less than ${n}`),
    toBeLessThanOrEqual: (n) =>
      check(Number(actual) <= n, `expected ${a} to be <= ${n}`, `expected ${a} not to be <= ${n}`),
    toBeOneOf: (values) =>
      check(values.some((v) => deepEqual(v, actual)), `expected ${a} to be one of ${stringify(values)}`,
        `expected ${a} not to be one of ${stringify(values)}`),
    toBeTypeOf: (type) =>
      check(typeof actual === type, `expected ${a} to be of type ${type}, got ${typeof actual}`,
        `expected ${a} not to be of type ${type}`),
    get not() {
      return makeExpect(actual, !negated)
    }
  }
  return matchers
}

/* ------------------------------------------------------------------ */
/* Sandbox                                                             */
/* ------------------------------------------------------------------ */

function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`
      try {
        return JSON.stringify(arg, null, 2) ?? String(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

class SkipRequest extends Error {}

function buildFrapApi(ctx: ScriptContext, pending: Promise<void>[]): Record<string, unknown> {
  const log = (level: LogEntry['level']) => (...args: unknown[]): void => {
    ctx.logs.push({ level, phase: ctx.phase, message: formatLogArgs(args), time: Date.now() })
  }

  const env = {
    get: (key: string): string | undefined => ctx.scope[key],
    has: (key: string): boolean => ctx.scope[key] !== undefined,
    all: (): Record<string, string> => ({ ...ctx.scope }),
    set: (key: string, value: unknown): void => {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
        throw new Error(`Not a valid environment variable name: ${JSON.stringify(key)}`)
      }
      const text = typeof value === 'string' ? value : String(value)
      ctx.scope[key] = text
      ctx.envWrites.push({ key, value: text })
    },
    unset: (key: string): void => {
      delete ctx.scope[key]
      ctx.envWrites.push({ key, value: null })
    }
  }

  const vars = {
    get: (key: string): string | undefined => ctx.vars.get(key),
    has: (key: string): boolean => ctx.vars.has(key),
    set: (key: string, value: unknown): void => {
      const text = typeof value === 'string' ? value : String(value)
      ctx.vars.set(key, text)
      ctx.scope[key] = text
    },
    unset: (key: string): void => {
      ctx.vars.delete(key)
      delete ctx.scope[key]
    },
    all: (): Record<string, string> => Object.fromEntries(ctx.vars)
  }

  const request = {
    get method(): string {
      return ctx.request.method
    },
    set method(value: string) {
      ctx.request.method = String(value).toUpperCase()
    },
    get url(): string {
      return ctx.request.url
    },
    set url(value: string) {
      ctx.request.url = String(value)
    },
    get headers(): Record<string, string> {
      return ctx.request.headers
    },
    get body(): string | null {
      return ctx.request.body
    },
    set body(value: string | null) {
      ctx.request.body = value === null ? null : String(value)
    },
    setHeader(name: string, value: unknown): void {
      // Replace case-insensitively so scripts do not create duplicates.
      for (const key of Object.keys(ctx.request.headers)) {
        if (key.toLowerCase() === name.toLowerCase()) delete ctx.request.headers[key]
      }
      ctx.request.headers[name] = String(value)
    },
    getHeader(name: string): string | undefined {
      const key = Object.keys(ctx.request.headers).find(
        (k) => k.toLowerCase() === name.toLowerCase()
      )
      return key ? ctx.request.headers[key] : undefined
    },
    removeHeader(name: string): void {
      for (const key of Object.keys(ctx.request.headers)) {
        if (key.toLowerCase() === name.toLowerCase()) delete ctx.request.headers[key]
      }
    },
    json(): unknown {
      return ctx.request.body ? JSON.parse(ctx.request.body) : undefined
    },
    setJson(value: unknown): void {
      ctx.request.body = JSON.stringify(value)
      ctx.request.bodyContentType = 'application/json'
    }
  }

  const api: Record<string, unknown> = {
    env,
    vars,
    variables: vars,
    request,
    console: {
      log: log('log'),
      info: log('info'),
      warn: log('warn'),
      error: log('error')
    },
    expect: (actual: unknown) => makeExpect(actual),
    test: (name: string, fn: () => unknown): void => {
      const started = performance.now()
      const record = (error?: unknown): void => {
        ctx.tests.push({
          name: String(name),
          passed: !error,
          durationMs: Math.round(performance.now() - started),
          ...(error ? { error: error instanceof Error ? error.message : String(error) } : {})
        })
      }
      try {
        const result = fn()
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          pending.push(
            (result as Promise<unknown>).then(
              () => record(),
              (err) => record(err)
            )
          )
        } else {
          record()
        }
      } catch (err) {
        record(err)
      }
    },
    sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
    skipRequest: (): never => {
      throw new SkipRequest('Request skipped by pre-request script')
    }
  }

  if (ctx.phase === 'post' && ctx.response) {
    const res = ctx.response
    const headerMap: Record<string, string> = {}
    for (const [key, value] of res.headers) {
      const lower = key.toLowerCase()
      headerMap[lower] = headerMap[lower] ? `${headerMap[lower]}, ${value}` : value
    }
    let parsed: unknown
    let parsedOk = false
    api.response = {
      status: res.status,
      statusText: res.statusText,
      ok: res.status >= 200 && res.status < 300,
      headers: headerMap,
      body: res.bodyText,
      size: res.size,
      time: res.timings.totalMs,
      contentType: res.contentType,
      url: res.finalUrl,
      redirects: res.redirects,
      header(name: string): string | undefined {
        return headerMap[name.toLowerCase()]
      },
      json(): unknown {
        if (!parsedOk) {
          parsed = JSON.parse(res.bodyText)
          parsedOk = true
        }
        return parsed
      },
      text(): string {
        return res.bodyText
      }
    }
  }

  return api
}

function buildSandbox(ctx: ScriptContext, pending: Promise<void>[]): vm.Context {
  const frap = buildFrapApi(ctx, pending)
  const consoleShim = frap.console

  const sandbox: Record<string, unknown> = {
    frap,
    // Familiar aliases so muscle memory from other clients works.
    fr: frap,
    console: consoleShim,
    expect: frap.expect,
    test: frap.test,
    // Node/web globals scripts realistically need.
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    FormData: globalThis.FormData,
    AbortController: globalThis.AbortController,
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    crypto: webcrypto,
    atob,
    btoa,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    performance
  }
  sandbox.globalThis = sandbox
  return vm.createContext(sandbox, { name: `frap:${ctx.phase}` })
}

export interface ScriptOutcome {
  error?: string
  skipped?: boolean
}

/** Trims the wrapper frames so a stack points at the user's own line. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const stack = err.stack ?? ''
  const frame = stack.split('\n').find((line) => line.includes('frap-script'))
  const at = frame?.match(/:(\d+):(\d+)/)
  // The wrapper adds one line above the user's code.
  const line = at ? Math.max(1, Number(at[1]) - 1) : null
  return line ? `${err.message} (line ${line})` : err.message
}

export async function runScript(code: string, ctx: ScriptContext): Promise<ScriptOutcome> {
  if (!code.trim()) return {}

  const pending: Promise<void>[] = []
  const sandbox = buildSandbox(ctx, pending)
  const wrapped = `(async () => {\n${code}\n})()`

  try {
    const result = vm.runInContext(wrapped, sandbox, {
      filename: `frap-script-${ctx.phase}.js`,
      // Guards synchronous infinite loops; the await below guards the rest.
      timeout: SCRIPT_TIMEOUT_MS
    }) as Promise<unknown>

    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Script timed out after ${SCRIPT_TIMEOUT_MS} ms`)),
        SCRIPT_TIMEOUT_MS
      )
    })
    try {
      await Promise.race([result, deadline])
      await Promise.race([Promise.all(pending), deadline])
    } finally {
      if (timer) clearTimeout(timer)
    }
    return {}
  } catch (err) {
    if (err instanceof SkipRequest || (err as Error)?.name === 'SkipRequest') {
      ctx.skipped = true
      return { skipped: true }
    }
    // A SkipRequest thrown inside the vm is a different class object, so also
    // match it by message.
    if (err instanceof Error && err.message === 'Request skipped by pre-request script') {
      ctx.skipped = true
      return { skipped: true }
    }
    return { error: describeError(err) }
  }
}
