/**
 * The CodeMirror half of `{{variable}}` support: chips, a hover card and a
 * right-click menu, matching what the plain inputs do.
 */
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  hoverTooltip,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type { VariableScope } from '@shared/types'
import {
  VARIABLE_RE,
  describeVariable,
  previewValue,
  variableAt,
  type VariableDescription
} from './variables'

/** Builds the hover card DOM. Kept in step with VariableCard's markup. */
function cardElement(description: VariableDescription): HTMLElement {
  const root = document.createElement('div')
  root.className = `var-card in-editor ${description.kind}`

  const name = document.createElement('div')
  name.className = 'name mono'
  name.textContent = `{{${description.name}}}`
  root.append(name)

  if (description.kind === 'resolved') {
    const value = document.createElement('div')
    value.className = 'value mono'
    value.textContent = previewValue(description.value ?? '')
    root.append(value)
  } else if (description.kind === 'dynamic') {
    const note = document.createElement('div')
    note.className = 'note'
    note.textContent = description.note ?? ''
    root.append(note)
  } else {
    const note = document.createElement('div')
    note.className = 'note missing'
    note.textContent = 'Not set in this environment'
    root.append(note)
  }

  if (description.origin) {
    const origin = document.createElement('div')
    origin.className = 'origin'
    origin.textContent = description.origin
    root.append(origin)
  }

  const hint = document.createElement('div')
  hint.className = 'hint'
  hint.textContent = 'Right-click to copy'
  root.append(hint)

  return root
}

/**
 * Finds the variable under a document position by re-scanning just its line,
 * which is cheap and avoids holding a parallel index of the decorations.
 */
function tokenAtPos(
  view: EditorView,
  pos: number
): { name: string; from: number; to: number } | null {
  const line = view.state.doc.lineAt(pos)
  const token = variableAt(line.text, pos - line.from)
  if (!token) return null
  return { name: token.name, from: line.from + token.start, to: line.from + token.end }
}

export interface VariableExtensionOptions {
  getScope: () => VariableScope
  onContextMenu: (description: VariableDescription) => void
}

export function variableHighlighting({
  getScope,
  onContextMenu
}: VariableExtensionOptions): Extension {
  const matcher = new MatchDecorator({
    regexp: new RegExp(VARIABLE_RE.source, 'g'),
    decorate: (add, from, to, match) => {
      const { kind } = describeVariable(match[1], getScope())
      add(from, to, Decoration.mark({ class: `cm-var-chip ${kind}` }))
    }
  })

  const chips = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }

      update(update: ViewUpdate): void {
        this.decorations = matcher.updateDeco(update, this.decorations)
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )

  const card = hoverTooltip((view, pos) => {
    const token = tokenAtPos(view, pos)
    if (!token) return null
    return {
      pos: token.from,
      end: token.to,
      above: true,
      create: () => ({ dom: cardElement(describeVariable(token.name, getScope())) })
    }
  })

  const menu = EditorView.domEventHandlers({
    contextmenu(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos === null) return false
      const token = tokenAtPos(view, pos)
      if (!token) return false
      // Only take over the menu when the pointer is on a variable.
      event.preventDefault()
      onContextMenu(describeVariable(token.name, getScope()))
      return true
    }
  })

  return [chips, card, menu]
}
