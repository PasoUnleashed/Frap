/**
 * Tells Frap's own disk writes apart from everyone else's.
 *
 * The workspace watcher exists so a `git pull`, a branch switch or an edit in
 * another editor shows up without restarting. But it cannot tell who wrote a
 * file, so without this the app would announce "the disk changed" every time
 * the user saved a request, reordered the tree, or ran a script that updates
 * the .env file — changes the renderer already knows about.
 *
 * A path is marked just before or just after we write it, and counts as ours
 * for a short grace period. Directories cover everything beneath them, which
 * is what a folder rename, move or delete needs.
 */
import * as path from 'node:path'

/** Long enough to cover the watcher's debounce and a slow disk. */
export const SELF_WRITE_GRACE_MS = 4000

/** Windows and macOS compare paths case-insensitively; Linux does not. */
export function pathKey(target: string): string {
  const resolved = path.resolve(target)
  return process.platform === 'linux' ? resolved : resolved.toLowerCase()
}

export class SelfWriteTracker {
  private readonly marks = new Map<string, number>()
  /**
   * Parent folders of the paths we wrote.
   *
   * Writing a file bumps its folder's mtime, and the recursive watcher reports
   * that folder as a separate event. Those are matched by equality only: a
   * prefix match here would also swallow a genuine external change to a
   * sibling that happened to land in the same grace window.
   */
  private readonly parents = new Map<string, number>()
  private readonly graceMs: number
  private readonly now: () => number

  // Written out rather than using parameter properties: those emit code, and
  // the test runner strips types without compiling.
  constructor(graceMs: number = SELF_WRITE_GRACE_MS, now: () => number = Date.now) {
    this.graceMs = graceMs
    this.now = now
  }

  /** Records that these paths are being written by us. */
  mark(...targets: Array<string | null | undefined>): void {
    const until = this.now() + this.graceMs
    if (this.marks.size > 512) this.prune()
    for (const target of targets) {
      if (!target) continue
      const key = pathKey(target)
      this.marks.set(key, until)
      const parent = pathKey(path.dirname(target))
      if (parent !== key) this.parents.set(parent, until)
    }
  }

  /** True when `absPath` is one we wrote, or sits inside a folder we wrote. */
  has(absPath: string): boolean {
    const key = pathKey(absPath)
    const now = this.now()

    const parentUntil = this.parents.get(key)
    if (parentUntil !== undefined) {
      if (parentUntil >= now) return true
      this.parents.delete(key)
    }

    for (const [marked, until] of this.marks) {
      if (until < now) {
        this.marks.delete(marked)
        continue
      }
      if (key === marked || key.startsWith(marked + path.sep)) return true
    }
    return false
  }

  private prune(): void {
    const now = this.now()
    for (const [key, until] of this.marks) if (until < now) this.marks.delete(key)
    for (const [key, until] of this.parents) if (until < now) this.parents.delete(key)
  }

  /** Test seam. */
  get size(): number {
    return this.marks.size
  }

  clear(): void {
    this.marks.clear()
    this.parents.clear()
  }
}
