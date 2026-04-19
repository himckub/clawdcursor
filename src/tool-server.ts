/**
 * HTTP Tool Server — REST API for any AI model to discover and execute tools.
 *
 * Endpoints:
 *   GET  /tools           — Tool schemas (OpenAI function-calling format by default)
 *   GET  /tools?format=raw — Raw tool definitions with categories
 *   POST /execute/:name   — Execute a tool by name
 *   GET  /docs            — Human-readable tool documentation
 *   GET  /health          — Server health check
 *
 * This is the model-agnostic interface. Any AI that can do function calling
 * (OpenAI, Anthropic, Google, Meta, Mistral, local models) can use this.
 */

import express from 'express';
import { getAllTools, getCompactSurface, toOpenAiFunctions, getTool, toJsonSchema } from './tools';
import type { ToolContext } from './tools';
import type { ToolDefinition } from './tools/types';
import { VERSION } from './version';

/** Validate request body against a tool's parameter schema. Returns error string or null. */
function validateParams(body: Record<string, unknown>, tool: ToolDefinition): string | null {
  const params = tool.parameters;
  for (const [name, def] of Object.entries(params)) {
    const value = body[name];
    if (def.required !== false && value === undefined) {
      return `Missing required parameter: "${name}"`;
    }
    if (value !== undefined) {
      const expected = def.type;
      const actual = typeof value;
      if (expected === 'number' && actual !== 'number') return `Parameter "${name}" must be a number, got ${actual}`;
      if (expected === 'string' && actual !== 'string') return `Parameter "${name}" must be a string, got ${actual}`;
      if (expected === 'boolean' && actual !== 'boolean') return `Parameter "${name}" must be a boolean, got ${actual}`;
    }
  }
  // Reject unknown parameters to catch typos
  for (const key of Object.keys(body)) {
    if (!(key in params)) {
      return `Unknown parameter: "${key}". Valid: ${Object.keys(params).join(', ') || '(none)'}`;
    }
  }
  return null;
}

export function createToolServer(ctx: ToolContext): express.Router {
  const router = express.Router();

  // ── Tool Discovery ──

  router.get('/tools', (_req, res) => {
    // `?mode=compact` → 6 compound tools (Anthropic Computer-Use style).
    // Default   → 72 granular tools (back-compat, fine-grained control).
    const mode = _req.query.mode === 'compact' ? 'compact' : 'granular';
    const tools = mode === 'compact' ? getCompactSurface() : getAllTools();
    const format = _req.query.format as string;

    if (format === 'raw') {
      // Raw format with categories and full metadata
      res.json(tools.map(t => ({
        name: t.name,
        description: t.description,
        category: t.category,
        parameters: toJsonSchema(t.parameters),
      })));
    } else {
      // Default: OpenAI function-calling format (universal standard)
      res.json(toOpenAiFunctions(tools));
    }
  });

  // ── Tool Execution ──

  router.post('/execute/:name', async (req, res) => {
    const { name } = req.params;
    // Try the compact surface first (6 compound names), then fall back to
    // the granular registry. A tool's name is unique across both.
    const compactTool = getCompactSurface().find(t => t.name === name);
    const tool = compactTool ?? getTool(name);

    if (!tool) {
      return res.status(404).json({
        error: `Tool "${name}" not found`,
        available: [...getCompactSurface(), ...getAllTools()].map(t => t.name),
      });
    }

    try {
      const body = req.body || {};
      const validationError = validateParams(body, tool);
      if (validationError) {
        return res.status(400).json({ tool: name, text: validationError, isError: true });
      }
      const result = await tool.handler(body, ctx);

      // Build response
      const response: any = {
        tool: name,
        text: result.text,
      };
      if (result.image) {
        response.image = result.image;
      }
      if (result.isError) {
        response.isError = true;
        return res.status(400).json(response);
      }
      res.json(response);
    } catch (err: any) {
      res.status(500).json({
        tool: name,
        text: `Internal error: ${err.message}`,
        isError: true,
      });
    }
  });

  // ── Documentation ──

  router.get('/docs', (_req, res) => {
    // `?mode=compact` serves the 6-compound surface; default is granular.
    const mode = _req.query.mode === 'compact' ? 'compact' : 'granular';
    const tools = mode === 'compact' ? getCompactSurface() : getAllTools();
    const categories = new Map<string, typeof tools>();

    for (const t of tools) {
      const cat = categories.get(t.category) || [];
      cat.push(t);
      categories.set(t.category, cat);
    }

    let md = `# clawdcursor Tool API\n\n`;
    md += `**Two tool surfaces** are available over this server:\n\n`;
    md += `| Surface | Tools | Use when |\n`;
    md += `|---|---|---|\n`;
    md += `| **Granular** (default) | 72 | You're writing code that calls individual primitives by name (\`mouse_click\`, \`type_text\`, …). |\n`;
    md += `| **Compact** (\`?mode=compact\`) | 6 | You're an LLM agent. Collapses the 72 primitives into 6 compound tools with action enums — Anthropic Computer-Use style. ~12× fewer tool-catalog tokens. |\n\n`;
    md += `You are currently viewing the **${mode}** surface.\n\n`;
    md += `## Endpoints\n\n`;
    md += `- \`GET /tools\` — Granular schemas (OpenAI function format)\n`;
    md += `- \`GET /tools?mode=compact\` — Compact schemas (6 compound tools)\n`;
    md += `- \`POST /execute/{name}\` — Execute a tool (accepts granular or compact names)\n`;
    md += `- \`GET /docs\` — Granular docs\n`;
    md += `- \`GET /docs?mode=compact\` — Compact docs\n\n`;
    md += `## Picking a compound action (compact mode)\n\n`;
    md += `Each compound tool has an \`action\` parameter with an enum of sub-actions. ` +
          `Call \`computer({"action":"click","x":100,"y":200})\` instead of \`mouse_click({"x":100,"y":200})\`. ` +
          `See each tool's description below for the valid action enum.\n\n`;

    const categoryLabels: Record<string, string> = {
      perception: 'Perception (Screen Reading)',
      mouse: 'Mouse Actions',
      keyboard: 'Keyboard Actions',
      window: 'Window & App Management',
      clipboard: 'Clipboard',
      browser: 'Browser (CDP)',
      orchestration: 'Orchestration',
    };

    for (const [cat, catTools] of categories) {
      md += `## ${categoryLabels[cat] || cat}\n\n`;
      for (const t of catTools) {
        md += `### \`${t.name}\`\n`;
        md += `${t.description}\n\n`;
        const params = Object.entries(t.parameters);
        if (params.length > 0) {
          md += `| Parameter | Type | Required | Description |\n`;
          md += `|-----------|------|----------|-------------|\n`;
          for (const [pname, pdef] of params) {
            md += `| ${pname} | ${pdef.type} | ${pdef.required !== false ? 'yes' : 'no'} | ${pdef.description} |\n`;
          }
          md += `\n`;
        }
      }
    }

    res.type('text/markdown').send(md);
  });

  // ── Health ──

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: VERSION,
      tools: getAllTools().length,
      platform: process.platform,
    });
  });

  return router;
}
