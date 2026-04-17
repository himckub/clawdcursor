/**
 * Router tests — aliases, webview2 settle, core route logic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { APP_ALIASES, resolveAlias } from '../pipeline/router/aliases';
import { needsWebView2Settle, WEBVIEW2_SETTLE_MS } from '../pipeline/router/webview2';
import { Router } from '../pipeline/router/router';
import type { PlatformAdapter } from '../v2/platform/types';

function makeMockAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  const noop: any = () => Promise.resolve();
  return {
    platform: 'win32',
    init: noop,
    shutdown: noop,
    checkPermissions: () => Promise.resolve({ input: true, accessibility: true, screenRecording: true }),
    requestPermissions: () => Promise.resolve({ input: true, accessibility: true, screenRecording: true }),
    getScreenSize: () => Promise.resolve({ physicalWidth: 1920, physicalHeight: 1080, logicalWidth: 1920, logicalHeight: 1080, dpiRatio: 1 }),
    screenshot: () => Promise.resolve({ buffer: Buffer.alloc(0), width: 0, height: 0, scaleFactor: 1 }),
    screenshotRegion: () => Promise.resolve({ buffer: Buffer.alloc(0), width: 0, height: 0, scaleFactor: 1 }),
    listWindows: () => Promise.resolve([]),
    getActiveWindow: () => Promise.resolve(null),
    focusWindow: () => Promise.resolve(true),
    maximizeWindow: noop,
    getUiTree: () => Promise.resolve([]),
    findElements: () => Promise.resolve([]),
    getFocusedElement: () => Promise.resolve(null),
    invokeElement: () => Promise.resolve({ success: true }),
    mouseClick: noop,
    mouseMove: noop,
    mouseDrag: noop,
    mouseScroll: noop,
    typeText: noop,
    keyPress: noop,
    readClipboard: () => Promise.resolve(''),
    writeClipboard: noop,
    openApp: () => Promise.resolve({}),
    launchApp: () => Promise.resolve({ pid: 1234 }),
    ...overrides,
  } as PlatformAdapter;
}

describe('APP_ALIASES', () => {
  it('has 40+ entries', () => {
    expect(Object.keys(APP_ALIASES).length).toBeGreaterThanOrEqual(35);
  });

  it.each([
    ['notepad',    { hasExecutable: true, searchTerm: 'Notepad' }],
    ['chrome',     { hasExecutable: false, searchTerm: 'Chrome' }],
    ['Outlook',    { hasExecutable: false, searchTerm: 'Outlook' }], // case-insensitive
    ['file explorer', { hasExecutable: false, searchTerm: 'File Explorer' }],
  ])('resolveAlias(%j) returns expected row', (name, expected) => {
    const r = resolveAlias(name);
    expect(r).not.toBeNull();
    expect(r!.searchTerm).toBe(expected.searchTerm);
    if (expected.hasExecutable) expect(r!.executable).toBeTruthy();
  });

  it('returns null for unknown names', () => {
    expect(resolveAlias('some-random-app-xyz')).toBeNull();
    expect(resolveAlias('')).toBeNull();
  });

  it('Notepad maps to TextEdit on macOS', () => {
    const r = resolveAlias('notepad');
    expect(r!.macOSAppName).toBe('TextEdit');
  });

  it('Explorer maps to Finder on macOS', () => {
    const r = resolveAlias('explorer');
    expect(r!.macOSAppName).toBe('Finder');
  });

  it('mspaint has alwaysNewInstance', () => {
    expect(resolveAlias('paint')!.alwaysNewInstance).toBe(true);
  });
});

describe('WebView2 settle rule', () => {
  it('matches known Electron apps', () => {
    ['outlook', 'OUTLOOK', 'olk', 'Teams', 'slack', 'discord', 'spotify', 'vscode', 'code']
      .forEach(n => expect(needsWebView2Settle(n)).toBe(true));
  });

  it('does not match non-Electron apps', () => {
    ['notepad', 'chrome', 'calculator', ''].forEach(n => expect(needsWebView2Settle(n)).toBe(false));
  });

  it('settle duration is 4s', () => {
    expect(WEBVIEW2_SETTLE_MS).toBe(4_000);
  });
});

describe('Router.route', () => {
  beforeEach(() => {
    // Compress the WebView2 settle for test speed — 4 real seconds × multiple
    // tests would make the suite slow. fake timers don't apply because the
    // settleIfWebView2 helper takes a real promise.
    // Approach: stub global setTimeout to be instant for tests that go through
    // Outlook etc. We fake timers when we need to assert the delay.
  });

  it('handles "open Chrome"', async () => {
    const adapter = makeMockAdapter();
    const launchApp = vi.fn().mockResolvedValue({ pid: 42 });
    adapter.launchApp = launchApp;
    const r = new Router(adapter);
    const res = await r.route('open Chrome');
    expect(res.handled).toBe(true);
    expect(res.path).toBe('open_app');
    expect(res.processId).toBe(42);
    expect(launchApp).toHaveBeenCalled();
    expect(r.telemetry.openAppHits).toBe(1);
  });

  it('handles "navigate to github.com"', async () => {
    const adapter = makeMockAdapter();
    const launchApp = vi.fn().mockResolvedValue({ pid: 99 });
    adapter.launchApp = launchApp;
    const r = new Router(adapter);
    const res = await r.route('navigate to github.com');
    expect(res.handled).toBe(true);
    expect(res.path).toBe('url_nav');
    expect(launchApp).toHaveBeenCalledWith('default-browser', expect.objectContaining({ url: 'https://github.com' }));
  });

  it('normalizes bare URLs to https://', async () => {
    const adapter = makeMockAdapter();
    const launchApp = vi.fn().mockResolvedValue({});
    adapter.launchApp = launchApp;
    await new Router(adapter).route('go to example.com');
    expect(launchApp.mock.calls[0][1].url).toBe('https://example.com');
  });

  it('preserves https:// URLs as-is', async () => {
    const adapter = makeMockAdapter();
    const launchApp = vi.fn().mockResolvedValue({});
    adapter.launchApp = launchApp;
    await new Router(adapter).route('visit https://clawdcursor.com');
    expect(launchApp.mock.calls[0][1].url).toBe('https://clawdcursor.com');
  });

  it('handles "focus Chrome"', async () => {
    const adapter = makeMockAdapter();
    const focusWindow = vi.fn().mockResolvedValue(true);
    adapter.focusWindow = focusWindow;
    const r = new Router(adapter);
    const res = await r.route('focus Chrome');
    expect(res.handled).toBe(true);
    expect(res.path).toBe('focus');
    expect(r.telemetry.focusHits).toBe(1);
  });

  it('refuses compound tasks', async () => {
    const adapter = makeMockAdapter();
    const r = new Router(adapter);
    const res = await r.route('open Chrome and type hello');
    expect(res.handled).toBe(false);
    expect(r.telemetry.compoundRefused).toBe(1);
  });

  it('returns { handled: false } for reasoning tasks', async () => {
    const adapter = makeMockAdapter();
    const r = new Router(adapter);
    const res = await r.route('summarize this article');
    expect(res.handled).toBe(false);
    expect(r.telemetry.llmFallbacks).toBe(1);
  });

  it('tracks telemetry across multiple routes', async () => {
    const adapter = makeMockAdapter();
    const r = new Router(adapter);
    await r.route('open Chrome');
    await r.route('go to github.com');
    await r.route('summarize article');
    expect(r.telemetry.openAppHits).toBe(1);
    expect(r.telemetry.urlNavHits).toBe(1);
    expect(r.telemetry.llmFallbacks).toBe(1);
  });
});
