# Stacksquare Scout

Flip the switch, browse LinkedIn like a human, and every profile you open
lands in the Stacksquare CRM scout queue (`stacksquare.ai/admin/scout`).

## How it works

- **Zero extra LinkedIn requests.** The content script harvests the Voyager
  JSON LinkedIn embeds in the page it already served you (`lib/parser.ts`,
  `embedded@1`). For SPA-navigated profiles it falls back to a slim DOM
  scrape (`dom@1`). It never calls LinkedIn APIs.
- **Capture switch.** Scouting ON (popup toggle, badge shows ON) shows the
  capture panel on every `/in/*` profile you open. OFF means the extension
  does nothing at all.
- **Auto-scan.** ~1.5s after a profile settles, Scout auto-runs the AI scan to
  fill any role/company/city the local parser missed (blanks only, never
  clobbers what you typed or the parser found). It fires once per profile and
  skips profiles the parser already fully read. You still click Send.
- **Per-person keys.** Each founder has their own API key (extension
  options); captures are attributed and promoted contacts default to that
  owner.
- **Queue, not contacts.** Captures upsert by LinkedIn URL into a review
  queue. Promote/dismiss happens in the admin; nothing pollutes the CRM
  automatically.
- **Lists.** The panel's List picker files a profile straight into a CRM
  "database list" (a Research segment, e.g. "Turkish founders in London")
  instead of the generic queue. Pick a list once and every profile you Send
  afterwards lands in it as a `discovered` member on that segment's Research
  page, ready to verify/enrich/promote. "Scout queue (unsorted)" is the
  default and keeps the old behavior. Lists are fetched from
  `stacksquare.ai/api/segments` (same API key).
- **DM conversation logging (v0.7, default OFF).** A separate "Log DMs" toggle
  in the popup. When ON, opening one of your own LinkedIn message threads
  (`/messaging/thread/*`) reads the conversation LinkedIn already rendered in
  your browser (`lib/messaging-parser.ts`, `msg-dom@1`, with a best-effort
  `msg-embedded@1`) and posts it to the CRM. It never calls LinkedIn APIs and
  takes no automated actions, same posture as profile capture (see the
  stacksquare repo `docs/adr/0002` + `0004`). The server summarizes the thread
  with AI and files the summary on the matching contact's outreach timeline;
  raw message bodies are never stored. Threads that match no contact land in an
  "Unmatched conversations" review list in the admin. A fast-model triage step
  drops automated / content-free threads. Capture happens once per thread view;
  re-opening is a cheap no-op unless there are new messages.

## Dev

```sh
pnpm install
pnpm dev        # hot-reload dev browser
pnpm build      # production build -> .output/chrome-mv3
```

Load in Chrome: chrome://extensions -> Developer mode -> Load unpacked ->
select `.output/chrome-mv3`. Then open the extension options and paste your
API key (in Vercel env as EXTENSION_KEY_ARIF / EXTENSION_KEY_KEREM).

## Server side

Lives in the stacksquare repo: `src/app/api/capture/route.ts` (ingest; routes
to a segment when the payload carries a `segmentId`, else the queue),
`src/app/api/segments/route.ts` (the List picker's source),
`src/app/admin/scout/` (queue UI), `src/lib/actions/captures.ts`
(promote/dismiss). List-routed profiles land in `src/app/admin/research/[id]`.

DM logging (v0.7) posts to `src/app/api/outreach/linkedin/route.ts` (triage +
summarize + attribute), summaries land on the contact detail page's Outreach
timeline, unmatched threads are reviewed in `src/app/admin/outreach`, and
`src/lib/actions/outreach-threads.ts` handles link/dismiss + the paste-in
fallback. Schema: `contact_identities`, `outreach_threads`, `outreach_timeline`
(apply `scripts/apply-outreach-timeline-ddl.mjs`).
