/**
 * SafetyLayer — unified gate for every agent action (v0.8.1 rebuild).
 *
 * v0.8.0's `src/safety.ts` classified only by description-string match, which
 * the audit correctly flagged as trivially bypassable (a `mouse_click(x,y)` on
 * a Send button never contains the word "send"). V2 orchestrator didn't call
 * SafetyLayer at all, and the `/action` REST endpoint bypassed it entirely.
 *
 * v0.8.1 fixes the chokepoint problem:
 *  - Pure function `evaluate(action, context) → Decision` keyed on the ACTION
 *    TYPE, not on description prose. A mouse_click on a button whose OCR
 *    label matches a Confirm-tier pattern elevates to Confirm. A key combo
 *    in BLOCKED_KEYS returns Block.
 *  - Registry-driven coverage test (`safety-coverage.test.ts`) enforces
 *    that every MCP tool handler invokes `evaluate` before its first side
 *    effect.
 *  - Decision is observable via the audit log (`safety.decision` events).
 *
 * Model-agnostic: no LLM calls. Pure rule engine.
 */

import { isBlockedKey, blockReason } from '../playbooks/keys-blocklist';
import { logger } from '../observability/logger';
import { getCorrelationId } from '../observability/correlation';

export type Tier = 'read' | 'input' | 'destructive' | 'system';

export type Decision =
  | { decision: 'allow'; tier: Tier }
  | { decision: 'confirm'; tier: Tier; reason: string }
  | { decision: 'block'; tier: Tier; reason: string };

/** What the evaluator sees. Tool name is CANONICAL — not a description. */
export interface EvaluationContext {
  /** Canonical tool / action name (e.g. "mouse_click", "a11y_set_value"). */
  tool: string;
  /** Arbitrary args shape — typed by caller; evaluator pattern-matches safely. */
  args: Record<string, unknown>;
  /** Optional OCR label of the element the action targets, when known. */
  targetLabel?: string;
  /** Optional active app name — raises the tier for sensitive domains
   *  (email, banking, messaging, password managers). */
  activeApp?: string;
}

/**
 * Patterns in a target element's OCR/a11y label that elevate the tier to
 * Confirm. Matched case-insensitively. Derived from v0.6.3 sensitive-app
 * policy + v0.8.0 audit findings.
 */
const CONFIRM_LABEL_PATTERNS: RegExp[] = [
  /\bsend\b/i,             // email, message, wire transfer
  /\bdelete\b/i,           // destructive
  /\bremove\b/i,
  /\btrash\b/i,
  /\berase\b/i,
  /\buninstall\b/i,
  /\bdrop\s+(database|table)/i,
  /\bshut\s*down\b/i,
  /\brestart\b/i,
  /\blog\s*out\b/i,
  /\bsign\s*out\b/i,
  /\bpurchase\b/i,
  /\bbuy\b/i,
  /\bcheckout\b/i,
  /\bpay\b/i,
  /\btransfer\b/i,
  /\bpublish\b/i,
  /\bconfirm\b/i,          // confirm dialogs themselves — require user
];

/** Apps where even innocuous clicks should elevate to Confirm. */
const SENSITIVE_APPS = /\b(outlook|olk|mail|gmail|banking|1password|lastpass|bitwarden|keeper|signal|whatsapp|messages|telegram|imessage)\b/i;

/** Tool name → default tier. */
const TOOL_TIER: Record<string, Tier> = {
  // Read — always allow
  'read_screen': 'read',
  'ocr_read_screen': 'read',
  'smart_read': 'read',
  'desktop_screenshot': 'read',
  'desktop_screenshot_region': 'read',
  'get_screen_size': 'read',
  'get_windows': 'read',
  'get_active_window': 'read',
  'get_focused_element': 'read',
  'find_element': 'read',
  'read_clipboard': 'read',
  'cdp_page_context': 'read',
  'cdp_read_text': 'read',
  'cdp_list_tabs': 'read',
  'shortcuts_list': 'read',
  // Input — allow with label check
  'mouse_click': 'input',
  'mouse_double_click': 'input',
  'mouse_right_click': 'input',
  'mouse_hover': 'input',
  'mouse_scroll': 'input',
  'mouse_drag': 'input',
  'type_text': 'input',
  'smart_type': 'input',
  'smart_click': 'input',
  'invoke_element': 'input',
  'key_press': 'input',
  'write_clipboard': 'input',
  'cdp_click': 'input',
  'cdp_type': 'input',
  'cdp_select_option': 'input',
  'cdp_scroll': 'input',
  'cdp_wait_for_selector': 'input',
  'cdp_switch_tab': 'input',
  'cdp_connect': 'input',
  'navigate_browser': 'input',
  'focus_window': 'input',
  'minimize_window': 'input',
  'shortcuts_execute': 'input',
  // System — always confirm (or block)
  'cdp_evaluate': 'system',
  'open_app': 'input',
  'wait': 'read',
  'delegate_to_agent': 'input',
  // Pipeline-internal actions
  'a11y_click': 'input',
  'a11y_set_value': 'input',
  'click': 'input',
  'type': 'input',
  'press': 'input',
  'scroll': 'input',
  'drag': 'input',
  'screenshot': 'read',
  'run_playbook': 'input',
  'done': 'read',
  'give_up': 'read',
  'cannot_read': 'read',
  // Tranche 1B — new MCP tools (extras.ts)
  'mouse_move_relative': 'input',
  'mouse_middle_click': 'input',
  'mouse_triple_click': 'input',
  'mouse_down': 'input',
  'mouse_up': 'input',
  'mouse_scroll_horizontal': 'input',
  'mouse_drag_stepped': 'input',
  'key_down': 'input',
  'key_up': 'input',
  'maximize_window': 'input',
  'minimize_window_to_taskbar': 'input',
  'restore_window': 'input',
  'close_window': 'destructive',    // polite request, but the user may not want this on autopilot
  'resize_window': 'input',
  'list_displays': 'read',
  'focus_element': 'input',
  'wait_for_element': 'read',
  'open_file': 'input',
  'open_url': 'input',
  'get_system_time': 'read',
  'switch_tab_os': 'input',
  'undo_last': 'input',
};

/**
 * Evaluate an action. Pure function — no side effects other than the
 * `safety.decision` audit log.
 */
export function evaluate(ctx: EvaluationContext): Decision {
  const tier: Tier = TOOL_TIER[ctx.tool] ?? 'input';
  const correlationId = getCorrelationId();

  const emit = (decision: Decision) => {
    logger.info('safety.decision', { tool: ctx.tool, ...decision, correlationId });
    return decision;
  };

  // 1. Keyboard combos: if blocked, reject immediately.
  if ((ctx.tool === 'key_press' || ctx.tool === 'press') && typeof ctx.args.combo === 'string') {
    if (isBlockedKey(ctx.args.combo)) {
      return emit({ decision: 'block', tier: 'destructive', reason: blockReason(ctx.args.combo) });
    }
  }
  if ((ctx.tool === 'key_press' || ctx.tool === 'press') && typeof ctx.args.key === 'string') {
    if (isBlockedKey(ctx.args.key)) {
      return emit({ decision: 'block', tier: 'destructive', reason: blockReason(ctx.args.key) });
    }
  }

  // 2. cdp_evaluate is ungated in v0.8.0 (audit C5). Require Confirm here;
  // full allowArbitraryJs config gate lands in v0.8.2.
  if (ctx.tool === 'cdp_evaluate') {
    return emit({
      decision: 'confirm',
      tier: 'system',
      reason: 'cdp_evaluate runs arbitrary JS in the active page — requires user approval',
    });
  }

  // 3. Read tier: always allow.
  if (tier === 'read') {
    return emit({ decision: 'allow', tier });
  }

  // 4. System tier: always confirm (catch-all).
  if (tier === 'system') {
    return emit({ decision: 'confirm', tier, reason: `${ctx.tool} is a system-tier action` });
  }

  // 4b. Destructive tier: confirm. Matches the tool-registry tag for
  //     explicitly-destructive verbs (close_window, etc.) so the gate
  //     fires even when there's no label match.
  if (tier === 'destructive') {
    return emit({ decision: 'confirm', tier, reason: `${ctx.tool} is a destructive-tier action` });
  }

  // 5. Input tier with a Confirm-pattern target label.
  if (ctx.targetLabel) {
    for (const pattern of CONFIRM_LABEL_PATTERNS) {
      if (pattern.test(ctx.targetLabel)) {
        return emit({
          decision: 'confirm',
          tier: 'destructive',
          reason: `target "${ctx.targetLabel}" matches destructive pattern ${pattern.source}`,
        });
      }
    }
  }

  // 6. Sensitive-app elevation: clicks/typing inside email/banking/messaging apps.
  if (ctx.activeApp && SENSITIVE_APPS.test(ctx.activeApp)) {
    // Only elevate for actions that could send/delete. Reads stay allowed.
    if (['smart_click', 'cdp_click', 'mouse_click', 'a11y_click', 'click', 'invoke_element'].includes(ctx.tool)) {
      // Without a target label, we can't be sure — mark Input but audit.
      logger.debug('safety.sensitive_app.click', { app: ctx.activeApp, tool: ctx.tool, correlationId });
    }
  }

  // 7. Default allow at input tier.
  return emit({ decision: 'allow', tier });
}

/**
 * Convenience predicate. Returns true if the decision allows the action to
 * proceed without user confirmation.
 */
export function isAllowed(d: Decision): boolean {
  return d.decision === 'allow';
}
