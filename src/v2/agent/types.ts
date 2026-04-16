/**
 * VisionAgent — a single, simple, vision-first reasoning loop.
 *
 * Replaces the 7-layer pipeline (preprocess → router → OCR reasoner → vision)
 * with ONE loop that has full context, full toolkit, and uses the vision model
 * to actually look at the screen instead of inferring from text.
 *
 * Architecture: the same as MCP, but internal. The agent "is" the host that
 * would normally drive the MCP tool server.
 */

import type { PlatformAdapter, ScreenshotResult } from '../platform/types';

export interface AgentTool {
  /** Tool name as seen by the LLM. */
  name: string;
  /** Human-readable description for the LLM. */
  description: string;
  /** JSON schema for input parameters. */
  inputSchema: Record<string, unknown>;
  /** Execute the tool. Returns a textual result for the LLM. */
  execute(args: any, ctx: AgentContext): Promise<ToolResult>;
}

export interface ToolResult {
  /** Text response visible to the LLM. */
  text: string;
  /** Optional new screenshot to include in the next turn (e.g. after click). */
  screenshot?: ScreenshotResult;
  /** Was the tool call successful? */
  success: boolean;
  /** If true, the agent should stop the loop (e.g. "done" tool). */
  stop?: boolean;
}

export interface AgentContext {
  platform: PlatformAdapter;
  task: string;
  startedAt: number;
  /** Cancellation token. */
  isAborted(): boolean;
}

export interface AgentRunOptions {
  task: string;
  /** Cancellation function. */
  isAborted?: () => boolean;
  /** Max iterations of the agent loop. Default 30. */
  maxIterations?: number;
  /** If true, fall back to text-only reasoning when vision unavailable. */
  allowTextFallback?: boolean;
}

export interface AgentRunResult {
  success: boolean;
  steps: AgentStep[];
  reason: string;
  durationMs: number;
}

export interface AgentStep {
  iteration: number;
  toolName: string;
  toolArgs: any;
  toolResult: { success: boolean; text: string };
  thinking?: string;
  durationMs: number;
}

export interface VisionAgent {
  run(opts: AgentRunOptions): Promise<AgentRunResult>;
}
