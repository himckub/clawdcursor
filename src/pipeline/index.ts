/**
 * Unified pipeline (v0.8.1).
 *
 * Entry point for all agent tasks. Composes:
 *
 *   preprocess → classify → router → (if miss) skill-cache → knowledge →
 *   sense (a11y snapshot) → text-agent (no screenshots) →
 *   (on cannot_read) vision-agent (fallback) → verifier → (optional) retry
 *
 * Model-agnostic: every layer that calls an LLM injects its client from
 * this class's deps. Providers registry + AI_* env vars decide which
 * model runs. Haiku isn't required; any text-capable OpenAI-compatible
 * model works for text-agent, any vision-capable one for the fallback.
 *
 * OS-agnostic: every action goes through PlatformAdapter. `if (process.platform)`
 * branches are forbidden in this file — plan §3.6.
 */

import {
  newCorrelationId,
  runWithCorrelation,
} from './observability/correlation';
import { CostMeter } from './observability/cost-meter';
import { logger } from './observability/logger';
import type {
  TaskResult as PipelineTaskResult,
  PipelineAction,
  ActionResult,
  Snapshot,
  AppGuide,
} from './types';
import type { PlatformAdapter } from '../v2/platform/types';

import { classifyTask } from './classify/classify';
import { Router } from './router/router';
import { resolveAlias } from './router/aliases';
import { SkillCache } from './skills/skill-cache';
import { loadGuide, getWorkflowForTask, detectApp } from './knowledge/loader';
import { captureSnapshot } from './sense/snapshot';
import { runTextAgent } from './text-agent/agent';
import { dispatchAction } from './dispatch';
import { matchPlaybook } from './playbooks/index';

// ─── Dependency injection contract ──────────────────────────────────

/**
 * LLM client injection. Pipeline does not know which provider is live;
 * it just hands prompts in and expects completions back. The three slots
 * correspond to the three layer roles:
 *   - text: text-agent inner loop (cheap)
 *   - decomposer: offline LLM fallback for decompose (cheap)
 *   - vision: vision-fallback loop (mid)
 *   - retry: verifier-reject single-turn retry (premium, opt-in)
 */
export interface PipelineLlm {
  text?:       (args: { system: string; user: string; maxTokens?: number }) => Promise<string>;
  decomposer?: (args: { system: string; user: string; maxTokens?: number }) => Promise<string>;
  vision?:     (args: { system: string; messages: any[]; maxTokens?: number }) => Promise<string>;
  retry?:      (args: { system: string; user: string; maxTokens?: number }) => Promise<string>;
}

export interface PipelineDeps {
  adapter: PlatformAdapter;
  llm: PipelineLlm;
  /** Default OFF per plan §4.4. */
  retry?: { useFallback: boolean; maxPerSession: number };
  /** A11y-only mode — refuses to hit the vision fallback. */
  disableVision?: boolean;
  /** Per-task iteration caps. */
  textAgentMaxIterations?: number;
}

export const PIPELINE_DEFAULTS: Required<Pick<PipelineDeps, 'retry' | 'disableVision' | 'textAgentMaxIterations'>> = {
  retry: { useFallback: false, maxPerSession: 5 },
  disableVision: false,
  textAgentMaxIterations: 12,
};

export interface PipelineRunInput {
  task: string;
  isAborted?: () => boolean;
}

// ─── Pipeline class ─────────────────────────────────────────────────

export class Pipeline {
  private router: Router;
  private skillCache: SkillCache;
  private retriesThisSession = 0;
  private readonly retry: { useFallback: boolean; maxPerSession: number };
  private readonly disableVision: boolean;
  private readonly textAgentMaxIterations: number;

  constructor(private readonly deps: PipelineDeps) {
    this.router = new Router(deps.adapter);
    this.skillCache = new SkillCache();
    this.retry = deps.retry ?? PIPELINE_DEFAULTS.retry;
    this.disableVision = deps.disableVision ?? PIPELINE_DEFAULTS.disableVision;
    this.textAgentMaxIterations = deps.textAgentMaxIterations ?? PIPELINE_DEFAULTS.textAgentMaxIterations;
  }

  /** Reset per-session counters. */
  resetSession(): void {
    this.retriesThisSession = 0;
  }

  async run(input: PipelineRunInput): Promise<PipelineTaskResult> {
    const correlationId = newCorrelationId();
    const startedAt = Date.now();
    const costMeter = new CostMeter();
    const log = logger.with({ correlationId, task: input.task });
    const isAborted = input.isAborted ?? (() => false);

    return runWithCorrelation({ correlationId, taskText: input.task }, async () => {
      log.info('pipeline.start');

      // ── 1. Classify ────────────────────────────────────────────
      const classification = classifyTask(input.task);
      log.debug('pipeline.classified', classification as any);

      // ── 2. Router ──────────────────────────────────────────────
      if (!isAborted()) {
        const routerResult = await this.router.route(input.task);
        if (routerResult.handled) {
          log.info('pipeline.router.handled', { path: routerResult.path });
          return this.buildResult({
            success: true,
            path: 'router',
            costMeter,
            startedAt,
            correlationId,
            text: routerResult.description ?? 'router handled',
            trace: [],
          });
        }
      }

      // ── 3. Skill cache ─────────────────────────────────────────
      const activeApp = await this.safeActiveAppName();
      if (!isAborted() && activeApp) {
        const hit = this.skillCache.find(input.task, activeApp);
        if (hit) {
          // Replay is left as a follow-up (complex with the full action
          // vocabulary). For v0.8.1-alpha.0 we log the hit and fall
          // through — still records for eventual auto-replay.
          log.info('pipeline.skill_cache.hit_fallthrough', { skill: hit.id, activeApp });
        }
      }

      // ── 4. Knowledge injection ─────────────────────────────────
      let guide: { promptFragment: string; appName: string } | undefined = undefined;
      try {
        const hint = await this.inferAppHint();
        if (hint) {
          const workflow = getWorkflowForTask(input.task, hint);
          if (workflow) {
            guide = { promptFragment: workflow.promptFragment, appName: workflow.guide.app };
            log.info('pipeline.knowledge.matched', { app: workflow.guide.app });
          } else {
            // Even without a workflow match, the guide file's shortcuts can be valuable.
            const g = loadGuide(detectApp(hint) ?? '');
            if (g) {
              const shortLine = g.shortcuts && Object.keys(g.shortcuts).length
                ? `APP: ${g.name} shortcuts: ${Object.entries(g.shortcuts).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(', ')}`
                : `APP: ${g.name}`;
              guide = { promptFragment: shortLine, appName: g.app };
            }
          }
        }
      } catch (err) {
        log.debug('pipeline.knowledge.error', { error: err instanceof Error ? err.message : String(err) });
      }

      // Classify-spatial → jump to vision-fallback (text-agent can't render canvas)
      const preferVisionFirst = classification.kind === 'spatial';

      // ── 5. Text agent (unless spatial/vision-disabled redirects) ────
      if (!preferVisionFirst && this.deps.llm.text) {
        const textResult = await runTextAgent(
          { task: input.task, guide, maxIterations: this.textAgentMaxIterations },
          {
            callTextLlm: async (args) => {
              const out = await this.deps.llm.text!(args);
              // Cost accounting — rough token estimate since the LLM client may
              // not always return usage. The real numbers arrive when the LLM
              // client surfaces usage in a follow-up.
              costMeter.record({
                model: 'text-agent',
                stage: 'text-agent',
                inputTokens: Math.ceil((args.system.length + args.user.length) / 4),
                outputTokens: Math.ceil(out.length / 4),
              });
              return out;
            },
            capture: async () => captureSnapshot(this.deps.adapter),
            dispatch: async (a) => this.dispatch(a),
            isAborted,
          },
        );

        log.info('pipeline.text_agent.exit', { exit: textResult.exit, actions: textResult.trace.length });

        if (textResult.exit === 'done') {
          // Record to skill cache for future replays.
          if (activeApp && textResult.trace.length > 0) {
            this.skillCache.record(
              input.task,
              activeApp,
              textResult.trace
                .map(t => this.traceToCachedStep(t.action))
                .filter((s): s is NonNullable<ReturnType<typeof this.traceToCachedStep>> => s !== null),
            );
          }
          return this.buildResult({
            success: true,
            path: 'text-agent',
            costMeter,
            startedAt,
            correlationId,
            text: textResult.text,
            trace: textResult.trace.map(t => ({ action: t.action, result: t.result, durationMs: 0 })),
          });
        }

        if (textResult.exit === 'give_up' || textResult.exit === 'aborted') {
          return this.buildResult({
            success: false,
            path: 'text-agent',
            costMeter,
            startedAt,
            correlationId,
            text: textResult.text,
            trace: textResult.trace.map(t => ({ action: t.action, result: t.result, durationMs: 0 })),
          });
        }

        // cannot_read OR max_iterations → escalate to vision-fallback.
      }

      // ── 6. Vision fallback (opt-in, default ON) ────────────────
      if (this.disableVision) {
        return this.buildResult({
          success: false,
          path: 'text-agent',
          costMeter,
          startedAt,
          correlationId,
          text: 'text-agent could not resolve task and --no-vision is set',
          trace: [],
        });
      }

      if (!this.deps.llm.vision) {
        // Haiku-unavailable-style fallback: no vision model configured. Explicit
        // structured error per plan §19a (graceful degradation).
        return this.buildResult({
          success: false,
          path: 'vision-agent',
          costMeter,
          startedAt,
          correlationId,
          text: 'No vision model configured. Run `clawdcursor doctor` to set AI_VISION_MODEL (any vision-capable OpenAI-compatible endpoint).',
          trace: [],
        });
      }

      // Phase 4 wiring note: actual vision-agent loop reuses the copied
      // pipeline/vision-agent/agent.ts module. That module's run() signature
      // differs from ours — it wants a full PipelineConfig. For the smoke
      // test of v0.8.1-alpha.0 we return a structured "vision fallback not
      // wired" message so the caller can see exactly where the pipeline
      // stopped. Full vision wiring lands in the next commit.
      log.info('pipeline.vision_fallback.not_wired');
      return this.buildResult({
        success: false,
        path: 'vision-agent',
        costMeter,
        startedAt,
        correlationId,
        text: 'text-agent could not resolve; vision-fallback wiring is landing in a follow-up commit.',
        trace: [],
      });
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private async dispatch(action: PipelineAction): Promise<ActionResult> {
    return dispatchAction(action, { adapter: this.deps.adapter });
  }

  /** Best-effort active-app name for skill-cache keying. */
  private async safeActiveAppName(): Promise<string | null> {
    try {
      const w = await this.deps.adapter.getActiveWindow();
      return w?.processName ?? null;
    } catch {
      return null;
    }
  }

  /** Best-effort hint for knowledge lookup — active window title. */
  private async inferAppHint(): Promise<string | null> {
    try {
      const w = await this.deps.adapter.getActiveWindow();
      return w?.title ?? w?.processName ?? null;
    } catch {
      return null;
    }
  }

  /** Map a PipelineAction to a CachedStep shape for the skill cache.
   *  Some actions don't cache meaningfully (screenshot, wait); return null. */
  private traceToCachedStep(action: PipelineAction): any | null {
    switch (action.type) {
      case 'a11y_click':     return { type: 'click', description: `a11y click "${action.target}"`, producedBy: 'pipeline.text-agent' };
      case 'a11y_set_value': return { type: 'type',  description: `a11y set "${action.target}"`, text: action.value, producedBy: 'pipeline.text-agent' };
      case 'click':          return { type: 'click', description: `click @${action.x},${action.y}`, x: action.x, y: action.y, producedBy: 'pipeline.text-agent' };
      case 'type':           return { type: 'type',  description: `type`, text: action.text, producedBy: 'pipeline.text-agent' };
      case 'press':          return { type: 'key',   description: `press ${action.combo}`, key: action.combo, producedBy: 'pipeline.text-agent' };
      case 'scroll':         return { type: 'scroll', description: `scroll ${action.dir}`, direction: action.dir, amount: action.amount, producedBy: 'pipeline.text-agent' };
      case 'wait':           return { type: 'wait',  description: `wait ${action.ms}ms`, ms: action.ms, producedBy: 'pipeline.text-agent' };
      default:               return null;
    }
  }

  private buildResult(args: {
    success: boolean;
    path: PipelineTaskResult['path'];
    costMeter: CostMeter;
    startedAt: number;
    correlationId: string;
    text: string;
    trace: PipelineTaskResult['trace'];
  }): PipelineTaskResult {
    const cost = args.costMeter.snapshot();
    return {
      success: args.success,
      path: args.path,
      costUsd: cost.totalUsd,
      durationMs: Date.now() - args.startedAt,
      correlationId: args.correlationId,
      trace: args.trace,
      text: args.text,
    };
  }
}

export type { TaskResult } from './types';
