// Read-only audit: never authenticates, submits forms, or changes server state.
const { createRequire } = require('node:module');
const fs = require('node:fs');
const { chromium } = createRequire('/tmp/aa-browser/package.json')('playwright');
const OUT = process.env.AUDIT_OUT || 'audit-results';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const report = { started_at: new Date().toISOString(), cases: [], page_errors: [], console_errors: [], failed_requests: [], http_errors: [] };
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, locale: 'es-US', timezoneId: 'America/New_York' });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const label = String(viewport.width);
      page.on('pageerror', error => report.page_errors.push({ viewport: label, message: error.message, stack: error.stack }));
      page.on('console', message => { if (message.type() === 'error') report.console_errors.push({ viewport: label, message: message.text() }); });
      page.on('requestfailed', request => report.failed_requests.push({ viewport: label, url: request.url(), error: request.failure()?.errorText }));
      page.on('response', response => { if (response.status() >= 400) report.http_errors.push({ viewport: label, url: response.url(), status: response.status() }); });
      async function capture(name) {
        const state = await page.evaluate(() => ({
          title: document.title, url: location.href,
          viewport: innerWidth, scroll_width: document.documentElement.scrollWidth,
          body_text: document.body.innerText.slice(0, 26000),
          controls: [...document.querySelectorAll('button,input,[role=tab],[data-sport]')].map(e => ({ tag: e.tagName, id: e.id, text: e.innerText?.trim(), placeholder: e.getAttribute('placeholder'), data: { ...e.dataset } })),
          broken_images: [...document.images].filter(i => i.complete && !i.naturalWidth && i.getBoundingClientRect().width > 0).map(i => i.src)
        }));
        fs.writeFileSync(`${OUT}/${label}-${name}.json`, JSON.stringify(state, null, 2));
        await page.screenshot({ path: `${OUT}/${label}-${name}.png`, fullPage: true });
        report.cases.push({ viewport: label, name, title: state.title, text_length: state.body_text.length, overflow: state.scroll_width > state.viewport + 1, broken_images: state.broken_images.length });
        console.log('BROWSER_STATE', label, name, JSON.stringify({ title: state.title, viewport: state.viewport, scroll_width: state.scroll_width, text_length: state.body_text.length, broken_images: state.broken_images.length }));
      }
      const response = await page.goto('https://aasport.net/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (!response || response.status() !== 200) throw new Error(`Homepage HTTP ${response?.status()}`);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await capture('home');
      fs.writeFileSync(`${OUT}/${label}-page.html`, await page.content());
      for (const name of ['Posiciones', 'Historial', 'Cerebro', 'Favoritos', 'Todos']) {
        try {
          const pattern = name === 'Cerebro' ? /Cerebro/ : new RegExp(`^${name}$`);
          await page.getByRole('button', { name: pattern }).first().click();
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await capture(name.toLowerCase());
        } catch (error) { report.cases.push({ viewport: label, name, error: error.message }); }
      }
      for (const sport of ['NBA', 'WNBA', 'NFL', 'NHL', 'Soccer', 'Tenis']) {
        try {
          const pattern = new RegExp(`^(?:[^A-Za-z]*)${sport}(?:\\s*LIVE)?$`, 'i');
          await page.getByText(pattern).first().click();
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await capture(sport.toLowerCase());
        } catch (error) { report.cases.push({ viewport: label, name: sport, error: error.message }); }
      }
      // Language switching is local UI state, not a server-side write.
      try {
        await page.getByRole('button', { name: 'EN', exact: true }).click();
        await capture('english');
      } catch (error) { report.cases.push({ viewport: label, name: 'english', error: error.message }); }
      await context.close();
    }
  } catch (error) {
    report.fatal = error.stack || String(error);
  } finally {
    await browser.close();
    report.finished_at = new Date().toISOString();
    fs.writeFileSync(`${OUT}/browser-report.json`, JSON.stringify(report, null, 2));
    console.log('BROWSER_REPORT', JSON.stringify(report));
    if (report.fatal || report.page_errors.length || report.cases.some(c => c.error || c.overflow)) process.exitCode = 1;
  }
})();
