import Editor from '@monaco-editor/react';

export function JsonEditor({
  value,
  language,
  onChange,
  readOnly,
  height,
}: {
  value: string;
  language: 'json' | 'markdown';
  onChange: (value: string) => void;
  readOnly?: boolean;
  height?: string;
}) {
  return (
    <div className="code-editor">
      <Editor
        language={language}
        value={value}
        onChange={(nextValue) => onChange(nextValue ?? '')}
        height={height || '360px'}
        theme="vs-light"
        options={{
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          wordWrap: 'on',
          readOnly: Boolean(readOnly),
        }}
      />
    </div>
  );
}
