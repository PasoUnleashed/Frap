import type { JSX } from 'react'
import type { KeyValue } from '@shared/types'

interface Props {
  rows: KeyValue[]
  onChange: (rows: KeyValue[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  hint?: string
}

const blank = (): KeyValue => ({ enabled: true, key: '', value: '' })

/** The table used for query params, headers and urlencoded form fields. */
export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder = 'Name',
  valuePlaceholder = 'Value',
  hint
}: Props): JSX.Element {
  const patch = (index: number, changes: Partial<KeyValue>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)))
  }

  const remove = (index: number): void => onChange(rows.filter((_, i) => i !== index))

  /** Typing in the trailing blank row turns it into a real row. */
  const editLast = (changes: Partial<KeyValue>): void => onChange([...rows, { ...blank(), ...changes }])

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
                <input
                  type="text"
                  value={row.key}
                  placeholder={keyPlaceholder}
                  onChange={(e) => patch(index, { key: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="text"
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
          <tr>
            <td className="check" />
            <td>
              <input
                type="text"
                value=""
                placeholder={keyPlaceholder}
                onChange={(e) => editLast({ key: e.target.value })}
              />
            </td>
            <td>
              <input
                type="text"
                value=""
                placeholder={valuePlaceholder}
                onChange={(e) => editLast({ value: e.target.value })}
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
