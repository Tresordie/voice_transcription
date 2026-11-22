// Markdown 渲染（marked + DOMPurify 消毒），样式见 index.css 的 .md-view
import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ async: false, gfm: true, breaks: false })

export default function MarkdownView({ markdown }: { markdown: string }) {
  const html = useMemo(() => {
    const rendered = marked.parse(markdown) as string
    return DOMPurify.sanitize(rendered, { ADD_ATTR: ['target'] })
  }, [markdown])
  return <div className="md-view" dangerouslySetInnerHTML={{ __html: html }} />
}
