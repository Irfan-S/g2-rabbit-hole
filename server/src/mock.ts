import { allowedTitles, BlockStreamParser } from './breakdown.ts'
import type { Block } from './types.ts'
import { pageUrl } from './wiki.ts'

export const MOCK_SPOKEN_TOPIC = 'Quantum superposition'

// Sample text in the exact format the model is asked to produce, so mock mode
// runs through the same parser and link checks as a real breakdown.
const SAMPLE_LINKS = ['Quantum mechanics', 'Wave function', 'Double-slit experiment', 'Qubit', 'Measurement in quantum mechanics', 'Quantum computing']

const SAMPLE = (title: string) => `# What it is
${title} is a core idea in [[Quantum mechanics|quantum mechanics]]. It says a system can be in several states at once. Each state is weighted by a number.

The full description of the system is called its [[Wave function|wave function]]. It holds every possible state together.

# How it shows up
The [[Double-slit experiment|double-slit experiment]] is the classic case. A single particle behaves as if it took both paths. The two paths then interfere like waves.

This only holds while nothing checks which path was taken. Looking at the path removes the pattern.

# What measuring does
A [[Measurement in quantum mechanics|measurement]] gives one definite result. The other possibilities are no longer observed. Which result appears is a matter of probability.

# Why it matters
A [[Qubit|qubit]] uses this idea to hold more than a plain zero or one. That is the basis of [[Quantum computing|quantum computing]]. This link is [[Not A Real Page|made up]] and must be dropped.`

export function mockTopic(query: string): { title: string; url: string; blocks: Block[] } {
  const title = query.replace(/\s+/g, ' ').trim() || MOCK_SPOKEN_TOPIC
  const blocks: Block[] = []
  const allowed = allowedTitles(SAMPLE_LINKS.map(link => ({ title: link, anchor: link })))
  const parser = new BlockStreamParser(allowed, block => blocks.push(block))
  parser.push(SAMPLE(title))
  parser.end()
  return { title, url: pageUrl(title), blocks }
}

export function mockAnswer(question: string): Block[] {
  const blocks: Block[] = []
  const allowed = allowedTitles(SAMPLE_LINKS.map(link => ({ title: link, anchor: link })))
  const parser = new BlockStreamParser(allowed, block => blocks.push(block))
  parser.push(
    `This is a canned answer to "${question}". It is described by the [[Wave function|wave function]].\n\nMock mode makes no model call. Run without MOCK=1 for a real answer.`,
  )
  parser.end()
  return blocks
}
