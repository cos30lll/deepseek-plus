import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Root } from 'mdast'
import type { Source } from '../../services/chat/view.js'
import { parseMarkdownAsync } from '../../services/markdown/asyncParse.js'
import { parseBoundedMarkdown } from '../../services/markdown/parseBounded.js'
import { useTranslate } from '../../i18n/index.js'
import { useScrollToBottom } from '../messages/scrollContext.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'

const SYNC_LIMIT = 4096
const AUTO_FORMAT_LIMIT = 48_000
const PREVIEW_LENGTH = 12_000

type ParseResult = {
  cacheKey: string
  text: string
  sources?: Source[]
  disableLink: boolean
  ast: Root | null
}

/** Format mounted replies by default. Keep long text off the UI thread. */
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
  const scrollToBottom = useScrollToBottom()
  const markdown = useThrottleMarkdownRender(content, loading)
  const [expanded, setExpanded] = useState(false)
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const previous = useRef<ParseResult | null>(null)
  const preview = !expanded && markdown.length > AUTO_FORMAT_LIMIT
  const text = preview ? markdown.slice(0, PREVIEW_LENGTH) : markdown
  const useWorker = text.length > SYNC_LIMIT
  const shortAst = useMemo(
    () => text && !useWorker ? parseBoundedMarkdown(text, { sources, disableLink }) : null,
    [text, useWorker, sources, disableLink]
  )

  useEffect(() => {
    if (!useWorker) return
    const job = parseMarkdownAsync(text, sources, disableLink)
    let cancelled = false
    void job.promise.then((ast) => {
      if (!cancelled) setParsed({ cacheKey, text, sources, disableLink, ast })
    })
    return () => {
      cancelled = true
      job.cancel()
    }
  }, [useWorker, text, sources, disableLink, cacheKey])

  const current = parsed?.cacheKey === cacheKey && parsed.text === text &&
    parsed.sources === sources && parsed.disableLink === disableLink
  const exactAst = useWorker ? (current ? parsed.ast : null) : shortAst
  const failed = exactAst === null && (!useWorker || current)
  if (exactAst) previous.current = { cacheKey, text, sources, disableLink, ast: exactAst }
  const last = previous.current
  // Do not flash Markdown punctuation while the next streaming revision is parsed.
  const ast = exactAst ?? (!failed && last?.cacheKey === cacheKey &&
    last.sources === sources && last.disableLink === disableLink && text.startsWith(last.text)
    ? last.ast : null)
  const truncatePlain = !ast && text.length > PREVIEW_LENGTH && (!expanded || !failed)
  useEffect(scrollToBottom, [ast, expanded, scrollToBottom])
  if (!text) return null
  return (
    <div className={className}>
      {ast ? (
        <MarkdownAstRenderer key={cacheKey} ast={ast} loading={loading} onUpdate={scrollToBottom} />
      ) : (
        <div className="ds-markdown ds-markdown-plain">
          {truncatePlain ? text.slice(0, PREVIEW_LENGTH) : text}
        </div>
      )}
      {failed ? <span className="ds-markdown-render-note">{t('historyMarkdownFallback')}</span> : null}
      {preview || (truncatePlain && !expanded) ? (
        <button type="button" className="ds-markdown-render-action" onClick={() => setExpanded(true)}>
          {t('historyExpandFullText')}
        </button>
      ) : null}
    </div>
  )
})
