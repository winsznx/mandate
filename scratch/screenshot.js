const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'https://mandate-web.timjosh507.workers.dev';
const STAGE = process.argv[2] || 'after';

const ROUTES = [
  '/',
  '/marketplace',
  '/category/health-factor',
  '/category/yield',
  '/category/grid-trading',
  '/category/rebalancing',
  '/agents/health-factor-a',
  '/agents/health-factor-b',
  '/compare',
  '/activate/health-factor-a',
  '/mandates',
  '/mandates/M-001',
  '/demo',
  '/developers',
  '/reports/agent-advantage',
  '/status',
  '/methodology',
  '/proof/M-001'
];

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '430x932', width: 430, height: 932 },
  { name: '390x844', width: 390, height: 844 }
];

async function capture() {
  const outputDir = path.join(__dirname, '..', 'artifacts', 'ui-final', STAGE);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Starting screenshot capture for stage '${STAGE}' from ${BASE_URL}...`);
  const browser = await chromium.launch({ headless: true });

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2
    });
    const page = await context.newPage();

    for (const route of ROUTES) {
      const slug = route === '/' ? 'home' : route.replace(/^\//, '').replace(/\//g, '_');
      const filename = `${vp.name}_${slug}.png`;
      const targetPath = path.join(outputDir, filename);

      try {
        await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: targetPath, fullPage: false });
        console.log(`Captured: ${STAGE}/${filename}`);
      } catch (err) {
        console.error(`Failed ${route} at ${vp.name}: ${err.message}`);
      }
    }
    await context.close();
  }

  await browser.close();
  console.log(`Finished screenshot capture for stage '${STAGE}'.`);
}

capture().catch(err => {
  console.error(err);
  process.exit(1);
});
