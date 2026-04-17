/**
 * Agent tools — what the VisionAgent can do at each step.
 *
 * These are deliberately small and explicit. The LLM picks one tool per turn,
 * the tool runs, the result (and a fresh screenshot) goes back to the LLM.
 *
 * Notes:
 *   - Coordinates are in IMAGE space (the resized screenshot the LLM sees).
 *     We convert back to logical screen pixels using scaleFactor.
 *   - Tools are platform-agnostic — they delegate to PlatformAdapter.
 */

import type { AgentContext, AgentTool, ToolResult } from './types';

/**
 * Build the tool registry. Stored as a Map for fast lookup.
 * Returns the same set of tools regardless of platform.
 */
export function buildTools(): Map<string, AgentTool> {
  const tools: AgentTool[] = [
    // ─── PERCEPTION ─────────────────────────────────────────────
    {
      name: 'screenshot',
      description: 'Take a fresh screenshot. Use sparingly — every tool result already includes a fresh screenshot. Useful to refresh after a wait.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        return {
          text: `Screenshot taken (${shot.width}x${shot.height}).`,
          screenshot: shot,
          success: true,
        };
      },
    },

    {
      name: 'read_screen',
      description: 'Read the accessibility tree of the focused window as structured text. Returns element names, types, and bounds. Use this to find clickable buttons by name.',
      inputSchema: {
        type: 'object',
        properties: {
          processId: { type: 'number', description: 'Optional: focus on a specific process' },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const tree = await ctx.platform.getUiTree(args.processId);
        if (tree.length === 0) {
          return { text: 'No accessibility elements found (app may not expose a11y or focused window changed).', success: true };
        }
        const lines = tree.slice(0, 80).map(el =>
          `[${el.controlType || 'Element'}] "${el.name || ''}" @${el.bounds.x},${el.bounds.y} ${el.bounds.width}x${el.bounds.height}${el.value ? ` value="${el.value.slice(0, 40)}"` : ''}${el.focused ? ' [FOCUSED]' : ''}`,
        );
        const more = tree.length > 80 ? `\n... +${tree.length - 80} more elements` : '';
        return { text: `Window UI tree (${tree.length} elements):\n${lines.join('\n')}${more}`, success: true };
      },
    },

    {
      name: 'list_windows',
      description: 'List all visible windows with title, process, and bounds. Use this to find the target app or check if a window opened/closed.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        const windows = await ctx.platform.listWindows();
        const active = await ctx.platform.getActiveWindow();
        const lines = windows.map(w => {
          const isActive = active && w.processId === active.processId && w.title === active.title;
          return `${isActive ? '→ ' : '  '}[${w.processName}] "${w.title}" pid=${w.processId} ${w.bounds.width}x${w.bounds.height}`;
        });
        return { text: `Windows (${windows.length}):\n${lines.join('\n')}`, success: true };
      },
    },

    // ─── INPUT (mouse) ───────────────────────────────────────────
    {
      name: 'click',
      description: 'Click at image-space coordinates. Use the (x,y) you see in the screenshot or accessibility tree.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X in image-space pixels' },
          y: { type: 'number', description: 'Y in image-space pixels' },
          button: { type: 'string', enum: ['left', 'right'], description: 'Default: left' },
          double: { type: 'boolean', description: 'Double-click. Default: false' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { logical, image } = await getCoordsForLogical(ctx, args.x, args.y);
        await ctx.platform.mouseClick(logical.x, logical.y, {
          button: args.button === 'right' ? 'right' : 'left',
          count: args.double ? 2 : 1,
        });
        await sleep(150);
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        return {
          text: `Clicked at image (${image.x},${image.y}) → screen (${logical.x},${logical.y}).`,
          screenshot: shot,
          success: true,
        };
      },
    },

    {
      name: 'drag',
      description: 'Drag from one point to another in image-space coordinates. Useful for selecting text, moving objects, drawing.',
      inputSchema: {
        type: 'object',
        properties: {
          startX: { type: 'number' }, startY: { type: 'number' },
          endX: { type: 'number' }, endY: { type: 'number' },
        },
        required: ['startX', 'startY', 'endX', 'endY'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const start = await getCoordsForLogical(ctx, args.startX, args.startY);
        const end = await getCoordsForLogical(ctx, args.endX, args.endY);
        await ctx.platform.mouseDrag(start.logical.x, start.logical.y, end.logical.x, end.logical.y);
        await sleep(200);
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        return {
          text: `Dragged from (${args.startX},${args.startY}) to (${args.endX},${args.endY}).`,
          screenshot: shot,
          success: true,
        };
      },
    },

    {
      name: 'scroll',
      description: 'Scroll up or down at given image-space coordinates.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' }, y: { type: 'number' },
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'number', description: 'Wheel ticks (default 3)' },
        },
        required: ['x', 'y', 'direction'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const { logical } = await getCoordsForLogical(ctx, args.x, args.y);
        await ctx.platform.mouseScroll(logical.x, logical.y, args.direction, args.amount ?? 3);
        await sleep(200);
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        return { text: `Scrolled ${args.direction} ${args.amount ?? 3} ticks.`, screenshot: shot, success: true };
      },
    },

    // ─── INPUT (keyboard) ────────────────────────────────────────
    {
      name: 'type',
      description: 'Type text into the currently focused input.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        await ctx.platform.typeText(args.text);
        await sleep(200);
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        return {
          text: `Typed ${args.text.length} chars: "${args.text.slice(0, 60)}${args.text.length > 60 ? '…' : ''}"`,
          screenshot: shot,
          success: true,
        };
      },
    },

    {
      name: 'key',
      description: 'Press a keyboard key or combo. Use "mod" for Cmd on macOS / Ctrl on Windows/Linux. Examples: "mod+s", "Return", "Tab", "shift+Tab", "Escape", "F5".',
      inputSchema: {
        type: 'object',
        properties: { combo: { type: 'string' } },
        required: ['combo'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        await ctx.platform.keyPress(args.combo);
        await sleep(150);
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        return { text: `Pressed: ${args.combo}`, screenshot: shot, success: true };
      },
    },

    // ─── A11Y SHORTCUTS (more reliable than coord clicks) ────────
    {
      name: 'invoke_element',
      description: 'Click a UI element by its accessibility name (more reliable than coordinate clicks). Use after read_screen finds the element name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Element name from the a11y tree' },
          controlType: { type: 'string', description: 'Optional: filter by control type (Button, Menu, etc.)' },
          processId: { type: 'number', description: 'Optional: limit to a specific process' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const result = await ctx.platform.invokeElement({
          name: args.name,
          controlType: args.controlType,
          processId: args.processId,
          action: 'click',
        });
        await sleep(200);
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        return {
          text: result.success ? `Invoked "${args.name}" via accessibility.` : `Failed to invoke "${args.name}" (element not found).`,
          screenshot: shot,
          success: result.success,
        };
      },
    },

    {
      name: 'set_field_value',
      description: 'Set the value of a text field directly via accessibility (more reliable than click+type for forms).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Field name from the a11y tree' },
          value: { type: 'string' },
          processId: { type: 'number' },
        },
        required: ['name', 'value'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const result = await ctx.platform.invokeElement({
          name: args.name,
          processId: args.processId,
          action: 'set-value',
          value: args.value,
        });
        await sleep(200);
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        return {
          text: result.success ? `Set "${args.name}" = "${args.value.slice(0, 40)}"` : `Failed to set "${args.name}"`,
          screenshot: shot,
          success: result.success,
        };
      },
    },

    // ─── APPS & WINDOWS ──────────────────────────────────────────
    {
      name: 'open_app',
      description: 'Open an application by name (e.g. "Safari", "TextEdit", "Calculator").',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const result = await ctx.platform.openApp(args.name);
        await sleep(800);
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        return {
          text: result.title ? `Opened ${args.name} (pid ${result.pid}, "${result.title}")` : `Launched ${args.name} (no window detected yet).`,
          screenshot: shot,
          success: true,
        };
      },
    },

    {
      name: 'focus_window',
      description: 'Bring a window to the foreground.',
      inputSchema: {
        type: 'object',
        properties: {
          processName: { type: 'string' },
          processId: { type: 'number' },
          title: { type: 'string', description: 'Title substring' },
        },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const ok = await ctx.platform.focusWindow(args);
        await sleep(300);
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        return { text: ok ? `Focused window.` : `No matching window found.`, screenshot: shot, success: ok };
      },
    },

    // ─── CLIPBOARD ───────────────────────────────────────────────
    {
      name: 'read_clipboard',
      description: 'Read the OS clipboard contents.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        const text = await ctx.platform.readClipboard();
        return { text: `Clipboard (${text.length} chars):\n${text.slice(0, 500)}`, success: true };
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
      async execute(args, ctx) {
        await ctx.platform.writeClipboard(args.text);
        return { text: `Wrote ${args.text.length} chars to clipboard.`, success: true };
      },
    },

    // ─── FLOW CONTROL ────────────────────────────────────────────
    {
      name: 'wait',
      description: 'Pause for a given number of milliseconds (e.g. waiting for an animation or page load).',
      inputSchema: {
        type: 'object',
        properties: { ms: { type: 'number', maximum: 10000 } },
        required: ['ms'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        await sleep(Math.min(args.ms, 10000));
        const shot = await ctx.platform.screenshot({ maxWidth: 1280 });
        return { text: `Waited ${args.ms}ms.`, screenshot: shot, success: true };
      },
    },

    {
      name: 'done',
      description: 'Declare the task complete with evidence. Only call this when you can SEE on screen that the task succeeded. The verifier will independently check.',
      inputSchema: {
        type: 'object',
        properties: { evidence: { type: 'string', description: 'What you see on screen that confirms completion' } },
        required: ['evidence'],
        additionalProperties: false,
      },
      async execute(args) {
        return { text: `Done declared: ${args.evidence}`, success: true, stop: true };
      },
    },

    {
      name: 'give_up',
      description: 'Declare the task impossible to complete (e.g. requires credentials, blocked by captcha). Use only after exhausting other options.',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      },
      async execute(args) {
        return { text: `Gave up: ${args.reason}`, success: false, stop: true };
      },
    },
  ];

  return new Map(tools.map(t => [t.name, t]));
}

// ─── HELPERS ──────────────────────────────────────────────────────

interface CoordResult { logical: { x: number; y: number }; image: { x: number; y: number } }

/**
 * Convert image-space coordinates (what the LLM sees in the resized screenshot)
 * to LOGICAL screen pixels (what the mouse API expects).
 *
 * Image is at most 1280px wide. If the screen is wider, we scaled by
 * physicalWidth/1280. But mouse coords are in LOGICAL pixels which equal
 * physicalWidth/dpiRatio. So:
 *    logical = image * (logicalWidth / imageWidth)
 *            = image * (logicalWidth / 1280) when image is 1280 wide
 */
async function getCoordsForLogical(ctx: AgentContext, imageX: number, imageY: number): Promise<CoordResult> {
  const screen = await ctx.platform.getScreenSize();
  // Approximate the image width that the LLM saw. We always request maxWidth=1280.
  const imageWidth = Math.min(1280, screen.physicalWidth);
  const ratio = screen.logicalWidth / imageWidth;
  return {
    image: { x: imageX, y: imageY },
    logical: { x: Math.round(imageX * ratio), y: Math.round(imageY * ratio) },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
