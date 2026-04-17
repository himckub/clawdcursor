/**
 * Zero-LLM action router.
 *
 * Intercepts mechanical/navigation subtasks and handles them without any LLM
 * call. Ported from src/action-router.ts — preserves the highest-ROI bits:
 *
 *   - APP_ALIASES table (40 apps × 3 OSes) via ./aliases
 *   - WEBVIEW2 settle rule (Outlook/Teams/Slack/...) via ./webview2
 *   - compound-task guard (refuses to route ambiguous splits)
 *   - URL normalization + browser-launch path
 *   - telemetry counters the caller can read for cost-saving proof
 *
 * The legacy router called into AIBrain / accessibility / native-desktop
 * directly. This port takes a `PlatformAdapter` and nothing else — the
 * pipeline's own router knows nothing about V1 internals.
 *
 * Security: `action-router.ts:339` had a `child_process.exec('start "" "${url}"')`
 * sink (audit C3). The port here goes through adapter.launchApp which uses
 * execFile with argv — no shell expansion. C3 closed in place.
 */

import type { PlatformAdapter } from '../../v2/platform/types';
import { logger } from '../observability/logger';
import { APP_ALIASES, resolveAlias } from './aliases';
import { needsWebView2Settle, settleIfWebView2 } from './webview2';

export { APP_ALIASES, resolveAlias, needsWebView2Settle, settleIfWebView2 };

export interface RouteResult {
  handled: boolean;
  /** Short human summary for telemetry / logs. */
  description?: string;
  /** If the router spawned an app or focused a window, its pid. */
  processId?: number;
  /** What path fired — used by the canonical regression suite to assert
   *  blind-first behavior. */
  path?: 'open_app' | 'url_nav' | 'shortcut' | 'focus' | 'none';
}

export interface RouterTelemetry {
  openAppHits: number;
  urlNavHits: number;
  shortcutHits: number;
  focusHits: number;
  llmFallbacks: number;
  compoundRefused: number;
}

/**
 * Compound-task guard: reject subtasks that still look compound. The
 * decomposer is supposed to split them first; if the router sees "X and Y"
 * with action verbs on both sides it should refuse rather than pick one.
 */
const COMPOUND_PATTERN = /\b(and|then)\b.*\b(type|click|press|open|save|send|scroll|navigate|go|visit|search|copy|paste|close)\b/i;

/** URL-ish detection — same heuristic as classify/NAVIGATION_URL. */
const URL_PATTERN = /\b(https?:\/\/|www\.|\S+\.(com|org|io|dev|net|co|app))\b/i;

/** `open <app>` phrasings. */
const OPEN_APP_PATTERN = /^\s*(?:open|launch|start|run)\s+(.+?)\s*$/i;

/** `go to <url>` / `navigate to <url>` / `visit <url>`. */
const NAV_URL_PATTERN = /^\s*(?:go to|navigate to|visit|browse to|open)\s+(.+?)\s*$/i;

/** `focus <app>` / `switch to <app>`. */
const FOCUS_APP_PATTERN = /^\s*(?:focus|switch to)\s+(.+?)\s*$/i;

export class Router {
  readonly telemetry: RouterTelemetry = {
    openAppHits: 0,
    urlNavHits: 0,
    shortcutHits: 0,
    focusHits: 0,
    llmFallbacks: 0,
    compoundRefused: 0,
  };

  constructor(private readonly adapter: PlatformAdapter) {}

  /** Attempt to route a single subtask. Returns { handled: false } on miss. */
  async route(subtask: string): Promise<RouteResult> {
    const task = subtask.trim();
    if (!task) return { handled: false, path: 'none' };

    if (COMPOUND_PATTERN.test(task)) {
      this.telemetry.compoundRefused += 1;
      logger.debug('router.refused_compound', { task });
      return { handled: false, path: 'none', description: 'refused: compound task' };
    }

    // 1. `open <app>` — resolve alias, launch through adapter, settle if WebView2
    const openMatch = task.match(OPEN_APP_PATTERN);
    if (openMatch) {
      const name = openMatch[1].trim();
      const alias = resolveAlias(name);
      const appToLaunch = alias ? (alias.macOSAppName && this.adapter.platform === 'darwin' ? alias.macOSAppName : (alias.executable ?? alias.key)) : name;
      logger.debug('router.open_app', { name, alias: !!alias, appToLaunch });

      try {
        const result = await this.adapter.launchApp(appToLaunch, {
          alwaysNewInstance: alias?.alwaysNewInstance,
        });
        this.telemetry.openAppHits += 1;
        // Settle for Electron/WebView2 apps.
        await settleIfWebView2(name);
        return {
          handled: true,
          path: 'open_app',
          processId: result.pid,
          description: `Opened ${alias?.searchTerm ?? name}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('router.open_app.failed', { name, error: msg });
        return { handled: false, path: 'none', description: `launchApp failed: ${msg}` };
      }
    }

    // 2. URL navigation — focus browser, launch with URL
    const navMatch = task.match(NAV_URL_PATTERN);
    if (navMatch && URL_PATTERN.test(navMatch[1])) {
      const url = this.normalizeUrl(navMatch[1]);
      logger.debug('router.url_nav', { url });
      try {
        const result = await this.adapter.launchApp('default-browser', { url });
        this.telemetry.urlNavHits += 1;
        return {
          handled: true,
          path: 'url_nav',
          processId: result.pid,
          description: `Navigated to ${url}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('router.url_nav.failed', { url, error: msg });
        return { handled: false, path: 'none', description: `url nav failed: ${msg}` };
      }
    }

    // 3. `focus <app>` — find the window and focus it
    const focusMatch = task.match(FOCUS_APP_PATTERN);
    if (focusMatch) {
      const name = focusMatch[1].trim();
      const alias = resolveAlias(name);
      const processNames = alias?.processNames ?? [name];
      for (const pn of processNames) {
        const ok = await this.adapter.focusWindow({ processName: pn });
        if (ok) {
          this.telemetry.focusHits += 1;
          return { handled: true, path: 'focus', description: `Focused ${alias?.searchTerm ?? name}` };
        }
      }
      return { handled: false, path: 'none', description: `focus failed: no window for ${name}` };
    }

    // Miss — let the caller escalate to the text-agent
    this.telemetry.llmFallbacks += 1;
    return { handled: false, path: 'none' };
  }

  /**
   * Normalize a URL-ish input into a full https:// URL.
   */
  private normalizeUrl(raw: string): string {
    const cleaned = raw.trim().replace(/['"]+/g, '');
    if (/^https?:\/\//i.test(cleaned)) return cleaned;
    if (/^www\./i.test(cleaned)) return 'https://' + cleaned;
    return 'https://' + cleaned;
  }
}
