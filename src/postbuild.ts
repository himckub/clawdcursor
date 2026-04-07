/**
 * Post-build script — runs after tsc.
 * Prints available commands.
 */

// Print available commands — keep it simple
console.log(`
🐾 Clawd Cursor built successfully!

  clawdcursor start     Start the desktop control agent
  clawdcursor mcp       Run as MCP server (for Claude Code, Cursor, etc.)
  clawdcursor doctor    Auto-detect and configure AI providers
  clawdcursor status    Check setup status
  clawdcursor stop      Stop the agent

  Run 'clawdcursor consent' first to grant desktop control permissions.
`);
