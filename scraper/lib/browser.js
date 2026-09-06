import { chromium } from "playwright";

// Shared headless-browser helper for the prediction scrapers. Using a real
// browser (rather than a plain HTTP request) is what lets this reach pages
// that render content via JavaScript, and gives a realistic fingerprint for
// sites with basic bot-blocking. It still won't defeat aggressive
// anti-bot protection (see forebet.js) — that's a known, documented limit.
export async function withPage(fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      locale: "en-GB",
    });
    const page = await context.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}
