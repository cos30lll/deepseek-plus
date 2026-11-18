import clsx from 'clsx'
import { memo, useContext, useEffect, useState } from 'react'
import type { Root } from 'mdast'
import type { Source } from '../../services/chat/view.js'
import { parseMarkdownAsync } from '../../services/markdown/asyncParse.js'
import { useTranslate } from '../../i18n/index.js'
import { LightweightHistoryContext } from '../messages/renderMode.js'
import { useScrollToBottom } from '../messages/scrollContext.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'

/** 解析放工作线程；历史先纯文本显示，可按需排版，主线程不批量同步解析。 */
export const Markdown = memo(function Markdown({
  content,
  loading,
  cacheKey,
  className,
  disableLink,
  sources,
}: {
  content: string
  loading: boolean
  cacheKey: string
  className?: string
  disableLink: boolean
  sources?: Source[]
}) {
  const t = useTranslate()
  const lightweight = useContext(LightweightHistoryContext)
  const scrollToBottom = useScrollToBottom()
  const throttledMarkdown = useThrottleMarkdownRender(content, loading)
  const [formatted, setFormatted] = useState(!lightweight)
  const [expanded, setExpanded] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => { if (loading) setFormatted(true) }, [loading])
  const [parsed, setParsed] = useState<{ text: string; sources?: Source[]; disableLink: boolean; ast: Root | null } | null>(null)
  useEffect(() => {
    if (!formatted || !throttledMarkdown) return
    setFailed(false)
    let cancelled = false
    const job = parseMarkdownAsync(throttledMarkdown, sources, disableLink)
    void job.promise.then((ast) => {
      if (!cancelled) {
        setParsed({ text: throttledMarkdown, sources, disableLink, ast })
        setFailed(ast === null)
      }
    })
    return () => { cancelled = true; job.cancel() }
  }, [formatted, throttledMarkdown, sources, disableLink])
  useEffect(scrollToBottom, [parsed, expanded, scrollToBottom])
  if (!throttledMarkdown) return null

  const ast = parsed?.text === throttledMarkdown && parsed.sources === sources && parsed.disableLink === disableLink ? parsed.ast : null
  // 只折叠显示，复制/发送/导出仍拿完整原文，用户可明确展开。
  const longPlain = throttledMarkdown.length > 12000 && !expanded
  const plain = longPlain ? throttledMarkdown.slice(0, 12000) : throttledMarkdown
  return (
    <div className={className}>
      {formatted && ast ? (
        <MarkdownAstRenderer key={cacheKey} ast={ast} loading={loading} onUpdate={scrollToBottom} />
      ) : (
        <div className={clsx('ds-markdown', 'ds-markdown-plain')}>{plain}</div>
      )}
      {!formatted ? <button type="button" className="ds-markdown-render-action" onClick={() => { setFormatted(true); setFailed(false) }}>{t('historyFormatMarkdown')}</button> : null}
      {failed ? <span className="ds-markdown-render-note">{t('historyMarkdownFallback')}</span> : null}
      {!ast && longPlain ? <button type="button" className="ds-markdown-render-action" onClick={() => setExpanded(true)}>{t('historyExpandFullText')}</button> : null}
    </div>
  )
})