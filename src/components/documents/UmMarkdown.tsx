"use client";

import ReactMarkdown from "react-markdown";

interface UmMarkdownProps {
  content: string;
  className?: string;
}

export function UmMarkdown({ content, className = "" }: UmMarkdownProps) {
  return (
    <div className={`um-doc markdown-body ${className}`}>
      <ReactMarkdown
        components={{
          img: ({ alt, src }) => (
            <span className="um-image-wrap">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src ?? ""} alt={alt ?? ""} loading="lazy" className="um-image" />
            </span>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="um-link">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
