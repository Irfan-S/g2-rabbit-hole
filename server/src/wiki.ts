import { parse, type HTMLElement } from 'node-html-parser'
import type { Article, ArticleLink, ArticleSection, Candidate, Figure, LeadImage } from './types.ts'

const LANG = process.env.WIKI_LANG ?? 'en'
const HOST = `https://${LANG}.wikipedia.org`
// Wikimedia asks API clients to identify themselves with contact details.
const USER_AGENT =
  process.env.WIKI_USER_AGENT ?? 'g2-rabbit-hole/0.1 (set WIKI_USER_AGENT to your contact email)'

/** Sections that carry no teaching content. */
const SKIP_SECTIONS = new Set([
  'see also',
  'references',
  'notes',
  'footnotes',
  'citations',
  'sources',
  'bibliography',
  'further reading',
  'external links',
  'explanatory notes',
  'works cited',
])

/** Link targets in these namespaces are not articles. */
const NON_ARTICLE_NAMESPACES = new Set([
  'file',
  'image',
  'category',
  'help',
  'wikipedia',
  'special',
  'template',
  'portal',
  'talk',
  'draft',
  'module',
  'mediawiki',
  'user',
  'book',
  'timedtext',
  'wp',
])

/** At most this many pictures are offered to the model per article. */
const MAX_FIGURES = 12

/** Elements whose text would pollute a paragraph. */
const STRIP_SELECTORS = [
  'style',
  'script',
  'table',
  'figure',
  'sup',
  '.mw-ref',
  '.reference',
  '.hatnote',
  '.navbox',
  '.infobox',
  '.metadata',
  '.noprint',
  '.mw-editsection',
  '.reflist',
  '.thumb',
  '.shortdescription',
  '.IPA',
]

export class WikiError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message)
  }
}

async function wikiFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT },
    redirect: 'follow',
  })
  return res
}

/** A search hit, flagged when it is a disambiguation page ("Mercury may refer to..."). */
export interface SearchHit extends Candidate {
  disambiguation: boolean
}

/** The top search hits for free text (for example a spoken phrase), best first. */
export async function searchHits(query: string, limit = 8): Promise<SearchHit[]> {
  const url =
    `${HOST}/w/api.php?action=query&format=json&generator=search&gsrlimit=${limit}` +
    `&prop=pageprops|description&ppprop=disambiguation&gsrsearch=` +
    encodeURIComponent(query)
  const res = await wikiFetch(url)
  if (!res.ok) throw new WikiError(`Wikipedia search failed (${res.status})`)
  const data = (await res.json()) as {
    query?: { pages?: Record<string, { title: string; index: number; description?: string; pageprops?: object }> }
  }
  return Object.values(data.query?.pages ?? {})
    .sort((a, b) => a.index - b.index)
    // The only page prop requested is `disambiguation`, so having any means it is one.
    .map(page => ({ title: page.title, description: page.description ?? '', disambiguation: !!page.pageprops }))
}

/** Lower case, without a leading "the": how a spoken request is compared with a title. */
export const plainTitle = (text: string) => text.toLowerCase().replace(/^the\s+/, '').trim()

/**
 * True when the request is a bare name with no main meaning: Wikipedia's page of that
 * exact name is a disambiguation page ("Mercury", "P50"). A name with a main article
 * ("Java", which also has "Java (disambiguation)") is not ambiguous in this sense.
 */
export function isAmbiguous(query: string, hits: SearchHit[]): boolean {
  return hits.some(hit => hit.disambiguation && plainTitle(hit.title) === plainTitle(query))
}

/** Search hits that are real articles, best first. */
export async function searchCandidates(query: string, limit = 8): Promise<Candidate[]> {
  return (await searchHits(query, limit))
    .filter(hit => !hit.disambiguation)
    .map(({ title, description }) => ({ title, description }))
}

/** The single best-matching article title for free text, by search rank alone. */
export async function searchTitle(query: string): Promise<string> {
  const hit = (await searchCandidates(query, 5))[0]?.title
  if (!hit) throw new WikiError(`No Wikipedia article found for "${query}"`, 404)
  return hit
}

/** The real title of a page (following redirects), or undefined if there is no such page. */
export async function canonicalTitle(title: string): Promise<string | undefined> {
  const res = await wikiFetch(
    `${HOST}/w/api.php?action=query&format=json&redirects=1&titles=${encodeURIComponent(title)}`,
  )
  if (!res.ok) return undefined
  const data = (await res.json()) as { query?: { pages?: Record<string, { title: string; missing?: string }> } }
  const page = Object.values(data.query?.pages ?? {})[0]
  return page && page.missing === undefined ? page.title : undefined
}

/** Fetches and extracts one article by exact title. */
export async function fetchArticle(title: string): Promise<Article> {
  const key = encodeURIComponent(title.replace(/ /g, '_'))
  const res = await wikiFetch(`${HOST}/w/rest.php/v1/page/${key}/html`)
  if (res.status === 404) throw new WikiError(`Wikipedia has no page titled "${title}"`, 404)
  if (!res.ok) throw new WikiError(`Wikipedia fetch failed (${res.status})`)
  const html = await res.text()
  if (html.includes('id="disambigbox"')) {
    // A link dive can land on a disambiguation page; open the best real article instead.
    const best = await searchTitle(title)
    if (best.toLowerCase() === title.toLowerCase()) throw new WikiError(`"${title}" has no single article`, 404)
    return fetchArticle(best)
  }
  return extractArticle(html, title)
}

/**
 * The article's main picture, if it has a freely licensed one (`pilicense=free` leaves out
 * logos, covers and other fair-use files). Never throws: a topic reads fine without it.
 */
export async function fetchLeadImage(title: string): Promise<LeadImage | undefined> {
  try {
    const res = await wikiFetch(
      `${HOST}/w/api.php?action=query&format=json&redirects=1&prop=pageimages&piprop=thumbnail|name` +
        `&pithumbsize=640&pilicense=free&titles=${encodeURIComponent(title)}`,
    )
    if (!res.ok) return undefined
    const data = (await res.json()) as {
      query?: { pages?: Record<string, { pageimage?: string; thumbnail?: { source?: string } }> }
    }
    const page = Object.values(data.query?.pages ?? {})[0]
    if (!page?.pageimage || !page.thumbnail?.source) return undefined
    return { url: page.thumbnail.source, page: `${HOST}/wiki/File:${encodeURIComponent(page.pageimage)}` }
  } catch {
    return undefined
  }
}

export function pageUrl(title: string): string {
  return `${HOST}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
}

function cleanText(raw: string): string {
  return raw
    .replace(/\[\s*\d+\s*\]/g, '') // leftover citation markers like [12]
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

/** "./Quantum_superposition#History" -> "Quantum superposition"; null when not an article link. */
export function linkTitleFromHref(href: string): string | null {
  if (!href.startsWith('./')) return null
  let target = href.slice(2).split('#')[0] ?? ''
  target = target.split('?')[0] ?? ''
  if (!target) return null
  try {
    target = decodeURIComponent(target)
  } catch {
    return null
  }
  const title = target.replace(/_/g, ' ').trim()
  if (!title) return null
  const colon = title.indexOf(':')
  if (colon > 0 && NON_ARTICLE_NAMESPACES.has(title.slice(0, colon).toLowerCase())) return null
  return title
}

/**
 * Pulls readable sections and real article links out of Wikipedia's Parsoid HTML.
 * Exported separately from the network call so it can be tested against fixtures.
 */
export function extractArticle(html: string, fallbackTitle: string): Article {
  const root = parse(html)
  const title = cleanText(root.querySelector('title')?.text ?? '') || fallbackTitle

  // Pictures, read before the strip below removes them. Only files on Wikimedia Commons:
  // those are freely licensed, while files uploaded to English Wikipedia itself are mostly
  // fair-use (logos, covers, press photos) and should not be re-shown.
  const figures: Figure[] = []
  for (const figure of root.querySelectorAll('figure')) {
    if (figures.length === MAX_FIGURES) break
    const src = figure.querySelector('img')?.getAttribute('src') ?? ''
    const file = /^\.\/(File:[^?#]+)/.exec(figure.querySelector('a')?.getAttribute('href') ?? '')?.[1]
    const caption = cleanText(figure.querySelector('figcaption')?.text ?? '')
    if (!file || caption.length < 15 || !src.includes('/wikipedia/commons/')) continue
    figures.push({
      url: src.startsWith('//') ? `https:${src}` : src,
      page: `${HOST}/wiki/${file}`,
      caption: caption.slice(0, 200),
    })
  }

  // Formulas: swap the MathML for its LaTeX source so the model can say it in words.
  // Dropping them left holes like "written as an equation: The theorem is named...".
  for (const el of root.querySelectorAll('math')) {
    const tex = texSource(el)
    // ponytail: formulas over 200 chars (derivations, matrices) are dropped to protect the prompt budget.
    if (tex && tex.length <= 200) el.textContent = ` ${tex} `
    else el.remove()
  }

  for (const selector of STRIP_SELECTORS) {
    for (const el of root.querySelectorAll(selector)) el.remove()
  }

  const sections: ArticleSection[] = []
  const links: ArticleLink[] = []
  const seenLinks = new Set<string>()
  let current: ArticleSection = { heading: 'Overview', paragraphs: [] }
  let skipping = false

  const pushCurrent = () => {
    if (current.paragraphs.length) sections.push(current)
  }

  const body = root.querySelector('body') ?? root
  for (const el of body.querySelectorAll('h2, h3, p')) {
    const tag = el.tagName?.toLowerCase()
    if (tag === 'h2' || tag === 'h3') {
      const heading = cleanText(el.text)
      // An h3 inside a skipped h2 section stays skipped.
      if (tag === 'h2') skipping = SKIP_SECTIONS.has(heading.toLowerCase())
      if (skipping || !heading) continue
      pushCurrent()
      current = { heading, paragraphs: [] }
      continue
    }
    if (skipping) continue
    if (cleanText(el.text).length < 40) continue // stubs, captions and empty paragraphs
    markLinks(el, title, links, seenLinks)
    current.paragraphs.push(cleanText(el.text))
  }
  pushCurrent()

  return { title, url: pageUrl(title), sections, links, figures }
}

/** Parsoid keeps the original LaTeX in data-mw: {"name":"math","body":{"extsrc":"a^2+b^2=c^2"}}. */
function texSource(math: HTMLElement): string {
  try {
    const data = JSON.parse(math.getAttribute('data-mw') ?? '') as { body?: { extsrc?: string } }
    return (data.body?.extsrc ?? '').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

/**
 * Rewrites each real article link in the paragraph as [[Exact Title|words shown]], the
 * same form the model must write, and records it. Seeing the marks in context is what
 * makes the model reproduce them; a separate list of titles was mostly ignored.
 */
function markLinks(
  paragraph: HTMLElement,
  ownTitle: string,
  links: ArticleLink[],
  seen: Set<string>,
) {
  for (const a of paragraph.querySelectorAll('a')) {
    const rel = a.getAttribute('rel') ?? ''
    if (!rel.includes('mw:WikiLink')) continue
    if ((a.getAttribute('class') ?? '').split(/\s+/).includes('new')) continue // red link
    const linkTitle = linkTitleFromHref(a.getAttribute('href') ?? '')
    if (!linkTitle) continue
    const key = linkTitle.toLowerCase()
    if (key === ownTitle.toLowerCase()) continue
    const anchor = cleanText(a.text)
    if (!anchor || /[\[\]|]/.test(linkTitle + anchor)) continue // would break the mark syntax
    a.textContent = `[[${linkTitle}|${anchor}]]`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ title: linkTitle, anchor })
  }
}

/**
 * Renders the article as prompt text, capped so one long page cannot blow the
 * token budget. Returns the text plus the links that survive the cap.
 */
export function articleForPrompt(
  article: Article,
  maxChars: number,
): { text: string; links: ArticleLink[] } {
  const parts: string[] = []
  let used = 0
  for (const section of article.sections) {
    const head = `## ${section.heading}`
    let added = 0
    let full = false
    for (const paragraph of section.paragraphs) {
      const cost = paragraph.length + (added === 0 ? head.length : 0)
      if (used + cost > maxChars) {
        full = true
        break
      }
      // The heading goes in only once a paragraph under it fits, so the cap
      // never leaves a heading with nothing beneath it.
      if (added === 0) parts.push(head)
      parts.push(paragraph)
      used += cost
      added++
    }
    if (full) break
  }
  const text = parts.join('\n\n')
  // Keep only links that are actually marked in the text we send.
  const links = article.links.filter(link => text.includes(`[[${link.title}|`))
  return { text, links }
}
