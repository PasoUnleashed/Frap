/**
 * Format migration.
 *
 * Every file Frap writes carries `frap: <version>`. Reading a file runs it
 * forward through the migrations to the current version *in memory*; the file
 * itself is only restamped when the user saves it. That is deliberate: a
 * `git pull` bringing in fifty older requests must not turn into a fifty-file
 * diff nobody asked for.
 *
 * Adding a version means: bump FORMAT_VERSION, append one entry to
 * MIGRATIONS, and write a test that reads a fixture of the old shape.
 */
import { FORMAT_VERSION } from '../shared/types.ts'

export type DocKind = 'request' | 'folder' | 'workspace'

/** A file written by a newer Frap than this one. */
export class FormatTooNewError extends Error {
  readonly version: number
  constructor(source: string, version: number) {
    super(
      `${source} is format v${version}, but this copy of Frap only understands ` +
        `v${FORMAT_VERSION}. Update Frap to open it.`
    )
    this.name = 'FormatTooNewError'
    this.version = version
  }
}

type Doc = Record<string, unknown>

interface Migration {
  /** The version this step produces. */
  to: number
  apply(doc: Doc, kind: DocKind): Doc
}

const MIGRATIONS: Migration[] = [
  {
    to: 2,
    /**
     * v1 -> v2 needs no rewriting.
     *
     * v2 added headers, auth and scripts to folders, and changed a request's
     * default auth from "none" to "inherit". Neither changes what a v1 file
     * means: v1 had no folder settings, so there was never anything to
     * inherit, and inheriting nothing is the same as none. Normalisation
     * fills the new fields in.
     */
    apply: (doc) => doc
  }
]

/**
 * The version a document declares.
 *
 * Files written before versioning was enforced have no `frap` key; they are
 * v1 by definition.
 */
export function versionOf(doc: unknown): number {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 1
  const raw = (doc as Doc).frap
  const version = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(version) && version >= 1 ? Math.floor(version) : 1
}

export interface MigrationResult {
  doc: Doc
  /** The version the file was written at. */
  from: number
  /** True when at least one migration ran, i.e. the file is out of date. */
  upgraded: boolean
}

/**
 * Brings a parsed document up to the current format.
 *
 * `source` is only used in the error message, so it should be something the
 * user can act on - a path, usually.
 */
export function migrateDocument(kind: DocKind, raw: unknown, source: string): MigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source} is not a Frap file`)
  }

  const from = versionOf(raw)
  if (from > FORMAT_VERSION) throw new FormatTooNewError(source, from)

  let doc = raw as Doc
  let upgraded = false
  for (const migration of MIGRATIONS) {
    if (migration.to <= from) continue
    doc = migration.apply(doc, kind)
    upgraded = true
  }

  return { doc: { ...doc, frap: FORMAT_VERSION }, from, upgraded }
}
