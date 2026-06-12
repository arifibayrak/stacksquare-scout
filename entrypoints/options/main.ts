const apiUrl = document.getElementById("apiUrl") as HTMLInputElement;
const apiKey = document.getElementById("apiKey") as HTMLInputElement;
const saved = document.getElementById("saved")!;

browser.storage.sync.get(["apiUrl", "apiKey"]).then((s) => {
  apiUrl.value = (s.apiUrl as string) || "https://stacksquare.ai";
  apiKey.value = (s.apiKey as string) || "";
});

document.getElementById("save")!.addEventListener("click", async () => {
  await browser.storage.sync.set({
    apiUrl: apiUrl.value.trim().replace(/\/$/, "") || "https://stacksquare.ai",
    apiKey: apiKey.value.trim(),
  });
  saved.textContent = "Saved";
  setTimeout(() => (saved.textContent = ""), 2000);
});
