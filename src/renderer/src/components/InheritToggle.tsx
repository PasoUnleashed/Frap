import type { JSX } from 'react'

interface Props {
  /** False when this node blocks what its folders contribute. */
  inherited: boolean
  onChange: (inherited: boolean) => void
  /** What is being inherited, e.g. "headers". Used in the label. */
  what: string
  /** True for a folder, which blocks for its whole subtree rather than itself. */
  isFolder?: boolean
}

/**
 * The per-property inheritance switch.
 *
 * Sits in the toolbar of whichever section it governs, so the setting is right
 * next to the thing it affects rather than hidden in a settings page.
 */
export function InheritToggle({ inherited, onChange, what, isFolder }: Props): JSX.Element {
  return (
    <label
      className={`inherit-toggle${inherited ? '' : ' blocked'}`}
      title={
        inherited
          ? `${what} from the folders above are applied${isFolder ? ' to this folder and below' : ''}.`
          : isFolder
            ? `Folders above contribute no ${what} to anything in here.`
            : `This request ignores ${what} from its folders.`
      }
    >
      <input
        type="checkbox"
        checked={inherited}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>Inherit {what}</span>
    </label>
  )
}
