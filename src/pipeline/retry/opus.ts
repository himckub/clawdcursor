/**
 * Retry-tier-up — single-turn escalation when the verifier rejects a task.
 *
 * Model-agnostic despite the historical name "Opus retry": the retry model
 * comes from `AI_RETRY_MODEL` (defaults to `AI_VISION_MODEL`, which itself
 * defaults to whatever the PROVIDERS registry says is vision-capable for
 * the active provider). Anthropic Opus, OpenAI o1, Gemini 2.5 Pro, or a
 * custom OpenAI-compatible endpoint all work the same way.
 *
 * Default OFF in v0.8.1 — opt-in via `--retry` / `OPENCLAW_RETRY_USE_FALLBACK=1`.
 * Telemetry-gated flip to default-on after verifier-reject rate proves <5%.
 * See plan §4.4 + §19a.1.
 */

import type { PipelineAction, ActionResult, VerifierResult } from '../types';
import { extractJson } from '../decompose/llm-decomposer';
import { logger } from '../observability/logger';

export interface RetryDeps {
  /** LLM call with a stronger model — typically vision-capable so it can
   *  also look at a fresh screenshot if needed. */
  callStrongLlm: (args: { system: string; user: string; maxTokens?: number }) => Promise<string>;
}

export interface RetryInput {
  task: string;
  trace: Array<{ action: PipelineAction; result: ActionResult }>;
  verdict: VerifierResult;
}

export interface RetryResult {
  /** The one extra action the retry model suggests. Null = give up. */
  suggestedAction: PipelineAction | null;
  /** Model's explanation of what went wrong. */
  diagnosis: string;
  /** The raw response, kept for audit. */
  raw: string;
}

const RETRY_SYSTEM = `You are the ClawdCursor retry-tier agent. The primary agent attempted a task and the ground-truth verifier rejected the result. Your job is to diagnose what went wrong and propose ONE corrective action.

Emit JSON: {"diagnosis": "one-line diagnosis", "action": {<PipelineAction>} | null}

If you cannot recover, set action to null and explain in diagnosis.

The action vocabulary is the same as the primary agent — a11y_click, a11y_set_value, click, type, press, scroll, wait, run_playbook, done, give_up.`;

export async function retryOnce(input: RetryInput, deps: RetryDeps): Promise<RetryResult> {
  const digest = buildStepLogDigest(input.trace);
  const rejectSummary = [
    `Verifier rejected: confidence ${input.verdict.confidence.toFixed(2)}${input.verdict.rejectReason ? ` — ${input.verdict.rejectReason}` : ''}`,
    `Signals:`,
    ...Object.entries(input.verdict.signals).map(([name, s]) => `  ${name}: value=${JSON.stringify(s.value)} weight=${s.weight}`),
  ].join('\n');

  const user = `TASK: ${input.task}

STEP LOG:
${digest}

${rejectSummary}

What went wrong and what should I try next? Reply with JSON.`;

  let raw: string;
  try {
    raw = await deps.callStrongLlm({ system: RETRY_SYSTEM, user, maxTokens: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('retry.llm_failed', { error: msg });
    return { suggestedAction: null, diagnosis: `retry LLM failed: ${msg}`, raw: '' };
  }

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== 'object') {
    return { suggestedAction: null, diagnosis: 'unparseable retry response', raw };
  }
  const obj = parsed as Record<string, unknown>;
  const diagnosis = String(obj.diagnosis ?? 'no diagnosis');
  const actionValue = obj.action;
  if (!actionValue || typeof actionValue !== 'object') {
    return { suggestedAction: null, diagnosis, raw };
  }
  // We accept the raw action object and let the pipeline's dispatcher validate
  // it via parseAction — keep this module focused on the retry orchestration.
  return { suggestedAction: actionValue as PipelineAction, diagnosis, raw };
}

/** Compact one-line-per-step digest of the action trace. */
export function buildStepLogDigest(trace: Array<{ action: PipelineAction; result: ActionResult }>): string {
  return trace.map((s, i) => {
    const type = (s.action as any).type ?? 'unknown';
    const mark = s.result.success ? '✓' : '✗';
    const summary = s.result.text.slice(0, 100);
    return `  ${i + 1}. ${type} → ${mark} ${summary}`;
  }).join('\n');
}
