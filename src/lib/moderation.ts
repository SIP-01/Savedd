/**
 * Moderation — team-signed result filtering (NIP-32 labels + NIP-09 deletes).
 * This is SAVEDD application control-plane data — NOT SIP-01 protocol data.
 * Namespaces live in src/lib/saveddProtocol.ts (single source of truth).
 *
 * Team members (owner + admins + moderators) publish kind 1985 label events
 * marking results as hidden:
 *
 *   ["L", "savedd.moderation"]            ← canonical namespace
 *   ["l", "hidden", "savedd.moderation"]  ← label
 *   ["r", "<normalized-url>"]             ← target (web result; NIP-32 target tag)
 *   ["e", "<event-id>"]                   ← target (Nostr result)
 *
 * (Legacy labels targeted URLs with `u` tags — readers accept both.)
 *
 * Readers (every user of the app) filter their own result lists against
 * labels signed by TRUSTED team keys ONLY (owner + owner-listed team) — the
 * author filter is the trust boundary. Legacy labels under
 * `0xsearchstr.moderation` keep working for reads; new labels are only
 * written under `savedd.moderation`.
 *
 * Un-hiding = NIP-09 deletion (kind 5 with an e-tag of the label event).
 *
 * Abuse reports filed from the Policy page are NIP-56 kind 1984 events
 * labeled under the `savedd.abuse` namespace (legacy read: `0xsearchstr.abuse`).
 *
 * ⚠️ KEY NOTE: OWNER_PUBKEY is the project owner's personal key — its nsec
 * lives only in the owner's own signer, never in this codebase. Running a
 * fork? Replace it in src/lib/saveddProtocol.ts (a one-line change).
 */
import type { NostrEvent } from '@nostrify/nostrify';

import { normalizeIndexUrl } from '@/lib/webIndex';
import { APP_RELAYS, getIndexRelayUrls, getSearchRelayUrls } from '@/lib/appRelays';
import {
  OWNER_PUBKEY,
  SAVEDD_PROTOCOL,
  LEGACY_PROTOCOL,
  ROLES_KIND,
  MODERATION_KIND,
  REPORT_KIND,
  isModerationNs,
} from '@/lib/saveddProtocol';

export { OWNER_PUBKEY };

/** Relays moderation data (labels, role lists, reports) is read from. */
export function getModerationRelayUrls(): string[] {
  return [
    ...new Set([
      ...getIndexRelayUrls(),
      ...getSearchRelayUrls(),
      // The owner's write relays (role lists + labels land here via NIP-65).
      ...APP_RELAYS.relays.map((r) => r.url),
    ]),
  ];
}

/** NIP-32 label kind. Re-exported from the central protocol module. */
export { MODERATION_KIND, REPORT_KIND, ROLES_KIND };

/** Label namespace for moderation actions (canonical — the only one written). */
export const MODERATION_NS = SAVEDD_PROTOCOL.moderation;
/** Legacy read-only namespace (existing hidden labels). Never write new ones. */
export const LEGACY_MODERATION_NS = LEGACY_PROTOCOL.moderation;

/** Label namespace for abuse reports (canonical — the only one written). */
export const REPORT_NS = SAVEDD_PROTOCOL.abuse;
/** Legacy read-only namespace (existing reports). Never write new ones. */
export const LEGACY_REPORT_NS = LEGACY_PROTOCOL.abuse;

/* ------------------------------------------------------------------ */
/* Roles (owner-managed team lists)                                    */
/* ------------------------------------------------------------------ */

/**
 * Role lists: addressable kind 30078 events signed by the OWNER.
 * Content is a JSON array of hex pubkeys. Readers trust the owner's
 * signature only — the d-tag alone is not a trust boundary.
 *
 * Canonical d-tags are savedd:*; the legacy presearchstr:* lists are
 * READ-ONLY (still trusted when owner-signed) until the owner migrates
 * (Admin → Roles). New writes are canonical only.
 */
export const ADMIN_ROLES_D_TAG = SAVEDD_PROTOCOL.adminRoles;
export const MOD_ROLES_D_TAG = SAVEDD_PROTOCOL.moderatorRoles;
export const ROLES_T_TAG = SAVEDD_PROTOCOL.rolesTag;
/** Legacy read-only role namespaces. Never write new ones. */
export const LEGACY_ADMIN_ROLES_D_TAG = LEGACY_PROTOCOL.adminRoles;
export const LEGACY_MOD_ROLES_D_TAG = LEGACY_PROTOCOL.moderatorRoles;

/** @deprecated Alias kept for existing imports — new code uses SaveddRole. */
export type AppRole = import('@/lib/saveddProtocol').SaveddRole;

/** Parse a role list event. Owner signature enforced by the caller's filter. */
export function parseRoleList(event: NostrEvent): string[] {
  if (event.kind !== ROLES_KIND) return [];
  if (event.pubkey !== OWNER_PUBKEY) return []; // trust boundary
  try {
    const parsed = JSON.parse(event.content) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string' && /^[0-9a-f]{64}$/i.test(p));
  } catch {
    return [];
  }
}

/** Build a role list event (owner publishes). */
export function buildRoleListEvent(dTag: string, pubkeys: string[]): {
  kind: number;
  content: string;
  tags: string[][];
} {
  const label = dTag === ADMIN_ROLES_D_TAG ? 'admin' : 'moderator';
  return {
    kind: ROLES_KIND,
    content: JSON.stringify(pubkeys),
    tags: [
      ['d', dTag],
      ['t', ROLES_T_TAG],
      ['alt', `SAVEDD ${label} list (owner-signed)`],
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Types + parsing                                                     */
/* ------------------------------------------------------------------ */

export interface HiddenTarget {
  /** Label event id (needed for un-hide via NIP-09). */
  labelEventId: string;
  /** 'u' (web URL, normalized) or 'e' (Nostr event id). */
  targetType: 'u' | 'e';
  /** The target value (normalized URL or event id hex). */
  value: string;
  /** When the label was published. */
  createdAt: number;
}

/** Parse a kind 1985 "hidden" label. Returns null if invalid or untrusted.
 *  URL targets read BOTH `r` (NIP-32-correct — written by current code) and
 *  `u` (legacy SAVEDD/Dsearch labels) tags. */
export function parseHiddenLabel(event: NostrEvent, trusted: Set<string> = new Set([OWNER_PUBKEY])): HiddenTarget | null {
  if (event.kind !== MODERATION_KIND) return null;
  if (!trusted.has(event.pubkey)) return null; // trust boundary

  // Canonical + legacy namespaces both hide (read path; writes are canonical).
  const isHidden = event.tags.some(([n, v, ns]) => n === 'l' && v === 'hidden' && isModerationNs(ns));
  if (!isHidden) return null;

  const urlTag = event.tags.find(([n]) => n === 'r')?.[1] ?? event.tags.find(([n]) => n === 'u')?.[1];
  const eTag = event.tags.find(([n]) => n === 'e')?.[1];
  if (urlTag) return { labelEventId: event.id, targetType: 'u', value: urlTag, createdAt: event.created_at };
  if (eTag && /^[0-9a-f]{64}$/i.test(eTag)) {
    return { labelEventId: event.id, targetType: 'e', value: eTag.toLowerCase(), createdAt: event.created_at };
  }
  return null;
}

/** Build a kind 1985 "hidden" label for a target (URL or event id). */
export function buildHideLabel(target: { url?: string; eventId?: string }): {
  kind: number;
  content: string;
  tags: string[][];
} | null {
  // NIP-32 label targets are e/p/a/r/t — a web URL is an `r` tag. (Legacy
  // labels used `u`; readers accept both.)
  const targetTag = target.url
    ? ['r', normalizeIndexUrl(target.url) ?? target.url.trim()]
    : target.eventId && /^[0-9a-f]{64}$/i.test(target.eventId)
      ? ['e', target.eventId.toLowerCase()]
      : null;
  if (!targetTag) return null;

  return {
    kind: MODERATION_KIND,
    content: '',
    tags: [
      ['L', MODERATION_NS],
      ['l', 'hidden', MODERATION_NS],
      targetTag,
      ['alt', `SAVEDD moderation: hidden ${targetTag[0] === 'r' ? targetTag[1] : 'event'}`],
    ],
  };
}

/** Build a NIP-09 deletion request for a label event (un-hide).
 *  Includes the `k` tag NIP-09 asks for (kind of the deleted event). */
export function buildUnhideDelete(labelEventId: string): { kind: number; content: string; tags: string[][] } {
  return {
    kind: 5,
    content: 'Un-hide result',
    tags: [['e', labelEventId], ['k', String(MODERATION_KIND)]],
  };
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

/** A set of hidden targets for fast result filtering. */
export interface ModerationSet {
  urls: Set<string>;
  eventIds: Set<string>;
}

export function toModerationSet(targets: HiddenTarget[]): ModerationSet {
  return {
    urls: new Set(targets.filter((t) => t.targetType === 'u').map((t) => t.value)),
    eventIds: new Set(targets.filter((t) => t.targetType === 'e').map((t) => t.value)),
  };
}

/** Is this result hidden by the moderation set? */
export function isHiddenResult(
  result: { url: string; nostrEvent?: { id: string } },
  set: ModerationSet,
): boolean {
  if (result.nostrEvent && set.eventIds.has(result.nostrEvent.id)) return true;
  const normalized = normalizeIndexUrl(result.url);
  if (normalized && set.urls.has(normalized)) return true;
  return false;
}
