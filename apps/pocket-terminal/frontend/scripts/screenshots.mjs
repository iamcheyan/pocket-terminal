/**
 * Evidence screenshot matrix.
 *
 * Produces the required breakpoints (390×844 handheld, 1280×800 desktop) for
 * all three layouts and both themes, plus the e-ink surface. Overwrites
 * docs/evidence/screens.
 */
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const BASE = process.env.POCKET_TERMINAL_URL ?? 'http://127.0.0.1:5178';
const SHOTS = process.env.POCKET_TERMINAL_SHOTS ?? new URL('../../../../docs/evidence/screens/', import.meta.url).pathname;
const EXEC = process.env.CHROME_PATH ?? '/run/current-system/sw/bin/chromium';
const PAGES = ['home', 'terminal', 'ssh', 'logs', 'diagnostics', 'runtime', 'actions', 'settings'];

await mkdir(SHOTS, {recursive: true});
const browser = await chromium.launch({executablePath: EXEC, args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars']});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});

// localStorage is per-origin, so the first navigation must happen before any
// preference write; later writes persist for the rest of the run.
let primed = false;
const go = async (id, theme, layout) => {
  if (!primed) {
    await page.goto(`${BASE}/?page=${id}`, {waitUntil: 'networkidle'});
    primed = true;
  }
  await page.evaluate(
    values => {
      localStorage.setItem('pt.theme', values.theme);
      localStorage.setItem('pt.layout', values.layout);
    },
    {theme, layout},
  );
  await page.goto(`${BASE}/?page=${id}`, {waitUntil: 'networkidle'});
  await page.waitForTimeout(260);
};

const shots = [];
const snap = async (name, width, height) => {
  await page.setViewportSize({width, height});
  await page.waitForTimeout(160);
  await page.screenshot({path: `${SHOTS}${name}.png`});
  shots.push(`${name}.png ${width}x${height}`);
};

for (const theme of ['dark', 'light']) {
  for (const id of PAGES) {
    await go(id, theme, 'desktop');
    await page.setViewportSize({width: 1280, height: 800});
    await snap(`desktop-${id}-${theme}-1280x800`, 1280, 800);
  }
}

for (const id of PAGES) {
  await go(id, 'light', 'eink');
  await snap(`eink-${id}-light-1280x800`, 1280, 800);
}

for (const id of PAGES) {
  await go(id, 'dark', 'handheld');
  await snap(`handheld-${id}-dark-390x844`, 390, 844);
}

for (const id of PAGES) {
  await go(id, 'light', 'handheld');
  await snap(`handheld-${id}-light-390x844`, 390, 844);
}

// Desktop layout forced down to the phone breakpoint: proves the media-query
// fallback keeps every page inside 390px even when desktop is selected.
for (const id of PAGES) {
  await go(id, 'dark', 'desktop');
  await page.setViewportSize({width: 390, height: 844});
  await snap(`desktop-layout-${id}-dark-390x844`, 390, 844);
}

await browser.close();
console.log(shots.join('\n'));
