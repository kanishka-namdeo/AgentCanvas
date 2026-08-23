'use client';

// Markdown.tsx — markdown renderer for agent chat messages.
//
// The agent's responses contain markdown (bold, lists, inline code, fenced
// code blocks). Rendering them raw (whitespace-pre-wrap) made every response
// look like wall-of-text. This component renders proper markdown with
// click-to-copy code blocks — the standard treatment in Claude / ChatGPT / v0.
//
// Uses react-markdown (already a dependency). Deliberately no syntax
// highlighting library in the chat — the code blocks here are short tool
// snippets and SVG fragments; a monospace block + copy button is lighter
// than shipping highlight.js into the bundle.

import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Check, Copy } from 'lucide-react';

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = typeof children === 'string' ? children : String(children ?? '');
  return (
    <div className="group/code relative my-1.5 rounded-md border ac-border-subtle ac-surface-2 overflow-hidden">
      <button
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }).catch(() => { /* clipboard unavailable — ignore */ });
        }}
        title="Copy code"
        aria-label="Copy code"
        className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium ac-text-3 ac-surface-1 border ac-border-subtle opacity-0 group-hover/code:opacity-100 transition-opacity ac-focus-ring"
      >
        {copied ? <Check className="h-2.5 w-2.5 ac-text-success" /> : <Copy className="h-2.5 w-2.5" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="overflow-x-auto p-2 pr-12 text-[10px] leading-relaxed font-mono ac-text-2">
        <code>{text}</code>
      </pre>
    </div>
  );
}

export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="text-xs ac-text-1 leading-relaxed markdown-chat">
      <ReactMarkdown
        components={{
          // Tighten the default spacing for a chat panel.
          p: ({ children }) => <p className="mb-1.5 last:mb-0 whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-4 mb-1.5 last:mb-0 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-4 mb-1.5 last:mb-0 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold ac-text-1">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className="underline text-[color:var(--ac-accent)]">
              {children}
            </a>
          ),
          h1: ({ children }) => <h3 className="text-[13px] font-semibold mt-2 mb-1">{children}</h3>,
          h2: ({ children }) => <h3 className="text-[12px] font-semibold mt-2 mb-1">{children}</h3>,
          h3: ({ children }) => <h4 className="text-[12px] font-semibold mt-1.5 mb-1">{children}</h4>,
          code: ({ className, children }) => {
            // Inline code (no language class, no newline) vs fenced block.
            const isBlock = /language-/.test(className ?? '') || String(children ?? '').includes('\n');
            if (isBlock) return <CodeBlock>{children}</CodeBlock>;
            return (
              <code className="px-1 py-0.5 rounded ac-surface-2 text-[10px] font-mono ac-text-2">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 pl-2 my-1.5 ac-text-3" style={{ borderColor: 'var(--ac-border-strong)' }}>
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-2 ac-border-subtle" style={{ borderColor: 'var(--ac-border)' }} />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-1.5">
              <table className="text-[10px] border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border px-1.5 py-0.5 text-left font-semibold ac-border-default ac-surface-1">{children}</th>
          ),
          td: ({ children }) => <td className="border px-1.5 py-0.5 ac-border-subtle">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
