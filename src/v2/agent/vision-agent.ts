/**
 * VisionAgent — single-loop, vision-first, tool-using agent.
 *
 * Architecture:
 *   loop:
 *     1. Capture screenshot
 *     2. Send to vision LLM with: task, tool catalog, history, current screenshot
 *     3. LLM picks ONE tool call (parsed from JSON)
 *     4. Execute tool (which produces a new screenshot)
 *     5. Append result to history
 *     6. If tool was "done" or "give_up" → stop
 *
 * No 36-rule prompt. No 7 layers. Just a model with eyes and tools.
 *
 * Model-agnostic: uses callVisionLLM from llm-client.ts which works with
 * Anthropic, OpenAI, OpenRouter, etc.
 */

import type { PipelineConfig } from '../../providers';
import { callVisionLLM, type VisionContentBlock } from '../../llm-client';
import { getPlatform } from '../platform';
import type {
  AgentContext,
  AgentRunOptions,
  AgentRunResult,
  AgentStep,
  AgentTool,
  ToolResult,
  VisionAgent,
} from './types';
import { buildTools } from './tools';

// Compact system prompt — 6 rules, not 36.
const SYSTEM_PROMPT = `You are ClawdCursor, a desktop automation agent. You see screenshots of the user's screen and call tools to operate the computer.

You have these tools (one call per turn): screenshot, read_screen, list_windows, click, drag, scroll, type, key, invoke_element, set_field_value, open_app, focus_window, read_clipboard, write_clipboard, wait, done, give_up.

OPERATING PRINCIPLES:
1. LOOK FIRST. Examine the screenshot before acting. The image shows the actual screen. Coordinates are in image pixels.
2. PREFER NAMED ACCESS. invoke_element and set_field_value work via accessibility (element name) and are more reliable than coordinate clicks. Use read_screen to find names, then invoke_element to click.
3. KEYBOARD > MOUSE. Use key shortcuts ("mod+s", "Tab", "Return") when the app supports them — they're faster and more reliable than clicking.
4. ONE STEP AT A TIME. Pick the single next action. The next screenshot will show the result; you don't need to plan everything upfront.
5. VERIFY BEFORE DECLARING DONE. Look at the screenshot. Is the task ACTUALLY complete? If the email compose window is still open, the email isn't sent. If text isn't visible, it wasn't typed. Only call "done" when you can SEE proof.
6. IF STUCK, TRY DIFFERENT. If a click doesn't work, try a keyboard shortcut. If the keyboard shortcut doesn't work, try clicking via accessibility. If nothing works after several attempts, call give_up with a reason.

RESPONSE FORMAT: Reply with strict JSON describing one tool call:
  {"thought": "brief reasoning", "tool": "click", "args": {"x": 100, "y": 200}}

Examples:
  {"thought": "Calculator is open. I'll press 5 then * then 7 then = via keyboard.", "tool": "key", "args": {"combo": "5"}}
  {"thought": "I can see Send button at the top of compose.", "tool": "click", "args": {"x": 320, "y": 80}}
  {"thought": "Text field is named 'Subject'. Setting it directly is most reliable.", "tool": "set_field_value", "args": {"name": "Subject", "value": "Hello"}}
  {"thought": "Email is sent — I see the inbox view and compose window is gone.", "tool": "done", "args": {"evidence": "Inbox visible, no compose window"}}

The current platform is ${process.platform}. Use "mod" instead of cmd/ctrl in key combos — it auto-resolves.`;

const MAX_ITERATIONS = 30;
const MAX_HISTORY_SCREENSHOTS = 3; // keep only the N most recent screenshots in context

export class VisionAgentImpl implements VisionAgent {
  private tools: Map<string, AgentTool>;

  constructor(private config: PipelineConfig) {
    this.tools = buildTools();
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const platform = await getPlatform();
    const isAborted = opts.isAborted ?? (() => false);
    const maxIter = opts.maxIterations ?? MAX_ITERATIONS;

    const ctx: AgentContext = { platform, task: opts.task, startedAt, isAborted };

    // Build the tool catalog string for the prompt.
    const toolCatalog = this.buildToolCatalog();

    // Initial screenshot.
    const initialShot = await platform.screenshot({ maxWidth: 1280 });

    // Conversation history.
    type Turn = { role: 'user' | 'assistant'; content: string | VisionContentBlock[] };
    const history: Turn[] = [];

    // First user message: task + initial screenshot + tool catalog.
    history.push({
      role: 'user',
      content: [
        { type: 'text', text: `TASK: ${opts.task}\n\nAVAILABLE TOOLS:\n${toolCatalog}\n\nCURRENT SCREEN:` },
        bufferToImage(initialShot.buffer),
      ],
    });

    const steps: AgentStep[] = [];

    for (let iter = 1; iter <= maxIter; iter++) {
      if (isAborted()) {
        return this.result(false, steps, 'aborted by user', startedAt);
      }

      // Trim screenshots from old turns to save tokens.
      const trimmedHistory = this.trimScreenshots(history, MAX_HISTORY_SCREENSHOTS);

      // Call the vision LLM.
      let llmResponse: string;
      const llmStart = Date.now();
      try {
        llmResponse = await callVisionLLM(this.config, {
          system: SYSTEM_PROMPT,
          messages: trimmedHistory.map(t => ({ role: t.role, content: t.content })),
          maxTokens: 1024,
          forceJson: true,
          timeoutMs: 30_000,
          retries: 1,
        });
      } catch (err: any) {
        steps.push({
          iteration: iter,
          toolName: 'llm_error',
          toolArgs: {},
          toolResult: { success: false, text: err.message },
          durationMs: Date.now() - llmStart,
        });
        return this.result(false, steps, `LLM call failed: ${err.message}`, startedAt);
      }

      // Parse the tool call.
      const parsed = this.parseToolCall(llmResponse);
      if (!parsed) {
        // Bad JSON — give the model one more chance with a hint.
        history.push({ role: 'assistant', content: llmResponse });
        history.push({ role: 'user', content: 'Your previous response was not valid JSON. Please reply with strict JSON: {"thought": "...", "tool": "...", "args": {...}}' });
        steps.push({
          iteration: iter,
          toolName: 'parse_error',
          toolArgs: {},
          toolResult: { success: false, text: llmResponse.slice(0, 200) },
          durationMs: Date.now() - llmStart,
        });
        continue;
      }

      const tool = this.tools.get(parsed.tool);
      if (!tool) {
        history.push({ role: 'assistant', content: llmResponse });
        history.push({ role: 'user', content: `Unknown tool "${parsed.tool}". Available: ${[...this.tools.keys()].join(', ')}` });
        steps.push({
          iteration: iter,
          toolName: parsed.tool,
          toolArgs: parsed.args,
          toolResult: { success: false, text: 'unknown tool' },
          thinking: parsed.thought,
          durationMs: Date.now() - llmStart,
        });
        continue;
      }

      // Execute the tool.
      const toolStart = Date.now();
      let result: ToolResult;
      try {
        result = await tool.execute(parsed.args, ctx);
      } catch (err: any) {
        result = { success: false, text: `Tool failed: ${err.message}` };
      }

      const stepDuration = Date.now() - toolStart;
      steps.push({
        iteration: iter,
        toolName: parsed.tool,
        toolArgs: parsed.args,
        toolResult: { success: result.success, text: result.text },
        thinking: parsed.thought,
        durationMs: stepDuration,
      });

      // Append assistant turn (just the JSON response).
      history.push({ role: 'assistant', content: llmResponse });

      // Append tool result + new screenshot if any.
      const userContent: VisionContentBlock[] = [
        { type: 'text', text: `Tool result: ${result.success ? '✓' : '✗'} ${result.text}\n\nCURRENT SCREEN:` },
      ];
      if (result.screenshot) {
        userContent.push(bufferToImage(result.screenshot.buffer));
      } else {
        // No fresh screenshot — capture one anyway so the model has updated context.
        const shot = await platform.screenshot({ maxWidth: 1280 });
        userContent.push(bufferToImage(shot.buffer));
      }
      history.push({ role: 'user', content: userContent });

      // If the tool said stop, exit the loop.
      if (result.stop) {
        return this.result(result.success, steps, result.text, startedAt);
      }
    }

    return this.result(false, steps, `Max iterations (${maxIter}) reached without completion`, startedAt);
  }

  // ─── HELPERS ──────────────────────────────────────────────────────

  private buildToolCatalog(): string {
    return [...this.tools.values()].map(t => {
      const params = Object.keys((t.inputSchema as any).properties ?? {}).join(', ') || '(none)';
      return `  ${t.name}(${params}) — ${t.description}`;
    }).join('\n');
  }

  private parseToolCall(response: string): { thought?: string; tool: string; args: any } | null {
    // Strip markdown code fences.
    let text = response.replace(/```json\s*|```\s*$/g, '').trim();

    // Try: direct parse.
    let obj = this.tryParse(text);
    if (!obj) {
      // Try: extract first {...} by matching balanced braces.
      const extracted = this.extractBalancedJson(text);
      if (extracted) obj = this.tryParse(extracted);
    }
    if (!obj) {
      // Try: greedy regex then progressively trim trailing chars.
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        let candidate = match[0];
        for (let i = 0; i < 5 && candidate.length > 10; i++) {
          obj = this.tryParse(candidate);
          if (obj) break;
          candidate = candidate.replace(/[},\s]+$/, '').replace(/\}$/, '') + '}';
        }
      }
    }

    if (!obj || typeof obj.tool !== 'string') return null;
    return { thought: obj.thought, tool: obj.tool, args: obj.args ?? {} };
  }

  private tryParse(s: string): any | null {
    try { return JSON.parse(s); } catch { return null; }
  }

  /** Extract the first balanced JSON object from a string. */
  private extractBalancedJson(s: string): string | null {
    const start = s.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') inString = !inString;
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;
  }

  private trimScreenshots(history: Array<{ role: string; content: any }>, keepLast: number): Array<{ role: string; content: any }> {
    // Find which user turns contain images.
    const imageIndices: number[] = [];
    history.forEach((turn, i) => {
      if (Array.isArray(turn.content) && turn.content.some((b: any) => b.type === 'image' || b.type === 'image_url')) {
        imageIndices.push(i);
      }
    });

    if (imageIndices.length <= keepLast) return history;

    const dropIndices = new Set(imageIndices.slice(0, imageIndices.length - keepLast));
    return history.map((turn, i) => {
      if (!dropIndices.has(i)) return turn;
      // Strip images from this turn, leaving only text.
      if (Array.isArray(turn.content)) {
        const textOnly = turn.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        return { ...turn, content: textOnly + '\n[earlier screenshot omitted]' };
      }
      return turn;
    });
  }

  private result(success: boolean, steps: AgentStep[], reason: string, startedAt: number): AgentRunResult {
    return { success, steps, reason, durationMs: Date.now() - startedAt };
  }
}

/** Wrap a PNG buffer as a vision content block. */
function bufferToImage(buf: Buffer): VisionContentBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') },
  };
}
