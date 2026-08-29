/**
 * The shared `{{variable}}` logic behind the chips, hover cards and menus.
 * Both the plain-input overlay and the CodeMirror extension build on this,
 * so it has to agree with the interpolator in src/main/interpolate.ts.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeVariable,
  findVariables,
  previewValue,
  segmentVariables,
  variableAt
} from '../src/renderer/src/variables.ts'
import { interpolate } from '../src/main/interpolate.ts'
import type { VariableScope } from '../src/shared/types.ts'

const SCOPE: VariableScope = {
  BASE_URL: { value: 'https://api.example.com', source: 'environment', environment: 'local' },
  TOKEN: { value: 'abc123', source: 'session' },
  EMPTY: { value: '', source: 'environment', environment: 'local' }
}

/* ------------------------------------------------------------------ */
/* Finding                                                             */
/* ------------------------------------------------------------------ */

test('finds every variable with its exact bounds', () => {
  const text = '{{BASE_URL}}/users/{{USER_ID}}'
  assert.deepEqual(findVariables(text), [
    { start: 0, end: 12, name: 'BASE_URL', text: '{{BASE_URL}}' },
    { start: 19, end: 30, name: 'USER_ID', text: '{{USER_ID}}' }
  ])
  // The bounds must slice back to exactly the matched text.
  for (const token of findVariables(text)) {
    assert.equal(text.slice(token.start, token.end), token.text)
  }
})

test('tolerates padding inside the braces', () => {
  assert.deepEqual(findVariables('{{ SPACED }}'), [
    { start: 0, end: 12, name: 'SPACED', text: '{{ SPACED }}' }
  ])
})

test('text without variables yields nothing', () => {
  assert.deepEqual(findVariables('https://example.com/plain'), [])
  assert.deepEqual(findVariables(''), [])
})

test('the matcher is not left stateful between calls', () => {
  const text = '{{A}} {{B}}'
  // A shared /g regex would return different results on a second call.
  assert.deepEqual(findVariables(text), findVariables(text))
  assert.equal(findVariables(text).length, 2)
})

test('agrees with the interpolator about what is a variable', () => {
  const text = '{{BASE_URL}}/x/{{ TOKEN }}/{{MISSING}}'
  const flat = Object.fromEntries(Object.entries(SCOPE).map(([k, v]) => [k, v.value]))
  const resolved = interpolate(text, flat)

  assert.equal(resolved, 'https://api.example.com/x/abc123/{{MISSING}}')
  // Every name the UI highlights is one the interpolator would substitute.
  assert.deepEqual(
    findVariables(text).map((t) => t.name),
    ['BASE_URL', 'TOKEN', 'MISSING']
  )
})

/* ------------------------------------------------------------------ */
/* Hit testing                                                         */
/* ------------------------------------------------------------------ */

test('finds the variable under a cursor offset', () => {
  const text = 'a {{ONE}} b {{TWO}}'
  assert.equal(variableAt(text, 0), null)
  assert.equal(variableAt(text, 5)?.name, 'ONE')
  assert.equal(variableAt(text, 10), null)
  assert.equal(variableAt(text, 15)?.name, 'TWO')
})

test('the braces themselves count as inside the variable', () => {
  const text = '{{ONE}}'
  assert.equal(variableAt(text, 0)?.name, 'ONE')
  assert.equal(variableAt(text, 7)?.name, 'ONE')
  assert.equal(variableAt(text, 8), null)
})

/* ------------------------------------------------------------------ */
/* Describing                                                          */
/* ------------------------------------------------------------------ */

test('resolved variables report their value and where it came from', () => {
  assert.deepEqual(describeVariable('BASE_URL', SCOPE), {
    name: 'BASE_URL',
    kind: 'resolved',
    value: 'https://api.example.com',
    origin: 'from the local environment'
  })
})

test('the hover card names which store a value came from', () => {
  const session = describeVariable('TOKEN', SCOPE)
  assert.equal(session.kind, 'resolved')
  assert.equal(session.origin, 'from the session store')

  const user = describeVariable('MINE', {
    MINE: { value: 'x', source: 'user' }
  })
  assert.equal(user.origin, 'from your user store')

  const env = describeVariable('SHARED', {
    SHARED: { value: 'x', source: 'environment', environment: 'staging' }
  })
  assert.equal(env.origin, 'from the staging environment')
})

test('an empty value is resolved, not missing', () => {
  const described = describeVariable('EMPTY', SCOPE)
  assert.equal(described.kind, 'resolved')
  assert.equal(described.value, '')
})

test('unknown names are reported as missing', () => {
  assert.deepEqual(describeVariable('NOPE', SCOPE), { name: 'NOPE', kind: 'missing' })
})

test('generated values are described rather than resolved', () => {
  const described = describeVariable('$uuid', SCOPE)
  assert.equal(described.kind, 'dynamic')
  assert.match(described.note!, /UUID/)
  // Every dynamic name the interpolator knows is described here too.
  for (const name of ['$uuid', '$guid', '$timestamp', '$isoTimestamp', '$randomInt', '$randomHex']) {
    assert.equal(describeVariable(name, SCOPE).kind, 'dynamic', name)
  }
})

test('a dynamic name is never shadowed by a scope entry', () => {
  const shadowed: VariableScope = { ...SCOPE, $uuid: { value: 'nope', source: 'session' } }
  assert.equal(describeVariable('$uuid', shadowed).kind, 'dynamic')
})

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

test('segments interleave plain text and variables losslessly', () => {
  const text = 'GET {{BASE_URL}}/x/{{ID}} end'
  const segments = segmentVariables(text)
  assert.deepEqual(
    segments.map((s) => (s.kind === 'text' ? s.text : s.token.text)),
    ['GET ', '{{BASE_URL}}', '/x/', '{{ID}}', ' end']
  )
  // Reassembling must give back exactly the original.
  assert.equal(
    segments.map((s) => (s.kind === 'text' ? s.text : s.token.text)).join(''),
    text
  )
})

test('a string that is only a variable produces one segment', () => {
  assert.deepEqual(segmentVariables('{{ONLY}}'), [
    { kind: 'variable', token: { start: 0, end: 8, name: 'ONLY', text: '{{ONLY}}' } }
  ])
})

test('adjacent variables do not merge', () => {
  const segments = segmentVariables('{{A}}{{B}}')
  assert.equal(segments.length, 2)
  assert.equal(segments.every((s) => s.kind === 'variable'), true)
})

test('an empty string produces no segments', () => {
  assert.deepEqual(segmentVariables(''), [])
})

test('long values are trimmed for display, empty ones labelled', () => {
  assert.equal(previewValue(''), '(empty)')
  assert.equal(previewValue('short'), 'short')
  const long = 'x'.repeat(500)
  assert.equal(previewValue(long, 10), 'xxxxxxxxxx…')
})
