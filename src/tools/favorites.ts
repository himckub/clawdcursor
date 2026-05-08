/**
 * Favorites tools — list, add, remove starred task strings.
 *
 * Storage: a single JSON array of strings at FAVORITES_PATH (under
 * ~/.clawdcursor/), shared with the legacy REST surface for compatibility
 * during the v0.9 PR7 cutover.
 *
 * The dashboard (PR7.3) calls these via MCP-over-HTTP; the legacy REST
 * /favorites routes still exist alongside until PR7.4. Both read/write the
 * same file, so they cannot drift.
 */

import * as fs from 'fs';
import { FAVORITES_PATH } from '../paths';
import type { ToolDefinition } from './types';

function loadFavorites(): string[] {
  try {
    if (fs.existsSync(FAVORITES_PATH)) {
      const data = fs.readFileSync(FAVORITES_PATH, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* corrupted or unreadable — treat as empty */
  }
  return [];
}

function saveFavorites(favorites: string[]): void {
  try {
    fs.writeFileSync(FAVORITES_PATH, JSON.stringify(favorites, null, 2), 'utf-8');
  } catch (err) {
    throw new Error(`Failed to save favorites: ${(err as Error).message}`, { cause: err });
  }
}

export function getFavoritesTools(): ToolDefinition[] {
  return [
    {
      name: 'favorites_list',
      description:
        'Return the list of starred ("favorite") task strings. ' +
        'Stored locally at ~/.clawdcursor/.clawdcursor-favorites.json — ' +
        'never sent over the network.',
      parameters: {},
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async () => {
        const favorites = loadFavorites();
        return { text: JSON.stringify(favorites) };
      },
    },

    {
      name: 'favorites_add',
      description:
        'Add a task string to the favorites list. No-op if already present. ' +
        'Returns the updated list.',
      parameters: {
        task: { type: 'string', description: 'Task string to star', required: true },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 1,
      handler: async ({ task }) => {
        const trimmed = String(task ?? '').trim();
        if (!trimmed) {
          return { text: 'favorites_add: task must be a non-empty string', isError: true };
        }
        const favorites = loadFavorites();
        if (!favorites.includes(trimmed)) {
          favorites.push(trimmed);
          saveFavorites(favorites);
        }
        return { text: JSON.stringify({ ok: true, favorites }) };
      },
    },

    {
      name: 'favorites_remove',
      description: 'Remove a task string from the favorites list. Returns the updated list.',
      parameters: {
        task: { type: 'string', description: 'Task string to unstar', required: true },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 1,
      handler: async ({ task }) => {
        const trimmed = String(task ?? '').trim();
        if (!trimmed) {
          return { text: 'favorites_remove: task must be a non-empty string', isError: true };
        }
        const favorites = loadFavorites();
        const idx = favorites.indexOf(trimmed);
        if (idx === -1) {
          return { text: `favorites_remove: "${trimmed}" not in favorites`, isError: true };
        }
        favorites.splice(idx, 1);
        saveFavorites(favorites);
        return { text: JSON.stringify({ ok: true, favorites }) };
      },
    },
  ];
}
