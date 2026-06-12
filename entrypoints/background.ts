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
  });

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
      return { ok: true, id: data.id, status: data.status };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Network error" };
    }
  }
});
