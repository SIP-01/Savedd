/**
 * Publish a curated result set for one search.
 *
 * Signed with the logged-in key. Readers only trust the owner, admins,
 * and moderators, so a normal account can submit the event and it still
 * will not replace the open web.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Loader2, Plus, X } from 'lucide-react';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';
import { buildCuratedEvent, type CuratedLink } from '@/lib/curatedSets';
import { findCuratedSet } from '@/lib/providers/curated';
import { normalizeQuery } from '@/lib/searchIndex';
import { isValidSubmissionUrl } from '@/lib/contentType';

interface CurateKeywordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialKeyword?: string;
}

const EMPTY_ROW: CuratedLink = { title: '', url: '', snippet: '' };

export function CurateKeywordDialog({ open, onOpenChange, initialKeyword = '' }: CurateKeywordDialogProps) {
  const { user } = useCurrentUser();
  const { mutate: createEvent, isPending } = useNostrPublish();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [keyword, setKeyword] = useState(initialKeyword);
  const [aliases, setAliases] = useState('');
  const [rows, setRows] = useState<CuratedLink[]>([{ ...EMPTY_ROW }]);
  const [error, setError] = useState<string | null>(null);
  const applied = useRef('');

  const normalized = normalizeQuery(keyword);
  const { data, isFetching } = useQuery({
    queryKey: ['curated-set', normalized],
    enabled: open && normalized.length > 0,
    queryFn: ({ signal }) => findCuratedSet(keyword, signal),
  });

  useEffect(() => {
    if (!open) {
      applied.current = '';
      return;
    }
    setKeyword(initialKeyword);
    setAliases('');
    setRows([{ ...EMPTY_ROW }]);
    setError(null);
  }, [open, initialKeyword]);

  useEffect(() => {
    if (!open || !data) return;
    if (data.keyword !== normalized) return;
    const key = `${data.keyword}:${data.links.map((l) => l.url).join('|')}`;
    if (applied.current === key) return;
    applied.current = key;
    setRows(data.links.length > 0 ? data.links : [{ ...EMPTY_ROW }]);
    setAliases(data.aliases.join(', '));
  }, [open, data, normalized]);

  const updateRow = (index: number, patch: Partial<CuratedLink>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const publish = (links: CuratedLink[], aliasText: string, cleared: boolean) => {
    setError(null);
    const template = buildCuratedEvent({
      keyword,
      aliases: aliasText.split(/[,\n]/),
      links,
    });
    if (!template) {
      setError('Enter a keyword.');
      return;
    }
    createEvent(template, {
      onSuccess: () => {
        toast({
          title: cleared ? 'Curated results removed' : 'Curated results published',
          description: cleared
            ? `"${keyword.trim()}" shows the open web again.`
            : `"${keyword.trim()}" now shows this list instead of the open web.`,
        });
        void queryClient.invalidateQueries({ queryKey: ['provider-search'] });
        void queryClient.invalidateQueries({ queryKey: ['curated-set'] });
        onOpenChange(false);
      },
      onError: (err) => setError(err.message || 'Failed to publish. Try again.'),
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const links = rows.filter((row) => row.title.trim() || row.url.trim());
    if (links.length === 0) {
      setError('Add at least one result, or use Remove to clear the list.');
      return;
    }
    if (links.some((row) => !row.title.trim() || !isValidSubmissionUrl(row.url))) {
      setError('Every result needs a title and an https:// link.');
      return;
    }
    publish(links, aliases, false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="w-5 h-5 text-primary" />
            Curate this search
          </DialogTitle>
          <DialogDescription>
            These links replace Brave and the index when someone searches this
            keyword. The event is signed with your Nostr key. Only the owner,
            an admin, or a moderator is trusted.
          </DialogDescription>
        </DialogHeader>

        {!user ? (
          <p className="text-sm text-muted-foreground py-4">Log in with your admin key first.</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="curate-keyword">Keyword</Label>
              <Input
                id="curate-keyword"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="saved"
              />
              <p className="text-[11px] text-muted-foreground">Exact match. Punctuation is ignored, so “Saved!” is the same as “saved”.</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="curate-aliases">Also show for</Label>
              <Input
                id="curate-aliases"
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                placeholder="salvation, born again"
              />
            </div>

            {isFetching && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading the current list…
              </p>
            )}

            <div className="space-y-3">
              {rows.map((row, index) => (
                <div key={index} className="space-y-2 rounded-lg border border-border/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Result {index + 1}</span>
                    {rows.length > 1 && (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                        aria-label={`Remove result ${index + 1}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <Input
                    value={row.title}
                    onChange={(e) => updateRow(index, { title: e.target.value })}
                    placeholder="Title"
                    aria-label={`Title ${index + 1}`}
                  />
                  <Input
                    value={row.url}
                    onChange={(e) => updateRow(index, { url: e.target.value })}
                    placeholder="https://"
                    aria-label={`Link ${index + 1}`}
                  />
                  <Textarea
                    value={row.snippet}
                    onChange={(e) => updateRow(index, { snippet: e.target.value })}
                    placeholder="Short description"
                    rows={2}
                    aria-label={`Description ${index + 1}`}
                  />
                </div>
              ))}
              {rows.length < 20 && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => setRows((current) => [...current, { ...EMPTY_ROW }])}
                >
                  <Plus className="w-4 h-4" />
                  Add a result
                </Button>
              )}
            </div>

            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={isPending || !data || data.links.length === 0}
                onClick={() => publish([], '', true)}
              >
                Remove
              </Button>
              <Button type="submit" disabled={isPending || !keyword.trim()}>
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Publish'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
