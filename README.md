# Rabbit Hole for Even G2

Speak a topic. The backend fetches the Wikipedia article, Claude rewrites it as a
teaching breakdown, and the glasses play it one word at a time. Linked terms show
in [brackets]; open one and you are a level deeper.

```
 Quantum             |                          | +----------------+
 superposition       |                          | | The [double-   |
 6/11                |        interfere         | | slit           |
 200 wpm             |                          | | experiment] is |
 +--------+          |                          | | the classic    |
 | picture|          |                          | | case. A ...    |
 +--------+          |                          | +----------------+
```

Middle: the speed reader, one large word at the centre of the display. Right: the part
of the paragraph being read. Left: topic, position and speed, with the picture that goes
with the section underneath when the article has one.

If what you say is a name with several meanings ("mercury"), the glasses list them and
you pick one. Otherwise Claude chooses the article that best matches what you said.

When a topic opens, its main picture from Wikipedia (if it has a freely licensed one)
is shown for three seconds as a cover; a press skips it. The phone-side page shows the
same picture in colour, with a link to its author and licence.

## Controls (temple touchpads or R1 ring)

| Where   | Press            | Swipe up / down          | Double press            |
|---------|------------------|--------------------------|-------------------------|
| Home    | Speak a topic    | Topics you have read     | Exit                    |
| Reading | Play / pause     | Sentence back / forward  | Menu                    |
| Menu    | Choose           | Move                     | Close                   |

While reading, **hold** the ring (or a touchpad) and ask a question about what you are
reading, then let go. The answer plays one level deeper, like a link, and Back returns you
to where you were. The menu has the same thing as "Ask a question (speak)". On the
phone-side page, type `?` followed by the question.

The menu lists the links in the current paragraph first, then nearby ones, then
Slower, Faster, Back to the parent topic, Topics you have read, New topic and Exit.
A link you have already opened is listed as "Reread:" instead of "Open:".

Every topic you open is remembered on the phone (the last 50). The list is on the
glasses (swipe on the home screen, or from the menu) and on the phone-side page.

## Run it

Two parts: `server/` (holds the API keys) and `app/` (the Even Hub plugin).

```bash
# 1. backend
cd server
cp .env.example .env        # add ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, APP_TOKEN
npm install
npm run dev                 # http://localhost:8787   (MOCK=1 npm run dev needs no keys)

# 2. app
cd ../app
cp .env.example .env.local  # VITE_API_BASE and VITE_API_TOKEN
npm install
npm run dev                 # http://localhost:5173
npm run simulate            # desktop simulator
```

On real glasses: `npx evenhub qr --url http://<your-computer-ip>:5173`, scan it in
the Even Realities app, and set `VITE_API_BASE` to `http://<your-computer-ip>:8787`
so the phone can reach the backend.

Skip the spoken step while developing: open `http://localhost:5173/?topic=Entropy`,
or type a topic on the phone-side page.

To ship: deploy `server/` somewhere with https, put that URL in `app/.env.local` and
in the `network` whitelist in `app/app.json`, change `package_id`, then `npm run pack`.

## Settings

| Where            | Setting              | Default            | What it does                          |
|------------------|----------------------|--------------------|---------------------------------------|
| server/.env      | `CLAUDE_MODEL`       | `claude-haiku-5-5` | Model that writes the breakdown       |
| server/.env      | `BREAKDOWN_WORDS`    | 600                | Target length of a breakdown          |
| server/.env      | `MAX_ARTICLE_CHARS`  | 150000             | How much of the article Claude reads  |
| server/.env      | `STT_PROVIDER`       | `elevenlabs`       | `elevenlabs`, `deepgram` or `openai`  |
| server/.env      | `APP_TOKEN`          | empty              | Shared secret the app must send       |
| app/src/config.ts| `WPM_DEFAULT`        | 200                | Starting speed (100 to 450)           |
| app/src/config.ts| `BIG_WORD_PX`        | 44                 | Size of the centre word (0 = firmware font) |
| app/src/config.ts| `WORD_BOX`/`PARA_BOX`| 372 / 200 px wide  | Size of the two boxes                 |

## How the limits of the glasses shape it

- **One font, one size.** The firmware has no larger text, bold or centring. So the
  word in the middle is drawn as a small picture (288 x 64) and sent to the glasses,
  with its focus letter always on the same spot. Set `BIG_WORD_PX` to 0 to use the
  firmware font instead, which is smaller but the cheapest thing to send.
- **No word highlighting.** Linked terms are marked with [brackets] instead.
- **One input box per screen.** Links therefore live on a separate menu screen.
- **Bluetooth is the speed limit.** Each word is one write. Even's own template
  spaces writes 120 ms apart, so that is the floor here. If the glasses fall behind,
  the status strip shows the speed actually reached (for example `~160 wpm`).
- **Links are checked.** Claude may only link titles that are real links in the source
  article; anything else is turned back into plain words by the server.

## What has and has not been tested

Tested: backend and app unit tests (`npm test` in each folder), type checks, a
production build and `evenhub pack`, and the full flow in Even's simulator against the
mock backend (reading, pause, sentence stepping, menu, link dive, back, speed, end).

Not tested, because they need your keys, network or hardware:

- live Wikipedia fetches (the extractor was tested on a hand-made sample of
  Wikipedia's HTML format, not a real page)
- the Claude call and the speech-to-text providers (ElevenLabs is the default)
- microphone capture
- real glasses: Bluetooth pace, and how the firmware font lines up with the simulator

## Credit

Article text comes from Wikipedia under CC BY-SA 4.0. Every topic opens with a card
naming the source, and the phone-side page links to the article.
