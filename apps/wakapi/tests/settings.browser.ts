import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const server = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(Bun.file(new URL('../dist/settings.html', import.meta.url)), {
      headers: { 'Content-Type': 'text/html' },
    }),
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const scope = window as unknown as {
      ReactNativeWebView: { postMessage: (json: string) => void };
      __bridgethingSettingsDeliver: (json: string) => void;
      captured: { verb: string; payload: { key: string; value: string } }[];
      failSave: boolean;
    };
    scope.captured = [];
    scope.failSave = false;
    scope.ReactNativeWebView = {
      postMessage(json) {
        const request = JSON.parse(json);
        scope.captured.push(request);
        const failed = scope.failSave && request.verb === 'config.set';
        queueMicrotask(() =>
          scope.__bridgethingSettingsDeliver(
            JSON.stringify({
              id: request.id,
              ok: !failed,
              value: request.verb === 'config.list' ? [] : null,
              error: failed ? 'Device disconnected' : undefined,
            }),
          ),
        );
      },
    };
  });
  await page.goto(server.url.toString());
  await page.waitForFunction(() => !document.querySelector('fieldset')!.disabled);
  await page.getByLabel('Server URL').fill('stats.example.net/wakapi/api');
  await page.getByLabel('Read-only API key').fill('example-read-key');
  assert.equal(await page.getByLabel('Read-only API key').getAttribute('type'), 'password');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  assert.equal(await page.getByLabel('Read-only API key').getAttribute('type'), 'text');
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await page.getByLabel('Default activity filter').selectOption('exclude-ai');
  await page.getByLabel('Accent', { exact: true }).selectOption('amber');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
  const saved = await page.evaluate(() =>
    (window as unknown as { captured: { verb: string; payload: { key: string; value: string } }[] }).captured
      .filter(item => item.verb === 'config.set')
      .map(item => item.payload),
  );
  assert.deepEqual(saved, [
    {
      key: 'connection',
      value: JSON.stringify({ server: 'https://stats.example.net/wakapi', apiKey: 'example-read-key' }),
    },
    { key: 'activity', value: 'exclude-ai' },
    { key: 'accent', value: 'amber' },
  ]);
  await page.getByLabel('Server URL').fill('file:///tmp');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'HTTP or HTTPS' }).waitFor();
  const count = await page.evaluate(
    () =>
      (window as unknown as { captured: { verb: string }[] }).captured.filter(item => item.verb === 'config.set')
        .length,
  );
  assert.equal(count, 3);
  await page.getByLabel('Server URL').fill('https://stats.example.net/wakapi');
  await page.evaluate(() => {
    (window as unknown as { failSave: boolean }).failSave = true;
  });
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Device disconnected' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save settings', exact: true }).isEnabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/wakapi-settings.png', fullPage: true });
  console.log(
    'Settings browser checks passed: masking, atomic connection save, filter, accent, invalid URL, failed save, mobile layout.',
  );
} finally {
  await browser.close();
  server.stop();
}
