/**
 * Orchestrates one request: resolve variables, run the pre-request script,
 * send, run the post-response script, then flush any environment writes.
 */
import * as path from 'node:path'
import type { ExecResult, FrapRequest, WorkspaceConfig } from '../shared/types.ts'
import { applyEnvChanges, envToObject, expandEnv, readEnvDoc } from './dotenv.ts'
import { sendHttp } from './http.ts'
import { finalize, toMutable, type PrepareContext } from './prepare.ts'
import { runScript, type ScriptContext } from './scripting.ts'

const BODY_PREVIEW_LIMIT = 256 * 1024

export interface ExecuteInput {
  root: string
  request: FrapRequest
  /** Absolute path to the active .env file, or null when none is selected. */
  envPath: string | null
  settings: WorkspaceConfig['settings']
  /** Session variables, shared across requests so scripts can chain them. */
  vars: Map<string, string>
  /** User-Agent for requests that do not set their own. */
  userAgent?: string
  signal?: AbortSignal
}

function previewOf(body: Buffer | null): string {
  if (!body) return ''
  const slice = body.subarray(0, BODY_PREVIEW_LIMIT)
  const text = slice.toString('utf8')
  // A lone replacement character means the payload was not UTF-8 text.
  if (text.includes('�') && body.length > 0) return `<${body.length} bytes of binary data>`
  return text + (body.length > BODY_PREVIEW_LIMIT ? '\n... truncated' : '')
}

export async function execute(input: ExecuteInput): Promise<ExecResult> {
  const { root, request, envPath, settings, vars, userAgent, signal } = input

  const result: ExecResult = {
    requestId: request.id,
    tests: [],
    logs: [],
    envWrites: []
  }

  // 1. Build the variable scope: .env file first, session variables on top.
  let scope: Record<string, string> = {}
  if (envPath) {
    try {
      const { doc } = await readEnvDoc(envPath)
      scope = expandEnv(envToObject(doc))
    } catch (err) {
      result.error = `Could not read environment file ${envPath}: ${(err as Error).message}`
      return result
    }
  }
  for (const [key, value] of vars) scope[key] = value

  const prepareCtx: PrepareContext = { root, scope, missing: new Set(), userAgent }

  let mutable
  try {
    mutable = toMutable(request, prepareCtx)
  } catch (err) {
    result.error = (err as Error).message
    return result
  }

  const scriptCtx: ScriptContext = {
    phase: 'pre',
    scope,
    vars,
    request: mutable,
    envWrites: [],
    logs: result.logs,
    tests: result.tests
  }

  const flushEnv = async (): Promise<void> => {
    if (!scriptCtx.envWrites.length) return
    result.envWrites = scriptCtx.envWrites.map((w) => ({
      file: envPath ? path.basename(envPath) : '(none)',
      key: w.key,
      value: w.value
    }))
    if (!envPath) {
      result.logs.push({
        level: 'warn',
        phase: scriptCtx.phase,
        message: 'frap.env.set was called but no environment is selected, so nothing was saved.',
        time: Date.now()
      })
      return
    }
    await applyEnvChanges(envPath, scriptCtx.envWrites)
  }

  // 2. Pre-request script.
  const pre = await runScript(request.scripts.preRequest, scriptCtx)
  if (pre.skipped) {
    await flushEnv()
    result.skipped = true
    return result
  }
  if (pre.error) {
    await flushEnv()
    result.error = pre.error
    result.scriptError = 'pre'
    return result
  }

  // 3. Send.
  let prepared
  try {
    prepared = await finalize(request, mutable, prepareCtx)
  } catch (err) {
    await flushEnv()
    result.error = (err as Error).message
    return result
  }

  result.sent = {
    method: prepared.method,
    url: prepared.url,
    headers: prepared.headers,
    bodyPreview: previewOf(prepared.body),
    bodySize: prepared.body?.length ?? 0
  }

  if (prepareCtx.missing.size) {
    result.logs.push({
      level: 'warn',
      phase: 'pre',
      message: `Unresolved variables: ${[...prepareCtx.missing].map((n) => `{{${n}}}`).join(', ')}`,
      time: Date.now()
    })
  }

  try {
    result.response = await sendHttp(prepared, {
      timeoutMs: request.settings?.timeoutMs ?? settings.timeoutMs,
      followRedirects: request.settings?.followRedirects ?? settings.followRedirects,
      maxRedirects: request.settings?.maxRedirects ?? settings.maxRedirects,
      validateTls: request.settings?.validateTls ?? settings.validateTls,
      signal
    })
  } catch (err) {
    await flushEnv()
    result.error = (err as Error).message
    return result
  }

  // 4. Post-response script.
  scriptCtx.phase = 'post'
  scriptCtx.response = result.response
  const post = await runScript(request.scripts.postResponse, scriptCtx)
  if (post.error) {
    result.error = post.error
    result.scriptError = 'post'
  }

  // 5. Persist environment writes, whatever happened above.
  try {
    await flushEnv()
  } catch (err) {
    result.error = result.error ?? `Could not write environment file: ${(err as Error).message}`
  }

  return result
}
