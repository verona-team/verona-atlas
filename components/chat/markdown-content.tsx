'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

const components: Components = {
  p: ({ children }) => (
    <p className="mb-3 last:mb-0">{children}</p>
  ),
  h1: ({ children }) => (
    <h1 className="text-xl font-semibold mt-5 mb-2 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-lg font-semibold mt-4 mb-2 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-semibold mt-3 mb-1.5 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-sm font-semibold mt-3 mb-1 first:mt-0">{children}</h4>
  ),
  ul: ({ children }) => (
    <ul className="mb-3 ml-5 list-disc space-y-1 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 ml-5 list-decimal space-y-1 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="leading-relaxed">{children}</li>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-foreground/20 pl-4 my-3 opacity-80 italic">
      {children}
    </blockquote>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = className?.includes('language-')
    if (isBlock) {
      const lang = className?.replace('language-', '') ?? ''
      return (
        <div className="my-3 rounded-lg border border-border overflow-hidden">
          {lang && (
            <div className="px-3 py-1 bg-muted/50 border-b border-border text-xs text-muted-foreground font-mono">
              {lang}
            </div>
          )}
          <pre className="p-3 overflow-x-auto bg-muted/30">
            <code className="text-sm font-mono leading-relaxed" {...props}>
              {children}
            </code>
          </pre>
        </div>
      )
    }
    return (
      <code className="rounded bg-muted/50 px-1.5 py-0.5 text-[0.9em] font-mono" {...props}>
        {children}
      </code>
    )
  },
  pre: ({ children }) => <>{children}</>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:opacity-80 transition-opacity"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-border bg-muted/30">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="px-3 py-2 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2 border-t border-border">{children}</td>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="italic">{children}</em>
  ),
}

interface MarkdownContentProps {
  content: string
  className?: string
}

export function MarkdownContent({ content, className = '' }: MarkdownContentProps) {
  return (
    <div className={`leading-relaxed ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
