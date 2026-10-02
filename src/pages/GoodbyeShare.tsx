/**
 * Share page for a finished "Heaven" memorial video.
 *
 * Public, no login. Fetches /api/heaven/:id/meta and plays the video;
 * the worker injects OG/Twitter tags into this page's HTML so the
 * link unfurls on social platforms. Every share button points at the
 * Savedd.com page URL (not the raw mp4) so shares drive awareness back
 * to the site and its "create your own" entry point.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSeoMeta } from '@unhead/react';
import { Check, Copy, Download, Heart, Loader2, Share2 } from 'lucide-react';

import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/useToast';

interface ShareMeta {
  id: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  departedName?: string;
  departedRelationship?: string;
  aspectRatio?: '9:16' | '16:9';
  videoUrl?: string;
}

const GoodbyeShare = () => {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);

  const shareUrl = `https://savedd.com/heaven/${id}`;
  const who = meta?.departedName || 'a loved one';

  useSeoMeta({
    title: `Heaven — for ${who} — Savedd.com`,
    description: 'An imagined farewell. A picture of hope.',
  });

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/heaven/${id}/meta`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as ShareMeta;
        if (cancelled) return;
        setMeta(data);
        // Keep polling gently while still generating (someone opened the
        // share link early).
        if (data.status === 'pending' || data.status === 'processing') {
          setTimeout(() => void load(), 5000);
        }
      } catch {
        // transient — leave the skeleton up
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: 'Copy failed', description: 'Select the link and copy it manually.', variant: 'destructive' });
    }
  };

  const shareText = encodeURIComponent('An imagined farewell. A picture of hope.');
  const encodedUrl = encodeURIComponent(shareUrl);

  return (
    <Layout>
      <div className="container max-w-xl py-8 sm:py-12">
        {notFound ? (
          <Card className="border-dashed">
            <CardContent className="py-12 px-8 text-center space-y-3">
              <Heart className="w-8 h-8 mx-auto text-muted-foreground/40" />
              <p className="text-muted-foreground text-sm">
                This tribute could not be found — it may have expired.
              </p>
              <Button asChild variant="outline" className="min-h-[44px]">
                <Link to="/heaven">Create your own</Link>
              </Button>
            </CardContent>
          </Card>
        ) : !meta ? (
          <div className="space-y-3">
            <Skeleton className="aspect-[9/16] max-h-[70vh] w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : meta.status !== 'done' ? (
          <Card>
            <CardContent className="py-12 px-8 text-center space-y-4">
              {meta.status === 'failed' ? (
                <>
                  <Heart className="w-8 h-8 mx-auto text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">
                    This generation did not complete.
                  </p>
                  <Button asChild variant="outline" className="min-h-[44px]">
                    <Link to="/heaven">Create another version</Link>
                  </Button>
                </>
              ) : (
                <>
                  <Loader2 className="w-8 h-8 mx-auto text-primary animate-spin" />
                  <p className="text-sm text-muted-foreground">
                    This video is still being created — the page will update when it is ready.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            <div className="text-center space-y-1">
              <h1 className="text-2xl sm:text-3xl font-display font-semibold tracking-tight">
                Heaven
              </h1>
              <p className="text-sm text-muted-foreground">
                For {who} — an imagined tribute, a picture of hope.
              </p>
            </div>

            <Card className="overflow-hidden border-primary/20">
              <video
                src={meta.videoUrl}
                controls
                playsInline
                preload="metadata"
                className={
                  meta.aspectRatio === '16:9'
                    ? 'w-full aspect-video bg-black'
                    : 'w-full max-h-[70vh] aspect-[9/16] bg-black object-contain'
                }
              />
            </Card>

            <p className="text-[11px] text-muted-foreground/70 leading-relaxed text-center">
              An imagined tribute created with AI — not a recording of real events,
              a vision, or a prophecy.
            </p>

            {/* Share */}
            <Card>
              <CardContent className="py-4 space-y-3">
                <p className="text-xs font-medium flex items-center gap-1.5">
                  <Share2 className="w-3.5 h-3.5 text-primary" />
                  Share this tribute
                </p>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={shareUrl}
                    onFocus={(e) => e.target.select()}
                    aria-label="Share link"
                    className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 text-xs font-mono h-11"
                  />
                  <Button onClick={() => void copyLink()} variant="outline" className="shrink-0 min-h-[44px]">
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    <span className="ml-1.5 hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline" size="sm" className="min-h-[44px]">
                    <a
                      href={`https://twitter.com/intent/tweet?url=${encodedUrl}&text=${shareText}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Share on X
                    </a>
                  </Button>
                  <Button asChild variant="outline" size="sm" className="min-h-[44px]">
                    <a
                      href={`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Facebook
                    </a>
                  </Button>
                  <Button asChild variant="outline" size="sm" className="min-h-[44px]">
                    <a
                      href={`https://wa.me/?text=${shareText}%20${encodedUrl}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      WhatsApp
                    </a>
                  </Button>
                  <Button asChild variant="ghost" size="sm" className="min-h-[44px]">
                    <a href={meta.videoUrl} download>
                      <Download className="w-4 h-4" />
                      <span className="ml-1.5">Download</span>
                    </a>
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="text-center space-y-3 pt-2">
              <p className="text-sm text-muted-foreground italic">
                “Seek, and ye shall find.”
              </p>
              <Button asChild className="min-h-[44px]">
                <Link to="/heaven">Create a tribute for someone you love</Link>
              </Button>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
};

export default GoodbyeShare;
