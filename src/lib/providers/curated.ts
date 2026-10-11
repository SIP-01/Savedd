/**
 * Curated results provider.
 *
 * When a search exactly matches a keyword on a trusted curated set,
 * those links are the Web results. The page hides Brave, DuckDuckGo,
 * SearXNG, and the general index until the reader asks for the open web.
 *
 * Trusted authors are the owner plus the owner-signed admin and
 * moderator lists. Anyone else's event is ignored.
 */
import type { NostrFilter } from '@nostrify/nostrify';

import { getModerationRelayUrls } from '@/lib/moderation';
import { queryRelayPool } from '@/lib/searchRelays';
import { normalizeQuery } from '@/lib/searchIndex';
import {
  CURATED_KIND,
  CURATED_T_TAG,
  curatedEventKeywords,
  parseCuratedEvent,
  type CuratedLink,
} from '@/lib/curatedSets';
import {
  OWNER_PUBKEY,
  ROLES_KIND,
  ROLE_LIST_D_TAGS,
  resolveRoleEvents,
} from '@/lib/saveddProtocol';
import type { SearchProvider, SearchOptions, ProviderSearchResponse } from './types';

const ROLE_CACHE_MS = 5 * 60_000;

let roleCache: { at: number; authors: string[] } | null = null;

async function trustedAuthors(signal?: AbortSignal): Promise<string[]> {
  const now = Date.now();
  if (roleCache && now - roleCache.at < ROLE_CACHE_MS) return roleCache.authors;

  try {
    const settled = await queryRelayPool(
      getModerationRelayUrls(),
      [{
        kinds: [ROLES_KIND],
        authors: [OWNER_PUBKEY],
        '#d': [...ROLE_LIST_D_TAGS],
        limit: ROLE_LIST_D_TAGS.length,
      }],
      { signal, timeoutMs: 4000 },
    );
    const roles = resolveRoleEvents(settled.flat());
    const authors = [...new Set([OWNER_PUBKEY, ...roles.admins, ...roles.mods])];
    roleCache = { at: now, authors };
    return authors;
  } catch {
    return roleCache?.authors ?? [OWNER_PUBKEY];
  }
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch {
    return '';
  }
}

/** Newest trusted set for this keyword, or null when nobody has published one. */
export async function findCuratedSet(
  query: string,
  signal?: AbortSignal,
): Promise<{ keyword: string; aliases: string[]; links: CuratedLink[] } | null> {
  const normalized = normalizeQuery(query);
  if (!normalized) return null;

  const authors = await trustedAuthors(signal);
  const filter: NostrFilter = {
    kinds: [CURATED_KIND],
    authors,
    '#t': [CURATED_T_TAG],
    '#k': [normalized],
    limit: 25,
  };

  const settled = await queryRelayPool(getModerationRelayUrls(), [filter], {
    signal,
    timeoutMs: 5000,
  });

  const trusted = new Set(authors);
  const matches = settled
    .flat()
    .filter((event) => curatedEventKeywords(event).includes(normalized))
    .sort((a, b) => b.created_at - a.created_at);

  const winner = matches[0];
  if (!winner) return null;
  const links = parseCuratedEvent(winner, trusted);
  if (!links) return null;

  const primary = (winner.tags.find(([n]) => n === 'd')?.[1] ?? '').replace(/^savedd:curated:/, '');
  return {
    keyword: normalized,
    aliases: curatedEventKeywords(winner).filter((k) => k !== primary && k !== normalized),
    links,
  };
}

export const curatedProvider: SearchProvider = {
  id: 'curated',
  name: 'Curated',
  source: 'web',
  privacy: 'nostr',
  privacyNote: 'Reads curated keyword lists from Nostr relays. Relay operators see the query, but no account is linked.',

  async search({ query, signal }: SearchOptions): Promise<ProviderSearchResponse> {
    const found = await findCuratedSet(query, signal).catch(() => null);
    if (!found || found.links.length === 0) return { results: [] };

    const stamp = Math.floor(Date.now() / 1000);
    return {
      results: found.links.map((link, index) => ({
        id: `curated:${found.keyword}:${index}`,
        title: link.title,
        url: link.url,
        snippet: link.snippet,
        source: 'web' as const,
        provider: 'curated',
        timestamp: stamp,
        domain: domainOf(link.url),
        kind: 'Curated',
        engine: 'Curated',
        score: 1000 - index,
      })),
    };
  },
};
