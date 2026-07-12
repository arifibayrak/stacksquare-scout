export default defineBackground(() => {
  // Badge mirrors the Scouting switch.
  async function syncBadge() {
    const { scouting } = await browser.storage.local.get("scouting");
    await browser.action.setBadgeBackgroundColor({ color: "#1d3fbf" });
    await browser.action.setBadgeText({ text: scouting ? "ON" : "" });
  }
  syncBadge();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.scouting) syncBadge();
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CAPTURE") {
      handleCapture(message.payload).then(sendResponse);
      return true; // async response
    }
    if (message?.type === "EXTRACT") {
      handleExtract(message.payload).then(sendResponse);
      return true;
    }
    if (message?.type === "LISTS") {
      handleLists().then(sendResponse);
      return true;
    }
  });

  async function handleLists() {
    const { apiUrl, apiKey } = await browser.storage.sync.get([
      "apiUrl",
      "apiKey",
    ]);
    const base = (apiUrl as string) || "https://stacksquare.ai";
    if (!apiKey) return { ok: false, error: "No API key set." };
    try {
      const res = await fetch(`${base}/api/segments`, {
        headers: { "X-API-Key": apiKey as string },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.error ?? `HTTP ${res.status}` };
      }
      const data = await res.json();
      return { ok: true, lists: data.lists ?? [] };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Network error",
      };
    }
  }

  async function handleExtract(payload: unknown) {
    const { apiUrl, apiKey } = await browser.storage.sync.get([
      "apiUrl",
      "apiKey",
    ]);
    const base = (apiUrl as string) || "https://stacksquare.ai";
    if (!apiKey) return { ok: false, error: "No API key set." };
    try {
      const res = await fetch(`${base}/api/extract`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey as string,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.error ?? `HTTP ${res.status}` };
      }
      const fields = await res.json();
      return { ok: true, fields };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Network error",
      };
    }
  }

  async function handleCapture(payload: unknown) {
    const { apiUrl, apiKey } = await browser.storage.sync.get([
      "apiUrl",
      "apiKey",
    ]);
    const base = (apiUrl as string) || "https://stacksquare.ai";
    if (!apiKey) {
      return { ok: false, error: "No API key set. Open Scout options." };
    }

    try {
      const res = await fetch(`${base}/api/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey as string,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.error ?? `HTTP ${res.status}` };
      }
      const data = await res.json();
      // Brief badge flash so a capture is visible without any page UI.
      await browser.action.setBadgeText({ text: "✓" });
      setTimeout(async () => {
        const { scouting } = await browser.storage.local.get("scouting");
        await browser.action.setBadgeText({ text: scouting ? "ON" : "" });
      }, 1800);
      // Pass the whole response through (destination, segment, id, status) so
      // the panel can report which list the profile landed in.
      return { ok: true, ...data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Network error" };
    }
  }
});
