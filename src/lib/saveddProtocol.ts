/**
 * SAVEDD protocol separation — the single source of truth for which parts
 * of the Nostr surface are SIP-01 (shared search/index protocol) and which
 * are SAVEDD application control-plane data.
 *
 * Architecture:
 *
 *                      SIP-01
 *                shared search protocol
 *                (kind 39697, widx:*, NIP-50/77…)
 *                        │
 *         ┌──────────────┴──────────────┐
 *         │                             │
 *    Search/index data            SAVEDD control plane
 *    (SIP-01, untouched)          (this module's namespaces)
 *         │                             │
 *         │                  OWNER_PUBKEY (trust root)
 *         │                             │ defines
 *         │                    admins ──┘        (owner only)
 *         │                             │ delegate
 *         │              reports / moderation / affiliates
 *         │
 *         └──── MUST KEEP WORKING — do not rename SIP-01 identifiers.
 *
 * Legacy migration policy (control plane only):
 *   READ  — canonical savedd:* plus legacy presearchstr:/0xsearchstr.*
 *           namespaces, and legacy events are trusted ONLY when signed by
 *           the owner key (the trust root never changes).
 *   WRITE — canonical savedd:* namespaces only. Never publish new
 *           presearchstr:/0xsearchstr.* control-plane events.
 *   Shared federation search data (SIP-01 observations, 0xsearchstr
 *   stakes/submissions/cache/term-signals) is NOT control-plane data and
 *   keeps its shared namespaces — renaming those would fork the protocol.
 */
import type { NostrEvent } from '@nostrify/nostrify';

/* ------------------------------------------------------------------ */
/* Trust root                                                          */
/* ------------------------------------------------------------------ */

/**
 * The owner pubkey (hex) — npub1c3gyzcvf2xakqy4vy06umu7hgpr97ttyp05yrlvmk8g8xvmse57qj286r6
 *
 * The single SAVEDD trust root. Its nsec lives only in the owner's signer,
 * never in this codebase. Forks: replace this one constant (and the worker
 * OWNER_PUBKEY var) or nothing you sign will be trusted.
 */
export const OWNER_PUBKEY = 'c45041618951bb6012ac23f5cdf3d740465f2d640be841fd9bb1d0733370cd3c';

/* ------------------------------------------------------------------ */
/* Namespaces                                                          */
/* ------------------------------------------------------------------ */

/** Canonical SAVEDD control-plane namespaces — the ONLY ones written. */
export const SAVEDD_PROTOCOL = {
  /** kind 30078, d-tag: owner-signed admin pubkey list. */
  adminRoles: 'savedd:admin-roles',
  /** kind 30078, d-tag: owner-signed moderator pubkey list. */
  moderatorRoles: 'savedd:mod-roles',
  /** kind 30078, d-tag: owner/admin-signed affiliate rule config. */
  affiliateRules: 'savedd:affiliate-rules',
  /** kind 30078, d-tag: owner/admin-signed Invite Friends config. */
  referralConfig: 'savedd:referral-config',
  /** NIP-32 label namespace (kind 1985): hidden results. */
  moderation: 'savedd.moderation',
  /** NIP-32 self-label namespace on kind 1984 abuse reports. */
  abuse: 'savedd.abuse',
  /** t-tag marker on role-list events. */
  rolesTag: 'savedd-roles',
  /** t-tag on a trusted curated keyword result set (kind 30078). */
  curatedTag: 'savedd-curated',
} as const;

/**
 * Legacy control-plane namespaces — READ-ONLY. Existing deployments have
 * live role lists and moderation labels under these; they stay readable
 * (owner-signed only) until the owner runs the migration (Admin → Roles),
 * and are never written by new code.
 */
export const LEGACY_PROTOCOL = {
  adminRoles: 'presearchstr:admin-roles',
  moderatorRoles: 'presearchstr:mod-roles',
  rolesTag: 'presearchstr-roles',
  moderation: '0xsearchstr.moderation',
  abuse: '0xsearchstr.abuse',
} as const;

/** Nostr kinds used by the SAVEDD control plane. */
export const ROLES_KIND = 30078; // NIP-78 app-specific data (addressable)
export const MODERATION_KIND = 1985; // NIP-32 label
export const REPORT_KIND = 1984; // NIP-56 report
export const DELETE_KIND = 5; // NIP-09 deletion

/** True for any namespace where SAVEDD moderation labels live (canonical or legacy). */
export function isModerationNs(ns: string | undefined): boolean {
  return ns === SAVEDD_PROTOCOL.moderation || ns === LEGACY_PROTOCOL.moderation;
}

/** True for any namespace where SAVEDD abuse reports live (canonical or legacy). */
export function isAbuseNs(ns: string | undefined): boolean {
  return ns === SAVEDD_PROTOCOL.abuse || ns === LEGACY_PROTOCOL.abuse;
}

/* ------------------------------------------------------------------ */
/* Roles + permission matrix                                           */
/* ------------------------------------------------------------------ */

export type SaveddRole = 'owner' | 'admin' | 'moderator' | 'user';

/** Resolve a pubkey's role from the effective (owner-signed) team lists. */
export function roleForPubkey(pubkey: string, admins: string[], mods: string[]): SaveddRole {
  if (pubkey === OWNER_PUBKEY) return 'owner';
  if (admins.includes(pubkey)) return 'admin';
  if (mods.includes(pubkey)) return 'moderator';
  return 'user';
}

/**
 * The permission matrix (see docs/SAVEDD-NOSTR-PROTOCOL.md):
 *
 *   Action                        owner  admin  moderator  user
 *   search / read SIP-01          yes    yes    yes        yes
 *   view + process abuse reports  yes    yes    yes        no
 *   moderate (hide/unhide)        yes    yes    yes        no
 *   add/edit/remove + publish     yes    yes    no         no
 *     affiliate rules
 *   manage admins/moderators      yes    no     no         no
 *   manage engine AI config       yes    no     no         no
 *   change owner / trust root     no*    no     no         no
 *
 * (* even the owner can't "transfer" ownership in-protocol — the trust root
 * is a code constant; changing it is a deploy, by design.)
 */
export const PERMISSIONS = {
  canViewReports: (role: SaveddRole): boolean => role !== 'user',
  canModerate: (role: SaveddRole): boolean => role !== 'user',
  canManageAffiliates: (role: SaveddRole): boolean => role === 'owner' || role === 'admin',
  /** Invite Friends configuration (enable/window) — owner + admins. */
  canManageReferralConfig: (role: SaveddRole): boolean => role === 'owner' || role === 'admin',
  canManageRoles: (role: SaveddRole): boolean => role === 'owner',
  canManageEngineConfig: (role: SaveddRole): boolean => role === 'owner',
  /** Curated keyword result sets — the whole team, same as moderation. */
  canCurate: (role: SaveddRole): boolean => role !== 'user',
} as const;

/* ------------------------------------------------------------------ */
/* Role-list event resolution (canonical wins, legacy read-through)    */
/* ------------------------------------------------------------------ */

/** All role-list d-tags readers should query (canonical + legacy). */
export const ROLE_LIST_D_TAGS = [
  SAVEDD_PROTOCOL.adminRoles,
  SAVEDD_PROTOCOL.moderatorRoles,
  LEGACY_PROTOCOL.adminRoles,
  LEGACY_PROTOCOL.moderatorRoles,
] as const;

export interface ResolvedRoles {
  admins: string[];
  mods: string[];
  /** Whether canonical (savedd:*) role events exist yet — drives the
   *  owner-only "migrate from legacy namespaces" affordance. */
  hasCanonicalAdmins: boolean;
  hasCanonicalMods: boolean;
  /** Whether legacy role events were present at all. */
  hasLegacyRoles: boolean;
}

/**
 * Resolve the effective team lists from a mixed bag of canonical + legacy
 * role events. Rules:
 *   - ONLY owner-signed events count (the trust root; anyone can publish
 *     these d-tags, only the owner's signature is authoritative).
 *   - Per list, canonical supersedes legacy once it exists — so removals
 *     stick after migration while pre-migration admins keep access.
 *   - Latest event per d-tag wins.
 */
export function resolveRoleEvents(events: NostrEvent[]): ResolvedRoles {
  const latestByD = new Map<string, NostrEvent>();
  for (const event of events) {
    if (event.kind !== ROLES_KIND) continue;
    if (event.pubkey !== OWNER_PUBKEY) continue; // trust boundary
    const d = event.tags.find(([n]) => n === 'd')?.[1];
    if (!d) continue;
    const existing = latestByD.get(d);
    if (!existing || event.created_at > existing.created_at) latestByD.set(d, event);
  }

  const read = (d: string): string[] | null => {
    const event = latestByD.get(d);
    if (!event) return null;
    try {
      const parsed: unknown = JSON.parse(event.content);
      if (!Array.isArray(parsed)) return null;
      return parsed.filter((p): p is string => typeof p === 'string' && /^[0-9a-f]{64}$/i.test(p));
    } catch {
      return null;
    }
  };

  const canonicalAdmins = read(SAVEDD_PROTOCOL.adminRoles);
  const legacyAdmins = read(LEGACY_PROTOCOL.adminRoles);
  const canonicalMods = read(SAVEDD_PROTOCOL.moderatorRoles);
  const legacyMods = read(LEGACY_PROTOCOL.moderatorRoles);

  return {
    admins: canonicalAdmins ?? legacyAdmins ?? [],
    mods: canonicalMods ?? legacyMods ?? [],
    hasCanonicalAdmins: canonicalAdmins !== null,
    hasCanonicalMods: canonicalMods !== null,
    hasLegacyRoles: legacyAdmins !== null || legacyMods !== null,
  };
}

/* ------------------------------------------------------------------ */
/* localStorage migration (device-local, not protocol)                 */
/* ------------------------------------------------------------------ */

/**
 * Read a namespaced localStorage key, falling back to its legacy
 * presearchstr/0xsearchstr name. On a legacy hit the value is copied to the
 * canonical key and the legacy key removed — settings migrate on first read.
 */
export function readStoredWithLegacy(canonicalKey: string, legacyKey: string): string | null {
  try {
    const value = localStorage.getItem(canonicalKey);
    if (value !== null) return value;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy !== null) {
      localStorage.setItem(canonicalKey, legacy);
      localStorage.removeItem(legacyKey);
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write ONLY the canonical key (and clear the legacy one). null removes. */
export function writeStoredCanonical(canonicalKey: string, legacyKey: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(canonicalKey);
    else localStorage.setItem(canonicalKey, value);
    localStorage.removeItem(legacyKey);
  } catch {
    // Storage unavailable — non-fatal everywhere it's used.
  }
}
