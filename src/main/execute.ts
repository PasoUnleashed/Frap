/**
 * Orchestrates one request: resolve variables, run the pre-request script,
 * send, run the post-response script, then flush any environment writes.
 */
import * as path from 'node:path'
import type { ExecResult, FolderScope, FrapRequest, WorkspaceConfig } from '../shared/types.ts'
import { applyEnvChanges, envToObject, expandEnv, readEnvDoc } from './dotenv.ts'
import { sendHttp } from './http.ts'
import { contributingFolders, finalize, toMutable, type PrepareContext } from './prepare.ts'
import { runScript, type ScriptContext } from './scripting.ts'

const BODY_PREVIEW_LIMIT = 256 * 1024

export interface ExecuteInput {
  root: string
  request: FrapRequest
  /** Absolute path to the active .env file, or null when none is selected. */
  envPath: string | null
  settings: WorkspaceConfig['settings']
  /** The session store, shared across requests so scripts can chain them. */
  vars: Map<string, string>
  /**
   * The user store as it stands. Writes come back in the result rather than
   * being persisted here, so the caller owns the one place that touches disk.
   */
  user?: Map<string, string>
  /** User-Agent for requests that do not set their own. */
  userAgent?: string
  /**
   * The folders the request sits in, outermost first. They contribute
   * headers, auth and scripts to everything below them.
   */
  folders?: FolderScope[]
  signal?: AbortSignal
}

/** One script to run, and something to call it in an error message. */
interface ScriptStep {
  code: string
  source: string
}

/**
 * The scripts for one phase, in the order they run: outermost folder first,
 * the request last.
 *
 * The same order for both phases is a deliberate choice over "the folder
 * wraps the request". It gives one rule to remember - the innermost thing
 * always runs last, and so always wins - which matches how folder headers and
 * folder auth already behave.
 */
function scriptsFor(
  phase: 'pre' | 'post',
  request: FrapRequest,
  folders: FolderScope[]
): ScriptStep[] {
  const key = phase === 'pre' ? 'preRequest' : 'postResponse'
  // A folder or the request can block inherited scripts for this phase.
  const steps: ScriptStep[] = contributingFolders(folders, request, key).map((folder) => ({
    code: folder.meta.scripts[key],
    source: `${folder.name} folder`
  }))
  steps.push({ code: request.scripts[key], source: 'request' })
  return steps.filter((step) => step.code.trim() !== '')
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
  const folders = input.folders ?? []
  const user = input.user ?? new Map<string, string>()

  const result: ExecResult = {
    requestId: request.id,
    tests: [],
    logs: [],
    writes: []
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
  // The environment layer on its own, so a script that removes a session or
  // user value can fall back to it.
  const envValues = { ...scope }
  // Lowest priority first, so the innermost store ends up winning:
  // environment file, then the user store, then this session's values.
  for (const [key, value] of user) scope[key] = value
  for (const [key, value] of vars) scope[key] = value

  const prepareCtx: PrepareContext = { root, scope, missing: new Set(), userAgent, folders }

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
    user,
    envValues,
    request: mutable,
    envWrites: [],
    userWrites: [],
    logs: result.logs,
    tests: result.tests
  }

  /**
   * Persists what the scripts wrote, once, after they have finished.
   *
   * Buffering rather than writing as you go means a script that throws
   * half-way cannot leave a file - or the user store - partly updated.
   */
  const flushWrites = async (): Promise<void> => {
    result.writes = [
      ...scriptCtx.userWrites.map((w) => ({
        store: 'user' as const,
        target: 'user store',
        key: w.key,
        value: w.value
      })),
      ...scriptCtx.envWrites.map((w) => ({
        store: 'environment' as const,
        target: envPath ? path.basename(envPath) : '(none)',
        key: w.key,
        value: w.value
      }))
    ]

    if (scriptCtx.envWrites.length) {
      if (!envPath) {
        result.logs.push({
          level: 'warn',
          phase: scriptCtx.phase,
          message: 'frap.env.set was called but no environment is selected, so nothing was saved.',
          time: Date.now()
        })
      } else {
        await applyEnvChanges(envPath, scriptCtx.envWrites)
      }
    }
  }

  /**
   * Runs a phase's scripts in order, stopping at the first failure.
   *
   * They share one context, so a folder script and the request's script see
   * the same request object, the same environment writes and the same test
   * list - but each gets its own sandbox, so a `const` in one cannot collide
   * with a `const` in another.
   */
  const runPhase = async (
    phase: 'pre' | 'post'
  ): Promise<{ error?: string; source?: string; skipped?: boolean }> => {
    for (const step of scriptsFor(phase, request, folders)) {
      const outcome = await runScript(step.code, scriptCtx)
      if (outcome.skipped) return { skipped: true }
      if (outcome.error) return { error: outcome.error, source: step.source }
    }
    return {}
  }

  // 2. Pre-request scripts: folders outermost first, then the request.
  const pre = await runPhase('pre')
  if (pre.skipped) {
    await flushWrites()
    result.skipped = true
    return result
  }
  if (pre.error) {
    await flushWrites()
    result.error = pre.source === 'request' ? pre.error : `${pre.source}: ${pre.error}`
    result.scriptError = 'pre'
    return result
  }

  // 3. Send.
  let prepared
  try {
    prepared = await finalize(request, mutable, prepareCtx)
  } catch (err) {
    await flushWrites()
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
    await flushWrites()
    result.error = (err as Error).message
    return result
  }

  // 4. Post-response scripts, in the same order as the pre-request ones.
  scriptCtx.phase = 'post'
  scriptCtx.response = result.response
  const post = await runPhase('post')
  if (post.error) {
    result.error = post.source === 'request' ? post.error : `${post.source}: ${post.error}`
    result.scriptError = 'post'
  }

  // 5. Persist environment writes, whatever happened above.
  try {
    await flushWrites()
  } catch (err) {
    result.error = result.error ?? `Could not write environment file: ${(err as Error).message}`
  }

  return result
}
