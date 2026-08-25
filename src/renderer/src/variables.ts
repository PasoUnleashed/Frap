/**
 * Everything the UI needs to recognise, describe and act on `{{variables}}`.
 *
 * Kept free of React and CodeMirror so both adapters — the plain-input overlay
 * and the editor extension — share one definition of what a variable is and
 * what it resolves to.
 */
import type { VariableScope } from '@shared/types'

/** Must stay in step with the interpolator in src/main/interpolate.ts. */
export const VARIABLE_RE = /\{\{\s*([^}\s]+)\s*\}\}/g

/** Generated per send, so they have no value to show until a request runs. */
export const DYNAMIC_VARIABLES: Record<string, string> = {
  $uuid: 'A new UUID for every send',
  $guid: 'A new UUID for every send',
  $timestamp: 'Seconds since the Unix epoch, at send time',
  $isoTimestamp: 'The current time as an ISO 8601 string',
  $randomInt: 'A random integer from 0 to 999',
  $randomHex: '16 random bytes as hex'
}

export interface VariableToken {
  /** Index of the opening brace. */
  start: number
  /** Index just past the closing brace. */
  end: number
  /** The name between the braces, whitespace trimmed. */
  name: string
  /** The matched text, e.g. `{{ BASE_URL }}`. */
  text: string
}

/** Finds every `{{variable}}` in a string, in order. */
export function findVariables(text: string): VariableToken[] {
  if (!text || !text.includes('{{')) return []
  const tokens: VariableToken[] = []
  // A fresh regex per call: the shared one is stateful with the /g flag.
  const re = new RegExp(VARIABLE_RE.source, 'g')
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      name: match[1],
      text: match[0]
    })
  }
  return tokens
}

/** The token covering `offset`, if any. Braces themselves count as inside. */
export function variableAt(text: string, offset: number): VariableToken | null {
  return findVariables(text).find((t) => offset >= t.start && offset <= t.end) ?? null
}

export type VariableKind = 'resolved' | 'dynamic' | 'missing'

export interface VariableDescription {
  name: string
  kind: VariableKind
  /** Present for `resolved`. */
  value?: string
  /** Human-readable provenance, e.g. `local (.env)` or `set by a script`. */
  origin?: string
  /** Present for `dynamic`. */
  note?: string
}

export function describeVariable(name: string, scope: VariableScope): VariableDescription {
  const dynamic = DYNAMIC_VARIABLES[name]
  if (dynamic) return { name, kind: 'dynamic', note: dynamic }

  const info = scope[name]
  if (!info) return { name, kind: 'missing' }

  return {
    name,
    kind: 'resolved',
    value: info.value,
    origin:
      info.source === 'session'
        ? 'set by a script this session'
        : info.environment
          ? `from the ${info.environment} environment`
          : 'from the active environment'
  }
}

/** Trims a long value for display without hiding that it was trimmed. */
export function previewValue(value: string, limit = 400): string {
  if (value === '') return '(empty)'
  const flattened = value.length > limit ? value.slice(0, limit) + '…' : value
  return flattened
}

/**
 * Splits text into plain runs and variable tokens, so a renderer can walk it
 * once without re-running the regex.
 */
export type VariableSegment =
  | { kind: 'text'; text: string }
  | { kind: 'variable'; token: VariableToken }

export function segmentVariables(text: string): VariableSegment[] {
  const tokens = findVariables(text)
  if (tokens.length === 0) return text ? [{ kind: 'text', text }] : []

  const segments: VariableSegment[] = []
  let cursor = 0
  for (const token of tokens) {
    if (token.start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, token.start) })
    }
    segments.push({ kind: 'variable', token })
    cursor = token.end
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}
