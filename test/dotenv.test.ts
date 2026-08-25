/**
 * Round-trip and mutation tests for the .env engine.
 * Run with: npm run test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseEnv,
  stringifyEnv,
  envToObject,
  setEnvValue,
  unsetEnvValue,
  expandEnv,
  entryViews
} from '../src/main/dotenv.ts'

const SAMPLE = [
  '# Frap sample environment',
  '# ------------------------',
  '',
  '# The API we point at',
  'BASE_URL=https://api.example.com',
  '',
  'API_KEY="secret with spaces"   # rotated 2026-01-01',
  "LITERAL='no $expansion here'",
  'export TOKEN=abc123',
  '  INDENTED = spaced-out',
  'EMPTY=',
  'HASH_IN_VALUE=abc#notacomment',
  'MULTI="line one\\nline two"',
  '',
  '# trailing comment at EOF'
].join('\n') + '\n'

test('parses values the way dotenv does', () => {
  const doc = parseEnv(SAMPLE)
  const obj = envToObject(doc)
  assert.equal(obj.BASE_URL, 'https://api.example.com')
  assert.equal(obj.API_KEY, 'secret with spaces')
  assert.equal(obj.LITERAL, 'no $expansion here')
  assert.equal(obj.TOKEN, 'abc123')
  assert.equal(obj.INDENTED, 'spaced-out')
  assert.equal(obj.EMPTY, '')
  assert.equal(obj.HASH_IN_VALUE, 'abc#notacomment')
  assert.equal(obj.MULTI, 'line one\nline two')
})

test('round-trips an untouched file byte for byte', () => {
  assert.equal(stringifyEnv(parseEnv(SAMPLE)), SAMPLE)
})

test('keeps comments, order and quote style when a value changes', () => {
  const doc = parseEnv(SAMPLE)
  setEnvValue(doc, 'BASE_URL', 'https://staging.example.com')
  setEnvValue(doc, 'API_KEY', 'rotated-key')
  const out = stringifyEnv(doc)

  assert.match(out, /^# Frap sample environment$/m)
  assert.match(out, /^# The API we point at$/m)
  assert.match(out, /^BASE_URL=https:\/\/staging\.example\.com$/m)
  // Inline comment survives, and the double-quote style is kept.
  assert.match(out, /^API_KEY="rotated-key"\s+# rotated 2026-01-01$/m)
  assert.match(out, /^# trailing comment at EOF$/m)
  // Nothing was reordered or dropped.
  assert.equal(out.split('\n').length, SAMPLE.split('\n').length)
})

test('appends unknown keys at the end without disturbing the file', () => {
  const doc = parseEnv(SAMPLE)
  setEnvValue(doc, 'NEW_TOKEN', 'xyz')
  const out = stringifyEnv(doc)
  assert.ok(out.startsWith('# Frap sample environment'))
  assert.match(out, /NEW_TOKEN=xyz\n$/)
})

test('quotes values only when it has to', () => {
  const doc = parseEnv('A=1\nB=2\n')
  setEnvValue(doc, 'A', 'plain-value')
  setEnvValue(doc, 'B', 'has spaces')
  setEnvValue(doc, 'C', 'has "quotes" and \n newline')
  assert.equal(
    stringifyEnv(doc),
    'A=plain-value\nB="has spaces"\n\nC="has \\"quotes\\" and \\n newline"\n'
  )
})

test('preserves CRLF line endings', () => {
  const crlf = '# note\r\nFOO=bar\r\n'
  const doc = parseEnv(crlf)
  setEnvValue(doc, 'FOO', 'baz')
  assert.equal(stringifyEnv(doc), '# note\r\nFOO=baz\r\n')
})

test('preserves a BOM', () => {
  const withBom = '﻿FOO=bar\n'
  assert.equal(stringifyEnv(parseEnv(withBom)), withBom)
})

test('handles multi-line quoted values', () => {
  const src = '# key\nPRIVATE_KEY="-----BEGIN-----\nline2\n-----END-----"\nAFTER=1\n'
  const doc = parseEnv(src)
  const obj = envToObject(doc)
  assert.equal(obj.PRIVATE_KEY, '-----BEGIN-----\nline2\n-----END-----')
  assert.equal(obj.AFTER, '1')
  assert.equal(stringifyEnv(doc), src)
})

test('unset removes only the target line', () => {
  const doc = parseEnv(SAMPLE)
  assert.equal(unsetEnvValue(doc, 'TOKEN'), true)
  const out = stringifyEnv(doc)
  assert.ok(!out.includes('TOKEN'))
  assert.match(out, /^# The API we point at$/m)
})

test('expands ${VAR} references with defaults', () => {
  const expanded = expandEnv({
    HOST: 'example.com',
    BASE: 'https://${HOST}/v1',
    NESTED: '${BASE}/users',
    FALLBACK: '${MISSING:-default}'
  })
  assert.equal(expanded.NESTED, 'https://example.com/v1/users')
  assert.equal(expanded.FALLBACK, 'default')
})

test('associates each entry with its documenting comment', () => {
  const views = entryViews(parseEnv(SAMPLE))
  const base = views.find((v) => v.key === 'BASE_URL')
  assert.equal(base?.comment, 'The API we point at')
  const key = views.find((v) => v.key === 'API_KEY')
  assert.equal(key?.comment, 'rotated 2026-01-01')
})
