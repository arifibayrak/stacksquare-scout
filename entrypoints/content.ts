import {
  parseProfile,
  profileSlug,
  parseContactInfo,
  isContactOverlay,
  contactOverlayUrl,
} from "../lib/parser";
import { ScoutPanel } from "../lib/panel";

export default defineContentScript({
  matches: ["https://www.linkedin.com/*"],
  runAt: "document_idle",
  main() {
    // Re-capture cooldown per profile URL, so SPA re-renders and quick
    // back-and-forth navigation don't hammer the endpoint.
    const COOLDOWN_MS = 10 * 60 * 1000;
    const lastSent = new Map<string, { at: number; hadRole: boolean }>();
    let currentUrl = "";
    let lastFilledUrl = "";
    let lastLinks: string[] = [];
    let lastContactEmail: string | null = null;
    let lastContactPhone: string | null = null;

    function cleanUrl(): string {
      return location.href.split("?")[0].split("#")[0].replace(/\/$/, "");
    }

    // Visible page text; the server extracts any fields the local parser
    // missed using AI, which survives LinkedIn DOM changes entirely.
    function pageText(): string {
      const root = document.querySelector("main") ?? document.body;
      return ((root as HTMLElement).innerText ?? "")
        .replace(/\n{3,}/g, "\n\n")
        .slice(0, 15000);
    }

    // When the extension is reloaded, content scripts in already-open tabs
    // are orphaned and every runtime/storage call fails forever. Detect it
    // and shut down cleanly instead of spamming the console.
    let dead = false;
    function alive(): boolean {
      if (dead) return false;
      if (!browser.runtime?.id) {
        shutdown();
        return false;
      }
      return true;
    }
    function shutdown() {
      if (dead) return;
      dead = true;
      clearInterval(urlTimer);
      try {
        panel.destroy();
      } catch {
        // host already gone
      }
      console.info("[scout] extension reloaded; refresh this tab to resume");
    }

    // The right-edge drawer. Its send button submits whatever is in the
    // fields, including manual email/phone/seniority.
    const panel = new ScoutPanel(async (values) => {
      if (!alive()) return { ok: false, error: "Refresh the tab" };
      if (!values.name) return { ok: false, error: "Name is required" };
      const scraped = parseProfile();
      const res = await browser.runtime.sendMessage({
        type: "CAPTURE",
        payload: {
          linkedinUrl: values.linkedinUrl || cleanUrl(),
          name: values.name,
          role: values.role || null,
          company: values.company || null,
          city: values.city || null,
          headline: scraped?.headline ?? null,
          relationship: scraped?.relationship ?? null,
          email: values.email || lastContactEmail || null,
          phone: values.phone || lastContactPhone || null,
          seniority: values.seniority || null,
          pageText: pageText(),
          payload: {
            ...(scraped?.payload ?? { parser: "manual@1" }),
            manual: true,
            websites: lastLinks,
          },
        },
      });
      if (res?.ok) {
        await browser.storage.local.set({
          lastCapture: { name: values.name, at: Date.now() },
        });
        lastSent.set(values.linkedinUrl || cleanUrl(), {
          at: Date.now(),
          hadRole: Boolean(values.role),
        });
      }
      return res ?? { ok: false, error: "No response from background" };
    }, async () => {
      // "Scan this profile": AI-extract role/company/city from page text.
      if (!alive()) return { ok: false, error: "Refresh the tab" };
      const text = pageText();
      if (!text) return { ok: false, error: "No page text" };
      const res = await browser.runtime.sendMessage({
        type: "EXTRACT",
        payload: { pageText: text },
      });
      return res ?? { ok: false, error: "No response from background" };
    }, () => {
      // "Get contact info": open LinkedIn's own contact-info overlay. The
      // overlay-detection branch below harvests it once it renders.
      const slug = profileSlug(location.href);
      if (slug) {
        baseProfileUrl = cleanUrl();
        location.href = contactOverlayUrl(slug);
      }
    });

    let baseProfileUrl = "";

    function harvestContactInfo() {
      const info = parseContactInfo();
      if (!info) return;
      lastLinks = [...info.websites, info.twitter].filter(Boolean) as string[];
      lastContactEmail = info.email;
      lastContactPhone = info.phone;
      panel.fillContactInfo(info);
    }

    function refreshPanel() {
      const slug = profileSlug(location.href);
      panel.setVisible(Boolean(slug));
      if (!slug) return;

      // On the contact-info overlay: keep the panel as-is and harvest links.
      if (isContactOverlay(location.href)) {
        harvestContactInfo();
        return;
      }

      const profile = parseProfile();
      if (!profile) return;

      // A genuinely new person resets the harvested contact info.
      const url = cleanUrl();
      const fresh = url !== lastFilledUrl;
      if (fresh && url !== baseProfileUrl) {
        lastLinks = [];
        lastContactEmail = null;
        lastContactPhone = null;
      }
      panel.fill(profile, fresh);
      if (fresh) lastFilledUrl = url;
    }

    async function maybeAutoCapture() {
      if (!alive()) return;
      const slug = profileSlug(location.href);
      if (!slug) return;

      try {
        const { scouting } = await browser.storage.local.get("scouting");
        if (!scouting) return;

        const profile = parseProfile();
        if (!profile || !profile.name) return;

        // Cooldown, with one exception: re-send when this pass found a role
        // and the earlier send went out before the experience section loaded.
        const url = cleanUrl();
        const prev = lastSent.get(url);
        if (
          prev &&
          Date.now() - prev.at < COOLDOWN_MS &&
          (prev.hadRole || !profile.role)
        )
          return;

        lastSent.set(url, { at: Date.now(), hadRole: Boolean(profile.role) });
        const res = await browser.runtime.sendMessage({
          type: "CAPTURE",
          payload: { ...profile, pageText: pageText() },
        });
        if (res?.ok) {
          await browser.storage.local.set({
            lastCapture: { name: profile.name, at: Date.now() },
          });
          panel.setStatus("Auto-captured ✓", "ok");
        } else {
          lastSent.delete(url); // allow retry on next settle
          if (res?.error) console.warn("[scout] capture failed:", res.error);
        }
      } catch (err) {
        if (String(err).includes("Extension context invalidated")) shutdown();
        else throw err;
      }
    }

    // LinkedIn is an SPA: watch for URL changes, let the new page settle,
    // then refill the panel and capture. The second timer catches
    // lazy-loaded sections.
    function onUrlSettled() {
      setTimeout(() => {
        refreshPanel();
        maybeAutoCapture();
      }, 1200);
      setTimeout(() => {
        refreshPanel();
        maybeAutoCapture();
      }, 4000);
    }

    const urlTimer = setInterval(() => {
      if (!alive()) return;
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        onUrlSettled();
      }
    }, 700);

    currentUrl = location.href;
    onUrlSettled();
  },
});
