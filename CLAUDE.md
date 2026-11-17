# Rabbit Hole for Even G2: handoff notes

Wikipedia "rabbit hole" learner for Even Realities G2 glasses, driven by the R1 ring.
Speak a topic -> backend fetches the Wikipedia article -> Claude rewrites it as a
teaching breakdown -> glasses play it one word at a time (speed reader), with the
paragraph being read in a side box. Linked terms show in [brackets] and can be opened
to go a level deeper. README.md has the user-facing overview and controls.

## Layout

- `server/`  Node + Hono backend. Holds the API keys. `src/index.ts` (routes),
  `wiki.ts` (fetch + extract Wikipedia Parsoid HTML), `breakdown.ts` (Claude prompts for breakdowns and for answers to questions,
  streaming parser, link validation), `stt.ts` (speech-to-text), `mock.ts` (MOCK=1).
- `app/`  Even Hub plugin (Vite + TypeScript, `@evenrealities/even_hub_sdk` 0.0.16).
  `src/main.ts` (state machine + input), `reader.ts` (speed-reader engine),
  `text.ts` (tokenising, chunking, word placement, pacing), `glass.ts` (all drawing),
  `history.ts` (topics already read, stored with `bridge.setLocalStorage('history')`),
  `api.ts` (NDJSON stream client), `ui.ts` (phone-side page), `config.ts` (layout, speeds).

## Commands

```bash
cd server && npm install && npm run dev      # http://localhost:8787  (MOCK=1 npm run dev = no keys)
cd app && npm install && npm run dev         # http://localhost:5173
cd app && npm run simulate                   # Even's desktop simulator
npm test && npm run typecheck                # in either folder
cd app && npm run pack                       # builds the .ehpk
```

Dev shortcut: `http://localhost:5173/?topic=Entropy` opens a topic without speaking.
On real glasses: `npx evenhub qr --url http://<LAN-ip>:5173` and set `VITE_API_BASE`
in `app/.env.local` to `http://<LAN-ip>:8787`.

## Current state (2026-11-17)

- `server/.env` is filled in: Anthropic key, ElevenLabs key, `CLAUDE_MODEL=claude-haiku-5-5`,
  `STT_PROVIDER=elevenlabs`, `WIKI_USER_AGENT` set. `APP_TOKEN` is empty (fine locally;
  set it, and `VITE_API_TOKEN` in `app/.env.local`, before the backend goes online).
- **Never print, log or commit the contents of `.env` or `.env.local`.** Check keys by
  presence only.
- `npm install` is done in both folders. Node here is 20.20; some dependency asks for 22+
  (install warning only, everything runs).
- `tsx watch` once missed a batch of server edits and kept serving old code: if a server change
  seems to have no effect, `touch server/src/index.ts` (or restart the server).
- If `npm run simulate` says `evenhub-simulator: command not found`, run
  `npm rebuild @evenrealities/evenhub-simulator` in `app/` (the install skipped the bin link once).
- `.claude/launch.json` has `server` and `app` dev-server entries.
- While the app is open on real glasses, saving a file reloads it there. The first screen after
  a reload used to fail with "createStartUpPageContainer failed" (the glasses still hold the page
  from the previous load); `Glass.build` now falls back to `rebuildPageContainer`. Not yet
  confirmed on the glasses.
- `app/.env.local` has `VITE_API_BASE` set to this Mac's LAN address (192.168.0.15 on 2026-11-17)
  for the glasses. Update it if the address changes; the simulator works with it too.
- Git repo created 2026-11-17, branch `main`, pushed to GitHub (`origin`), public since the
  same day. It has no licence file. `.env`, `.env.local`, `node_modules/`, `dist/` and `dev-qr.png` are ignored.

## Tested so far

- Unit tests: 37 backend, 39 app. (On Node 20 vitest crashes while printing a failure,
  `Map.groupBy is not a function`; the run still reports which test failed.) Type checks, production build, `evenhub pack`.
- Full flow in Even's simulator against the MOCK backend: reading, pause, sentence
  stepping, menu, link dive, back, speed change, end of topic.
- Live, against the real services (2026-11-17):
  - Wikipedia search + fetch + extraction on about ten real articles.
  - Claude breakdowns through `GET /api/topic`: 6 to 7 sections, 12 to 30 links, first
    paragraph 2 to 2.7 s after the request, 5 to 9 s to finish, about $0.002 to $0.004 a topic.
  - ElevenLabs speech-to-text through `POST /api/stt` (0.7 to 1.0 s; model `scribe_v3` since
    2026-11-17 at the user's request, `scribe_v2` before; both checked live), with audio made by
    macOS `say`, so a clean synthetic voice only.
  - Simulator against the live backend: reading, pause, menu, link dive.
- On real G2 glasses (2026-11-17, user's report): loads from the QR code over the LAN, topics
  reach the backend, a spoken topic is transcribed, and the 44 px word picture keeps up at 200 wpm.
  Later the same day, on the final build: the three-column layout reads comfortably, holding the
  ring starts a question recording, and a spoken "VIX" brought up the list of meanings, one was
  chosen and it read (so the reader page with the word picture plus the section-picture slot is
  accepted by the glasses). Not reported either way: how cover and section pictures look.
- The centre word is a 288 x 64 PNG sent with `updateImageRawData` for every word and heading
  (`wordPng` in `glass.ts`, size `BIG_WORD_PX` in `config.ts`; 0 = firmware font). If the
  glasses reject a picture, `Glass` falls back to the firmware font for the session.

## What live testing changed (and why)

- **Thinking is off and effort is `high`** in `streamBreakdown`. Haiku 5.5 thinks by default
  and thinking counts against `max_tokens`: the first real call spent all 3,000 tokens
  thinking and returned no text. With thinking on, the first word took 4 to 15 s; off, about 1 s.
  With thinking off, default effort ignored the link and paragraph rules; `high` fixes most of it.
- **Links are marked inline in the article text** sent to Claude (`markLinks` in `wiki.ts`)
  instead of a separate LINKS list, and the user prompt ends with a reminder (length, sections,
  links). The system prompt has one example section; removing it brings back long paragraphs.
- **Link fallback** (`autoLink` in `breakdown.ts`): even so, the model sometimes writes a whole
  topic with no links, so a paragraph with none gets up to two by matching the article's own
  link text. It is a plain text match and can pick a word used in another sense.
- **Whole article is sent** (`MAX_ARTICLE_CHARS` 150000, was 24000). The old cap cut long
  pages in page order, so "French Revolution" stopped in 1791.
- **Disambiguation pages are skipped** in `searchTitle`, and `fetchArticle` re-searches if a
  link dive lands on one. For a truly ambiguous word ("mercury") Wikipedia's own ranking
  varies between requests (planet or Freddie Mercury).
- **Haiku picks the article for a spoken topic** (`resolveTopic` in `index.ts`, `pickArticle` in
  `breakdown.ts`). Plain search rank sent "P50 probability distribution" to "Average". Now the top
  8 hits and their one-line descriptions go to Haiku, which picks one or names a better article
  (used only if it exists). Skipped when the request is exactly the top hit's title. The top hit
  starts loading in parallel, so the pick costs about 0.3 to 0.5 s when it agrees, 1 s when not.
  A bare name whose Wikipedia page is a disambiguation page ("mercury", "P50") is not picked
  at all: the server sends a `choices` event and the glasses list the meanings (`isAmbiguous`
  in `wiki.ts`, `chooseTopic` in `main.ts`; checked in the simulator). A badly misheard phrase can still
  pick wrongly. Thinking is ON for this one call, at low effort (user's decision): it fixes
  "the bolts man constant" -> "Boltzmann constant"; easy requests still take about 0.9 s, hard
  ones 2 to 2.5 s (first paragraph 4 to 6 s after the request instead of about 3).
- **Formulas are kept as LaTeX** from Parsoid's `data-mw` (they used to be deleted, leaving
  holes in sentences); Claude says them in words.
- `stop_reason` is logged; a refusal is reported as an error, a `max_tokens` cut-off warns.

## Opening screen and how the display shows grey (2026-11-17)

The home screen is the `cover` layout with `app/src/home.png` (a rabbit beside a burrow and a
tree, drawn by `app/art/home.py`) and three lines under it; plain text if the picture fails.
Checked in the simulator only. While making it: the simulator, which says it matches the
glasses' grey conversion, shows level 4 of 15 at about 67% brightness and level 1 at about 44%
(roughly level^0.3). Soft shading therefore disappears, so the art uses three levels (15, 4, 1)
and black gaps. The same curve is why cover and section photos look washed out; darkening
them before sending (a gamma around 2 to 3) is an untried idea.

## Menus are drawn by the app, not the firmware list (2026-11-17)

The user wanted a swipe up on the first menu item to land on the last (a quick way to Exit).
Logging what real glasses send while a firmware list is open showed only presses, each with
`currentSelectItemIndex` (absent for item 0): the firmware moves the highlight privately and
sends no scroll events, at the ends or anywhere else. Wrap-around is therefore impossible with
a list container. So menus are now text on the `message` layout: `menuText` in `main.ts` draws
up to `MENU_ROWS` items with a ">" marker, `moveMenu` moves it on the text container's swipe
events and wraps. `TEXT_MENU = false` in `config.ts` brings the firmware list back.
The linked words moved out of the main menu into their own list ("Open a link (12)"), at the
user's request, so the main menu is about eight items.
Confirmed by the user on the glasses the same day: swipes move the marker and it wraps.
To see what real glasses send in some state, the trick used here was a temporary route that
logged events posted by the app; it was removed afterwards.

## Getting it into the Even app (not done; needs the user)

README has the steps. State on 2026-11-17: `npm run pack` works (79 KB `out.ehpk`); the CLI is
not signed in (`evenhub login` needs the user's password in a terminal); `package_id` is still
`com.example.rabbithole`; the backend runs only on this Mac (`VITE_API_BASE` is its LAN address),
so an installed build would work only at home with the Mac's server running. The user had
assumed there was no backend: it exists because the API keys must not sit in the app. Open
decision: host the backend online, or keep it at home. A public release additionally needs a
plan for who pays for API use, a 24 x 24 icon in Even's format, a licence and Even's review.

## Hosting the backend (prepared 2026-11-17, nothing deployed)

`server/Dockerfile` (+ `.dockerignore`) runs the backend with `node --import tsx src/index.ts`
on Node 22; keys come from the host's environment, never the image. The Docker daemon was not
running on this Mac, so the image itself has NOT been built. What was verified instead: a
clean copy holding only the files the image gets, `npm ci`, and that exact start command
served real topics. Measured there (Node 20, this Mac): 87 MB idle, 130 to 170 MB after single
topics, 225 MB peak with four topics at once; 0.65 to 1.06 s of CPU per topic (6 to 8 s
wall), 0.3 s per question. So: 512 MB and a shared CPU are enough for one person.
Cloudflare Workers free plan allows 10 ms of CPU per request (checked on their limits page
the same day), far below what a topic uses, so it would need the paid plan or a redesign
that moves Wikipedia parsing and stream parsing into the app.
The user then asked about Vultr: their pricing page listed 1 vCPU / 1 GB at $5 a month
(0.5 GB at $3.50, and $2.50 IPv6-only), and asked for setup files. `server/compose.yaml` runs
the backend behind Caddy (`server/Caddyfile`) for automatic https on `DOMAIN`; README has the
steps. NOT run anywhere: no Docker daemon here, so compose and Caddy are unverified beyond the
YAML parsing. The user wants to try a bare IP address instead of a hostname, with
encryption. Checked the same day: Let's Encrypt IP certificates are generally available but
only under its `shortlived` profile (160 hours), and Caddy's ACME issuer has a `profile`
option (marked experimental). So the Caddyfile names the ACME issuer explicitly (for an IP
address Caddy would otherwise self-sign) with `profile {$ACME_PROFILE:classic}`; set
`ACME_PROFILE=shortlived` with an IP in `DOMAIN`. Untested: whether Caddy actually completes
an IP order. The user plans a Vultr Cloud Compute 1 vCPU / 1 GB with Ubuntu LTS. In production (`NODE_ENV=production`, set by the Dockerfile) the server now exits
at start if `APP_TOKEN` is empty. The token path was checked live on a local production-mode
run: 401 without or with a wrong `X-App-Token`, normal service with the right one, `/health`
open, CORS preflight for the header passes.

## Motion while walking (thought through, nothing built)

True stabilisation is not possible from a plugin: the display is fixed to the head, a correction
would have to land within about 10 to 20 ms, and a plugin gets IMU reports at most every 100 ms
(`bridge.imuControl`, `ImuReportPace.P100` to `P1000`) and takes 100 ms or more to change what is
shown. What is possible: use the IMU (or `isWearing`) to notice walking and slow down, lengthen
pauses, pause on jolts, or hide the side columns. One centred word is already the most
motion-tolerant layout, since the eye never has to move.

## Bluetooth and battery (looked at 2026-11-17)

The word picture is about 96% of all image data sent: one frame per word, against one small
photo per section and one cover per topic. Estimated per word (frame packed to 4-bit grey and
compressed with deflate as a stand-in for the Even app's LZ4; not a Bluetooth measurement):
about 620 bytes with smoothed letters, about 270 with pure black-and-white letters
(`CRISP_WORDS`, now on), about 17 as firmware text. The frame is also only as tall as the
letters need (288 x 53 at 44 px, was 288 x 64), which saves drawing work, not bytes.
Not built: pairing short words with the next one (about 27% fewer frames on a sample), and a
menu toggle to fall back to the firmware font. The user confirmed on the glasses that the
crisp letters look good. Two-line headings are 21 px in the shorter frame (were 28).

## NOT tested yet

1. Transcript accuracy on real glasses beyond one try. The glasses mic works: the user said
   "P50" on the glasses and got "P50 (neuroscience)" (2026-11-17). That title is one of several
   meanings (Peel P50, KelTec P50, Huawei P50, ...) and Wikipedia's ranking of them changes
   between requests, so ambiguous topics land on an arbitrary one. `/api/stt` now logs
   `stt ... heard=... topic=...` for tracing.
2. Speeds above 200 wpm on real glasses (each word is a picture over Bluetooth; `MIN_WORD_MS`
   is still the 120 ms taken from Even's ASR template), and long sessions.
7. **Section pictures on real glasses** (added 2026-11-17). `extractArticle` keeps up to 12
   captioned figures hosted on Wikimedia Commons (files uploaded to English Wikipedia itself are
   mostly fair use and are skipped). Claude may tag a section with `@figure N`; with thinking off
   it does so on some topics and not at all on others, so `matchFigure` in `breakdown.ts` pairs an
   untagged section with the unused figure whose caption shares at least two telling words with
   the paragraph. The app shows it in a 128 x 128 slot under the status lines (`FIGURE_IMAGE`,
   `Glass.setFigure`; `SIDE_FIGURES = false` turns it off). Checked in the simulator only.
   Unknown on hardware: whether a reader page with two image containers is accepted (if not,
   `Glass.reader` rebuilds without the slot), and what one more picture per section costs.
6. **Cover pictures on real glasses** (added 2026-11-17). `fetchLeadImage` in `wiki.ts` asks
   Wikipedia for the article's main freely licensed image; the app shows it once per topic on a
   `cover` layout (288 x 144 picture, title and credit under it, 3 s or a press) and on the phone
   page. Checked in the simulator only. Unknown on hardware: how long the picture takes over
   Bluetooth, whether the WebView may load from `upload.wikimedia.org` / `thumb.wikimedia.org`
   (both are in the `app.json` whitelist), and whether light pictures look washed out in 16 greens.
5. **Hold-to-talk questions on real glasses** (added 2026-11-17). The user confirmed that holding
   the ring starts listening. Their first question was transcribed as an unrelated sentence, so
   transcription accuracy there is still open. While reading, a long press
   (`LONG_PRESS_EVENT`) starts recording a question and the release sends it to `POST /api/ask`
   (article + current passage + question -> Haiku); the answer is pushed on the trail like a link
   dive. Verified: the server route against real articles (first paragraph 1.3 to 2.6 s), the answer
   flow in the simulator via the `?topic=X&ask=...` shortcut, and that a simulated long press reaches
   the app. NOT verified: the release path, and whether the ring delivers long press and release
   (and no stray click) to a plugin. The menu item "Ask a question (speak)" is the fallback.
   The simulator hangs in CoreAudio when the app opens the microphone on this Mac (probably a
   permission prompt), so anything that listens cannot be driven through the automation port here.
   Answers to questions the article does not cover come from the model's memory and begin with
   "The article does not cover this."
4. Reading history on real glasses: added 2026-11-17 and checked in the simulator only (list on
   the glasses, phone page, "Reread:" marks). Whether it survives closing the Even app is unchecked.

Handy for testing: start the simulator with `--automation-port 9898` and it serves
`GET /api/screenshot/glasses` (PNG of the display) and `POST /api/input`
(`{"action":"click"|"double_click"|"up"|"down"}`).

## Decisions already made by the user

- G2 only (the R1 ring does not work with G1).
- Topic is spoken. Breakdown first, not raw Wikipedia.
- Layout (changed 2026-11-17 after wearing it): three columns. Info (topic, position, speed) on
  the left, the word at the centre of the display, the paragraph on the right. The first layout
  had the word in a box on the left, which meant looking off-centre and was a strain.
  The user confirmed on the glasses that the centred layout reads comfortably.
- Centre word larger than the firmware font (drawn as a picture); 44 px approved.
- Each word is centred as a whole (`CENTRE_WORDS` in `config.ts`). Pivot-letter alignment, the
  usual speed-reader placement, made long words sit to the right on the glasses and was dropped.
- Speed reader is the reading mode. No motion stabilisation (not possible from a plugin).
- Haiku 5.5 for breakdowns (cost), ElevenLabs for speech-to-text (Scribe v3, batch endpoint;
  the user considered the live/realtime variant and decided it is not needed).
- The article picker may think (low effort): the user accepted 1.5 to 2.5 s on hard requests.

## Platform limits that shaped the design (from Even Hub docs)

- 576x288 canvas, text/list/image containers only, one fixed firmware font: no larger
  text, bold, alignment or per-word styling. Words are placed with spaces and newlines
  (`placeWord` in `text.ts`, measured with `@evenrealities/pretext`).
- Exactly one container per page captures input, so links live on a separate list page.
- `textContainerUpgrade` is flicker-free; `rebuildPageContainer` flickers. Text limits:
  1,000 chars on create/rebuild, 2,000 on upgrade. Lists: 20 items, 63 bytes each.
- Plugins run in a phone WebView and are foreground-only. No dashboard widget API.
- A press is event type 0 and arrives with `eventType` undefined; list index 0 likewise.

## Ideas not built

- Prefetching the top links of the current paragraph.
- ElevenLabs real-time transcription instead of the batch endpoint.
- Self-hosted Whisper as a no-key option.
- "Rough road" mode using the IMU to enlarge spacing or hold paging.
