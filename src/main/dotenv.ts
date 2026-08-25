/**
 * A .env parser/serialiser that round-trips a file byte-for-byte unless you
 * explicitly change a value.
 *
 * Comments, blank lines, `export ` prefixes, indentation, quote style, inline
 * comments, CRLF vs LF and the BOM are all preserved. Changing FOO rewrites
 * exactly the one line FOO lives on and leaves everything else untouched.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

const BOM = '﻿'

export type Quote = '"' | "'" | '`' | ''

export interface EnvEntryLine {
  kind: 'entry'
  raw: string
  indent: string
  exported: boolean
  key: string
  /** Decoded value (escapes resolved, quotes stripped). */
  value: string
  quote: Quote
  /** Everything after the value on the final physical line, e.g. `  # a note`. */
  trailing: string
  /**
   * Set once `value` has been changed. Untouched lines are written back from
   * `raw`, which is what makes the round-trip byte-exact: we never try to
   * reproduce incidental formatting like `KEY = value` or an unquoted `#`.
   */
  dirty?: boolean
}

export type EnvLine =
  | { kind: 'blank'; raw: string }
  | { kind: 'comment'; raw: string }
  | { kind: 'other'; raw: string }
  | EnvEntryLine

export interface EnvDoc {
  lines: EnvLine[]
  eol: string
  bom: boolean
}

const ENTRY_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function decodeDoubleQuoted(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const n = s[++i]
    switch (n) {
      case 'n': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case '\\': out += '\\'; break
      case '"': out += '"'; break
      case "'": out += "'"; break
      case '`': out += '`'; break
      case undefined: out += '\\'; break
      default: out += '\\' + n
    }
  }
  return out
}

/** Finds the index of the closing quote, honouring backslash escapes for `"`. */
function findClosingQuote(text: string, start: number, quote: Quote): number {
  const escapes = quote === '"'
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (escapes && c === '\\') {
      i++
      continue
    }
    if (c === quote) return i
  }
  return -1
}

/**
 * Splits an unquoted value from its inline comment. dotenv only treats `#` as
 * the start of a comment when it sits at the start or follows whitespace.
 */
function splitUnquoted(rest: string): { value: string; trailing: string } {
  let i = 0
  while (i < rest.length) {
    if (rest[i] === '#' && (i === 0 || /\s/.test(rest[i - 1]))) break
    i++
  }
  const valuePart = rest.slice(0, i)
  const comment = rest.slice(i)
  const trimmedEnd = valuePart.replace(/\s+$/, '')
  // Whitespace sitting between the value and the `#` belongs to the trailing
  // text, so rewriting the value leaves the comment exactly where it was.
  const gap = valuePart.slice(trimmedEnd.length)
  return { value: trimmedEnd.trimStart(), trailing: gap + comment }
}

export function parseEnv(input: string): EnvDoc {
  let text = input
  const bom = text.charCodeAt(0) === 0xfeff
  if (bom) text = text.slice(1)

  const crlfCount = (text.match(/\r\n/g) || []).length
  const lfCount = (text.match(/\n/g) || []).length
  const eol = crlfCount > 0 && crlfCount * 2 >= lfCount ? '\r\n' : '\n'

  const lines: EnvLine[] = []
  let pos = 0

  const lineEnd = (from: number): number => {
    const idx = text.indexOf('\n', from)
    return idx === -1 ? text.length : idx
  }

  while (pos < text.length) {
    const end = lineEnd(pos)
    const physical = text.slice(pos, end).replace(/\r$/, '')
    const trimmed = physical.trim()

    if (trimmed === '') {
      lines.push({ kind: 'blank', raw: physical })
      pos = end + 1
      continue
    }
    if (trimmed.startsWith('#')) {
      lines.push({ kind: 'comment', raw: physical })
      pos = end + 1
      continue
    }

    const m = ENTRY_RE.exec(physical)
    if (!m) {
      lines.push({ kind: 'other', raw: physical })
      pos = end + 1
      continue
    }

    const [, indent, exported, key, restRaw] = m
    const leading = restRaw.length - restRaw.trimStart().length
    const first = restRaw.trimStart()[0]

    if (first === '"' || first === "'" || first === '`') {
      // Absolute offset of the opening quote within `text`.
      const quoteAt = pos + (physical.length - restRaw.length) + leading
      const close = findClosingQuote(text, quoteAt + 1, first)
      if (close !== -1) {
        const rawValue = text.slice(quoteAt + 1, close)
        const value = first === '"' ? decodeDoubleQuoted(rawValue) : rawValue
        const stmtEnd = lineEnd(close)
        const trailing = text.slice(close + 1, stmtEnd).replace(/\r$/, '')
        lines.push({
          kind: 'entry',
          raw: text.slice(pos, stmtEnd).replace(/\r$/, ''),
          indent,
          exported: Boolean(exported),
          key,
          value,
          quote: first,
          trailing
        })
        pos = stmtEnd + 1
        continue
      }
      // Unterminated quote: fall through and treat it as an unquoted value.
    }

    const { value, trailing } = splitUnquoted(restRaw)
    lines.push({
      kind: 'entry',
      raw: physical,
      indent,
      exported: Boolean(exported),
      key,
      value,
      quote: '',
      trailing
    })
    pos = end + 1
  }

  return { lines, eol, bom }
}

/* ------------------------------------------------------------------ */
/* Serialising                                                         */
/* ------------------------------------------------------------------ */

function needsQuotes(value: string): boolean {
  if (value === '') return false
  if (/^\s|\s$/.test(value)) return true
  if (/[\n\r\t"'`\\#]/.test(value)) return true
  if (/\s/.test(value)) return true
  return false
}

function encodeValue(value: string, preferred: Quote): { quote: Quote; text: string } {
  const multiline = /[\n\r]/.test(value)

  if (!multiline && preferred === "'" && !value.includes("'")) {
    return { quote: "'", text: value }
  }
  if (!multiline && preferred === '`' && !value.includes('`')) {
    return { quote: '`', text: value }
  }
  if (preferred !== '"' && !needsQuotes(value)) {
    return { quote: '', text: value }
  }
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return { quote: '"', text: escaped }
}

function renderEntry(line: EnvEntryLine): string {
  const { quote, text } = encodeValue(line.value, line.quote)
  const prefix = line.indent + (line.exported ? 'export ' : '') + line.key + '='
  return prefix + quote + text + quote + line.trailing
}

export function stringifyEnv(doc: EnvDoc): string {
  const parts = doc.lines.map((l) => (l.kind === 'entry' && l.dirty ? renderEntry(l) : l.raw))
  const body = parts.length === 0 ? '' : parts.join(doc.eol) + doc.eol
  return (doc.bom ? BOM : '') + body
}

/* ------------------------------------------------------------------ */
/* Mutation                                                            */
/* ------------------------------------------------------------------ */

/** Last assignment wins, matching dotenv's own resolution order. */
export function envToObject(doc: EnvDoc): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of doc.lines) if (line.kind === 'entry') out[line.key] = line.value
  return out
}

export function setEnvValue(doc: EnvDoc, key: string, value: string): void {
  for (let i = doc.lines.length - 1; i >= 0; i--) {
    const line = doc.lines[i]
    if (line.kind === 'entry' && line.key === key) {
      if (line.value !== value) {
        line.value = value
        line.dirty = true
      }
      return
    }
  }
  // Unknown key: append at the end, after a blank separator line.
  const last = doc.lines[doc.lines.length - 1]
  if (last && last.kind !== 'blank') doc.lines.push({ kind: 'blank', raw: '' })
  doc.lines.push({
    kind: 'entry',
    raw: '',
    indent: '',
    exported: false,
    key,
    value,
    quote: '',
    trailing: '',
    dirty: true
  })
}

export function unsetEnvValue(doc: EnvDoc, key: string): boolean {
  const before = doc.lines.length
  doc.lines = doc.lines.filter((l) => !(l.kind === 'entry' && l.key === key))
  return doc.lines.length !== before
}

/* ------------------------------------------------------------------ */
/* Variable expansion (`${FOO}` / `$FOO`)                              */
/* ------------------------------------------------------------------ */

const EXPAND_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g

export function expandEnv(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const resolve = (key: string, seen: Set<string>): string => {
    if (out[key] !== undefined) return out[key]
    const raw = vars[key]
    if (raw === undefined) return ''
    if (seen.has(key)) return raw
    const next = new Set(seen).add(key)
    const expanded = raw.replace(EXPAND_RE, (match, braced, fallback, bare) => {
      const name = braced || bare
      if (vars[name] === undefined) return fallback !== undefined ? fallback : match
      return resolve(name, next)
    })
    out[key] = expanded
    return expanded
  }
  for (const key of Object.keys(vars)) resolve(key, new Set())
  return out
}

/* ------------------------------------------------------------------ */
/* File helpers                                                        */
/* ------------------------------------------------------------------ */

export async function readEnvDoc(
  absPath: string
): Promise<{ doc: EnvDoc; exists: boolean; raw: string }> {
  try {
    const raw = await fs.readFile(absPath, 'utf8')
    return { doc: parseEnv(raw), exists: true, raw }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { doc: parseEnv(''), exists: false, raw: '' }
    }
    throw err
  }
}

export async function writeEnvDoc(absPath: string, doc: EnvDoc): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, stringifyEnv(doc), 'utf8')
}

/**
 * Applies a batch of changes to a .env file in one read-modify-write pass.
 * A `null` value deletes the key. Comments and layout survive untouched.
 */
export async function applyEnvChanges(
  absPath: string,
  changes: Array<{ key: string; value: string | null }>
): Promise<void> {
  if (changes.length === 0) return
  const { doc } = await readEnvDoc(absPath)
  for (const { key, value } of changes) {
    if (value === null) unsetEnvValue(doc, key)
    else setEnvValue(doc, key, value)
  }
  await writeEnvDoc(absPath, doc)
}

/** Pairs each entry with the comment documenting it, for the env editor UI. */
export function entryViews(doc: EnvDoc): Array<{ key: string; value: string; comment?: string }> {
  const out: Array<{ key: string; value: string; comment?: string }> = []
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i]
    if (line.kind !== 'entry') continue
    let comment = line.trailing.replace(/^\s*#\s?/, '').trim() || undefined
    if (!comment) {
      const prev = doc.lines[i - 1]
      if (prev && prev.kind === 'comment') {
        comment = prev.raw.replace(/^\s*#\s?/, '').trim() || undefined
      }
    }
    out.push({ key: line.key, value: line.value, comment })
  }
  return out
}
