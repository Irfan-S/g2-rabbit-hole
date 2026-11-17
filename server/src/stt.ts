// Speech-to-text for the spoken topic.
//
// The glasses deliver raw PCM: signed 16-bit little-endian, 16 kHz, mono.
// We wrap it in a WAV header and hand it to whichever provider is configured.
// The ElevenLabs call is tested against the live API (scribe_v3 and scribe_v2). The
// Deepgram and OpenAI calls follow their published HTTP APIs but were never run live.

const SAMPLE_RATE = 16000

export function pcmToWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const header = new DataView(new ArrayBuffer(44))
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) header.setUint8(offset + i, value.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  header.setUint32(4, 36 + pcm.length, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  header.setUint32(16, 16, true) // PCM chunk size
  header.setUint16(20, 1, true) // format: PCM
  header.setUint16(22, 1, true) // channels: mono
  header.setUint32(24, sampleRate, true)
  header.setUint32(28, sampleRate * 2, true) // byte rate
  header.setUint16(32, 2, true) // block align
  header.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  header.setUint32(40, pcm.length, true)
  const wav = new Uint8Array(44 + pcm.length)
  wav.set(new Uint8Array(header.buffer), 0)
  wav.set(pcm, 44)
  return wav
}

/** Removes the lead-in people naturally say before a topic. */
export function cleanSpokenTopic(transcript: string): string {
  return transcript
    // Some providers tag non-speech sounds, e.g. "(background noise)" or "[music]".
    .replace(/[(\[][^)\]]*[)\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!]+$/g, '')
    .replace(
      /^(?:(?:hey|ok|okay|so|um|uh|please)[, ]+)*(?:(?:can you |could you )?(?:tell me about|teach me about|teach me|explain|look up|search for|search|show me|open|what is|what are|what's|who is|who was|i want to learn about|let's learn about|learn about)\s+)?/i,
      '',
    )
    .replace(/^(?:the topic of|the topic)\s+/i, '')
    .trim()
}

async function deepgram(wav: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) throw new Error('DEEPGRAM_API_KEY is not set on the server')
  const model = process.env.STT_MODEL ?? 'nova-3'
  const res = await fetch(
    `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&smart_format=true`,
    {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' },
      body: wav,
    },
  )
  if (!res.ok) throw new Error(`Deepgram returned ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
  }
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
}

async function elevenlabs(wav: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set on the server')
  const form = new FormData()
  form.append('model_id', process.env.STT_MODEL ?? 'scribe_v3')
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'topic.wav')
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
  })
  if (!res.ok) throw new Error(`ElevenLabs returned ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { text?: string }
  return data.text ?? ''
}

async function openai(wav: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY is not set on the server')
  const form = new FormData()
  form.append('model', process.env.STT_MODEL ?? 'whisper-1')
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'topic.wav')
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  })
  if (!res.ok) throw new Error(`OpenAI returned ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { text?: string }
  return data.text ?? ''
}

export async function transcribe(pcm: Uint8Array): Promise<string> {
  const provider = (process.env.STT_PROVIDER ?? 'elevenlabs').toLowerCase()
  const wav = pcmToWav(pcm)
  if (provider === 'elevenlabs') return elevenlabs(wav)
  if (provider === 'deepgram') return deepgram(wav)
  if (provider === 'openai') return openai(wav)
  throw new Error(`Unknown STT_PROVIDER "${provider}" (use "elevenlabs", "deepgram" or "openai")`)
}
