/**
 * `{{VARIABLE}}` substitution.
 *
 * Values come from the active .env file, overlaid with anything scripts have
 * set at runtime. A handful of `{{$dynamic}}` values are generated per call.
 */
import { randomUUID, randomBytes } from 'node:crypto'

const DYNAMIC: Record<string, () => string> = {
  $uuid: () => randomUUID(),
  $guid: () => randomUUID(),
  $timestamp: () => Math.floor(Date.now() / 1000).toString(),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => Math.floor(Math.random() * 1000).toString(),
  $randomHex: () => randomBytes(16).toString('hex')
}

const TOKEN = /\{\{\s*([^}\s]+)\s*\}\}/g

/** How many times a value may itself expand to another `{{...}}`. */
const MAX_DEPTH = 5

export function interpolate(
  input: string,
  scope: Record<string, string>,
  missing?: Set<string>
): string {
  if (!input || !input.includes('{{')) return input

  let out = input
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let replaced = false
    out = out.replace(TOKEN, (match, name: string) => {
      const dynamic = DYNAMIC[name]
      if (dynamic) {
        replaced = true
        return dynamic()
      }
      const value = scope[name]
      if (value === undefined) {
        missing?.add(name)
        return match
      }
      replaced = true
      return value
    })
    if (!replaced || !out.includes('{{')) break
  }
  return out
}

/** Returns every `{{name}}` referenced in a string, dynamic values excluded. */
export function referencedVariables(input: string): string[] {
  const names = new Set<string>()
  for (const match of input.matchAll(TOKEN)) {
    if (!DYNAMIC[match[1]]) names.add(match[1])
  }
  return [...names]
}
