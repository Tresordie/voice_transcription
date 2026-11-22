// Markdown 渲染（marked + DOMPurify + svg/mermaid 图形升级），样式见 index.css 的 .md-view
// rich=false（如流式输出中）走轻量同步路径：只渲染 markdown，图形保持源码（生成完成后自动升级）
import { useEffect, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { renderRichMarkdown } from '../lib/ai/richRender'

marked.setOptions({ async: false, gfm: true, breaks: false })

interface MarkdownViewProps {
  markdown: string
  /** 是否启用 svg/mermaid 图形渲染（默认开；流式期间传 false 用轻量路径） */
  rich?: boolean
}

export default function MarkdownView({ markdown, rich = true }: MarkdownViewProps) {
  const [html, setHtml] = useState('')

  useEffect(() => {
    if (!rich) {
      // 轻量同步路径：流式期间实时刷新
      setHtml(DOMPurify.sanitize(marked.parse(markdown) as string))
      return
    }
    let cancelled = false
    const dark = document.documentElement.classList.contains('dark')
    renderRichMarkdown(markdown, { dark })
      .then((h) => {
        if (!cancelled) setHtml(h)
      })
      .catch(() => {
        if (!cancelled) setHtml(DOMPurify.sanitize(marked.parse(markdown) as string))
      })
    return () => {
      cancelled = true
    }
  }, [markdown, rich])

  return (
    <div
      className="md-view"
      dangerouslySetInnerHTML={{ __html: html || DOMPurify.sanitize(marked.parse(markdown) as string) }}
    />
  )
}
