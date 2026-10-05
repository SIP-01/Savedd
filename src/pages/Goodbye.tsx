/**
 * "Heaven" — memorial video wizard (formerly "A Peaceful Goodbye").
 *
 * Five gentle steps: who went home → who they are leaving → their world →
 * preview & consent → generating/result. Submitting posts a multipart form
 * to /api/heaven/generate (photos + JSON fields); the worker handles the
 * Grok Imagine call and this page polls /api/heaven/status/:id until the
 * video is ready, then sends the user to the share page.
 *
 * The same validation runs server-side — the checks here are only for a
 * kind user experience, not security.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSeoMeta } from '@unhead/react';
import {
  Heart, ImagePlus, Loader2, MapPin, PawPrint, Sparkles, Users, X,
} from 'lucide-react';

import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/useToast';
import {
  HOMEGOING_ASPECT_RATIOS,
  HOMEGOING_DURATIONS,
  MAX_PHOTOS_PER_SIDE,
  summarizeHomegoingScene,
  type HomegoingAspectRatio,
  type HomegoingDuration,
  type HomegoingInput,
} from '@/lib/goodbye/homegoing';
import { cn } from '@/lib/utils';

interface PhotoSlot {
  file: File;
  previewUrl: string;
}

const STEPS = [
  { id: 1, title: 'Who went home', icon: Heart },
  { id: 2, title: 'Who they are leaving', icon: Users },
  { id: 3, title: 'Their world', icon: MapPin },
  { id: 4, title: 'Preview', icon: Sparkles },
  { id: 5, title: 'Your video', icon: Sparkles },
] as const;

function PhotoPicker({
  label,
  hint,
  photos,
  onChange,
}: {
  label: string;
  hint: string;
  photos: PhotoSlot[];
  onChange: (photos: PhotoSlot[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const next = [...photos];
    for (const file of Array.from(files)) {
      if (next.length >= MAX_PHOTOS_PER_SIDE) break;
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) continue;
      next.push({ file, previewUrl: URL.createObjectURL(file) });
    }
    onChange(next);
  };

  const remove = (index: number) => {
    const next = [...photos];
    URL.revokeObjectURL(next[index].previewUrl);
    next.splice(index, 1);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="grid grid-cols-3 gap-2">
        {photos.map((photo, i) => (
          <div key={photo.previewUrl} className="relative aspect-square rounded-lg overflow-hidden border border-border/60">
            <img src={photo.previewUrl} alt="" className="w-full h-full object-cover" />
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label="Remove photo"
              className="absolute top-1 right-1 w-8 h-8 rounded-full bg-background/80 backdrop-blur flex items-center justify-center text-foreground/70 hover:text-destructive"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
        {photos.length < MAX_PHOTOS_PER_SIDE && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="aspect-square rounded-lg border border-dashed border-border flex flex-col items-center justify-center gap-1.5 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors min-h-[44px]"
          >
            <ImagePlus className="w-5 h-5" />
            <span className="text-[11px]">Add photo</span>
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

const Goodbye = () => {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [step, setStep] = useState(1);
  const [departedPhotos, setDepartedPhotos] = useState<PhotoSlot[]>([]);
  const [familyPhotos, setFamilyPhotos] = useState<PhotoSlot[]>([]);
  const [departedName, setDepartedName] = useState('');
  const [departedRelationship, setDepartedRelationship] = useState('');
  const [familyNames, setFamilyNames] = useState('');
  const [familyRelationship, setFamilyRelationship] = useState('');
  const [setting, setSetting] = useState('');
  const [pets, setPets] = useState('');
  const [details, setDetails] = useState('');
  const [aspectRatio, setAspectRatio] = useState<HomegoingAspectRatio>('9:16');
  const [duration, setDuration] = useState<HomegoingDuration>(12);
  const [consent, setConsent] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useSeoMeta({
    title: 'Heaven — Savedd.com',
    description: 'A short video of your loved one saying goodbye, and walking home.',
  });

  const input: HomegoingInput = useMemo(
    () => ({
      departedName,
      departedRelationship,
      familyNames,
      familyRelationship,
      setting,
      pets,
      details,
      aspectRatio,
      duration,
      consent,
    }),
    [departedName, departedRelationship, familyNames, familyRelationship, setting, pets, details, aspectRatio, duration, consent],
  );

  const canContinue =
    step === 1 ? departedPhotos.length > 0
    : step === 2 ? familyPhotos.length > 0
    : step === 3 ? setting.trim().length >= 3
    : step === 4 ? consent
    : false;

  // Stop polling on unmount.
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const startPolling = (id: string) => {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/heaven/status/${id}`);
        if (!res.ok) return;
        const data = (await res.json()) as { status?: string; error?: string | { message?: string } };
        if (data.status === 'done') {
          if (pollRef.current) clearInterval(pollRef.current);
          navigate(`/heaven/${id}`);
        } else if (data.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          const message = typeof data.error === 'string' ? data.error : data.error?.message;
          setJobError(message || 'This generation did not complete — please try again.');
          setSubmitting(false);
          setStep(4);
        }
      } catch {
        // transient — keep polling
      }
    }, 4000);
  };

  const submit = async () => {
    setSubmitting(true);
    setJobError(null);
    try {
      const form = new FormData();
      form.set('fields', JSON.stringify(input));
      for (const photo of departedPhotos) form.append('departedPhotos', photo.file);
      for (const photo of familyPhotos) form.append('familyPhotos', photo.file);

      const res = await fetch('/api/heaven/generate', { method: 'POST', body: form });
      const data = (await res.json()) as { id?: string; status?: string; error?: { message?: string } };

      if (!res.ok || !data.id) {
        throw new Error(data.error?.message || 'Could not start the generation.');
      }
      if (data.status === 'failed') {
        throw new Error(data.error?.message || 'The video service could not start this generation.');
      }

      setJobId(data.id);
      setStep(5);
      startPolling(data.id);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : 'Something went wrong.');
      setSubmitting(false);
      toast({
        title: 'Could not start',
        description: error instanceof Error ? error.message : 'Something went wrong.',
        variant: 'destructive',
      });
    }
  };

  return (
    <Layout>
      <div className="container max-w-xl py-8 sm:py-12">
        <div className="mb-6 overflow-hidden rounded-2xl border border-primary/20 shadow-sm">
          <img
            src="/heaven-example.jpg"
            alt="A family watches two figures walk upward into a warm, open sky."
            className="w-full aspect-video object-cover"
          />
        </div>
        <div className="flex items-center gap-3 mb-2">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 border border-primary/20">
            <Heart className="w-5 h-5 text-primary" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-display font-semibold tracking-tight">
            Heaven
          </h1>
        </div>
        <p className="text-muted-foreground mb-6 text-sm leading-relaxed">
          A short video of your loved one saying goodbye, and walking home.
        </p>

        {/* Step indicator */}
        <div className="flex items-center gap-1.5 mb-8" aria-label={`Step ${step} of 5`}>
          {STEPS.map((s) => (
            <div
              key={s.id}
              className={cn(
                'h-1.5 flex-1 rounded-full transition-colors',
                s.id <= step ? 'bg-primary' : 'bg-border/60',
              )}
            />
          ))}
        </div>

        {step === 1 && (
          <Card>
            <CardContent className="py-6 space-y-5">
              <h2 className="font-display text-xl font-semibold">Who went home?</h2>
              <PhotoPicker
                label="Photos of your loved one"
                hint="1–3 clear photos of their face. Adults only."
                photos={departedPhotos}
                onChange={setDepartedPhotos}
              />
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="departedName">First name (optional)</Label>
                  <Input
                    id="departedName"
                    value={departedName}
                    onChange={(e) => setDepartedName(e.target.value)}
                    placeholder="Robert"
                    maxLength={60}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="departedRelationship">They were your… (optional)</Label>
                  <Input
                    id="departedRelationship"
                    value={departedRelationship}
                    onChange={(e) => setDepartedRelationship(e.target.value)}
                    placeholder="dad, mom, husband, friend…"
                    maxLength={60}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <CardContent className="py-6 space-y-5">
              <h2 className="font-display text-xl font-semibold">Who are they leaving?</h2>
              <PhotoPicker
                label="Photos of the family"
                hint="1–3 photos of the family member(s) saying goodbye."
                photos={familyPhotos}
                onChange={setFamilyPhotos}
              />
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="familyNames">First name(s) (optional)</Label>
                  <Input
                    id="familyNames"
                    value={familyNames}
                    onChange={(e) => setFamilyNames(e.target.value)}
                    placeholder="Michael"
                    maxLength={120}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="familyRelationship">Relationship (optional)</Label>
                  <Input
                    id="familyRelationship"
                    value={familyRelationship}
                    onChange={(e) => setFamilyRelationship(e.target.value)}
                    placeholder="his son, her daughters…"
                    maxLength={80}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <Card>
            <CardContent className="py-6 space-y-5">
              <h2 className="font-display text-xl font-semibold">Their world</h2>
              <div className="space-y-1.5">
                <Label htmlFor="setting">A favorite place or activity</Label>
                <Textarea
                  id="setting"
                  value={setting}
                  onChange={(e) => setSetting(e.target.value)}
                  placeholder="Hiking in the mountains, riding horses, in front of his RV, racing snowmobiles, on the porch at the farm…"
                  maxLength={280}
                  rows={3}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pets" className="flex items-center gap-1.5">
                  <PawPrint className="w-3.5 h-3.5 text-primary" />
                  Pets (optional)
                </Label>
                <Input
                  id="pets"
                  value={pets}
                  onChange={(e) => setPets(e.target.value)}
                  placeholder="their golden retriever, Daisy"
                  maxLength={160}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="details">Small details (optional)</Label>
                <Input
                  id="details"
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  placeholder="late autumn, golden hour, the old boat"
                  maxLength={280}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Shape</Label>
                  <div className="flex gap-1.5">
                    {HOMEGOING_ASPECT_RATIOS.map((ratio) => (
                      <Button
                        key={ratio}
                        type="button"
                        variant={aspectRatio === ratio ? 'default' : 'outline'}
                        size="sm"
                        className="flex-1 min-h-[44px]"
                        onClick={() => setAspectRatio(ratio)}
                      >
                        {ratio}
                      </Button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground/70">9:16 is best for sharing to social.</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Length</Label>
                  <div className="flex gap-1.5">
                    {HOMEGOING_DURATIONS.map((d) => (
                      <Button
                        key={d}
                        type="button"
                        variant={duration === d ? 'default' : 'outline'}
                        size="sm"
                        className="flex-1 min-h-[44px] px-0"
                        onClick={() => setDuration(d)}
                      >
                        {d}s
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 4 && (
          <Card>
            <CardContent className="py-6 space-y-5">
              <h2 className="font-display text-xl font-semibold">The scene we will create</h2>
              <p className="text-sm leading-relaxed text-muted-foreground border-l-2 border-primary/40 pl-3">
                {summarizeHomegoingScene(input)}
              </p>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {[...departedPhotos, ...familyPhotos].map((photo) => (
                  <img
                    key={photo.previewUrl}
                    src={photo.previewUrl}
                    alt=""
                    className="w-16 h-16 rounded-lg object-cover border border-border/60 shrink-0"
                  />
                ))}
              </div>
              <label className="flex items-start gap-3 cursor-pointer min-h-[44px]">
                <Checkbox
                  checked={consent}
                  onCheckedChange={(checked) => setConsent(checked === true)}
                  className="mt-0.5"
                  aria-label="Consent"
                />
                <span className="text-xs text-muted-foreground leading-relaxed">
                  I have the right to use these photos. I understand this is an imagined
                  tribute video created with AI.
                </span>
              </label>
              {jobError && (
                <p className="text-sm text-destructive" role="alert">{jobError}</p>
              )}
            </CardContent>
          </Card>
        )}

        {step === 5 && (
          <Card>
            <CardContent className="py-12 px-8 text-center space-y-5">
              <Loader2 className="w-8 h-8 mx-auto text-primary animate-spin" />
              <h2 className="font-display text-xl font-semibold">Creating your video</h2>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
                This usually takes one to three minutes. You can stay on this page —
                we will open your video as soon as it is ready.
              </p>
              <Progress value={undefined} className="max-w-60 mx-auto" />
              <p className="text-[11px] text-muted-foreground/60">Job {jobId}</p>
            </CardContent>
          </Card>
        )}

        {/* Navigation */}
        {step < 5 && (
          <div className="flex items-center justify-between mt-6">
            <Button
              type="button"
              variant="ghost"
              className="min-h-[44px]"
              onClick={() => setStep((s) => Math.max(1, s - 1))}
              disabled={step === 1 || submitting}
            >
              Back
            </Button>
            {step < 4 ? (
              <Button
                type="button"
                className="min-h-[44px] min-w-28"
                onClick={() => setStep((s) => s + 1)}
                disabled={!canContinue}
              >
                Continue
              </Button>
            ) : (
              <Button
                type="button"
                className="min-h-[44px]"
                onClick={() => void submit()}
                disabled={!canContinue || submitting}
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                <span className="ml-1.5">{submitting ? 'Starting…' : 'Create the video'}</span>
              </Button>
            )}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground/60 leading-relaxed mt-8 text-center">
          “Seek, and ye shall find.” — Savedd.com
        </p>
      </div>
    </Layout>
  );
};

export default Goodbye;
