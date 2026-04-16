/**
 * Pipeline V2 — the simplified orchestrator.
 *
 *   ┌──────────┐    ┌──────────────┐    ┌──────────┐
 *   │  ROUTER  │ ─▶ │ VISION AGENT │ ─▶ │ VERIFIER │
 *   │  (regex) │    │  (one loop)  │    │ (ground  │
 *   │  fast    │    │  vision-first│    │  truth)  │
 *   └──────────┘    └──────────────┘    └──────────┘
 *
 * 3 layers, not 7. Each has ONE job. The verifier is independent of the
 * agent — it can't be fooled by the agent's self-reported "done".
 */

import type { PipelineConfig } from '../providers';
import { OcrEngine } from '../ocr-engine';
import { getPlatform } from './platform';
import { GroundTruthVerifier } from './verifier/ground-truth';
import type { StateSnapshot, VerifyResult } from './verifier/types';
import { VisionAgentImpl } from './agent/vision-agent';
import type { AgentRunResult } from './agent/types';

export interface PipelineRunOptions {
  task: string;
  isAborted?: () => boolean;
  /** Skip the regex router and go straight to the agent. */
  skipRouter?: boolean;
  /** Skip the verifier (use the agent's self-report). For debugging only. */
  skipVerifier?: boolean;
}

export interface PipelineRunResult {
  success: boolean;
  /** Where the task was completed (router shortcut, agent, or failed). */
  layer: 'router' | 'agent' | 'failed';
  reason: string;
  durationMs: number;
  /** Agent steps if the agent ran. */
  agentSteps?: AgentRunResult['steps'];
  /** Verifier verdict if it ran. */
  verifyResult?: VerifyResult;
}

export class PipelineV2 {
  private agent: VisionAgentImpl;
  private verifier: GroundTruthVerifier | null = null;
  private ocr: OcrEngine;

  constructor(private config: PipelineConfig) {
    this.agent = new VisionAgentImpl(config);
    this.ocr = new OcrEngine();
  }

  async run(opts: PipelineRunOptions): Promise<PipelineRunResult> {
    const startedAt = Date.now();
    const platform = await getPlatform();
    if (!this.verifier) this.verifier = new GroundTruthVerifier(platform);

    // ─── ROUTER ─────────────────────────────────────────────
    if (!opts.skipRouter) {
      const routed = await this.tryRouter(opts.task);
      if (routed.handled) {
        return {
          success: routed.success,
          layer: 'router',
          reason: routed.reason,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    // ─── AGENT ──────────────────────────────────────────────
    // Capture state BEFORE for the verifier.
    const before = opts.skipVerifier ? null : await this.captureState();

    const agentResult = await this.agent.run({
      task: opts.task,
      isAborted: opts.isAborted,
    });

    if (opts.skipVerifier) {
      return {
        success: agentResult.success,
        layer: 'agent',
        reason: agentResult.reason,
        durationMs: Date.now() - startedAt,
        agentSteps: agentResult.steps,
      };
    }

    // ─── VERIFIER ───────────────────────────────────────────
    // Independent ground truth check. Even if the agent said "done", verifier decides.
    const after = await this.captureState();
    const verifyResult = await this.verifier!.verify({
      task: opts.task,
      before: before!,
      after,
    });

    // Final verdict: agent said success AND verifier confirms.
    // If agent failed, verifier doesn't override that.
    const finalSuccess = agentResult.success && verifyResult.pass;
    const reason = agentResult.success
      ? (verifyResult.pass ? `${agentResult.reason} | verified: ${verifyResult.reason}` : `Agent claimed done, verifier rejected: ${verifyResult.reason}`)
      : agentResult.reason;

    return {
      success: finalSuccess,
      layer: 'agent',
      reason,
      durationMs: Date.now() - startedAt,
      agentSteps: agentResult.steps,
      verifyResult,
    };
  }

  // ─── ROUTER ──────────────────────────────────────────────
  // Minimal regex router for trivial tasks. NOT a full layer — just shortcuts.

  private async tryRouter(task: string): Promise<{ handled: boolean; success: boolean; reason: string }> {
    const t = task.trim().toLowerCase();
    const platform = await getPlatform();

    // "open <app>" — single-app launch with no further action.
    // Strict: only short app names, no "and", no commas, no compound verbs.
    const openMatch = t.match(/^open\s+(?:the\s+)?([a-z][a-z0-9 .-]{0,30}?)(?:\s+app)?$/);
    const isCompound = /,|\b(and|then|but|with)\b/.test(t);
    if (openMatch && !isCompound) {
      const appName = openMatch[1].trim();
      // Reject if it looks like a sentence (multiple words with verbs).
      if (/\b(type|click|press|send|search|navigate|go|find|create|delete|fill)\b/.test(appName)) {
        // Not actually a simple app launch — let the agent handle it.
      } else {
        const result = await platform.openApp(appName);
        return {
          handled: true,
          success: !!result.title || !!result.pid,
          reason: result.title ? `Router: opened "${appName}" → ${result.title}` : `Router: launched "${appName}"`,
        };
      }
    }

    // "take a screenshot" / "screenshot the screen"
    if (/^(take\s+a\s+)?screenshot(\s+(?:of\s+)?(?:the\s+)?screen)?$/.test(t)) {
      await platform.screenshot();
      return { handled: true, success: true, reason: 'Router: screenshot taken' };
    }

    // Not a routable shortcut.
    return { handled: false, success: false, reason: '' };
  }

  // ─── STATE CAPTURE ───────────────────────────────────────

  private async captureState(): Promise<StateSnapshot> {
    // Run OCR in parallel with the verifier's state capture.
    // The OCR text is used for task assertions and anti-pattern detection.
    let ocrText = '';
    try {
      const ocrResult = await this.ocr.recognizeScreen();
      ocrText = ocrResult.elements.map(el => el.text).join(' ');
    } catch { /* OCR may not be available — verifier will adapt */ }
    return this.verifier!.captureState(ocrText);
  }
}
