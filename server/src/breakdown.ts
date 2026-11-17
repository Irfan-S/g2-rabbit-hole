import Anthropic from '@anthropic-ai/sdk'
import type { ArticleLink, Block, Candidate, Figure, LinkSpan } from './types.ts'

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-5-5'
const TARGET_WORDS = Number(process.env.BREAKDOWN_WORDS ?? 600)
const MAX_TOKENS = Number(process.env.BREAKDOWN_MAX_TOKENS ?? 4096) // longest seen in testing: 2,400

const STYLE_RULES = `Style rules
- Short sentences, 18 words at most. One idea per sentence.
- No bullet points, tables, bold, italics, citations or footnote markers.
- No formulas or symbols. Formulas in the ARTICLE are written in LaTeX: say them in words.
- No parentheses or asides. The only brackets allowed are link marks.`

/** `need` says how many links are wanted; `scope` is the unit a concept is linked once in. */
const linkRules = (need: string, scope: string) => `Link rules
- In the ARTICLE, pages the reader can open are marked as [[Exact Title|words shown]].
- The reader opens links to go one level deeper. ${need}
- When you mention a marked concept, mark its first mention in ${scope} the same way.
  Example: The boundary of no escape is called the [[Event horizon|event horizon]].
- Copy "Exact Title" character for character from the ARTICLE. Never invent a title.
- "words shown" is the natural wording in your sentence, 1 to 3 words.
- Link the concepts a curious reader would want to open next, not every marked word.`

export const SYSTEM_PROMPT = `You rewrite a Wikipedia article as a learning breakdown.
The reader sees it on smart glasses, one word at a time, so clarity matters more than style.

Content rules
- Use only facts stated in the ARTICLE. Add nothing from outside it. If the article is thin, write less.
- Explain the topic in a sensible teaching order: what it is, how it works, why it matters, then details.
- Define each technical term in plain words the first time it appears.
- Write about ${TARGET_WORDS} words in 4 to 7 sections.

${STYLE_RULES}

Format rules
- Start each section with a line beginning with "# " followed by a short heading.
- A section has 2 or 3 paragraphs, separated by one blank line.
- A paragraph has 2 to 4 sentences. The reader sees one paragraph at a time in a small box, so start a new one rather than write a fifth sentence.
- Output nothing before the first heading and nothing after the last paragraph.

This is the shape of one section. The topic is only an illustration:

# How sourdough rises
@figure 2

Sourdough bread rises without added [[Baker's yeast|yeast]]. It uses a starter instead. A starter is a mix of flour and water left to ferment.

Wild microbes in the starter make a gas called [[Carbon dioxide|carbon dioxide]]. The gas gets trapped in the dough. That is what makes the loaf swell.

${linkRules('So a section without links is a dead end. Every section needs 2 to 5.', 'a section')}

Figure rules
- FIGURES lists pictures from the article by number, with their captions. The reader sees a section's picture beside it.
- When a figure shows what a section is about, put a line "@figure N" directly under that section's heading, as in the example.
- Go by the caption. Use each figure once at most, and leave a section without one if nothing fits.`

export function buildUserPrompt(title: string, articleText: string, figures: Figure[] = []): string {
  const list = figures.map((figure, i) => `${i + 1}. ${figure.caption}`).join('\n')
  // The closing reminder matters: with the article between the rules and the answer,
  // the model otherwise wrote few or no links.
  return (
    `TITLE: ${title}\n\nARTICLE:\n${articleText}\n\nFIGURES:\n${list || '(none)'}\n\n` +
    `Write the breakdown now: about ${TARGET_WORDS} words in 4 to 7 sections, however long the article is. ` +
    'Keep 2 to 5 [[Exact Title|words shown]] links in every section.' +
    (figures.length ? ' Add "@figure N" under a heading where a figure fits.' : '')
  )
}

export const ANSWER_PROMPT = `The reader is going through a breakdown of a Wikipedia article on smart glasses, one word at a time, and has asked a question out loud. Answer it.

Content rules
- Answer the QUESTION directly in the first sentence.
- Use the ARTICLE first. If it does not cover the question, answer from what you know and begin with "The article does not cover this."
- The question was transcribed from speech, so a word may be misheard. Read it in the light of the ARTICLE.
- PASSAGE is what the reader was on when asking. "This", "that" or "it" in the question usually means something in it.
- Define any technical term you bring in.
- Write 60 to 120 words.

${STYLE_RULES}

Format rules
- 2 to 4 paragraphs, separated by one blank line. No headings.
- A paragraph has 2 or 3 sentences. The reader sees one paragraph at a time in a small box.
- Output nothing but the answer.

This is the shape of an answer. The topic is only an illustration:

Sourdough rises because wild microbes in the starter make gas. No added [[Baker's yeast|yeast]] is needed.

The gas is [[Carbon dioxide|carbon dioxide]]. It gets trapped in the dough. That is what makes the loaf swell.

${linkRules('The answer needs 1 to 3.', 'the answer')}`

export function buildAnswerPrompt(title: string, articleText: string, question: string, passage: string): string {
  return (
    `TITLE: ${title}\n\nARTICLE:\n${articleText}\n\n` +
    `PASSAGE:\n${passage || '(none)'}\n\nQUESTION: ${question}\n\n` +
    'Answer the question now in 60 to 120 words, as 2 to 4 short paragraphs. Keep 1 to 3 [[Exact Title|words shown]] links.'
  )
}

const LINK_PATTERN = /\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g

function normaliseTitle(title: string): string {
  return title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Converts one raw model line into clean text plus link spans.
 * A link survives only if its title is in `allowed`; anything else is flattened
 * to plain words, so the reader can never be sent to a page that does not exist.
 */
export function resolveLinks(
  raw: string,
  allowed: Map<string, string>,
): { text: string; links: LinkSpan[] } {
  const links: LinkSpan[] = []
  let text = ''
  let cursor = 0
  for (const match of raw.matchAll(LINK_PATTERN)) {
    const index = match.index ?? 0
    text += raw.slice(cursor, index)
    const target = match[1] ?? ''
    const shown = (match[2] ?? target).trim()
    const canonical = allowed.get(normaliseTitle(target))
    if (canonical && shown) {
      links.push({ start: text.length, end: text.length + shown.length, title: canonical })
    }
    text += shown
    cursor = index + match[0].length
  }
  text += raw.slice(cursor)

  // Strip stray link brackets the pattern did not consume, then re-anchor spans.
  if (/\[\[|\]\]/.test(text)) {
    const rebuilt = stripStrayBrackets(text, links)
    return rebuilt
  }
  return { text, links }
}

function stripStrayBrackets(text: string, links: LinkSpan[]): { text: string; links: LinkSpan[] } {
  let out = ''
  // map[oldIndex] = index of the same position in the stripped string
  const map: number[] = new Array<number>(text.length + 1)
  let i = 0
  while (i < text.length) {
    map[i] = out.length
    const pair = text.slice(i, i + 2)
    if (pair === '[[' || pair === ']]') {
      map[i + 1] = out.length
      i += 2
      continue
    }
    out += text[i]
    i++
  }
  map[text.length] = out.length
  return {
    text: out,
    links: links.map(link => ({ ...link, start: map[link.start] ?? 0, end: map[link.end] ?? 0 })),
  }
}

export function allowedTitles(links: ArticleLink[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const link of links) map.set(normaliseTitle(link.title), link.title)
  return map
}

/**
 * Incremental parser for the model's output. Feed it text deltas; it calls
 * `emit` each time a heading or paragraph is complete, so the glasses can start
 * reading before the whole breakdown has been generated.
 */
export class BlockStreamParser {
  private buffer = ''
  private paragraph: string[] = []
  private readonly phrases: LinkPhrase[]
  /** Titles already linked in the current section, so a term is offered once per section. */
  private linked = new Set<string>()
  /** The picture tagged for the current section, attached to each of its paragraphs. */
  private figure: Figure | undefined
  private usedFigures = new Set<number>()
  /** Telling words of each caption, for matching a picture the model did not tag. */
  private readonly captionWords: Array<Set<string>>

  constructor(
    private readonly allowed: Map<string, string>,
    private readonly emit: (block: Block) => void,
    /** The article's own links, used to link paragraphs the model left bare. */
    articleLinks: ArticleLink[] = [],
    /** Pictures the model may tag a section with, as "@figure N" (1-based). */
    private readonly figures: Figure[] = [],
  ) {
    this.phrases = linkPhrases(articleLinks)
    this.captionWords = captionWords(figures)
  }

  push(delta: string) {
    this.buffer += delta
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      this.line(this.buffer.slice(0, newline))
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
    }
  }

  end() {
    if (this.buffer) this.line(this.buffer)
    this.buffer = ''
    this.flushParagraph()
  }

  private line(rawLine: string) {
    const line = rawLine.trim()
    if (!line) {
      this.flushParagraph()
      return
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      this.flushParagraph()
      const { text } = resolveLinks(heading[1] ?? '', new Map())
      const clean = tidy(text)
      if (clean) this.emit({ kind: 'heading', text: clean, links: [] })
      this.linked.clear()
      this.figure = undefined
      return
    }
    const tag = /^@figure\s+(\d+)\W*$/i.exec(line)
    if (tag) {
      // Never shown as text. A number that is not in the list, or was used already, is ignored.
      this.flushParagraph()
      const index = Number(tag[1]) - 1
      if (this.figures[index] && !this.usedFigures.has(index)) {
        this.usedFigures.add(index)
        this.figure = this.figures[index]
      }
      return
    }
    this.paragraph.push(line)
  }

  private flushParagraph() {
    if (!this.paragraph.length) return
    const raw = this.paragraph.join(' ').replace(/\s+/g, ' ').trim()
    this.paragraph = []
    const { text, links } = resolveLinks(raw, this.allowed)
    for (const link of links) this.linked.add(link.title)
    if (!text) return
    const block: Block = { kind: 'para', text, links: links.length ? links : this.autoLink(text) }
    this.figure ??= this.matchFigure(text)
    if (this.figure) block.image = this.figure
    this.emit(block)
  }

  /**
   * Fallback for a section the model tagged no picture for (with thinking off it tags
   * some topics throughout and others not at all): the unused picture whose caption
   * shares the most telling words with this paragraph, if it shares at least two.
   */
  // ponytail: word overlap, so it can pair a picture with a paragraph that only mentions
  // the same names. If mismatches show up in use, raise the threshold or drop the fallback.
  private matchFigure(text: string): Figure | undefined {
    const words = new Set(significantWords(text))
    let best = -1
    let bestScore = 1
    this.captionWords.forEach((caption, index) => {
      if (this.usedFigures.has(index)) return
      let score = 0
      for (const word of caption) if (words.has(word)) score++
      if (score > bestScore) {
        best = index
        bestScore = score
      }
    })
    if (best < 0) return undefined
    this.usedFigures.add(best)
    return this.figures[best]
  }

  /**
   * Fallback for a paragraph the model left without links. With thinking off it does
   * that for whole topics (measured: 0 links on 2 of 6), which would leave the reader
   * nowhere to dive. Links the first mention of up to two terms the article itself links.
   */
  // ponytail: longest-phrase text match, so it can link a word used in a different sense.
  // If wrong links show up in use, replace with a second model pass or turn thinking on.
  private autoLink(text: string): LinkSpan[] {
    const found: LinkSpan[] = []
    for (const { title, pattern } of this.phrases) {
      if (found.length === 2) break
      if (this.linked.has(title)) continue
      const match = pattern.exec(text)
      if (!match) continue
      const start = match.index
      const end = start + match[0].length
      if (found.some(link => start < link.end && end > link.start)) continue
      found.push({ start, end, title })
      this.linked.add(title)
    }
    return found.sort((a, b) => a.start - b.start)
  }
}

const COMMON_WORDS = new Set(
  'about after again along among around because before being between could during every first found group known large later first other since their there these those three through under until where which while within would years'.split(' '),
)

/** Lower-case words of five letters or more, without the most common ones. */
function significantWords(text: string): string[] {
  return (text.toLowerCase().match(/\p{L}{5,}/gu) ?? []).filter(word => !COMMON_WORDS.has(word))
}

/**
 * The telling words of each caption. Words that appear in more than a third of the
 * captions are the topic's own ("black", "hole") and tell the pictures apart no better
 * than "the" does, so they are left out.
 */
function captionWords(figures: Figure[]): Array<Set<string>> {
  const sets = figures.map(figure => new Set(significantWords(figure.caption)))
  const counts = new Map<string, number>()
  for (const set of sets) for (const word of set) counts.set(word, (counts.get(word) ?? 0) + 1)
  const limit = Math.max(1, figures.length / 3)
  for (const set of sets) for (const word of [...set]) if ((counts.get(word) ?? 0) > limit) set.delete(word)
  return sets
}

interface LinkPhrase {
  title: string
  pattern: RegExp
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whole-word matchers for every anchor and title, longest first so specific names win. */
function linkPhrases(links: ArticleLink[]): LinkPhrase[] {
  const seen = new Set<string>()
  const phrases: Array<{ words: string; title: string }> = []
  for (const link of links) {
    for (const words of [link.anchor, link.title]) {
      const key = words.toLowerCase()
      if (words.length < 4 || words.split(' ').length > 4 || seen.has(key)) continue
      seen.add(key)
      phrases.push({ words, title: link.title })
    }
  }
  return phrases
    .sort((a, b) => b.words.length - a.words.length)
    .map(({ words, title }) => ({
      title,
      pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(words)}(?![\\p{L}\\p{N}])`, 'iu'),
    }))
}

function tidy(text: string): string {
  return text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()
}

/** A client for whoever's key this request runs on: the server's own, or the caller's. */
function anthropic(apiKey: string): Anthropic {
  if (!apiKey) throw new Error('No Anthropic API key. Add one in the app settings.')
  return new Anthropic({ apiKey })
}

/** Runs one prompt and emits blocks as they complete. `what` names the call in the log. */
async function streamBlocks(
  apiKey: string,
  what: string,
  system: string,
  user: string,
  maxTokens: number,
  links: ArticleLink[],
  figures: Figure[],
  emit: (block: Block) => void,
  signal?: AbortSignal,
): Promise<void> {
  const client = anthropic(apiKey)
  const parser = new BlockStreamParser(allowedTitles(links), emit, links, figures)

  const stream = client.messages
    .stream(
      {
        model: MODEL,
        max_tokens: maxTokens,
        // Haiku 5.5 thinks by default, and thinking counts against max_tokens. Measured on
        // real articles: thinking on = 4 to 15 s before the first word (and at 3000 tokens,
        // no words at all); thinking off = about 1 s, with no visible loss for a rewrite.
        thinking: { type: 'disabled' },
        // "high" is what makes the model keep the link and paragraph rules with thinking off:
        // at the default (medium) it left most topics with few or no links. No effect on speed.
        output_config: { effort: 'high' },
        system,
        messages: [{ role: 'user', content: user }],
      },
      { signal },
    )
    .on('text', delta => parser.push(delta))

  const message = await stream.finalMessage().catch(err => {
    // Say plainly when the key itself is the problem: with people bringing their own
    // keys this is the most likely failure, and the raw API error is not readable.
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error('The Anthropic API key was rejected. Check it in the app settings.')
    }
    throw err
  })
  parser.end()
  // One line per call, so real token use (and so cost) can be read off the log.
  console.log(
    `${what} model=${MODEL} input_tokens=${message.usage.input_tokens} output_tokens=${message.usage.output_tokens} stop_reason=${message.stop_reason} figures_offered=${figures.length}`,
  )
  if (message.stop_reason === 'refusal') throw new Error('Claude declined to write this')
  if (message.stop_reason === 'max_tokens') console.warn(`${what} was cut off at ${maxTokens} tokens`)
}

const PICK_PROMPT = `You match a spoken request to the English Wikipedia article the person wants to read about.
- The request was transcribed from speech, so a word may be misheard or split oddly.
- Choose by the idea the words name, not by which article happens to contain the words. The article about a general concept beats one about a single field, product or event that uses the term.
- Prefer the main article on the subject over narrow, derived or list articles.
- When the request is a bare name with several meanings, pick the meaning most people would mean.
- If no candidate fits, or there are none, answer with the exact title of the English Wikipedia article that does.
Reply in exactly two lines and nothing else:
HEARD: what the person most likely said, with any misheard words put right
TITLE: the article title, with no number or quotes`

/**
 * Turns the model's reply into a title. A candidate's title is returned exactly as
 * Wikipedia spells it; anything else comes back cleaned, as a title the model proposed.
 * No TITLE line means no answer: with thinking off, a reply without one is the model
 * reasoning aloud, and its first line is not a title.
 */
export function matchCandidate(reply: string, candidates: Candidate[]): string {
  const line = (/^TITLE:(.*)$/im.exec(reply)?.[1] ?? '')
    .trim()
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^["'`]+|["'`.]+$/g, '')
    .trim()
  const lower = line.toLowerCase()
  const listed = candidates.find(c => lower === c.title.toLowerCase() || lower.startsWith(c.title.toLowerCase() + ':'))
  return listed?.title ?? line
}

/**
 * Asks the model which search hit a spoken request means. Plain search rank sent
 * "P50 probability distribution" to "Average" with "Percentile" sitting second.
 * Returns '' if the model gives nothing usable.
 */
export async function pickArticle(
  apiKey: string,
  query: string,
  candidates: Candidate[],
  signal?: AbortSignal,
): Promise<string> {
  if (!apiKey) return ''
  const client = anthropic(apiKey)
  const list = candidates.map((c, i) => `${i + 1}. ${c.title}${c.description ? `: ${c.description}` : ''}`).join('\n')
  const message = await client.messages.create(
    {
      model: MODEL,
      // Thinking is left on here, at low effort (the user's call, 2026-11-17): it is what
      // turns "the bolts man constant" into "Boltzmann constant" instead of "Usain Bolt".
      // Easy requests skip the thinking and still take under a second; hard ones take 1.5 to 2 s.
      // Thinking counts against max_tokens, so the cap leaves room for it.
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system: PICK_PROMPT,
      messages: [{ role: 'user', content: `REQUEST: ${query}\n\nCANDIDATES, best search match first:\n${list || '(search found nothing)'}` }],
    },
    { signal },
  )
  // Same one-line form as the other calls, so the pick's share of the cost can be read off the log.
  console.log(
    `pick ${JSON.stringify(query)} model=${MODEL} input_tokens=${message.usage.input_tokens} output_tokens=${message.usage.output_tokens} stop_reason=${message.stop_reason}`,
  )
  if (message.stop_reason === 'refusal') return ''
  const text = message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
  return matchCandidate(text, candidates)
}

/** Streams a breakdown of the article. */
export function streamBreakdown(
  apiKey: string,
  title: string,
  articleText: string,
  links: ArticleLink[],
  figures: Figure[],
  emit: (block: Block) => void,
  signal?: AbortSignal,
): Promise<void> {
  const user = buildUserPrompt(title, articleText, figures)
  return streamBlocks(apiKey, `breakdown "${title}"`, SYSTEM_PROMPT, user, MAX_TOKENS, links, figures, emit, signal)
}

/** Streams a short answer to a question the reader asked while on `passage` of the article. */
export function streamAnswer(
  apiKey: string,
  title: string,
  articleText: string,
  links: ArticleLink[],
  question: string,
  passage: string,
  emit: (block: Block) => void,
  signal?: AbortSignal,
): Promise<void> {
  const user = buildAnswerPrompt(title, articleText, question, passage)
  return streamBlocks(apiKey, `answer "${title}" q=${JSON.stringify(question)}`, ANSWER_PROMPT, user, 1024, links, [], emit, signal)
}
