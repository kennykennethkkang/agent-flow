'use client'

/** A chat's commit message in full: the summary line first, the bullets under it, scrolling when long. */
export function CommitText({ text, color = 'var(--hub-ink)', soft = 'var(--hub-canvas)', max = 280 }: { text: string; color?: string; soft?: string; max?: number }) {
  const [head, ...rest] = text.split('\n')
  const body = rest.join('\n').replace(/^\s*\n/, '').trimEnd()
  return (
    // A span, so it can sit in a paragraph or a callout.
    <span role="region" aria-label="Commit message" tabIndex={0} className="hub-commit"
      style={{ display: 'grid', gap: 6, minWidth: 0, maxHeight: max, textAlign: 'left', overflowY: 'auto', padding: '8px 10px', borderRadius: 8, background: soft, border: '1px solid var(--hub-hair)' }}>
      <span style={{ font: '500 13px/1.45 var(--hub-mono)', color, overflowWrap: 'anywhere' }}>{head}</span>
      {body && <span style={{ font: '400 12px/1.6 var(--hub-mono)', color: 'var(--hub-body)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{body}</span>}
    </span>
  )
}
