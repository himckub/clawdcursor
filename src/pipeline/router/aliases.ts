/**
 * APP_ALIASES — the 40-app, 3-OS canonical app table.
 *
 * Ported verbatim from src/action-router.ts (v0.6.3 heritage). Each row
 * maps a user-facing natural-language name to the set of actual process
 * names on each OS plus the macOS app bundle name.
 *
 * Adding an app = one row here, nothing else. No business-logic file
 * should reference raw process names — they go through this table.
 */

export interface AppAlias {
  /** Process names to look for when checking "is this app running?". */
  processNames: string[];
  /** Human-friendly search term for UIA-tree search (window title matching). */
  searchTerm: string;
  /** macOS app bundle name for `open -a`. */
  macOSAppName?: string;
  /** Windows fallback exe, used when Start-Process can't find by name. */
  executable?: string;
  /**
   * If true, the user typically wants a FRESH instance (mspaint: new
   * canvas, notepad: new document). Launch with -n on macOS, or by
   * executable path on Windows.
   */
  alwaysNewInstance?: boolean;
}

export const APP_ALIASES: Record<string, AppAlias> = {
  // Drawing / editors
  'paint':              { processNames: ['mspaint'],                          searchTerm: 'Paint',              executable: 'mspaint.exe', alwaysNewInstance: true },
  'mspaint':            { processNames: ['mspaint'],                          searchTerm: 'Paint',              executable: 'mspaint.exe', alwaysNewInstance: true },
  'notepad':            { processNames: ['notepad', 'Notepad'],               searchTerm: 'Notepad',            executable: 'notepad.exe', alwaysNewInstance: true, macOSAppName: 'TextEdit' },
  'textedit':           { processNames: ['TextEdit'],                         searchTerm: 'TextEdit',           macOSAppName: 'TextEdit' },

  // Utility
  'calculator':         { processNames: ['CalculatorApp', 'Calculator', 'calc'], searchTerm: 'Calculator',      macOSAppName: 'Calculator' },
  'calc':               { processNames: ['CalculatorApp', 'Calculator', 'calc'], searchTerm: 'Calculator',      macOSAppName: 'Calculator' },

  // Browsers
  'chrome':             { processNames: ['chrome', 'Google Chrome'],          searchTerm: 'Chrome',             macOSAppName: 'Google Chrome' },
  'google chrome':      { processNames: ['chrome', 'Google Chrome'],          searchTerm: 'Chrome',             macOSAppName: 'Google Chrome' },
  'firefox':            { processNames: ['firefox'],                          searchTerm: 'Firefox',            macOSAppName: 'Firefox' },
  'safari':             { processNames: ['Safari'],                           searchTerm: 'Safari',             macOSAppName: 'Safari' },
  'edge':               { processNames: ['msedge'],                           searchTerm: 'Edge',               macOSAppName: 'Microsoft Edge' },
  'microsoft edge':     { processNames: ['msedge'],                           searchTerm: 'Edge',               macOSAppName: 'Microsoft Edge' },

  // Office
  'outlook':            { processNames: ['OUTLOOK', 'olk'],                   searchTerm: 'Outlook',            macOSAppName: 'Microsoft Outlook' },
  'microsoft outlook':  { processNames: ['OUTLOOK', 'olk'],                   searchTerm: 'Outlook',            macOSAppName: 'Microsoft Outlook' },
  'word':               { processNames: ['WINWORD'],                          searchTerm: 'Word',               macOSAppName: 'Microsoft Word' },
  'excel':              { processNames: ['EXCEL'],                            searchTerm: 'Excel',              macOSAppName: 'Microsoft Excel' },

  // Shell
  'explorer':           { processNames: ['explorer'],                         searchTerm: 'File Explorer',      macOSAppName: 'Finder' },
  'finder':             { processNames: ['Finder'],                           searchTerm: 'Finder',             macOSAppName: 'Finder' },
  'file explorer':      { processNames: ['explorer'],                         searchTerm: 'File Explorer',      macOSAppName: 'Finder' },
  'cmd':                { processNames: ['cmd'],                              searchTerm: 'Command Prompt',     macOSAppName: 'Terminal' },
  'terminal':           { processNames: ['WindowsTerminal', 'cmd', 'Terminal'], searchTerm: 'Terminal',         macOSAppName: 'Terminal' },
  'powershell':         { processNames: ['powershell', 'pwsh'],               searchTerm: 'PowerShell' },

  // Dev tools
  'vscode':             { processNames: ['Code'],                             searchTerm: 'Visual Studio Code', macOSAppName: 'Visual Studio Code' },
  'code':               { processNames: ['Code'],                             searchTerm: 'Visual Studio Code', macOSAppName: 'Visual Studio Code' },
  'cursor':             { processNames: ['Cursor'],                           searchTerm: 'Cursor',             macOSAppName: 'Cursor' },
  'xcode':              { processNames: ['Xcode'],                            searchTerm: 'Xcode',              macOSAppName: 'Xcode' },
  'wezterm':            { processNames: ['WezTerm', 'wezterm'],               searchTerm: 'WezTerm',            macOSAppName: 'WezTerm' },
  'iterm':              { processNames: ['iTerm2', 'iTerm'],                  searchTerm: 'iTerm',              macOSAppName: 'iTerm' },
  'iterm2':             { processNames: ['iTerm2'],                           searchTerm: 'iTerm2',             macOSAppName: 'iTerm' },

  // Settings / system
  'settings':           { processNames: ['SystemSettings'],                   searchTerm: 'Settings',           macOSAppName: 'System Settings' },
  'system settings':    { processNames: ['System Preferences', 'System Settings'], searchTerm: 'System Settings', macOSAppName: 'System Settings' },
  'task manager':       { processNames: ['Taskmgr'],                          searchTerm: 'Task Manager',       macOSAppName: 'Activity Monitor' },
  'activity monitor':   { processNames: ['Activity Monitor'],                 searchTerm: 'Activity Monitor',   macOSAppName: 'Activity Monitor' },

  // Collab / comms
  'figma':              { processNames: ['Figma'],                            searchTerm: 'Figma',              macOSAppName: 'Figma' },
  'slack':              { processNames: ['Slack', 'slack'],                   searchTerm: 'Slack',              macOSAppName: 'Slack' },
  'teams':              { processNames: ['ms-teams', 'Teams'],                searchTerm: 'Teams',              macOSAppName: 'Microsoft Teams' },
  'discord':            { processNames: ['Discord'],                          searchTerm: 'Discord',            macOSAppName: 'Discord' },

  // Media
  'spotify':            { processNames: ['Spotify'],                          searchTerm: 'Spotify',            macOSAppName: 'Spotify' },

  // Apple native
  'notes':              { processNames: ['Notes'],                            searchTerm: 'Notes',              macOSAppName: 'Notes' },
  'mail':               { processNames: ['Mail'],                             searchTerm: 'Mail',               macOSAppName: 'Mail' },
};

/**
 * Resolve a user-facing app name to its alias row. Case-insensitive,
 * whitespace-tolerant. Returns null for unknown apps — caller should fall
 * back to `launchApp(name)` with the raw string.
 */
export function resolveAlias(name: string): (AppAlias & { key: string }) | null {
  const k = name.trim().toLowerCase();
  const hit = APP_ALIASES[k];
  if (!hit) return null;
  return { key: k, ...hit };
}
