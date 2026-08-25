import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { KeyValue } from '@shared/types'
import { VariableInput } from './VariableInput'

interface Props {
  rows: KeyValue[]
  onChange: (rows: KeyValue[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  hint?: string
}

type Field = 'key' | 'value'

const blank = (): KeyValue => ({ enabled: true, key: '', value: '' })

/** The table used for query params, headers and urlencoded form fields. */
export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder = 'Name',
  valuePlaceholder = 'Value',
  hint
}: Props): JSX.Element {
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const [focusAfterAdd, setFocusAfterAdd] = useState<{ index: number; field: Field } | null>(null)

  const cellKey = (index: number, field: Field): string => `${index}:${field}`

  const register = (index: number, field: Field) => (element: HTMLInputElement | null): void => {
    if (element) inputs.current.set(cellKey(index, field), element)
    else inputs.current.delete(cellKey(index, field))
  }

  /**
   * Typing in the trailing blank row promotes it to a real row. The caret has
   * to follow, otherwise the first character lands in the new row while you
   * carry on typing into the empty placeholder below it.
   *
   * Layout effect rather than a plain effect: focus moves before the browser
   * paints, so a fast typist never sees or types into the wrong cell.
   */
  useLayoutEffect(() => {
    if (!focusAfterAdd) return
    const element = inputs.current.get(cellKey(focusAfterAdd.index, focusAfterAdd.field))
    if (element) {
      element.focus()
      const end = element.value.length
      element.setSelectionRange(end, end)
    }
    setFocusAfterAdd(null)
  }, [focusAfterAdd, rows])

  const patch = (index: number, changes: Partial<KeyValue>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)))
  }

  const remove = (index: number): void => {
    inputs.current.clear()
    onChange(rows.filter((_, i) => i !== index))
  }

  const promote = (field: Field, value: string): void => {
    onChange([...rows, { ...blank(), [field]: value }])
    setFocusAfterAdd({ index: rows.length, field })
  }

  return (
    <div>
      <table className="kv">
        <thead>
          <tr>
            <th className="check" />
            <th>{keyPlaceholder}</th>
            <th>{valuePlaceholder}</th>
            <th className="tools" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className={row.enabled ? '' : 'disabled'}>
              <td className="check">
                <input
                  type="checkbox"
                  checked={row.enabled}
                  onChange={(e) => patch(index, { enabled: e.target.checked })}
                  title={row.enabled ? 'Disable this row' : 'Enable this row'}
                />
              </td>
              <td>
                <VariableInput
                  inputRef={register(index, 'key')}
                  value={row.key}
                  placeholder={keyPlaceholder}
                  onChange={(e) => patch(index, { key: e.target.value })}
                />
              </td>
              <td>
                <VariableInput
                  inputRef={register(index, 'value')}
                  value={row.value}
                  placeholder={valuePlaceholder}
                  onChange={(e) => patch(index, { value: e.target.value })}
                />
              </td>
              <td className="tools">
                <button className="ghost" title="Remove" onClick={() => remove(index)}>
                  ×
                </button>
              </td>
            </tr>
          ))}

          {/* Placeholder row. It is never part of `rows`, so an unfinished
              entry is never written to the request file. */}
          <tr>
            <td className="check" />
            <td>
              <input
                type="text"
                value=""
                placeholder={keyPlaceholder}
                onChange={(e) => promote('key', e.target.value)}
              />
            </td>
            <td>
              <input
                type="text"
                value=""
                placeholder={valuePlaceholder}
                onChange={(e) => promote('value', e.target.value)}
              />
            </td>
            <td className="tools" />
          </tr>
        </tbody>
      </table>
      {hint && <div className="kv-add faint">{hint}</div>}
    </div>
  )
}
