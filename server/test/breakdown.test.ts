import { describe, expect, it } from 'vitest'
import { allowedTitles, BlockStreamParser, matchCandidate, resolveLinks } from '../src/breakdown.ts'
import { mockTopic } from '../src/mock.ts'
import type { Block } from '../src/types.ts'

const allowed = allowedTitles([
  { title: 'Wave function', anchor: 'wave function' },
  { title: 'Qubit', anchor: 'qubit' },
])

describe('resolveLinks', () => {
  it('keeps allowed links and records where they sit in the clean text', () => {
    const { text, links } = resolveLinks('The [[Wave function|wave function]] holds it. A [[Qubit]] too.', allowed)
    expect(text).toBe('The wave function holds it. A Qubit too.')
    expect(links).toEqual([
      { start: 4, end: 17, title: 'Wave function' },
      { start: 30, end: 35, title: 'Qubit' },
    ])
    for (const link of links) expect(text.slice(link.start, link.end).toLowerCase()).toBe(link.title.toLowerCase())
  })

  it('matches titles loosely on case, spacing and underscores but returns the exact title', () => {
    const { links } = resolveLinks('A [[wave_function|wave]] here.', allowed)
    expect(links).toEqual([{ start: 2, end: 6, title: 'Wave function' }])
  })

  it('flattens links to pages that were not offered', () => {
    const { text, links } = resolveLinks('An [[Invented page|invented idea]] appears.', allowed)
    expect(text).toBe('An invented idea appears.')
    expect(links).toEqual([])
  })

  it('removes stray brackets without shifting later link positions', () => {
    const { text, links } = resolveLinks('Broken [[ here, then a [[Qubit|qubit]] works.', allowed)
    expect(text).toBe('Broken  here, then a qubit works.')
    expect(links).toHaveLength(1)
    expect(text.slice(links[0]!.start, links[0]!.end)).toBe('qubit')
  })
})

describe('BlockStreamParser', () => {
  const run = (chunks: string[]) => {
    const blocks: Block[] = []
    const parser = new BlockStreamParser(allowed, block => blocks.push(block))
    for (const chunk of chunks) parser.push(chunk)
    parser.end()
    return blocks
  }
  const source = '# What it is\nFirst sentence. Second\nwrapped line with a [[Qubit|qubit]].\n\nNext paragraph.\n# Why it matters\nLast one.'

  it('splits headings and paragraphs', () => {
    expect(run([source]).map(b => [b.kind, b.text])).toEqual([
      ['heading', 'What it is'],
      ['para', 'First sentence. Second wrapped line with a qubit.'],
      ['para', 'Next paragraph.'],
      ['heading', 'Why it matters'],
      ['para', 'Last one.'],
    ])
  })

  it('gives the same result however the stream is chopped up', () => {
    const whole = run([source])
    for (const size of [1, 2, 3, 7, 13]) {
      const chunks: string[] = []
      for (let i = 0; i < source.length; i += size) chunks.push(source.slice(i, i + size))
      expect(run(chunks)).toEqual(whole)
    }
  })

  it('emits a block as soon as it is complete, before the stream ends', () => {
    const blocks: Block[] = []
    const parser = new BlockStreamParser(allowed, block => blocks.push(block))
    parser.push('# Head\nPara one.\n\nPara two still com')
    expect(blocks.map(b => b.text)).toEqual(['Head', 'Para one.'])
  })
})

describe('BlockStreamParser link fallback', () => {
  const articleLinks = [
    { title: 'Wave function', anchor: 'wave function' },
    { title: 'Qubit', anchor: 'qubit' },
    { title: 'Light', anchor: 'light' },
  ]
  const run = (source: string) => {
    const blocks: Block[] = []
    const parser = new BlockStreamParser(allowed, block => blocks.push(block), articleLinks)
    parser.push(source)
    parser.end()
    return blocks.filter(b => b.kind === 'para')
  }

  it('links known terms in a paragraph the model left bare, once per section', () => {
    const [first, second, third] = run(
      '# One\nA Wave Function describes a qubit in flight, lightly.\n\nThe wave function again.\n# Two\nThe wave function, new section.',
    )
    expect(first!.links.map(l => [first!.text.slice(l.start, l.end), l.title])).toEqual([
      ['Wave Function', 'Wave function'],
      ['qubit', 'Qubit'],
    ])
    expect(second!.links).toEqual([]) // already offered in this section; "lightly" is not "light"
    expect(third!.links.map(l => l.title)).toEqual(['Wave function'])
  })

  it('leaves a paragraph alone when the model linked it', () => {
    const [para] = run('# One\nA [[Qubit|qubit]] has a wave function.')
    expect(para!.links.map(l => l.title)).toEqual(['Qubit'])
  })
})

describe('mockTopic', () => {
  it('drops the deliberately invalid link and keeps the real ones', () => {
    const topic = mockTopic('Quantum superposition')
    const titles = topic.blocks.flatMap(b => b.links.map(l => l.title))
    expect(titles).toContain('Wave function')
    expect(titles).not.toContain('Not A Real Page')
    expect(JSON.stringify(topic.blocks)).not.toMatch(/\[\[|\]\]/)
  })
})

describe('matchCandidate', () => {
  const candidates = [
    { title: 'Average', description: 'Number taken as representative' },
    { title: 'Percentile', description: 'Statistic' },
  ]
  it('returns a listed title exactly as Wikipedia spells it', () => {
    expect(matchCandidate('HEARD: P50 probability distribution\nTITLE: percentile', candidates)).toBe('Percentile')
    expect(matchCandidate('HEARD: x\nTITLE: 2. "Percentile".', candidates)).toBe('Percentile')
    expect(matchCandidate('TITLE: Percentile: Statistic', candidates)).toBe('Percentile')
  })
  it('passes through a title the model proposes instead', () => {
    expect(matchCandidate('HEARD: the Boltzmann constant\nTITLE: Boltzmann constant', candidates)).toBe('Boltzmann constant')
  })
  it('gives nothing when the reply has no TITLE line', () => {
    expect(matchCandidate('This is likely a mishearing of Boltzmann constant, which', candidates)).toBe('')
  })
})

describe('BlockStreamParser figures', () => {
  const figures = [
    { url: 'u1', page: 'p1', caption: 'First picture' },
    { url: 'u2', page: 'p2', caption: 'Second picture' },
  ]
  const run = (source: string) => {
    const blocks: Block[] = []
    const parser = new BlockStreamParser(allowed, block => blocks.push(block), [], figures)
    parser.push(source)
    parser.end()
    return blocks
  }

  it('matches an untagged section to a picture by the words its caption shares with the text', () => {
    const blocks: Block[] = []
    const captioned = [
      { url: 'u1', page: 'p1', caption: 'Rudolf Clausius, originator of the concept' },
      { url: 'u2', page: 'p2', caption: 'A temperature diagram for steam engines' },
    ]
    const parser = new BlockStreamParser(allowed, block => blocks.push(block), [], captioned)
    parser.push('# History\nIt began with steam.\n\nRudolf Clausius named the concept in 1865.\n\nMore followed.\n# Later\nClausius again.')
    parser.end()
    expect(blocks.map(b => b.image?.url)).toEqual([undefined, undefined, 'u1', 'u1', undefined, undefined])
  })

  it('attaches a tagged picture to the paragraphs of that section only, and hides the tag', () => {
    const blocks = run('# One\n@figure 2\n\nAlpha.\n\nBeta.\n# Two\nGamma.\n# Three\n@figure 2\nDelta.\n# Four\n@figure 9\nEpsilon.')
    expect(blocks.map(b => b.text)).toEqual(['One', 'Alpha.', 'Beta.', 'Two', 'Gamma.', 'Three', 'Delta.', 'Four', 'Epsilon.'])
    const picture = (text: string) => blocks.find(b => b.text === text)!.image?.caption
    expect([picture('Alpha.'), picture('Beta.')]).toEqual(['Second picture', 'Second picture'])
    // no tag, a figure already used, and a number that is not in the list
    expect([picture('Gamma.'), picture('Delta.'), picture('Epsilon.')]).toEqual([undefined, undefined, undefined])
  })
})
