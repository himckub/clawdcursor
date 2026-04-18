/**
 * Unified-agent tool catalog.
 *
 * ONE tool vocabulary across blind / hybrid / vision modes. The only
 * difference between modes: in `blind`, the `screenshot` tool is removed
 * from the catalog before the LLM sees it.
 *
 * Design rules:
 *   - Every mutation goes through PlatformAdapter (OS-agnostic).
 *   - NO ctx.platform call happens outside a tool's `execute()` — the agent
 *     loop never touches the adapter directly.
 *   - Terminal actions (`done` / `give_up` / `cannot_read`) just return
 *     `stop: true` with a terminalExit tag; the agent loop decides the
 *     AgentResult.
 *   - a11y-first wording. `invoke_element` and `set_field_value` are the
 *     preferred targeting tools; coord clicks are the fallback.
 *
 * Zero app-specific rules. A new LOB app works because a11y roles + the
 * rank-before-truncate sense layer surface its buttons.
 */

import type { UnifiedTool, UnifiedToolResult, AgentToolContext } from './types';

/**
 * Build the unified tool catalog. Modes:
 *   - 'blind'  → no screenshot tool
 *   - 'hybrid' → full catalog; model can call screenshot on demand
 *   - 'vision' → full catalog; initial screenshot is seeded elsewhere
 */
export function buildUnifiedTools(mode: 'blind' | 'hybrid' | 'vision'): UnifiedTool[] {
  const tools: UnifiedTool[] = [
    // ─── PERCEPTION ─────────────────────────────────────────────
    {
      name: 'read_screen',
      description: 'Refresh the accessibility snapshot of the focused window (already attached each turn — call this only if you suspect staleness).',
      inputSchema: {
        type: 'object',
        properties: {
          processId: { type: 'number', description: 'Optional: limit to a specific process' },
        },
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        const pid = typeof args.processId === 'number' ? args.processId : undefined;
        const tree = await ctx.platform.getUiTree(pid);
        if (tree.length === 0) {
          return { success: true, text: '(empty a11y tree — app may be custom-canvas)' };
        }
        const lines = tree.slice(0, 60).map(el =>
          `[${el.controlType || 'Element'}] "${el.name || ''}" @${el.bounds.x},${el.bounds.y} ${el.bounds.width}×${el.bounds.height}${el.value ? ` value="${el.value.slice(0, 40)}"` : ''}${el.focused ? ' [FOCUSED]' : ''}`,
        );
        const more = tree.length > 60 ? `\n… +${tree.length - 60} more` : '';
        return { success: true, text: `Fresh a11y (${tree.length} els):\n${lines.join('\n')}${more}` };
      },
    },

    {
      name: 'list_windows',
      description: 'List visible top-level windows with title, process, and bounds. Useful when the active window is wrong or missing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute(_args, ctx) {
        const windows = await ctx.platform.listWindows();
        const active = await ctx.platform.getActiveWindow();
        const lines = windows.slice(0, 20).map(w => {
          const isActive = active && w.processId === active.processId && w.title === active.title;
          return `${isActive ? '→' : ' '} [${w.processName}] "${w.title}" pid=${w.processId} ${w.bounds.width}×${w.bounds.height}`;
        });
        const more = windows.length > 20 ? `\n… +${windows.length - 20} more windows` : '';
        return { success: true, text: `Windows (${windows.length}):\n${lines.join('\n')}${more}` };
      },
    },

    // ─── A11Y ACTIONS (preferred) ───────────────────────────────
    {
      name: 'invoke_element',
      description: 'Click/activate a UI element by its accessibility name. MORE RELIABLE than coord clicks — use this when the snapshot shows a named target.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Accessibility name of the element' },
          controlType: { type: 'string', description: 'Optional role filter (Button, MenuItem, Tab, etc.)' },
          processId: { type: 'number', description: 'Optional: limit to a specific process' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const controlType = typeof args.controlType === 'string' ? args.controlType : undefined;
        const processId = typeof args.processId === 'number' ? args.processId : undefined;
        const res = await ctx.platform.invokeElement({ name, controlType, processId, action: 'click' });
        await sleep(150);
        return {
          success: res.success,
          text: res.success ? `Invoked "${name}" via a11y.` : `a11y invoke "${name}" missed — element not found.`,
          targetLabel: name,
        };
      },
    },

    {
      name: 'set_field_value',
      description: 'Set an editable field\'s value directly via accessibility (more reliable than click+type for forms).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Accessibility name of the field' },
          value: { type: 'string' },
          processId: { type: 'number' },
        },
        required: ['name', 'value'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const value = String(args.value ?? '');
        const processId = typeof args.processId === 'number' ? args.processId : undefined;
        const res = await ctx.platform.invokeElement({ name, processId, action: 'set-value', value });
        await sleep(150);
        return {
          success: res.success,
          text: res.success ? `Set "${name}" = ${value.length} chars` : `Set "${name}" failed.`,
          targetLabel: name,
        };
      },
    },

    // ─── INPUT (mouse) ──────────────────────────────────────────
    {
      name: 'click',
      description: 'Click at logical-pixel (x,y). Use coords from the a11y snapshot. Falls back from invoke_element when an element has no a11y name.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'string', enum: ['left', 'right'] },
          count: { type: 'number', description: '1=single, 2=double' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const x = Number(args.x ?? 0);
        const y = Number(args.y ?? 0);
        const button = args.button === 'right' ? 'right' : 'left';
        const count = args.count === 2 ? 2 : 1;
        await ctx.platform.mouseClick(x, y, { button, count });
        await sleep(150);
        return { success: true, text: `Clicked ${button} x${count} at (${x},${y})` };
      },
    },

    {
      name: 'drag',
      description: 'Drag the mouse from (startX,startY) to (endX,endY). Used for selecting text, drawing, resizing.',
      inputSchema: {
        type: 'object',
        properties: {
          startX: { type: 'number' },
          startY: { type: 'number' },
          endX: { type: 'number' },
          endY: { type: 'number' },
        },
        required: ['startX', 'startY', 'endX', 'endY'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const sx = Number(args.startX ?? 0);
        const sy = Number(args.startY ?? 0);
        const ex = Number(args.endX ?? 0);
        const ey = Number(args.endY ?? 0);
        await ctx.platform.mouseDrag(sx, sy, ex, ey);
        await sleep(200);
        return { success: true, text: `Dragged (${sx},${sy})→(${ex},${ey})` };
      },
    },

    {
      name: 'scroll',
      description: 'Scroll at (x,y) in a direction. Omit x,y to scroll at the screen center.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'number', description: 'Wheel ticks (default 3)' },
        },
        required: ['direction'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const dir = args.direction === 'up' ? 'up' : 'down';
        const amount = typeof args.amount === 'number' ? args.amount : 3;
        let x = typeof args.x === 'number' ? args.x : Math.floor(ctx.screen.logicalWidth / 2);
        let y = typeof args.y === 'number' ? args.y : Math.floor(ctx.screen.logicalHeight / 2);
        await ctx.platform.mouseScroll(x, y, dir, amount);
        await sleep(150);
        return { success: true, text: `Scrolled ${dir} ${amount} at (${x},${y})` };
      },
    },

    // ─── INPUT (keyboard) ───────────────────────────────────────
    {
      name: 'type',
      description: 'Type text into the currently focused input. Prefer set_field_value when a field has an a11y name.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const text = String(args.text ?? '');
        await ctx.platform.typeText(text);
        await sleep(200);
        return { success: true, text: `Typed ${text.length} chars: "${truncate(text, 60)}"` };
      },
    },

    {
      name: 'key',
      description: 'Press a key combo. Use "mod" for Ctrl/Cmd. Examples: "mod+s", "Return", "Tab", "shift+Tab", "Escape", "F5".',
      inputSchema: {
        type: 'object',
        properties: { combo: { type: 'string' } },
        required: ['combo'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const combo = String(args.combo ?? '');
        await ctx.platform.keyPress(combo);
        await sleep(150);
        return { success: true, text: `Pressed ${combo}` };
      },
    },

    // ─── APPS & WINDOWS ─────────────────────────────────────────
    {
      name: 'open_app',
      description: 'Open an application by name (e.g. "Notepad", "TextEdit", "Safari").',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const name = String(args.name ?? '');
        const res = await ctx.platform.openApp(name);
        await sleep(800);
        return {
          success: true,
          text: res.title ? `Opened "${name}" (pid=${res.pid}, window="${res.title}")` : `Launched "${name}" (no window surfaced yet)`,
        };
      },
    },

    {
      name: 'focus_window',
      description: 'Bring a window to the foreground. Match by processName, pid, or title substring.',
      inputSchema: {
        type: 'object',
        properties: {
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      changesScreen: true,
      async execute(args, ctx) {
        const q: Record<string, string | number | undefined> = {};
        if (typeof args.processName === 'string') q.processName = args.processName;
        if (typeof args.processId === 'number') q.processId = args.processId;
        if (typeof args.title === 'string') q.title = args.title;
        const ok = await ctx.platform.focusWindow(q as any);
        await sleep(250);
        return { success: ok, text: ok ? 'Focused matching window.' : 'No matching window found.' };
      },
    },

    // ─── CLIPBOARD ─────────────────────────────────────────────
    {
      name: 'read_clipboard',
      description: 'Read the OS clipboard.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute(_args, ctx) {
        const text = await ctx.platform.readClipboard();
        return { success: true, text: `Clipboard (${text.length} chars):\n${truncate(text, 500)}` };
      },
    },

    {
      name: 'write_clipboard',
      description: 'Write text to the OS clipboard.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        const text = String(args.text ?? '');
        await ctx.platform.writeClipboard(text);
        return { success: true, text: `Wrote ${text.length} chars to clipboard.` };
      },
    },

    // ─── FLOW CONTROL ───────────────────────────────────────────
    {
      name: 'wait',
      description: 'Pause for N milliseconds (max 5000). Use after actions that trigger animations or page loads.',
      inputSchema: {
        type: 'object',
        properties: { ms: { type: 'number', maximum: 5000 } },
        required: ['ms'],
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args) {
        const ms = Math.min(5000, Math.max(0, Number(args.ms ?? 0)));
        await sleep(ms);
        return { success: true, text: `Waited ${ms}ms.` };
      },
    },

    // ─── VISION (hybrid + vision modes only) ────────────────────
    {
      name: 'screenshot',
      description: 'Take a screenshot to inspect pixels. Expensive — use only when a11y is insufficient (custom canvas, icon-only UI, verification after action).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      changesScreen: false,
      async execute(_args, ctx) {
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        ctx.screenshotsCaptured.n += 1;
        return {
          success: true,
          text: `Captured ${shot.width}×${shot.height}.`,
          screenshot: shot,
        };
      },
    },

    // ─── TERMINAL ACTIONS ──────────────────────────────────────
    {
      name: 'done',
      description: 'Declare the task complete. Provide SPECIFIC screen evidence.',
      inputSchema: {
        type: 'object',
        properties: { evidence: { type: 'string' } },
        required: ['evidence'],
        additionalProperties: false,
      },
      changesScreen: false,
      terminal: true,
      async execute(args) {
        const evidence = String(args.evidence ?? 'ok');
        return { success: true, text: `done: ${evidence}`, stop: true, terminalExit: 'done' };
      },
    },

    {
      name: 'give_up',
      description: 'Abandon the task when it\'s impossible from here (credentials missing, captcha, destructive action needs user confirm, stuck after retries).',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      },
      changesScreen: false,
      terminal: true,
      async execute(args) {
        const reason = String(args.reason ?? 'unknown');
        return { success: false, text: `give_up: ${reason}`, stop: true, terminalExit: 'give_up' };
      },
    },

    {
      name: 'cannot_read',
      description: 'Escalate from blind mode to vision — the a11y snapshot doesn\'t contain what you need. Only available in blind mode.',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      },
      changesScreen: false,
      terminal: true,
      async execute(args) {
        const reason = String(args.reason ?? 'a11y snapshot insufficient');
        return { success: false, text: `cannot_read: ${reason}`, stop: true, terminalExit: 'cannot_read' };
      },
    },
  ];

  // Strip screenshot from blind mode. Keep `cannot_read` — that's the
  // blind-only escape hatch.
  if (mode === 'blind') {
    return tools.filter(t => t.name !== 'screenshot');
  }
  // Remove cannot_read when vision is already available — there's nothing
  // to escalate to. Model can use give_up if stuck.
  return tools.filter(t => t.name !== 'cannot_read');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
