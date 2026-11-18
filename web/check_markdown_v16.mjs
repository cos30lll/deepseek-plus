import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { rspack } from '@rspack/core'

// One focused regression: the stopped reply from the reported C example must
// render as Markdown immediately, not wait for a manual formatting action.
const web = path.dirname(fileURLToPath(import.meta.url))
const temp = await mkdtemp(path.join(tmpdir(), 'deepseek-markdown-'))
const sample = [
  '```c',
  '#include <stdio.h>',
  '',
  'int main(void)',
  '{',
  '    printf("Hello, World!\\n");',
  '    return 0;',
  '}',
  '```',
  '',
  '**说明： **',
  '',
  '- `#include <stdio.h>`：引入标准输入输出库。',
  '- **返回值**：0 表示正常结束。',
].join('\n')
const resultPath = path.join(temp, 'result.json')
const entry = String.raw`
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
// Only provide globals read during module initialization; no app, database,
// network, DOM mounting or effects are started by server rendering.
globalThis.window = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
}
globalThis.localStorage = globalThis.sessionStorage = { getItem: () => null }
const { Markdown } = await import(${JSON.stringify(path.join(web, 'src/components/markdown/Markdown.tsx'))})
const { parseBoundedMarkdown } = await import(${JSON.stringify(path.join(web, 'src/services/markdown/parseBounded.ts'))})
const content = ${JSON.stringify(sample)}
const render = (value, loading) => renderToStaticMarkup(createElement(Markdown, {
  content: value, loading, cacheKey: 'reported-c-example', disableLink: false,
}))
const previousError = console.error
console.error = (message, ...args) => {
  if (typeof message === 'string' && message.startsWith('Warning: useLayoutEffect does nothing on the server')) return
  previousError(message, ...args)
}
try {
  for (const loading of [false, true]) {
    const html = render(content, loading)
    assert.match(html, /class="md-code-block"/)
    assert.match(html, /<pre><code>#include &lt;stdio.h&gt;/)
    assert.match(html, /<strong><span>说明：<\/span><\/strong>/)
    assert.match(html, /<strong><span>返回值<\/span><\/strong>/)
    assert.match(html, /<ul>/)
    assert.match(html, /<code>#include &lt;stdio.h&gt;<\/code>/)
    assert.ok(!html.includes('排版显示') && !html.includes('Format Markdown'))
    assert.ok(!html.includes('ds-markdown-plain') && !html.includes('historyMarkdownFallback'))
    assert.ok(!html.includes('\x60\x60\x60c'))
  }
  const literal = render('\x60\x60\x60text\n**说明： **\n\x60\x60\x60', false)
  assert.match(literal, /<code>\*\*说明： \*\*<\/code>/)
  assert.ok(!literal.includes('<strong>'))
  const escaped = render('\\\\*\\\\*说明： \\\\*\\\\*', false)
  assert.ok(!escaped.includes('<strong>'))
  const ast = parseBoundedMarkdown(content, { sources: undefined, disableLink: false })
  assert.ok(ast && ast.children.some((node) => node.type === 'code' && node.lang === 'c'))
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
    stoppedReplyFormatted: true, streamingReplyFormatted: true,
    fencedCode: true, bold: true, lists: true, inlineCode: true,
    codeAndEscapedMarkersPreserved: true,
    appStarted: false, userDatabaseWritten: false, screenshotOrHierarchyRead: false,
  }))
} finally { console.error = previousError }
`

try {
  const entryPath = path.join(temp, 'check.mjs')
  await writeFile(entryPath, entry)
  const compiler = rspack({
    mode: 'development',
    context: web,
    target: 'node',
    entry: entryPath,
    devtool: false,
    output: { path: path.join(temp, 'out'), filename: 'check.cjs', publicPath: '' },
    resolve: {
      modules: [path.join(web, 'node_modules'), 'node_modules'],
      extensions: ['.tsx', '.ts', '.js'],
      extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    },
    module: {
      parser: { 'css/module': { namedExports: false } },
      generator: { css: { exportsOnly: true }, 'css/module': { exportsOnly: true } },
      rules: [
        { test: /\.module\.css$/, type: 'css/module' },
        { test: /\.css$/, exclude: /\.module\.css$/, type: 'css' },
        { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
        {
          test: /\.[jt]sx?$/, exclude: /node_modules/,
          loader: 'builtin:swc-loader', type: 'javascript/auto',
          options: { jsc: { target: 'es2022', parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } } },
        },
      ],
    },
    optimization: { minimize: false },
    performance: { hints: false },
  })
  try {
    const stats = await new Promise((resolve, reject) => compiler.run((error, stats) => error ? reject(error) : resolve(stats)))
    assert.ok(stats && !stats.hasErrors(), stats?.toString({ all: false, errors: true }))
  } finally {
    await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()))
  }
  const result = spawnSync(process.execPath, [path.join(temp, 'out/check.cjs')], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error))
  console.log('MARKDOWN_V16_OK', await readFile(resultPath, 'utf8'))
} finally {
  await rm(temp, { recursive: true, force: true })
}
