/**
 * The watcher must stay silent for Frap's own writes, and stay loud for
 * everyone else's.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as path from 'node:path'
import { SelfWriteTracker } from '../src/main/selfwrites.ts'

const root = path.resolve('/ws')
const at = (...parts: string[]): string => path.join(root, ...parts)

test('a path we wrote is recognised as ours', () => {
  const tracker = new SelfWriteTracker()
  tracker.mark(at('Auth', 'Log in.frap.json'))
  assert.equal(tracker.has(at('Auth', 'Log in.frap.json')), true)
})

test('a path we did not write is reported as external', () => {
  const tracker = new SelfWriteTracker()
  tracker.mark(at('Auth', 'Log in.frap.json'))
  assert.equal(tracker.has(at('Auth', 'Whoami.frap.json')), false)
  assert.equal(tracker.has(at('other.frap.json')), false)
})

test('marking a folder covers everything inside it', () => {
  const tracker = new SelfWriteTracker()
  // A folder rename or delete only names the folder, but the watcher reports
  // each child too.
  tracker.mark(at('Archive'))
  assert.equal(tracker.has(at('Archive')), true)
  assert.equal(tracker.has(at('Archive', 'Old.frap.json')), true)
  assert.equal(tracker.has(at('Archive', 'Nested', 'Deep.frap.json')), true)
  // A sibling whose name merely starts the same must not be swallowed.
  assert.equal(tracker.has(at('Archived.frap.json')), false)
})

test('marks expire, so a later external edit is still reported', () => {
  let clock = 1000
  const tracker = new SelfWriteTracker(500, () => clock)
  tracker.mark(at('a.frap.json'))
  assert.equal(tracker.has(at('a.frap.json')), true)

  clock += 499
  assert.equal(tracker.has(at('a.frap.json')), true)

  clock += 2
  assert.equal(tracker.has(at('a.frap.json')), false)
})

test('expired marks are dropped rather than accumulating', () => {
  let clock = 0
  const tracker = new SelfWriteTracker(100, () => clock)
  tracker.mark(at('a.frap.json'), at('b.frap.json'))
  assert.equal(tracker.size, 2)
  clock += 200
  tracker.has(at('anything'))
  assert.equal(tracker.size, 0)
})

test('several paths can be marked at once, as a reorder does', () => {
  const tracker = new SelfWriteTracker()
  tracker.mark(at('A.frap.json'), at('B.frap.json'), at('C.frap.json'))
  assert.equal(tracker.has(at('B.frap.json')), true)
  assert.equal(tracker.has(at('D.frap.json')), false)
})

test('null and undefined targets are ignored', () => {
  const tracker = new SelfWriteTracker()
  tracker.mark(null, undefined, at('a.frap.json'))
  assert.equal(tracker.size, 1)
})

test('paths are compared the way the platform compares them', () => {
  const tracker = new SelfWriteTracker()
  tracker.mark(at('Auth', 'Log in.frap.json'))
  const differentCase = at('auth', 'log in.frap.json')
  // Linux is case-sensitive; Windows and macOS are not.
  assert.equal(tracker.has(differentCase), process.platform !== 'linux')
})

test('relative and absolute spellings of the same path match', () => {
  const tracker = new SelfWriteTracker()
  tracker.mark(at('Auth', '..', 'Auth', 'Log in.frap.json'))
  assert.equal(tracker.has(at('Auth', 'Log in.frap.json')), true)
})
