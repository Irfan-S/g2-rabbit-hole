import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { articleForPrompt, extractArticle, isAmbiguous, linkTitleFromHref } from '../src/wiki.ts'

const html = readFileSync(new URL('./fixtures/parsoid.html', import.meta.url), 'utf8')

describe('linkTitleFromHref', () => {
  it('decodes titles and drops fragments', () => {
    expect(linkTitleFromHref('./Schr%C3%B6dinger_equation')).toBe('Schrödinger equation')
    expect(linkTitleFromHref('./Wave_function#Definition')).toBe('Wave function')
  })
  it('rejects non-article targets', () => {
    expect(linkTitleFromHref('./File:Double-slit.svg')).toBeNull()
    expect(linkTitleFromHref('./Help:Contents')).toBeNull()
    expect(linkTitleFromHref('https://example.com')).toBeNull()
    expect(linkTitleFromHref('./#cite_note-1')).toBeNull()
  })
  it('keeps article titles that merely contain a colon', () => {
    expect(linkTitleFromHref('./Star_Trek:_The_Next_Generation')).toBe('Star Trek: The Next Generation')
  })
})

describe('extractArticle', () => {
  const article = extractArticle(html, 'fallback')

  it('reads the title and builds sections in order', () => {
    expect(article.title).toBe('Quantum superposition')
    expect(article.sections.map(s => s.heading)).toEqual(['Overview', 'Wave postulate', 'Transformation'])
  })

  it('strips citations, maths, infoboxes, captions and stub paragraphs', () => {
    const lead = article.sections[0]!.paragraphs
    expect(lead).toHaveLength(1)
    expect(lead[0]).toContain('Quantum superposition is a fundamental principle')
    // Links stay marked inline, in the form the model is asked to write.
    expect(lead[0]).toContain('of [[Quantum mechanics|quantum mechanics]] that')
    expect(article.sections[1]!.paragraphs[0]).toContain('[[Quantum mechanics|the wider theory]]')
    expect(article.sections[1]!.paragraphs[0]).toContain('a red link plus help and an external site.')
    expect(lead[0]).not.toMatch(/\[1\]|displaystyle|Ψ|ℏ/)
    // Current Parsoid maths carries its LaTeX source, which is kept for the model to verbalise.
    expect(lead[0]).toContain('with energy E = \\hbar \\omega.')
    const all = JSON.stringify(article.sections)
    expect(all).not.toMatch(/Infobox text|A caption|For other uses|Principle of quantum mechanics/)
  })

  it('keeps captioned pictures hosted on Commons, and nothing else', () => {
    expect(article.figures).toEqual([
      {
        url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Two_paths.jpg/250px-Two_paths.jpg',
        page: 'https://en.wikipedia.org/wiki/File:Two_paths.jpg',
        caption: 'A particle taking two paths at once.',
      },
    ])
  })

  it('skips See also / References, including nested subsections', () => {
    const all = JSON.stringify(article.sections)
    expect(all).not.toMatch(/skipped section|nested paragraph|Reference text/)
  })

  it('collects only real, unique article links', () => {
    expect(article.links.map(l => l.title)).toEqual([
      'Quantum mechanics',
      'Schrödinger equation',
      'Wave function',
      'Wave equation',
      'Star Trek: The Next Generation',
    ])
    expect(article.links[0]!.anchor).toBe('quantum mechanics')
  })
})

describe('articleForPrompt', () => {
  const article = extractArticle(html, 'fallback')

  it('caps the text and drops links that fall outside the cap', () => {
    const full = articleForPrompt(article, 100000)
    expect(full.links).toHaveLength(5)
    const capped = articleForPrompt(article, 520)
    expect(capped.text).toContain('## Overview')
    expect(capped.text).not.toContain('Wave postulate')
    expect(capped.links.map(l => l.title)).toEqual(['Quantum mechanics', 'Schrödinger equation', 'Wave function'])
  })
})

describe('isAmbiguous', () => {
  const hit = (title: string, disambiguation = false) => ({ title, description: '', disambiguation })

  it('is true when the page of that exact name is a disambiguation page', () => {
    const hits = [hit('Mercury', true), hit('Mercury (planet)'), hit('Mercury (element)')]
    expect(isAmbiguous('mercury', hits)).toBe(true)
    expect(isAmbiguous('The Mercury', hits)).toBe(true)
  })

  it('is false when the name has a main article, or the request says more than the name', () => {
    expect(isAmbiguous('java', [hit('Java'), hit('Java (disambiguation)', true)])).toBe(false)
    expect(isAmbiguous('mercury the planet', [hit('Mercury', true), hit('Mercury (planet)')])).toBe(false)
  })
})
