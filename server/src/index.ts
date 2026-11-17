import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { stream } from 'hono/streaming'
import { pickArticle, streamAnswer, streamBreakdown } from './breakdown.ts'
import { TtlCache } from './cache.ts'
import { mockAnswer, mockTopic, MOCK_SPOKEN_TOPIC } from './mock.ts'
import { cleanSpokenTopic, transcribe } from './stt.ts'
import type { ArticleLink, Block, Candidate, Figure, LeadImage, StreamEvent } from './types.ts'
import {
  articleForPrompt,
  canonicalTitle,
  fetchArticle,
  fetchLeadImage,
  isAmbiguous,
  plainTitle,
  searchHits,
  WikiError,
} from './wiki.ts'

const PORT = Number(process.env.PORT ?? 8787)
const APP_TOKEN = process.env.APP_TOKEN ?? ''
// Enough for almost any article in full (about 50k tokens, under half a cent on Haiku 5.5).
// At the old 24k cap long pages were cut in page order: "French Revolution" stopped in 1791.
const MAX_ARTICLE_CHARS = Number(process.env.MAX_ARTICLE_CHARS ?? 150000)
const MAX_AUDIO_BYTES = 16000 * 2 * 30 // 30 seconds of 16 kHz 16-bit mono
const LICENSE = 'Wikipedia, CC BY-SA 4.0'
// MOCK=1 serves a canned topic so the glasses app can be developed with no API keys.
const MOCK = process.env.MOCK === '1'

interface CachedTopic {
  title: string
  url: string
  image?: LeadImage
  blocks: Block[]
}

const topics = new TtlCache<CachedTopic>(200, 24 * 60 * 60 * 1000)

/** An article as it is sent to Claude. Kept so a follow-up question does not refetch it. */
interface PromptArticle {
  title: string
  url: string
  image?: LeadImage
  figures: Figure[]
  text: string
  links: ArticleLink[]
}

const articles = new TtlCache<PromptArticle>(50, 24 * 60 * 60 * 1000)

/** Fetches in progress, so a second request for the same article joins the first. */
const loading = new Map<string, Promise<PromptArticle>>()

function loadArticle(title: string): Promise<PromptArticle> {
  const key = title.toLowerCase()
  const hit = articles.get(key)
  if (hit) return Promise.resolve(hit)
  let pending = loading.get(key)
  if (!pending) {
    pending = (async () => {
      const [article, image] = await Promise.all([fetchArticle(title), fetchLeadImage(title)])
      if (!article.sections.length) throw new WikiError(`"${title}" has no readable text`, 404)
      const entry = {
        title: article.title,
        url: article.url,
        image,
        figures: article.figures,
        ...articleForPrompt(article, MAX_ARTICLE_CHARS),
      }
      articles.set(key, entry)
      articles.set(article.title.toLowerCase(), entry)
      return entry
    })().finally(() => loading.delete(key))
    loading.set(key, pending)
  }
  return pending
}

/**
 * Works out which article a spoken or typed request means.
 * - A bare name with several meanings ("mercury"): returns the meanings for the reader to choose.
 * - A request that names the top search hit exactly: that article.
 * - Anything else: the model chooses among the hits, or names a better article, which is
 *   used only if it really exists.
 */
async function resolveTopic(query: string, signal: AbortSignal): Promise<string | Candidate[]> {
  const started = Date.now()
  const hits = await searchHits(query)
  const candidates: Candidate[] = hits
    .filter(hit => !hit.disambiguation)
    .map(({ title, description }) => ({ title, description }))
  if (isAmbiguous(query, hits) && candidates.length > 1) {
    console.log(`resolve ${JSON.stringify(query)} -> ${candidates.length} choices (${Date.now() - started} ms)`)
    return candidates
  }
  const top = candidates[0]?.title
  let title = top
  let how = 'exact match'
  if (!top || plainTitle(top) !== plainTitle(query)) {
    how = 'top hit'
    // The model usually agrees with the top hit, so start fetching that article now:
    // the pick then costs no extra wait unless it chooses something else.
    if (top) void loadArticle(top).catch(() => undefined)
    // A failed pick must not fail the topic: the top hit is still a reasonable answer.
    const choice = await pickArticle(query, candidates, signal).catch(err => {
      console.warn('pick failed:', (err as Error).message)
      return ''
    })
    if (candidates.some(candidate => candidate.title === choice)) {
      title = choice
      how = 'picked'
    } else if (choice) {
      const real = await canonicalTitle(choice).catch(() => undefined)
      if (real) {
        title = real
        how = 'suggested'
      }
    }
  }
  if (!title) throw new WikiError(`No Wikipedia article found for "${query}"`, 404)
  console.log(`resolve ${JSON.stringify(query)} -> "${title}" (${how}, ${Date.now() - started} ms)`)
  return title
}

type Send = (event: StreamEvent) => Promise<unknown>

/** Answers with an NDJSON stream: whatever `run` sends, then `done`, or one `error` line. */
function ndjson(c: Context, what: string, run: (send: Send, signal: AbortSignal) => Promise<void>) {
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
  c.header('Cache-Control', 'no-store')
  c.header('X-Accel-Buffering', 'no') // ask proxies not to buffer the stream
  return stream(c, async out => {
    const send: Send = event => out.write(JSON.stringify(event) + '\n')
    const abort = new AbortController()
    out.onAbort(() => abort.abort())
    try {
      await run(send, abort.signal)
      await send({ type: 'done' })
    } catch (err) {
      if (abort.signal.aborted) return
      console.error(`${what} failed:`, err)
      await send({ type: 'error', message: (err as Error).message })
    }
  })
}

/** Sends blocks in order as the model finishes them, and keeps them for the caller. */
function relay(send: Send) {
  const blocks: Block[] = []
  let pending: Promise<unknown> = Promise.resolve()
  return {
    blocks,
    emit: (block: Block) => {
      blocks.push(block)
      pending = pending.then(() => send({ type: 'block', block }))
    },
    flush: () => pending,
  }
}

export const app = new Hono()

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-App-Token'],
  }),
)

app.get('/health', c => c.json({ ok: true }))

// Everything under /api needs the shared token when one is configured.
app.use('/api/*', async (c, next) => {
  if (APP_TOKEN && c.req.header('x-app-token') !== APP_TOKEN) {
    return c.json({ error: 'Missing or wrong X-App-Token' }, 401)
  }
  await next()
})

/** Raw PCM in, cleaned topic text out. */
app.post('/api/stt', async c => {
  const pcm = new Uint8Array(await c.req.arrayBuffer())
  if (pcm.length < 3200) return c.json({ error: 'Recording too short' }, 400)
  if (pcm.length > MAX_AUDIO_BYTES) return c.json({ error: 'Recording too long' }, 413)
  if (MOCK) return c.json({ transcript: MOCK_SPOKEN_TOPIC, topic: MOCK_SPOKEN_TOPIC })
  try {
    const transcript = await transcribe(pcm)
    const topic = cleanSpokenTopic(transcript)
    // Without this a wrong article cannot be traced to the mic, the transcript or the search.
    console.log(`stt ${(pcm.length / 32000).toFixed(1)}s heard=${JSON.stringify(transcript)} topic=${JSON.stringify(topic)}`)
    return c.json({ transcript, topic })
  } catch (err) {
    console.error('stt failed:', err)
    return c.json({ error: (err as Error).message }, 502)
  }
})

/**
 * Streams a topic as NDJSON: one `meta` line, then a `block` line per heading
 * or paragraph as Claude finishes it, then `done`.
 *   ?q=free text      -> searched on Wikipedia first (spoken topics)
 *   ?title=Exact Name -> opened directly (link dives)
 */
app.get('/api/topic', c => {
  const q = c.req.query('q')?.trim()
  const exact = c.req.query('title')?.trim()
  if (!q && !exact) return c.json({ error: 'Pass ?q= or ?title=' }, 400)

  return ndjson(c, 'topic', async (send, signal) => {
    if (MOCK) {
      const mock = mockTopic(exact || q!)
      await send({ type: 'meta', title: mock.title, url: mock.url, license: LICENSE, cached: false })
      for (const block of mock.blocks) {
        await new Promise(resolve => setTimeout(resolve, 150))
        await send({ type: 'block', block })
      }
      return
    }

    const resolved = exact || (await resolveTopic(q!, signal))
    if (typeof resolved !== 'string') {
      await send({ type: 'choices', query: q!, options: resolved })
      return
    }
    const title = resolved
    const cacheKey = title.toLowerCase()

    const cached = topics.get(cacheKey)
    if (cached) {
      await send({ type: 'meta', title: cached.title, url: cached.url, license: LICENSE, cached: true, image: cached.image })
      for (const block of cached.blocks) await send({ type: 'block', block })
      return
    }

    const article = await loadArticle(title)
    await send({ type: 'meta', title: article.title, url: article.url, license: LICENSE, cached: false, image: article.image })

    const out = relay(send)
    await streamBreakdown(article.title, article.text, article.links, article.figures, out.emit, signal)
    await out.flush()

    if (!out.blocks.some(block => block.kind === 'para')) throw new Error('The breakdown came back empty')
    const entry = { title: article.title, url: article.url, image: article.image, blocks: out.blocks }
    topics.set(cacheKey, entry)
    topics.set(article.title.toLowerCase(), entry)
  })
})

/**
 * Answers a question about the article being read, in the same NDJSON form as a topic.
 * Body: { title: exact article title, question, passage?: what the reader was on }.
 */
app.post('/api/ask', async c => {
  const body = (await c.req.json().catch(() => null)) as { title?: unknown; question?: unknown; passage?: unknown } | null
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const question = typeof body?.question === 'string' ? body.question.replace(/\s+/g, ' ').trim() : ''
  const passage = typeof body?.passage === 'string' ? body.passage.slice(0, 2000) : ''
  if (!title || title.length > 300) return c.json({ error: 'Pass the article title' }, 400)
  if (!question || question.length > 500) return c.json({ error: 'Pass a question of at most 500 characters' }, 400)

  return ndjson(c, 'ask', async (send, signal) => {
    if (MOCK) {
      await send({ type: 'meta', title: question, url: '', license: LICENSE, cached: false })
      for (const block of mockAnswer(question)) await send({ type: 'block', block })
      return
    }
    const article = await loadArticle(title)
    await send({ type: 'meta', title: question, url: article.url, license: LICENSE, cached: false })
    const out = relay(send)
    await streamAnswer(article.title, article.text, article.links, question, passage, out.emit, signal)
    await out.flush()
    if (!out.blocks.some(block => block.kind === 'para')) throw new Error('The answer came back empty')
  })
})

// Start listening unless a test imported this file.
if (!process.env.VITEST) {
  serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, info => {
    console.log(`rabbit-hole server on http://localhost:${info.port}`)
    if (MOCK) console.warn('MOCK=1: serving canned content, no Wikipedia or Claude calls.')
    if (!APP_TOKEN) console.warn('APP_TOKEN is not set: anyone who finds this URL can spend your API keys.')
  })
}
