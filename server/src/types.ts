// Wire format shared with the glasses app (app/src/types.ts mirrors this file).

/** A linked term inside a block's text. `start`/`end` are character offsets. */
export interface LinkSpan {
  start: number
  end: number
  /** Exact Wikipedia page title to open when the reader dives in. */
  title: string
}

export interface Block {
  kind: 'heading' | 'para'
  text: string
  links: LinkSpan[]
  /** A picture from the article that goes with this paragraph. */
  image?: Figure
}

/** A search hit: an article title and Wikipedia's one-line description of it. */
export interface Candidate {
  title: string
  description: string
}

/** An article's main picture: a web-sized thumbnail and the page that credits it. */
export interface LeadImage {
  url: string
  page: string
}

/** A picture from inside the article, with its caption. */
export interface Figure extends LeadImage {
  caption: string
}

/** One line of the NDJSON stream returned by GET /api/topic. */
export type StreamEvent =
  | { type: 'meta'; title: string; url: string; license: string; cached: boolean; image?: LeadImage }
  | { type: 'block'; block: Block }
  /** The request names several things: nothing is opened, the reader picks one of these. */
  | { type: 'choices'; query: string; options: Candidate[] }
  | { type: 'done' }
  | { type: 'error'; message: string }

/** A link found in the source article: the words shown and the page it points to. */
export interface ArticleLink {
  title: string
  anchor: string
}

export interface ArticleSection {
  heading: string
  paragraphs: string[]
}

export interface Article {
  title: string
  url: string
  sections: ArticleSection[]
  links: ArticleLink[]
  figures: Figure[]
}
