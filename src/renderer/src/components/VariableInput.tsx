import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type JSX,
  type MouseEvent,
  type Ref
} from 'react'
import { createPortal } from 'react-dom'
import type { VariableScope } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import {
  describeVariable,
  previewValue,
  segmentVariables,
  variableAt,
  type VariableDescription,
  type VariableToken
} from '../variables'

/* ------------------------------------------------------------------ */
/* Shared behaviour                                                    */
/* ------------------------------------------------------------------ */

/** Right-click actions for a variable, wherever it is rendered. */
export async function showVariableMenu(
  description: VariableDescription,
  openEnvironments: () => void
): Promise<void> {
  const resolved = description.kind === 'resolved'
  const choice = await api.contextMenu([
    {
      id: 'copy-value',
      label: resolved ? 'Copy value' : 'Copy value (not set)',
      enabled: resolved
    },
    { id: 'copy-name', label: `Copy {{${description.name}}}` },
    { type: 'separator' },
    { id: 'environments', label: 'Open Environments…' }
  ])

  switch (choice) {
    case 'copy-value':
      if (resolved) await api.clipboard.write(description.value ?? '')
      break
    case 'copy-name':
      await api.clipboard.write(`{{${description.name}}}`)
      break
    case 'environments':
      openEnvironments()
      break
    default:
      break
  }
}

/** A hook giving both adapters the same scope and the same menu action. */
export function useVariableTools(): {
  scope: VariableScope
  openMenu: (description: VariableDescription) => void
} {
  const { state, actions } = useStore()
  const openMenu = useCallback(
    (description: VariableDescription) => {
      void showVariableMenu(description, () => actions.toggle('showEnvs', true))
    },
    [actions]
  )
  return { scope: state.variables, openMenu }
}

/* ------------------------------------------------------------------ */
/* Hover card                                                          */
/* ------------------------------------------------------------------ */

/** Rendered into a portal so table and pane overflow cannot clip it. */
export function VariableCard({
  description,
  x,
  y
}: {
  description: VariableDescription
  x: number
  y: number
}): JSX.Element {
  const card = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null)

  // Measure, then nudge back inside the viewport before painting.
  useLayoutEffect(() => {
    const element = card.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const margin = 8
    const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))
    const above = y - rect.height - 10
    const top = above >= margin ? above : y + 20
    setPlacement({ left, top })
  }, [x, y, description])

  return createPortal(
    <div
      ref={card}
      className={`var-card ${description.kind}`}
      style={
        placement
          ? { left: placement.left, top: placement.top }
          : { left: x, top: y, visibility: 'hidden' }
      }
    >
      <div className="name mono">{`{{${description.name}}}`}</div>
      {description.kind === 'resolved' && (
        <div className="value mono">{previewValue(description.value ?? '')}</div>
      )}
      {description.kind === 'dynamic' && <div className="note">{description.note}</div>}
      {description.kind === 'missing' && (
        <div className="note missing">Not set in this environment</div>
      )}
      {description.origin && <div className="origin">{description.origin}</div>}
      <div className="hint">Right-click to copy</div>
    </div>,
    document.body
  )
}

/* ------------------------------------------------------------------ */
/* Text measuring                                                      */
/* ------------------------------------------------------------------ */

let measuringContext: CanvasRenderingContext2D | null = null

/**
 * Maps a pixel offset inside an input to a character index.
 *
 * The highlight overlay is `pointer-events: none` so the input keeps all its
 * native behaviour — selection, dragging, the caret. That means hit-testing
 * for hover and right-click has to be done by measuring the text ourselves.
 */
function offsetToIndex(input: HTMLInputElement, clientX: number): number {
  if (!measuringContext) {
    measuringContext = document.createElement('canvas').getContext('2d')
  }
  const context = measuringContext
  if (!context) return -1

  const styles = getComputedStyle(input)
  context.font = styles.font || `${styles.fontSize} ${styles.fontFamily}`

  const rect = input.getBoundingClientRect()
  const paddingLeft = parseFloat(styles.paddingLeft) || 0
  const borderLeft = parseFloat(styles.borderLeftWidth) || 0
  const x = clientX - rect.left - paddingLeft - borderLeft + input.scrollLeft
  if (x < 0) return -1

  const text = input.value
  // Binary search the smallest prefix whose width passes x.
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (context.measureText(text.slice(0, mid + 1)).width < x) low = mid + 1
    else high = mid
  }
  return low
}

/* ------------------------------------------------------------------ */
/* The input                                                           */
/* ------------------------------------------------------------------ */

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'ref'> {
  value: string
  inputRef?: Ref<HTMLInputElement>
}

/**
 * A text input that paints `{{variable}}` chips behind the text.
 *
 * The overlay draws only backgrounds — the glyphs still come from the real
 * input sitting on top — so the chips cost no layout and the field behaves
 * exactly like a normal one.
 */
export function VariableInput({ value, inputRef, className, ...rest }: Props): JSX.Element {
  const { scope, openMenu } = useVariableTools()
  const own = useRef<HTMLInputElement | null>(null)
  const mirror = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<{ description: VariableDescription; x: number; y: number } | null>(
    null
  )

  const attach = (element: HTMLInputElement | null): void => {
    own.current = element
    if (typeof inputRef === 'function') inputRef(element)
    else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = element
  }

  const segments = segmentVariables(value)
  const hasVariables = segments.some((segment) => segment.kind === 'variable')

  // The overlay has to scroll with the text it is sitting behind.
  const syncScroll = useCallback(() => {
    if (mirror.current && own.current) mirror.current.scrollLeft = own.current.scrollLeft
  }, [])

  useEffect(syncScroll, [value, syncScroll])
  useEffect(() => setHover(null), [value])

  const tokenAtEvent = (event: MouseEvent<HTMLInputElement>): VariableToken | null => {
    const input = own.current
    if (!input || !hasVariables) return null
    const index = offsetToIndex(input, event.clientX)
    return index < 0 ? null : variableAt(value, index)
  }

  const onMouseMove = (event: MouseEvent<HTMLInputElement>): void => {
    const token = tokenAtEvent(event)
    if (!token) {
      if (hover) setHover(null)
      return
    }
    if (hover?.description.name === token.name) return
    const rect = event.currentTarget.getBoundingClientRect()
    setHover({
      description: describeVariable(token.name, scope),
      x: event.clientX,
      y: rect.top
    })
  }

  const onContextMenu = (event: MouseEvent<HTMLInputElement>): void => {
    const token = tokenAtEvent(event)
    if (!token) return
    // Only take over the menu when the pointer is actually on a variable.
    event.preventDefault()
    setHover(null)
    openMenu(describeVariable(token.name, scope))
  }

  return (
    <span className="var-input">
      {hasVariables && (
        <div className="var-mirror mono" aria-hidden="true" ref={mirror}>
          {segments.map((segment, index) =>
            segment.kind === 'text' ? (
              <span key={index}>{segment.text}</span>
            ) : (
              <span
                key={index}
                className={`var-chip ${describeVariable(segment.token.name, scope).kind}`}
              >
                {segment.token.text}
              </span>
            )
          )}
        </div>
      )}

      <input
        {...rest}
        ref={attach}
        type={rest.type ?? 'text'}
        value={value}
        className={className}
        spellCheck={false}
        onScroll={syncScroll}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHover(null)}
        onContextMenu={onContextMenu}
      />

      {hover && <VariableCard description={hover.description} x={hover.x} y={hover.y} />}
    </span>
  )
}
