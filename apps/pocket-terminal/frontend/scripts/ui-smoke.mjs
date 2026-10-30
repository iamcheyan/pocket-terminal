/**
 * Headless verification + screenshot harness.
 *
 * Runs one Chromium instance against the real Vite dev server + terminald,
 * asserts there is no horizontal overflow and no console/page error, drives
 * the real UI (terminal command execution, SSH mock connect, palette, DPad
 * focus) and writes the evidence screenshots.
 *
 * Usage: node scripts/ui-smoke.mjs
 *   POCKET_TERMINAL_URL  default http://127.0.0.1:5178
 *   POCKET_TERMINAL_SHOTS default ../../../../docs/evidence/screens
 *   POCKET_SKIP_SHOTS=1  verify only
 */
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const BASE = process.env.POCKET_TERMINAL_URL ?? 'http://127.0.0.1:5178';
const SHOTS = process.env.POCKET_TERMINAL_SHOTS ?? new URL('../../../../docs/evidence/screens/', import.meta.url).pathname;
const EXECUTABLE = process.env.CHROME_PATH ?? '/run/current-system/sw/bin/chromium';

const PAGES = ['home', 'terminal', 'ssh', 'logs', 'diagnostics', 'runtime', 'actions', 'settings'];

const VIEWPORTS = {
  phone: {width: 390, height: 844},
  desktop: {width: 1280, height: 800},
};

const problems = [];

const checkOverflow = async (page, label) => {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = [];
    for (const node of document.querySelectorAll('body *')) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.right > doc.clientWidth + 1) {
        offenders.push(`${node.tagName.toLowerCase()}.${node.className?.toString().split(' ')[0] ?? ''} right=${Math.round(rect.right)}`);
      }
    }
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      bodyScroll: document.body.scrollWidth,
      offenders: offenders.slice(0, 6),
    };
  });
  const pagesScroll = await page.evaluate(() => {
    const node = document.querySelector('.page');
    return node ? {scrollWidth: node.scrollWidth, clientWidth: node.clientWidth} : null;
  });
  if (overflow.scrollWidth !== overflow.clientWidth) {
    problems.push(`${label}: document scrollWidth ${overflow.scrollWidth} != clientWidth ${overflow.clientWidth} (${overflow.offenders.join(', ')})`);
  }
  if (await page.locator('.page').count()) {
    const ok = await page.evaluate(() => {
      const node = document.querySelector('.page');
      return node.scrollWidth <= node.clientWidth + 1;
    });
    if (!ok) problems.push(`${label}: .page overflows horizontally ${JSON.stringify(pagesScroll)}`);
  }
  return overflow;
};

const shoot = async (page, name) => {
  if (process.env.POCKET_SKIP_SHOTS === '1') return;
  await mkdir(SHOTS, {recursive: true});
  await page.screenshot({path: `${SHOTS}${name}.png`, fullPage: false});
  console.log(`  shot ${name}.png`);
};

const setTheme = async (page, theme) => {
  await page.evaluate(value => {
    document.documentElement.dataset.theme = value;
    localStorage.setItem('pt.theme', value);
  }, theme);
  await page.waitForTimeout(140);
};

const setLayout = async (page, layout) => {
  await page.evaluate(value => {
    document.documentElement.dataset.layout = value;
    localStorage.setItem('pt.layout', value);
  }, layout);
  await page.waitForTimeout(140);
};

const gotoPage = async (page, id) => {
  await page.evaluate(value => {
    localStorage.setItem('pt.page', value);
  }, id);
  await page.goto(`${BASE}/?page=${id}`, {waitUntil: 'networkidle'});
  await page.waitForTimeout(320);
};

/**
 * The daemon caps sessions and remembers trusted host keys, so a previous run
 * must not starve this one or pre-accept the TOFU prompt under test.
 */
const resetState = async () => {
  const api = process.env.POCKET_TERMINAL_API ?? 'http://127.0.0.1:8795';
  const list = await (await fetch(`${api}/api/terminal/sessions`)).json();
  for (const session of list.sessions ?? []) {
    await fetch(`${api}/api/terminal/sessions/${session.id}`, {method: 'DELETE'});
  }
  const hosts = await (await fetch(`${api}/api/ssh/known-hosts`)).json();
  for (const host of hosts.knownHosts ?? []) {
    await fetch(`${api}/api/ssh/known-hosts/${encodeURIComponent(host.id)}`, {method: 'DELETE'});
  }
  console.log(`· cleared ${list.sessions?.length ?? 0} sessions, ${hosts.knownHosts?.length ?? 0} known hosts`);
};

const main = async () => {
  await resetState();
  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  });
  const context = await browser.newContext({viewport: VIEWPORTS.desktop});
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Chromium logs a generic line for every 4xx response; the response
    // listener above already records the actionable form.
    if (/Failed to load resource/.test(text)) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));
  // TOFU deliberately answers the first connect with 409 host_key_unknown;
  // that is the contract under test, not a failure.
  page.on('response', response => {
    if (response.status() < 400) return;
    const path = new URL(response.url()).pathname;
    const isTofu = response.status() === 409 && /\/api\/ssh\/profiles\/.+\/connect$/.test(path);
    if (isTofu) return;
    consoleErrors.push(`http ${response.status()} ${response.request().method()} ${path}`);
  });

  console.log('· desktop dark walk');
  await page.goto(`${BASE}/`, {waitUntil: 'networkidle'});
  await page.waitForTimeout(400);

  // Page-level screenshots are owned by scripts/screenshots.mjs; this run
  // asserts geometry and captures the workflow evidence only.
  for (const id of PAGES) {
    await gotoPage(page, id);
    await checkOverflow(page, `desktop/${id}`);
  }

  // Light theme sweep.
  console.log('· desktop light walk');
  for (const id of PAGES) {
    await gotoPage(page, id);
    await setTheme(page, 'light');
    await checkOverflow(page, `desktop-light/${id}`);
  }

  // E-Ink layout evidence.
  console.log('· e-ink layout');
  await gotoPage(page, 'diagnostics');
  await setLayout(page, 'eink');
  await checkOverflow(page, 'eink/diagnostics');

  // Handheld layout at both breakpoints.
  console.log('· handheld layout');
  for (const layout of ['handheld', 'desktop']) {
    await page.setViewportSize(VIEWPORTS.phone);
    await gotoPage(page, 'home');
    await setLayout(page, layout);
    await setTheme(page, 'dark');
    for (const id of PAGES) {
      await gotoPage(page, id);
      await checkOverflow(page, `phone-${layout}/${id}`);
    }
  }

  // Real terminal command execution through the UI.
  console.log('· terminal round-trip');
  await page.setViewportSize(VIEWPORTS.desktop);
  await setLayout(page, 'desktop');
  await setTheme(page, 'dark');
  await gotoPage(page, 'terminal');
  const newTab = page.getByRole('button', {name: /New tab/i});
  await newTab.click();
  await page.waitForTimeout(220);
  const start = page.getByRole('button', {name: /Start session/i});
  if (await start.count()) {
    await start.click();
    await page.getByRole('dialog').waitFor({state: 'detached', timeout: 5000});
    await page.waitForTimeout(1200);
  }
  const host = page.locator('.term-host').first();
  await host.click();
  await page.waitForTimeout(700);
  await page.keyboard.type('echo POCKET_UI_SMOKE_$((6*7)); uname -sr; whoami');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1400);
  const screenText = await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  if (!screenText.includes('POCKET_UI_SMOKE_42')) {
    problems.push(`terminal: expected command output on screen, got ${JSON.stringify(screenText.slice(-220))}`);
  } else {
    console.log('  terminal output confirmed:', screenText.split('\n').filter(Boolean).slice(-4).join(' | '));
  }
  await checkOverflow(page, 'desktop/terminal-live');
  await shoot(page, 'terminal-live-command-1280x800');

  // Split pane.
  const split = page.getByRole('button', {name: /Split/i}).first();
  await split.click();
  await page.waitForTimeout(500);
  const panes = await page.locator('.term-pane').count();
  if (panes < 2) problems.push(`split pane: expected 2 panes, saw ${panes}`);
  await shoot(page, 'terminal-split-1280x800');

  // SSH mock full flow: TOFU dialog then connected session.
  console.log('· ssh mock flow');
  await gotoPage(page, 'ssh');
  await page.getByRole('button', {name: /Mock Lab/}).first().click();
  await page.waitForTimeout(200);
  await shoot(page, 'ssh-profiles-1280x800');
  const connect = page.getByRole('button', {name: /^Connect$/}).first();
  await connect.click();
  await page.waitForTimeout(900);
  const dialogVisible = await page.getByRole('dialog').count();
  if (dialogVisible > 0) {
    const title = await page.getByRole('dialog').innerText();
    if (!/Unknown host key/i.test(title)) problems.push('ssh: unexpected dialog before TOFU');
    await shoot(page, 'ssh-tofu-dialog-1280x800');
    await page.getByRole('button', {name: /Trust and connect/i}).click();
    await page.waitForTimeout(1200);
  }
  const sshHost = page.locator('.term-host').first();
  await sshHost.click();
  await page.waitForTimeout(900);
  await page.keyboard.type('echo SSH_UI_SMOKE_$((11*11)); hostname');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const sshScreen = await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  if (!sshScreen.includes('SSH_UI_SMOKE_121')) {
    problems.push(`ssh: expected round-trip output, got ${JSON.stringify(sshScreen.slice(-220))}`);
  } else {
    console.log('  ssh output confirmed');
  }
  await shoot(page, 'ssh-connected-1280x800');

  // Command palette via keyboard, then DPad traversal evidence.
  console.log('· palette + dpad');
  await page.goto(`${BASE}/?page=home`, {waitUntil: 'networkidle'});
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(250);
  const palette = page.getByRole('dialog', {name: /Command palette/i});
  if (!(await palette.count())) problems.push('palette: Ctrl+K did not open the palette');
  await page.keyboard.type('logs');
  await page.waitForTimeout(160);
  await shoot(page, 'palette-1280x800');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const heading = await page.locator('.topbar h1').innerText();
  if (!/Log viewer/i.test(heading)) problems.push(`palette: expected Log viewer page, got ${heading}`);

  await page.goto(`${BASE}/?page=home`, {waitUntil: 'networkidle'});
  await page.waitForTimeout(300);
  await page.locator('body').click({position: {x: 5, y: 5}});
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(120);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(120);
  const ring = await page.evaluate(() => document.querySelectorAll('[data-dpad-active="true"]').length);
  if (ring !== 1) problems.push(`dpad: expected one focus ring, found ${ring}`);
  await shoot(page, 'dpad-focus-ring-1280x800');

  await browser.close();

  if (consoleErrors.length) {
    for (const text of consoleErrors.slice(0, 12)) problems.push(`console: ${text}`);
  }

  if (problems.length) {
    console.error('\nFAILED');
    for (const problem of problems) console.error(` - ${problem}`);
    process.exit(1);
  }
  console.log('\nOK: no console errors, no horizontal overflow, terminal + ssh round-trips verified');
};

await main();
