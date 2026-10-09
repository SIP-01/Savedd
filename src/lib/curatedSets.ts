/**
 * Curated keyword results — a Savedd control-plane list that replaces
 * the open-web results for an exact keyword.
 *
 * Open keyword stakes (0xsearchstr:stake:*) stay what they are: anyone
 * can pin one link, and the rest of the page still shows. A curated set
 * is different. It is a full result list, and only the owner, an admin,
 * or a moderator can publish one. Readers ignore every other author.
 *
 *   kind: 30078
 *   d: "savedd:curated:<primary keyword>"   (one set per author per keyword)
 *   t: "savedd-curated"
 *   k: each normalized keyword this set should answer, including the primary
 *   content: JSON [{ title, url, snippet }, ...]
 *
 * `k` is a single-letter tag on purpose: relays index those, so a search
 * can ask for one keyword without downloading every curated set.
 * An empty list is a deliberate clear — the newest trusted event wins,
 * and an empty one means "show the open web again."
 */
import type { NostrEvent } from '@nostrify/nostrify';

import { isValidSubmissionUrl } from '@/lib/contentType';
import { normalizeQuery } from '@/lib/searchIndex';
import { SAVEDD_PROTOCOL } from '@/lib/saveddProtocol';

export const CURATED_KIND = 30078;
export const CURATED_T_TAG = SAVEDD_PROTOCOL.curatedTag;

export const MAX_CURATED_RESULTS = 20;
export const MAX_CURATED_KEYWORDS = 12;
const MAX_TITLE = 140;
const MAX_SNIPPET = 280;

export interface CuratedLink {
  title: string;
  url: string;
  snippet: string;
}

export function curatedDTag(keyword: string): string {
  return `savedd:curated:${normalizeQuery(keyword)}`;
}

export interface CuratedInput {
  keyword: string;
  /** Extra searches that should show this same list. */
  aliases: string[];
  links: CuratedLink[];
}

/** Build the unsigned event. Null when the primary keyword is empty. */
export function buildCuratedEvent(
  input: CuratedInput,
): { kind: number; content: string; tags: string[][] } | null {
  const keyword = input.keyword.trim();
  const primary = normalizeQuery(keyword);
  if (!primary) return null;

  const keywords = [...new Set([
    primary,
    ...input.aliases.map((alias) => normalizeQuery(alias)).filter(Boolean),
  ])].slice(0, MAX_CURATED_KEYWORDS);

  const links = input.links
    .map((link) => ({
      title: link.title.trim().slice(0, MAX_TITLE),
      url: link.url.trim(),
      snippet: link.snippet.trim().slice(0, MAX_SNIPPET),
    }))
    .filter((link) => link.title.length > 0 && isValidSubmissionUrl(link.url))
    .slice(0, MAX_CURATED_RESULTS);

  return {
    kind: CURATED_KIND,
    content: JSON.stringify(links),
    tags: [
      ['d', curatedDTag(keyword)],
      ['t', CURATED_T_TAG],
      ...keywords.map((k) => ['k', k]),
      ['keyword', keyword],
      ['alt', `Curated results for ${keyword}`],
    ],
  };
}

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter(([n]) => n === name).map(([, v]) => v ?? '');
}

/** Normalized keywords this event claims to answer. */
export function curatedEventKeywords(event: NostrEvent): string[] {
  const fromK = tagValues(event, 'k').map((v) => normalizeQuery(v)).filter(Boolean);
  const d = tagValues(event, 'd')[0] ?? '';
  const fromD = d.startsWith('savedd:curated:') ? normalizeQuery(d.slice('savedd:curated:'.length)) : '';
  return [...new Set(fromD ? [fromD, ...fromK] : fromK)];
}

/**
 * Parse a curated event.
 * Returns null when the event is the wrong shape or the author is not trusted.
 * Returns [] when a trusted author deliberately cleared the keyword.
 */
export function parseCuratedEvent(event: NostrEvent, trusted: Set<string>): CuratedLink[] | null {
  if (event.kind !== CURATED_KIND) return null;
  if (!trusted.has(event.pubkey)) return null;
  if (!event.tags.some(([n, v]) => n === 't' && v === CURATED_T_TAG)) return null;
  const d = tagValues(event, 'd')[0];
  if (!d?.startsWith('savedd:curated:')) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;

  const links: CuratedLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    const snippet = typeof row.snippet === 'string' ? row.snippet.trim() : '';
    if (!title || !isValidSubmissionUrl(url)) continue;
    links.push({ title: title.slice(0, MAX_TITLE), url, snippet: snippet.slice(0, MAX_SNIPPET) });
    if (links.length >= MAX_CURATED_RESULTS) break;
  }
  return links;
}
