# SAVEDD — Nostr Protocol & Permissions

How SAVEDD separates the **shared search protocol** it runs on (SIP-01) from
the **application control plane** it owns. Single source of truth in code:
[`src/lib/saveddProtocol.ts`](../src/lib/saveddProtocol.ts).

```
                        SAVEDD
                          │
            ┌─────────────┴─────────────┐
            │                           │
         SIP-01                    SAVEDD APP DATA
      search / index                    │
            │                ┌──────────┼───────────┐
            │                │          │           │
            │            Admin roles  Moderation   Referrals
            │                │          │           │
            │            Abuse reports  │      Invite Friends
            │                │          │           │
            │           Affiliate rules─┘           │
            │                                       │
            └──────── interoperable ────────────────┘
```

## The two layers

### SIP-01 layer (shared, do not fork)

SAVEDD is a **client of SIP-01**, not a fork of it. These stay byte-for-byte
protocol compatible:

| What | Kind / shape | Notes |
|---|---|---|
| Web Index Observations | kind 39697, `d = widx:<hash>`, `u`, `x`, `t` | Read + write (auto-indexer, device identity) |
| Index/search queries | NIP-50 `search` filters | Relay-side |
| Negentropy sync | NIP-77 | Relay-to-relay |

The shared federation namespaces — `0xsearchstr:stake:*` (keyword stakes),
`0xsearchstr-submit` (community submissions), `0xsearchstr:term:*` (term
signals), `0xsearchstr:cache:*` (legacy cache) — are **inter-engine protocol
data** shared with Dsearch/0xSearchstr, not SAVEDD control-plane state. They
keep their names so the federation keeps working.

### SAVEDD control plane (SAVEDD-owned)

| Function | Kind | Namespace / d-tag | Authority |
|---|---|---|---|
| Admin roles | 30078 | `savedd:admin-roles` | **Owner only** |
| Moderator roles | 30078 | `savedd:mod-roles` | **Owner only** |
| Affiliate rules | 30078 | `savedd:affiliate-rules` | Owner + admins |
| Invite Friends config | 30078 | `savedd:referral-config` | Owner + admins |
| Moderation labels | 1985 (NIP-32) | `savedd.moderation` | Owner + admins + moderators |
| Curated keywords | 30078 | `savedd:curated:<keyword>` | Owner + admins + moderators |
| Abuse reports | 1984 (NIP-56) | `savedd.abuse` | Anyone files → team reads |
| Delete / un-hide | 5 (NIP-09) | — | The label's own author (team) |
| Referral attribution ping | 34967 | `d`/`p` = inviter pubkey | Per-device analytics key |
| Affiliate click | 6079 | `p` = inviter, `host` = merchant | Per-device analytics key |
| Web bookmarks | 39701 (NIP-B0) | `d` = URL | Each user's own key |

## Trust hierarchy

```
OWNER_PUBKEY  (code constant — the trust root; changing it is a deploy)
  │
  ├── defines admins        (owner-signed savedd:admin-roles)
  ├── defines moderators    (owner-signed savedd:mod-roles)
  └── engine AI config      (worker-side NIP-98, owner key only)
        │
        └── admins operate: reports, moderation, affiliate rules,
            referral config
              │
              └── moderators operate: reports, moderation
```

The `d`-tag alone is never a trust boundary: readers filter role lists and
config events by **author** (owner, or owner + resolved admins for delegated
config). A stranger publishing `d = savedd:admin-roles` gets ignored.

## Permission matrix

| Action | Owner | Admin | Moderator | User |
|---|---|---|---|---|
| Search / read SIP-01 | ✅ | ✅ | ✅ | ✅ |
| File an abuse report | ✅ | ✅ | ✅ | ✅ |
| View / process reports | ✅ | ✅ | ✅ | ❌ |
| Moderate (hide/unhide) results | ✅ | ✅ | ✅ | ❌ |
| Publish a curated keyword result set | ✅ | ✅ | ✅ | ❌ |
| Add / edit / remove + publish affiliate rules | ✅ | ✅ | ❌ | ❌ |
| Manage Invite Friends config | ✅ | ✅ | ❌ | ❌ |
| Manage admins / moderators | ✅ | ❌ | ❌ | ❌ |
| Engine AI config (worker) | ✅ | ❌ | ❌ | ❌ |
| Change the trust root | ❌* | ❌ | ❌ | ❌ |

\* Ownership is a code constant, not an event — nobody can transfer it
in-protocol, including the owner. Forks change the constant and redeploy.

Invite Friends usage (getting your own `?ref=npub…` link) is open to **every
logged-in user** — using a link is not an administrative permission.

## Invite Friends / referrals

- **Identity** — the `?ref=` parameter is an `npub`/`nprofile`/hex, decoded
  and normalized to the 32-byte hex pubkey. No usernames, no display names.
- **Config** (`savedd:referral-config`, kind 30078): `{ enabled,
  attributionWindowDays }` — program-wide settings only. Referral
  RELATIONSHIPS never live in a config event.
- **State** — first-touch attribution persists in the visitor's
  localStorage (`savedd:referrer`), surviving refresh/restart/login/logout.
  After the attribution window expires, a new invite link may re-attribute.
- **Events** — one addressable ping per device per inviter (kind 34967,
  `d` = inviter) + one kind 6079 per affiliate click (`p` = inviter,
  `host` = merchant). Both signed by a dedicated per-device analytics key —
  never the account key, never the SIP-01 indexer identity.
- **Self-referral** — rejected: a logged-in user following their own link
  never attributes.
- **Authority separation** — `?ref=` is attribution only. It grants no
  permissions of any kind.

## Public vs private data

| Data | Visibility |
|---|---|
| SIP-01 index, search results | Public |
| Affiliate rules, referral config | Public config (codes are visible in tagged URLs anyway) |
| Role lists | Public, owner-signed |
| Moderation labels | Public, team-signed (hidden from results until you look) |
| Abuse reports | Public Nostr events, but only surfaced to the team console — never rendered in public search UI |
| Referral pings / clicks | Public, pseudonymous (device key), counts only |
| User keys, BYOK provider keys | Device-local (savedd:* localStorage) |

## Legacy migration

| Legacy (read-only) | Canonical (read + write) |
|---|---|
| `presearchstr:admin-roles` | `savedd:admin-roles` |
| `presearchstr:mod-roles` | `savedd:mod-roles` |
| `presearchstr-roles` (t-tag) | `savedd-roles` |
| `0xsearchstr.moderation` | `savedd.moderation` |
| `0xsearchstr.abuse` | `savedd.abuse` |

Rules:

1. **Read**: canonical + legacy. Legacy data is trusted ONLY when signed by
   the owner key — legacy events from anyone else grant nothing.
2. **Write**: canonical only. New code never publishes legacy control-plane
   events.
3. **Role lists**: canonical supersedes legacy per list once it exists, so
   post-migration removals stick. Until then legacy lists keep working.
4. **Migration**: owner-only button in Admin → Roles publishes the current
   effective lists to the canonical d-tags. Nothing is auto-copied from
   arbitrary legacy events.
5. **Device-local state** (BYOK keys, votes, relay customizations, relay
   discovery cache): canonical `savedd:*` localStorage keys, legacy keys
   migrated on first read.

Legacy reads can be removed once the owner has migrated roles and old
labels/reports are no longer relevant.
