import { test, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

declare global {
  interface Window {
    __dirTest: Record<string, { bytes: number; closed: boolean }>;
    __resumeBytes: number;
    __airdropTest?: {
      dropDataChannel?: () => void;
      dropSignaling?: () => void;
      getRecoveryCount?: () => number;
    };
  }
}

async function disableFilePickers(context: BrowserContext) {
  await context.addInitScript(() => {
    try { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); } catch {}
    try { Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true }); } catch {}
  });
}

async function createRoom(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: /发送文件/ }).click();
  const label = await page.locator('[aria-label^="Token "]').getAttribute('aria-label');
  const token = (label || '').replace('Token ', '').replace(' ', '');
  expect(token).toMatch(/^[A-HJ-NP-Za-hj-np-z2-9]{8}$/);
  return token;
}

async function joinRoom(page: Page, token: string) {
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await expect(page.getByLabel('配对 Token')).toHaveValue(token);
  const joinButton = page.getByRole('button', { name: '连接对方' });
  await expect(joinButton).toBeEnabled({ timeout: 15_000 });
  await joinButton.click();
}

async function waitForConnection(sender: Page, receiver: Page) {
  await expect(sender.getByText('对方已连接')).toBeVisible({ timeout: 20_000 });
  await expect(receiver.getByText('对方已连接')).toBeVisible({ timeout: 20_000 });
}

function makeFile(testInfo: TestInfo, name: string, size: number, byte = 0x41): string {
  const file = testInfo.outputPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, byte));
  return file;
}

test('transfers a multi-file queue over the memory fallback', async ({ browser }, testInfo) => {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  await disableFilePickers(receiverContext);
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  const token = await createRoom(sender);
  await joinRoom(receiver, token);
  await waitForConnection(sender, receiver);

  const files = [
    makeFile(testInfo, 'queue-a.bin', 256 * 1024, 0x11),
    makeFile(testInfo, 'queue-b.txt', 32 * 1024, 0x22)
  ];
  await sender.locator('input[type=file]').setInputFiles(files);
  await expect(receiver.getByText('收到文件接收请求')).toBeVisible();
  await receiver.getByRole('button', { name: '开始接收' }).click();
  await expect(receiver.getByText('全部文件接收完成')).toBeVisible({ timeout: 30_000 });
  await expect(sender.getByText('对方已确认接收完成')).toBeVisible({ timeout: 30_000 });
  await expect(receiver.getByRole('button', { name: /^下载 / })).toHaveCount(2);

  await senderContext.close();
  await receiverContext.close();
});

test('streams multiple files into a selected directory', async ({ browser, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'File System Access mocks are exercised in Chromium');
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  await receiverContext.addInitScript(() => {
    window.__dirTest = {};
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => ({
        getFileHandle: async (name: string) => ({
          createWritable: async () => ({
            write: async (data: ArrayBuffer) => {
              const entry = window.__dirTest[name] ||= { bytes: 0, closed: false };
              entry.bytes += data.byteLength;
            },
            close: async () => { window.__dirTest[name].closed = true; },
            abort: async () => {}
          })
        })
      })
    });
  });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  const token = await createRoom(sender);
  await joinRoom(receiver, token);
  await waitForConnection(sender, receiver);

  const files = [
    makeFile(testInfo, 'stream-a.bin', 512 * 1024, 0x33),
    makeFile(testInfo, 'stream-b.bin', 768 * 1024, 0x44)
  ];
  await sender.locator('input[type=file]').setInputFiles(files);
  await receiver.getByRole('button', { name: '选择保存目录并接收' }).click();
  await expect(receiver.getByText('全部文件接收完成')).toBeVisible({ timeout: 30_000 });
  const result = await receiver.evaluate(() => window.__dirTest);
  expect(result['stream-a.bin']).toEqual({ bytes: 512 * 1024, closed: true });
  expect(result['stream-b.bin']).toEqual({ bytes: 768 * 1024, closed: true });

  await senderContext.close();
  await receiverContext.close();
});

test('recovers the data channel and resumes from the receiver offset', async ({ browser, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Deterministic recovery hook is enabled for Chromium E2E');
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  await receiverContext.addInitScript(() => {
    window.__resumeBytes = 0;
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        createWritable: async () => ({
          write: async (data: ArrayBuffer) => {
            window.__resumeBytes += data.byteLength;
            await new Promise((resolve) => setTimeout(resolve, 8));
          },
          close: async () => {},
          abort: async () => {}
        })
      })
    });
  });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  const token = await createRoom(sender);
  await joinRoom(receiver, token);
  await waitForConnection(sender, receiver);

  await sender.locator('input[type=file]').setInputFiles(makeFile(testInfo, 'resume.bin', 6 * 1024 * 1024, 0x55));
  await receiver.getByRole('button', { name: '选择位置并接收' }).click();
  const progress = receiver.getByRole('progressbar');
  await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow')), { timeout: 15_000 }).toBeGreaterThan(0);
  await receiver.evaluate(() => window.__airdropTest?.dropDataChannel?.());
  await expect.poll(() => receiver.evaluate(() => window.__airdropTest?.getRecoveryCount?.() || 0), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(receiver.getByText('全部文件接收完成')).toBeVisible({ timeout: 30_000 });
  await expect(sender.getByText('对方已确认接收完成')).toBeVisible({ timeout: 30_000 });
  expect(await receiver.evaluate(() => window.__resumeBytes)).toBe(6 * 1024 * 1024);

  await senderContext.close();
  await receiverContext.close();
});

test('resumes the signaling room during an active transfer', async ({ browser, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Deterministic recovery hook is enabled for Chromium E2E');
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  await receiverContext.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        createWritable: async () => ({
          write: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); },
          close: async () => {},
          abort: async () => {}
        })
      })
    });
  });
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  const token = await createRoom(sender);
  await joinRoom(receiver, token);
  await waitForConnection(sender, receiver);

  await sender.locator('input[type=file]').setInputFiles(makeFile(testInfo, 'signal-resume.bin', 4 * 1024 * 1024, 0x66));
  await receiver.getByRole('button', { name: '选择位置并接收' }).click();
  await sender.evaluate(() => window.__airdropTest?.dropSignaling?.());
  await expect(receiver.getByText('全部文件接收完成')).toBeVisible({ timeout: 35_000 });
  await expect(sender.getByText('对方已确认接收完成')).toBeVisible({ timeout: 35_000 });

  await senderContext.close();
  await receiverContext.close();
});

test('scanner explains camera permission failure and keeps manual input available', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Camera permission mock is exercised in Chromium');
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'mediaDevices', {
      configurable: true,
      get: () => ({
        getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError'); }
      })
    });
  });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /接收文件/ }).click();
  await page.getByRole('button', { name: '扫描邀请二维码' }).click();
  await expect(page.getByText('摄像头权限被拒绝，请在浏览器设置中允许后重试')).toBeVisible();
  await page.getByRole('button', { name: '手动输入 Token' }).click();
  await expect(page.getByLabel('配对 Token')).toBeVisible();
  await context.close();
});
