# Stacksquare Scout

Flip the switch, browse LinkedIn like a human, and every profile you open
lands in the Stacksquare CRM scout queue (`stacksquare.ai/admin/scout`).

## How it works

- **Zero extra LinkedIn requests.** The content script harvests the Voyager
  JSON LinkedIn embeds in the page it already served you (`lib/parser.ts`,
  `embedded@1`). For SPA-navigated profiles it falls back to a slim DOM
  scrape (`dom@1`). It never calls LinkedIn APIs.
- **Capture switch.** Scouting ON (popup toggle, badge shows ON) captures
  every `/in/*` profile you open, with a 10-minute per-profile cooldown.
  OFF means the extension does nothing at all.
- **Per-person keys.** Each founder has their own API key (extension
  options); captures are attributed and promoted contacts default to that
  owner.
- **Queue, not contacts.** Captures upsert by LinkedIn URL into a review
  queue. Promote/dismiss happens in the admin; nothing pollutes the CRM
  automatically.

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

Lives in the stacksquare repo: `src/app/api/capture/route.ts` (ingest),
`src/app/admin/scout/` (queue UI), `src/lib/actions/captures.ts`
(promote/dismiss). Phase 2 adds the enrichment waterfall there.
