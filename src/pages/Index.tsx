import { useState, useCallback, useMemo, useEffect, useRef, useTransition } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSeoMeta } from '@unhead/react';
import { Search, Network, ExternalLink, Gem, ChevronLeft, ChevronRight } from 'lucide-react';

import { Layout } from '@/components/Layout';
import { LogoMark } from '@/components/LogoMark';
import { SearchBar } from '@/components/SearchBar';
import { SourceTabs, type SourceTabValue, ALL_SOURCE_TABS, isExternalTab, getExternalTabUrl, getMapsUrl } from '@/components/SourceTabs';
import { UnifiedResultCard } from '@/components/UnifiedResultCard';
import { StakeResultCard } from '@/components/StakeResultCard';
import { VoteTalliesProvider } from '@/components/VoteButtons';
import { AIAnswerCard } from '@/components/AIAnswerCard';
import { StakeKeywordDialog } from '@/components/StakeKeywordDialog';
import { ProviderStatus } from '@/components/ProviderStatus';
import { BrowserFallback } from '@/components/BrowserFallback';
import { SearchSkeleton } from '@/components/SearchSkeleton';
import { PrivacyIndicator } from '@/components/PrivacyIndicator';
import { InstantAnswer } from '@/components/InstantAnswer';
import { TrendingQueries } from '@/components/TrendingQueries';
import { QueryInsights } from '@/components/QueryInsights';
import { ScriptureVerse } from '@/components/ScriptureVerse';
import { Card, CardContent } from '@/components/ui/card';
import { ENGINE_PROFILE } from '@/lib/engine/profile';
import { useProviderSearch } from '@/hooks/useProviderSearch';
import { useInstantAnswer } from '@/hooks/useInstantAnswer';
import { useAIAnswer } from '@/hooks/useAIAnswer';
import { useSearchHotkeys } from '@/hooks/useSearchHotkeys';
import { useAppContext } from '@/hooks/useAppContext';
import type { SearchSource } from '@/lib/providers/types';

// Tabs that can actually be the ACTIVE source — external shortcut tabs
// (Maps / Videos / News ↗) open in a new browser tab instead, so they can
// never be selected via deep link or stored default.
const KNOWN_TAB_IDS = new Set(ALL_SOURCE_TABS.filter((t) => !isExternalTab(t.id)).map((t) => t.id as string));

/** Results per results page. All results stream in up front (providers run
 *  in parallel), so pages render instantly — later pages fill in as
 *  slower providers resolve in the background. */
const PAGE_SIZE = 10;

const Index = () => {
  const { config } = useAppContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') || '';
  // URL param wins; otherwise the user's configured default tab (Web out of
  // the box). Unknown/garbage stored values fall back to 'web'.
  const storedDefault = config.tabConfig.defaultTab;
  const paramSource = searchParams.get('source') || '';
  const initialSource = (KNOWN_TAB_IDS.has(paramSource) ? (paramSource as SourceTabValue) : null)
    || (KNOWN_TAB_IDS.has(storedDefault) ? (storedDefault as SourceTabValue) : 'web');

  const [query, setQuery] = useState(initialQuery);
  const [activeQuery, setActiveQuery] = useState(initialQuery);
  const [source, setSource] = useState<SourceTabValue>(initialSource);
  const [stakeOpen, setStakeOpen] = useState(false);
  // Lets the hero keep the typed query and show a button spinner while the
  // heavier results view renders, instead of blanking the field first.
  const [isSearchPending, startSearchTransition] = useTransition();

  const hasSearched = activeQuery.length > 0;

  // Global hotkeys: Ctrl+K / Cmd+K and "/" focus the search bar.
  useSearchHotkeys();

  // URL → state sync. Only when the `q` param itself changes (logo click,
  // back/forward, a shared link). Done during render — not an effect — so
  // submitting can set the active query before the router commits the new
  // URL without this sync wiping the field back to the stale empty param.
  const paramQuery = searchParams.get('q') || '';
  const [trackedParamQuery, setTrackedParamQuery] = useState(paramQuery);
  if (paramQuery !== trackedParamQuery) {
    setTrackedParamQuery(paramQuery);
    setQuery(paramQuery);
    setActiveQuery(paramQuery);
    if (!paramQuery) {
      setSource(KNOWN_TAB_IDS.has(storedDefault) ? (storedDefault as SourceTabValue) : 'web');
    }
  }
  useEffect(() => {
    if (!paramQuery) window.scrollTo(0, 0);
  }, [paramQuery]);

  // Map SourceTabValue to provider search source.
  // 'i2p' has no provider — it shows directory links only.
  // 'index' selects only the community-index providers (SIP-01 + legacy cache).
  const providerSource = source === 'i2p' ? 'all' : source;

  const {
    results,
    providers,
    isLoading,
    isFetching,
    isEmpty,
    suggestions,
    counts,
    privacyMode,
    suppressedProviders,
  } = useProviderSearch({
    query: activeQuery,
    source: providerSource as SearchSource | 'all' | 'index',
    enabled: hasSearched && source !== 'i2p',
  });

  // Filter results for the current source tab.
  const filteredResults = useMemo(() => {
    if (source === 'all') return results;
    if (source === 'i2p') return [];
    // The Index tab = community index only (SIP-01 observations + legacy cache).
    if (source === 'index') {
      return results.filter((r) => r.provider === 'web-index' || r.provider === 'cached-index');
    }
    // The Code tab also shows NIP-C0 snippets (they arrive as Nostr results
    // with kind 'Code') alongside Stack Overflow.
    if (source === 'code') {
      return results.filter((r) => r.source === 'code' || (r.source === 'nostr' && r.kind === 'Code'));
    }
    return results.filter((r) => r.source === source);
  }, [results, source]);

  // Keyword stakes get their own top-of-page placement (Presearch-style).
  const stakeResults = useMemo(
    () => filteredResults.filter((r) => r.provider === 'keyword-stake'),
    [filteredResults],
  );
  const organicResults = useMemo(
    () => filteredResults.filter((r) => r.provider !== 'keyword-stake'),
    [filteredResults],
  );

  const totalResults = organicResults.length;

  // Pagination — back to page 1 on a new query or tab. Adjusted during
  // render so a results update doesn't wait on an effect.
  const [page, setPage] = useState(1);
  const resultsTopRef = useRef<HTMLDivElement>(null);
  const pageKey = `${activeQuery}\0${source}`;
  const [trackedPageKey, setTrackedPageKey] = useState(pageKey);
  if (pageKey !== trackedPageKey) {
    setTrackedPageKey(pageKey);
    setPage(1);
  }

  const pageCount = Math.max(1, Math.ceil(totalResults / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedResults = useMemo(
    () => organicResults.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [organicResults, currentPage],
  );

  const goToPage = useCallback((p: number) => {
    setPage(p);
    resultsTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Instant answers (calculator, NIP-19 profiles, Wikipedia summaries).
  const { answer: instantAnswer } = useInstantAnswer(
    activeQuery,
    hasSearched && source !== 'i2p',
  );

  // AI Answer layer — synthesizes from the search evidence (opt-in,
  // Settings → AI). Runs only for text-class queries with enough evidence.
  const ai = useAIAnswer(activeQuery, organicResults, hasSearched && source !== 'i2p');

  useSeoMeta({
    title: hasSearched
      ? `${activeQuery} - ${ENGINE_PROFILE.branding.name}`
      : `${ENGINE_PROFILE.branding.name} — ${ENGINE_PROFILE.branding.slogan}`,
    description: ENGINE_PROFILE.branding.description,
  });

  const handleSubmit = useCallback((value: string) => {
    // Keep the text on screen immediately. The results view (and the URL)
    // can lag a heavy render — defer that so the hero can show a spinner
    // instead of looking like Enter did nothing.
    setQuery(value);
    startSearchTransition(() => {
      setActiveQuery(value);
      setSearchParams((prev) => {
        prev.set('q', value);
        prev.set('source', source);
        return prev;
      });
    });
  }, [source, setSearchParams]);

  const handleSourceChange = useCallback((newSource: SourceTabValue) => {
    // External shortcut tabs (Maps / Videos / News ↗) don't filter results —
    // they open the matching engine in a new browser tab with the current
    // query and leave the active source untouched.
    if (isExternalTab(newSource)) {
      // Maps honors the provider chosen in Settings (Google Maps / OSM).
      const url = newSource === 'maps'
        ? getMapsUrl(activeQuery || query, config.mapsProvider ?? 'google')
        : getExternalTabUrl(newSource, activeQuery || query);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    setSource(newSource);
    if (activeQuery) {
      setSearchParams((prev) => {
        prev.set('source', newSource);
        return prev;
      });
    }
  }, [activeQuery, query, config.mapsProvider, setSearchParams]);

  // ─── Hero mode (no search yet) ───
  if (!hasSearched) {
    return (
      <Layout minimal>
        <div className="flex flex-col items-center justify-center min-h-[calc(100vh-8rem)] px-4 py-16">
          <div className="text-center mb-10 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-700">
            <div className="flex items-center justify-center mb-7">
              <div className="relative isolate flex items-center justify-center w-20 h-20 rounded-full border border-primary/25 bg-card/70 shadow-sm">
                <div className="absolute inset-[-18%] -z-10 rounded-full bg-primary/10 blur-2xl motion-reduce:hidden" />
                <LogoMark className="w-12 h-12" />
              </div>
            </div>
            <h1 className="font-display text-5xl sm:text-6xl md:text-7xl font-semibold tracking-[0.22em] mb-3 text-foreground">
              {ENGINE_PROFILE.branding.wordmark}
            </h1>
            <p className="font-display italic text-xl sm:text-2xl text-primary max-w-lg mx-auto leading-snug">
              {ENGINE_PROFILE.branding.slogan}
            </p>
            <p className="mt-2 text-[11px] uppercase tracking-[0.28em] text-muted-foreground/80">
              Matthew 7:7
            </p>
          </div>

          <div className="w-full max-w-2xl mb-4 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 motion-safe:delay-200">
            {/* Autofocus only on the top-level page. Inside an iframe embed
                (e.g. the Shakespeare preview), browsers restore focus to the
                last-focused element when tabbing back into the frame — an
                autofocused input mid-page traps the tab cycle so the header
                (Settings, login) is never reached. Without autofocus the tab
                order starts at the document top: skip link → header → search. */}
            <SearchBar
              value={query}
              onChange={setQuery}
              onSubmit={handleSubmit}
              isLoading={isSearchPending}
              size="large"
              autoFocus={typeof window !== 'undefined' && window.self === window.top}
            />
          </div>

          <div className="mb-6 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500 motion-safe:delay-300">
            <SourceTabs value={source} onChange={handleSourceChange} />
          </div>

          {ENGINE_PROFILE.ui.biblicalQuotes && (
            <div className="mt-2 mb-8 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-700 motion-safe:delay-300">
              <ScriptureVerse />
            </div>
          )}

          <div className="mt-6 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500 motion-safe:delay-500">
            <PrivacyIndicator source={providerSource as SearchSource | 'all'} />
          </div>

          {ENGINE_PROFILE.ui.showTrending && (
            <TrendingQueries
              onSelect={(q) => {
                setQuery(q);
                handleSubmit(q);
              }}
              className="mt-8 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500 motion-safe:delay-700"
            />
          )}
        </div>
      </Layout>
    );
  }

  // ─── Results mode ───
  return (
    <Layout>
      <div className="container py-6">
        <div className="max-w-2xl mb-5">
          <SearchBar
            value={query}
            onChange={setQuery}
            onSubmit={handleSubmit}
            isLoading={isFetching || isSearchPending}
          />
          {/* How the engine understood the query — phrases, boolean, filters */}
          <QueryInsights query={activeQuery} className="mt-2" />
        </div>

        {/* Tabs + provider status */}
        <div className="flex flex-col gap-3 mb-6">
          <div className="flex items-center gap-2 flex-wrap">
            <SourceTabs value={source} onChange={handleSourceChange} counts={hasSearched ? counts : undefined} />
            <PrivacyIndicator source={providerSource as SearchSource | 'all'} className="ml-auto" />
          </div>
          {providers.length > 0 && source !== 'i2p' && (
            <ProviderStatus providers={providers} hasResults={totalResults > 0} />
          )}
          {privacyMode && suppressedProviders.length > 0 && source !== 'i2p' && (
            <p className="text-xs text-green-600 dark:text-green-500 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              Privacy Mode — {suppressedProviders.length} external provider{suppressedProviders.length !== 1 ? 's' : ''} blocked. This search never left the Nostr network.
            </p>
          )}
        </div>

        <div className="max-w-2xl">
          {/* I2P tab — directory links only */}
          {source === 'i2p' && (
            <I2PDirectory query={activeQuery} />
          )}

          {/* Instant answer — shown above everything else */}
          {source !== 'i2p' && instantAnswer && (
            <InstantAnswer answer={instantAnswer} className="mb-4" />
          )}

          {/* AI answer — synthesized from the search evidence (opt-in) */}
          {source !== 'i2p' && ai.active && (ai.isLoading || ai.answer || ai.error) && (
            <AIAnswerCard
              answer={ai.answer}
              evidence={ai.evidence}
              isLoading={ai.isLoading}
              error={ai.error}
              className="mb-4"
            />
          )}

          {/* Community keyword stakes — Presearch-style top placement */}
          {source !== 'i2p' && stakeResults.length > 0 && (
            <div className="space-y-3 mb-4">
              {stakeResults.map((result) => (
                <StakeResultCard key={result.id} result={result} />
              ))}
            </div>
          )}

          {/* Vote tallies load once per visible result set (batched) and
              flow to every card's vote buttons via context. */}
          <VoteTalliesProvider results={[...stakeResults, ...organicResults]}>

          {/* Loading state */}
          {source !== 'i2p' && isLoading && totalResults === 0 ? (
            <SearchSkeleton />
          ) : source !== 'i2p' && isEmpty ? (
            <>
              {!instantAnswer && (
                <Card className="border-dashed mb-4">
                  <CardContent className="py-10 px-8 text-center">
                    <Search className="w-8 h-8 mx-auto mb-3 text-muted-foreground/40" />
                    <p className="text-muted-foreground max-w-sm mx-auto mb-5">
                      No results found for &ldquo;{activeQuery}&rdquo;.
                    </p>
                    {ENGINE_PROFILE.ui.showTrending && (
                      <TrendingQueries
                        limit={5}
                        onSelect={(q) => {
                          setQuery(q);
                          handleSubmit(q);
                        }}
                      />
                    )}
                    {ENGINE_PROFILE.ui.showStake && (
                      <button
                        onClick={() => setStakeOpen(true)}
                        className="inline-flex items-center gap-1.5 mt-5 text-xs text-primary/80 hover:text-primary transition-colors"
                      >
                        <Gem className="w-3 h-3" />
                        Be the first to stake this keyword
                      </button>
                    )}
                  </CardContent>
                </Card>
              )}
              <BrowserFallback query={activeQuery} />
            </>
          ) : source !== 'i2p' && (
            <div className="space-y-3">
              {/* Result count header + stake CTA */}
              {totalResults > 0 && (
                <div ref={resultsTopRef} className="flex items-center justify-between gap-3 mb-1 scroll-mt-24">
                  <p className="text-sm text-muted-foreground">
                    {totalResults} result{totalResults !== 1 ? 's' : ''}
                    {pageCount > 1 && (
                      <span className="text-muted-foreground/60"> · page {currentPage} of {pageCount}</span>
                    )}
                    {source === 'all' && providers.some((p) => p.status === 'searching') && (
                      <span className="ml-2 text-primary animate-search-pulse">more loading...</span>
                    )}
                  </p>
                  {ENGINE_PROFILE.ui.showStake && (
                    <button
                      onClick={() => setStakeOpen(true)}
                      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/70 hover:text-primary transition-colors shrink-0"
                      title="Stake this keyword — your link takes the top spot for this search"
                    >
                      <Gem className="w-3 h-3" />
                      Stake this keyword
                    </button>
                  )}
                </div>
              )}

              {/* Results — paginated; all pages are already in memory and
                  fill in further as providers resolve in the background. */}
              {pagedResults.map((result) => (
                <UnifiedResultCard key={result.id} result={result} />
              ))}

              {pageCount > 1 && (
                <ResultsPagination
                  current={currentPage}
                  total={pageCount}
                  onChange={goToPage}
                  loading={providers.some((p) => p.status === 'searching')}
                />
              )}

              {/* Stakes-only view: no organic results yet, but a stake matched */}
              {organicResults.length === 0 && stakeResults.length > 0 && !isLoading && (
                <Card className="border-dashed">
                  <CardContent className="py-8 px-8 text-center">
                    <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                      No organic results for &ldquo;{activeQuery}&rdquo; yet — just the community
                      stake above.
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* Suggestions */}
              {suggestions.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap pt-2">
                  <span className="text-xs text-muted-foreground">Related:</span>
                  {suggestions.slice(0, 5).map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => {
                        setQuery(suggestion);
                        handleSubmit(suggestion);
                      }}
                      className="text-xs px-2 py-1 rounded-md border border-border/50 text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}

              {/* Browser fallback when sparse (or stakes-only) */}
              {((totalResults > 0 && totalResults < 5) || (totalResults === 0 && stakeResults.length > 0 && !isLoading)) && source !== 'tor' && (
                <BrowserFallback query={activeQuery} className="mt-4" />
              )}
            </div>
          )}
          </VoteTalliesProvider>
        </div>
      </div>

      {ENGINE_PROFILE.ui.showStake && (
        <StakeKeywordDialog
          open={stakeOpen}
          onOpenChange={setStakeOpen}
          initialKeyword={activeQuery}
        />
      )}
    </Layout>
  );
};

/* ─── Results pagination ─── */

/** Page window with gaps: 1 2 … c-1 c c+1 … N. */
function pageWindow(current: number, total: number): (number | 'gap')[] {
  const win = new Set<number>([1, 2, total - 1, total, current - 1, current, current + 1]);
  const sorted = [...win].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push('gap');
    out.push(p);
    prev = p;
  }
  return out;
}

function ResultsPagination({ current, total, onChange, loading }: {
  current: number;
  total: number;
  onChange: (page: number) => void;
  loading: boolean;
}) {
  return (
    <nav className="flex items-center justify-center gap-1.5 pt-4 flex-wrap" aria-label="Result pages">
      <button
        type="button"
        onClick={() => onChange(current - 1)}
        disabled={current <= 1}
        className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors disabled:opacity-40 disabled:pointer-events-none"
        aria-label="Previous page"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>

      {pageWindow(current, total).map((p, i) =>
        p === 'gap' ? (
          <span key={`gap-${i}`} className="px-1 text-muted-foreground/50 text-sm select-none">…</span>
        ) : (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            aria-current={p === current ? 'page' : undefined}
            className={
              p === current
                ? 'inline-flex items-center justify-center min-w-8 h-8 px-2 rounded-lg text-sm font-medium bg-primary/10 text-primary border border-primary/30'
                : 'inline-flex items-center justify-center min-w-8 h-8 px-2 rounded-lg text-sm border border-border/50 text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors'
            }
          >
            {p}
          </button>
        ),
      )}

      <button
        type="button"
        onClick={() => onChange(current + 1)}
        disabled={current >= total}
        className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors disabled:opacity-40 disabled:pointer-events-none"
        aria-label="Next page"
      >
        <ChevronRight className="w-4 h-4" />
      </button>

      {loading && (
        <span className="text-[11px] text-muted-foreground/60 ml-2 animate-search-pulse">
          loading more…
        </span>
      )}
    </nav>
  );
}

/* ─── I2P directory ─── */
function I2PDirectory({ query }: { query: string }) {
  const links = [
    { name: 'Identiguy', url: 'http://identiguy.i2p', desc: 'I2P address book and directory' },
    { name: 'notbob.i2p', url: 'http://notbob.i2p', desc: 'I2P eepsite directory' },
    { name: 'stats.i2p', url: 'http://stats.i2p', desc: 'I2P network statistics' },
  ];

  return (
    <div className="space-y-4">
      <Card className="border-dashed border-i2p/20">
        <CardContent className="py-10 px-8 text-center">
          <Network className="w-8 h-8 mx-auto mb-3 text-i2p/30" />
          <p className="text-muted-foreground max-w-sm mx-auto mb-1">
            I2P search is available via eepsite directories.
          </p>
          <p className="text-xs text-muted-foreground/60">
            There is no public I2P search API. Use the directories below to explore eepsites.
          </p>
        </CardContent>
      </Card>
      <div className="rounded-xl border border-dashed p-5 border-i2p/20 bg-i2p/5">
        <div className="flex items-center gap-2 mb-3">
          <Network className="w-4 h-4 text-i2p/60" />
          <span className="text-sm font-medium text-muted-foreground">Explore I2P eepsites:</span>
        </div>
        <div className="space-y-2">
          {links.map((link) => (
            <a
              key={link.name}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border/30 hover:border-primary/30 hover:bg-primary/5 transition-colors"
            >
              <span className="text-sm font-medium text-foreground">{link.name}</span>
              <span className="text-xs text-muted-foreground flex-1 truncate">{link.desc}</span>
              <ExternalLink className="w-3 h-3 text-muted-foreground/40 shrink-0" />
            </a>
          ))}
        </div>
      </div>
      <BrowserFallback query={query} />
    </div>
  );
}

export default Index;
