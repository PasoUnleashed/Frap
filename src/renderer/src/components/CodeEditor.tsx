import { useMemo, type JSX } from 'react'
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { xml } from '@codemirror/lang-xml'
import { createTheme } from '@uiw/codemirror-themes'
import { tags as t } from '@lezer/highlight'
import { variableHighlighting } from '../codemirror-variables'
import { useVariableTools } from './VariableInput'

export type Language = 'javascript' | 'json' | 'html' | 'xml' | 'text'

const theme = createTheme({
  theme: 'dark',
  settings: {
    background: '#101218',
    foreground: '#e7eaf1',
    caret: '#5b8cff',
    selection: '#2f4785',
    selectionMatch: '#2c3a5e',
    // Must stay translucent. CodeMirror paints the selection in a layer at
    // z-index -1, behind the content, so an opaque line highlight would hide
    // any selection made within the active line.
    lineHighlight: 'rgba(126, 160, 255, 0.07)',
    gutterBackground: '#101218',
    gutterForeground: '#4d5566',
    gutterBorder: 'transparent',
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, 'SF Mono', Menlo, monospace"
  },
  styles: [
    { tag: t.comment, color: '#6b7385', fontStyle: 'italic' },
    { tag: [t.string, t.special(t.string)], color: '#a5d6a7' },
    { tag: [t.number, t.bool, t.null], color: '#ffb86c' },
    { tag: [t.keyword, t.operatorKeyword], color: '#c792ea' },
    { tag: [t.definitionKeyword, t.modifier], color: '#c792ea' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
    { tag: [t.propertyName], color: '#7fd6f0' },
    { tag: [t.className, t.typeName], color: '#ffcb6b' },
    { tag: [t.tagName], color: '#f07178' },
    { tag: [t.attributeName], color: '#ffcb6b' },
    { tag: [t.operator, t.punctuation], color: '#99a1b3' },
    { tag: t.invalid, color: '#f85149' }
  ]
})

const wrap = EditorView.lineWrapping

function extensionsFor(language: Language): Extension[] {
  switch (language) {
    case 'javascript':
      return [javascript(), wrap]
    case 'json':
      return [json(), wrap]
    case 'html':
      return [html(), wrap]
    case 'xml':
      return [xml(), wrap]
    default:
      return [wrap]
  }
}

interface Props {
  value: string
  onChange?: (value: string) => void
  language?: Language
  readOnly?: boolean
  placeholder?: string
  /**
   * Draw {{variable}} chips. Only for fields the interpolator actually
   * touches - not scripts, docs, response bodies or .env files.
   */
  variables?: boolean
}

/** Shared CodeMirror setup, themed to match the rest of the app. */
export function CodeEditor({
  value,
  onChange,
  language = 'text',
  readOnly = false,
  placeholder,
  variables = false
}: Props): JSX.Element {
  const { scope, openMenu } = useVariableTools()

  const extensions = useMemo(() => {
    const base = extensionsFor(language)
    if (!variables) return base
    // `scope` is in the deps so switching environment re-colours the chips
    // even when the document itself has not changed.
    return [...base, variableHighlighting({ getScope: () => scope, onContextMenu: openMenu })]
  }, [language, variables, scope, openMenu])

  return (
    <div className="cm-host">
      <CodeMirror
        value={value}
        theme={theme}
        extensions={extensions}
        editable={!readOnly}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={onChange}
        basicSetup={{
          lineNumbers: true,
          foldGutter: language === 'json' || language === 'javascript',
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
          autocompletion: !readOnly,
          bracketMatching: true,
          closeBrackets: !readOnly,
          searchKeymap: true,
          // Ctrl+Enter is "send request", so keep it out of the editor.
          defaultKeymap: true
        }}
      />
    </div>
  )
}
