/**
 * Community Engine Profile — one core, many independently branded engines.
 *
 * SAVEDD is the first proof of concept: a Christian community search engine
 * on the Dsearch / SIP-01 architecture. Future engines (Bitcoin, academic,
 * local, …) should be new profiles, not forks of the search pipeline.
 *
 * Nothing in this file is a secret. API keys stay in the Cloudflare worker
 * environment (`OPENAI_API_KEY` — legacy alias `AI_API_KEY` — and
 * `BRAVE_API_KEY`) and never ship in the bundle.
 */

export interface EngineNavLink {
  to: string;
  label: string;
}

export interface EngineBranding {
  name: string;
  shortName: string;
  domain: string;
  siteUrl: string;
  slogan: string;
  description: string;
  ogImage: string;
  /** Default appearance for first-time visitors. */
  defaultTheme: 'light' | 'dark';
  /** Search-bar placeholder. */
  searchPlaceholder: string;
  /** Wordmark as shown in the header (plain text; styling is CSS). */
  wordmark: string;
}

export interface EngineSearchConfig {
  /** SIP-01 community index is a first-class source. */
  sip01: boolean;
  /**
   * Indexer software id stamped as the `source` tag on every SIP-01
   * kind 39697 observation this engine publishes (spec §6). One id per
   * branded engine, so the network attributes contributions to this
   * engine — not to the shared Dsearch core it runs on.
   */
  indexerSource: string;
  /** Brave Search via the engine proxy (and/or a user BYOK key). */
  brave: boolean;
  /**
   * Provider ids turned off for this community engine's first-run config.
   * Users can re-enable anything in Settings — the providers themselves
   * stay in the registry.
   */
  disabledProviders: string[];
}

export interface EngineTabConfig {
  order: string[];
  hidden: string[];
  defaultTab: string;
}

export interface EngineUiConfig {
  /** Ecosystem hub pages (Network / Build / Protocol / Community / …). */
  showNetwork: boolean;
  showBuild: boolean;
  showProtocol: boolean;
  showCommunity: boolean;
  showDashboard: boolean;
  showDocs: boolean;
  showExplore: boolean;
  showTrending: boolean;
  showSubmit: boolean;
  showStake: boolean;
  showLogin: boolean;
  showNostr: boolean;
  biblicalQuotes: boolean;
  tabConfig: EngineTabConfig;
  navLinks: EngineNavLink[];
  footerLinks: EngineNavLink[];
  footerTagline: string;
}

export interface EngineAiConfig {
  /** AI answers on for first-time visitors (still opt-out in Settings). */
  enabledDefault: boolean;
  /** OpenAI-compatible provider id used as the settings default. */
  providerId: string;
  /** Display name of the intended engine-tier provider. */
  providerName: string;
  /** Default OpenAI-compatible endpoint (engine-tier; no key here). */
  endpoint: string;
  /** Default model id (engine-tier; operator can override via env). */
  model: string;
  /**
   * Production system prompt. Injected server-side on the engine tier so
   * clients cannot override it. Also used client-side for user-BYOK calls.
   */
  systemPrompt: string;
}

export interface CommunityEngineProfile {
  id: string;
  branding: EngineBranding;
  search: EngineSearchConfig;
  ui: EngineUiConfig;
  ai: EngineAiConfig;
}

/** KJV — public domain. Used by the SAVEDD AI profile; not a theological authority. */
export const SAVEDD_SYSTEM_PROMPT = `You are Savedd AI, a Christian-informed search assistant.

Your role is to help users understand information through the broad historic Christian worldview while respecting legitimate differences among Christian traditions.

Your primary goal is to provide useful, accurate, truthful, and intellectually honest answers. You are an assistant, not a religious authority: never claim divine revelation, prophetic insight, or certainty the evidence does not support.

GENERAL PRINCIPLES

- Seek truth and accuracy rather than simply reinforcing the user's assumptions.
- Clearly distinguish facts, interpretations, opinions, and theological claims.
- NEVER invent facts, sources, quotations, Bible verses, or citations.
- Acknowledge uncertainty when the available evidence is uncertain or disputed.
- Answer the user's actual question directly.
- Do not unnecessarily preach or force Christian language into questions where it is not relevant.

CHRISTIAN WORLDVIEW

When relevant, consider the broad historic Christian understanding of:

- God
- Scripture
- human dignity
- human nature
- morality
- justice
- freedom
- responsibility
- family
- community
- work
- human flourishing

When discussing Christianity:

- Distinguish broadly shared historic Christian beliefs from beliefs specific to particular Christian traditions.
- Respect legitimate differences among Catholic, Orthodox, Protestant, evangelical, and other Christian traditions.
- Do not present one denomination's distinctive doctrine as though it represents all Christians.
- Distinguish historic Christian consensus from minority or disputed interpretations when the evidence supports that distinction.
- Distinguish biblical text from theological interpretation and from your own reasoning.
- When Scripture is relevant, identify biblical references accurately (book, chapter, verse) and never fabricate a quotation or a reference.

CONTROVERSIAL QUESTIONS

When a subject is controversial:

- Fairly describe significant perspectives.
- Do not misrepresent opposing viewpoints.
- Explain how a broad historic Christian worldview approaches the issue.
- Clearly identify where Christians agree and where Christians disagree.
- Do not pretend that a disputed theological conclusion is an uncontested Christian belief.

SEARCH RESULTS AND EVIDENCE

When search evidence is supplied:

- Use the supplied evidence whenever possible.
- Cite every factual statement drawn from the evidence with [n] markers referencing the numbered evidence items.
- Do not claim that a source says something it does not say.
- Clearly distinguish what the sources establish from your own inference.
- If the evidence is insufficient to answer confidently, say so plainly and say what is missing.

STYLE

- Be clear, concise, thoughtful, and respectful.
- Give the direct answer first, then supporting detail. No preamble.
- Provide additional explanation when it helps the user understand the issue.
- Do not force Christianity, Scripture, or religious framing into unrelated questions.
- The goal is not to tell users what to believe, but to help them understand information through a broad historic Christian worldview.`;

/**
 * SAVEDD — Christian community search engine.
 *
 * Built on Dsearch core + SIP-01. This profile is the product surface;
 * the search pipeline, providers, parser, and index protocol stay shared.
 */
export const SAVEDD_PROFILE: CommunityEngineProfile = {
  id: 'savedd',
  branding: {
    name: 'SAVEDD',
    shortName: 'SAVEDD',
    domain: 'savedd.com',
    siteUrl: 'https://savedd.com',
    slogan: 'Seek, and ye shall find.',
    description:
      'SAVEDD searches Scripture, the Church, and the open web. Optional AI answers are grounded in sources — never invented, never claimed as revelation.',
    ogImage: 'https://savedd.com/og.jpg',
    defaultTheme: 'light',
    searchPlaceholder: 'Search the web',
    wordmark: 'SAVEDD',
  },
  search: {
    sip01: true,
    indexerSource: 'savedd-web/1',
    brave: true,
    // Keep SIP-01 (web-index), Brave, DuckDuckGo, and SearXNG on.
    // Everything else stays in the architecture but is off for this profile.
    disabledProviders: [
      'parallel',
      'cached-index',
      'wikipedia',
      'tor',
      'stackoverflow',
      'nostr',
      'git',
      'nostr-wiki',
      'hackernews',
      'community',
      'keyword-stakes',
    ],
  },
  ui: {
    showNetwork: false,
    showBuild: false,
    showProtocol: false,
    showCommunity: false,
    showDashboard: false,
    showDocs: false,
    showExplore: false,
    showTrending: false,
    showSubmit: false,
    showStake: false,
    showLogin: true,
    showNostr: false,
    biblicalQuotes: true,
    tabConfig: {
      order: ['web', 'index', 'all', 'nostr', 'wiki', 'news', 'code', 'tor', 'i2p'],
      hidden: ['all', 'nostr', 'wiki', 'news', 'code', 'tor', 'i2p'],
      defaultTab: 'web',
    },
    navLinks: [
      { to: '/heaven', label: 'Heaven' },
      { to: '/about', label: 'About' },
    ],
    footerLinks: [
      { to: '/heaven', label: 'Heaven' },
      { to: '/about', label: 'About' },
      { to: '/partners', label: 'Invite friends' },
      { to: '/settings', label: 'Settings' },
      { to: '/policy', label: 'Content Policy' },
    ],
    footerTagline: 'Matthew 7:7',
  },
  ai: {
    enabledDefault: true,
    providerId: 'openai',
    providerName: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-5.6-luna',
    systemPrompt: SAVEDD_SYSTEM_PROMPT,
  },
};

/**
 * Active engine for this deployment.
 *
 * Swap this constant (or load from a catalog) to launch the next community
 * engine on the same core. Do not scatter brand strings through the app.
 */
export const ENGINE_PROFILE: CommunityEngineProfile = SAVEDD_PROFILE;
