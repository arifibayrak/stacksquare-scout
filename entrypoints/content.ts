import { parseProfile, profileSlug } from "../lib/parser";

export default defineContentScript({
  matches: ["https://www.linkedin.com/*"],
  runAt: "document_idle",
  main() {
    // Re-capture cooldown per profile URL, so SPA re-renders and quick
    // back-and-forth navigation don't hammer the endpoint.
    const COOLDOWN_MS = 10 * 60 * 1000;
    const lastSent = new Map<string, number>();
    let currentUrl = "";

    async function maybeCapture() {
      const slug = profileSlug(location.href);
      if (!slug) return;

      const { scouting } = await browser.storage.local.get("scouting");
      if (!scouting) return;

      const url = location.href.split("?")[0].replace(/\/$/, "");
      const last = lastSent.get(url) ?? 0;
      if (Date.now() - last < COOLDOWN_MS) return;

      const profile = parseProfile();
      if (!profile || !profile.name) return;

      lastSent.set(url, Date.now());
      const res = await browser.runtime.sendMessage({
        type: "CAPTURE",
        payload: profile,
      });
      if (res?.ok) {
        await browser.storage.local.set({
          lastCapture: { name: profile.name, at: Date.now() },
        });
      } else {
        // Allow a retry on the next settle if the send failed.
        lastSent.delete(url);
        if (res?.error) console.warn("[scout] capture failed:", res.error);
      }
    }

    // LinkedIn is an SPA: watch for URL changes, let the new page settle,
    // then capture. The double timer gives lazy sections time to land.
    function onUrlSettled() {
      setTimeout(maybeCapture, 1200);
      setTimeout(maybeCapture, 4000);
    }

    setInterval(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        onUrlSettled();
      }
    }, 700);

    currentUrl = location.href;
    onUrlSettled();
  },
});
