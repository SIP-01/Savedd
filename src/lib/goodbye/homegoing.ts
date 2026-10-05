/**
 * "Heaven" (internal name: Homegoing, formerly "A Peaceful Goodbye") — shared core.
 *
 * This module holds every piece of the homegoing-video feature that is
 * testable without a server runtime: input validation, sanitization, and
 * assembly of the Grok Imagine video prompt. `worker.ts` is a thin HTTP
 * shell over these functions, and the wizard page reuses the same
 * validation so client and server can never disagree.
 *
 * Product invariants (enforced here, tested in homegoing.test.ts):
 *   - Consent is mandatory — the payload is rejected without it.
 *   - The story is fixed: embrace → reassurance → goodbye → walking with
 *     Jesus into the sky. User text can only colour the setting, never
 *     rewrite the plot.
 *   - Every prompt carries the guardrails: no speaking, no graves/
 *     coffins/illness, adult subjects, faithful faces, modest clothing,
 *     and the "Savedd.com" watermark spelled with two Ds.
 *   - User text is length-capped and control-character-stripped so the
 *     wizard cannot be used to smuggle arbitrary instructions past the
 *     template.
 */

/** Maximum photos per side (departed / family). Matches the wizard UI. */
export const MAX_PHOTOS_PER_SIDE = 3;

/** Aspect ratios offered in the wizard. */
export const HOMEGOING_ASPECT_RATIOS = ['9:16', '16:9'] as const;
export type HomegoingAspectRatio = (typeof HOMEGOING_ASPECT_RATIOS)[number];

/** Durations offered in the wizard (seconds). */
export const HOMEGOING_DURATIONS = [8, 10, 12, 15] as const;
export type HomegoingDuration = (typeof HOMEGOING_DURATIONS)[number];

export const HOMEGOING_MODEL = 'grok-imagine-video-1.5';
export const HOMEGOING_RESOLUTION = '720p';

/** The fixed, user-facing watermark string. Two Ds. Do not "fix" the spelling. */
export const WATERMARK_TEXT = 'Savedd.com';

/** Inputs collected by the wizard (photos are handled separately as files). */
export interface HomegoingInput {
  /** Optional first name of the departed (display only). */
  departedName: string;
  /** e.g. "dad", "mom", "husband", "friend". */
  departedRelationship: string;
  /** Optional first name(s) of the family member(s) who remain. */
  familyNames: string;
  /** e.g. "his son", "her daughters". */
  familyRelationship: string;
  /** Required: favorite place or activity, one concrete sentence. */
  setting: string;
  /** Optional pets, e.g. "their golden retriever, Daisy". */
  pets: string;
  /** Optional extra detail: season, time of day, meaningful objects. */
  details: string;
  aspectRatio: HomegoingAspectRatio;
  duration: HomegoingDuration;
  /** Must be true — "I have the right to use these photos…". */
  consent: boolean;
}

const TEXT_LIMITS = {
  departedName: 60,
  departedRelationship: 60,
  familyNames: 120,
  familyRelationship: 80,
  setting: 280,
  pets: 160,
  details: 280,
} as const;

/** Strip control chars / template-hostile characters, collapse whitespace, cap length. */
export function sanitizeText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[<>{}`\\]|[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * Validate wizard input. Returns the cleaned input, or an error string.
 * Photo counts are validated by the caller (files live outside this payload).
 */
export function validateHomegoingInput(raw: unknown): HomegoingInput | string {
  if (typeof raw !== 'object' || raw === null) return 'Body must be a JSON object';
  const r = raw as Record<string, unknown>;

  const input: HomegoingInput = {
    departedName: sanitizeText(r.departedName, TEXT_LIMITS.departedName),
    departedRelationship: sanitizeText(r.departedRelationship, TEXT_LIMITS.departedRelationship),
    familyNames: sanitizeText(r.familyNames, TEXT_LIMITS.familyNames),
    familyRelationship: sanitizeText(r.familyRelationship, TEXT_LIMITS.familyRelationship),
    setting: sanitizeText(r.setting, TEXT_LIMITS.setting),
    pets: sanitizeText(r.pets, TEXT_LIMITS.pets),
    details: sanitizeText(r.details, TEXT_LIMITS.details),
    aspectRatio: HOMEGOING_ASPECT_RATIOS.includes(r.aspectRatio as HomegoingAspectRatio)
      ? (r.aspectRatio as HomegoingAspectRatio)
      : '9:16',
    duration: HOMEGOING_DURATIONS.includes(r.duration as HomegoingDuration)
      ? (r.duration as HomegoingDuration)
      : 12,
    consent: r.consent === true,
  };

  if (!input.consent) {
    return 'Please confirm you have the right to use these photos and understand this is an imagined tribute.';
  }
  if (input.setting.length < 3) {
    return 'Please describe a favorite place or activity (e.g. "hiking in the mountains").';
  }
  return input;
}

/** Display name for the departed, falling back to the relationship. */
function departedLabel(input: HomegoingInput): string {
  if (input.departedName && input.departedRelationship) {
    return `${input.departedName} (their ${input.departedRelationship})`;
  }
  return input.departedName || (input.departedRelationship ? `the ${input.departedRelationship}` : 'the departed');
}

/** Display label for the remaining family. */
function familyLabel(input: HomegoingInput): string {
  if (input.familyNames && input.familyRelationship) {
    return `${input.familyNames} (${input.familyRelationship})`;
  }
  return input.familyNames || input.familyRelationship || 'their loved ones';
}

/**
 * Assemble the fixed-story Imagine prompt.
 *
 * Reference images are addressed positionally ("reference image 1…N") so the
 * model can bind faces; ordering is departed first, then family.
 */
export function buildHomegoingPrompt(
  input: HomegoingInput,
  departedPhotoCount: number,
  familyPhotoCount: number,
): string {
  const departedRefs = Array.from({ length: departedPhotoCount }, (_, i) => i + 1);
  const familyRefs = Array.from({ length: familyPhotoCount }, (_, i) => departedPhotoCount + i + 1);

  const refLine = (refs: number[]) =>
    refs.length > 0 ? ` (reference image${refs.length > 1 ? 's' : ''} ${refs.join(', ')})` : '';

  const departed = departedLabel(input);
  const family = familyLabel(input);

  const petsLine = input.pets
    ? `Include their pet(s) naturally and calmly near the family: ${input.pets}.`
    : 'No pets in the scene.';

  const detailsLine = input.details ? `Additional detail to honor: ${input.details}.` : null;

  return [
    `Generate a solemn, peaceful, thoughtful, cinematic memorial video. No speaking, no captions, no subtitles, no on-screen text except a small tasteful ${WATERMARK_TEXT} watermark centered at the bottom (spelled S-A-V-E-D-D, two Ds). Photorealistic, gentle warm light, slow camera, quiet reverence. Do not add logos, slogans, or graphics on clothing. Do not depict injury, illness, a funeral, a grave, a coffin, or death itself. This is a farewell and homegoing, not a death scene. All people depicted are adults.`,
    '',
    'CHARACTERS (match the reference photos closely: face, age, hair, skin tone, body type):',
    `- The departed: ${departed}${refLine(departedRefs)}.`,
    `- Loved ones present: ${family}${refLine(familyRefs)}.`,
    '- Jesus Christ: traditional, recognizable, kind, luminous but not garish — long hair, beard, simple light-colored robe, warm eyes, gentle expression. He is comforting, not theatrical.',
    '',
    'SETTING:',
    `${input.setting}.`,
    petsLine,
    detailsLine,
    'Weather and time of day should feel peaceful: late-golden-hour or soft morning light.',
    '',
    `STORY BEATS (one continuous shot or two very gentle cuts, ${input.duration} seconds total):`,
    '1. The departed and their loved ones share a loving, tearful embrace in the setting. Faces are close. The love is visible. Movement is slow.',
    '2. Jesus approaches quietly from the light. He looks the remaining family in the eyes. They are reassured — grief mixed with peace, not panic.',
    '3. The departed looks back, bids a silent tearful goodbye, then turns and walks side by side with Jesus, hand in hand.',
    '4. They walk upward into a beautiful open sky toward heaven: soft clouds, warm rays, a sense of being welcomed. The family remains behind, watching with love, facing toward their departing loved one, not toward the \'camera\'.',
    '',
    'STYLE:',
    '- No speaking. No lip movement that looks like speech.',
    '- Keep faces faithful to the uploaded people. Do not swap identities. Do not age or de-age anyone except to match the photos.',
    '- Modest clothing. Remove or ignore graphics on shirts from the source photos.',
    '- Jesus should never look cartoonish, menacing, or celebrity-like.',
    '- End on the two figures walking into the light, family watching from below.',
    '- Fade music out so it isn\'t cut off abruptly at the end.',
    '',
    'WATERMARK:',
    'Small, tasteful, semi-transparent "SAVEDD.COM" in the bottom center. Two Ds. Do not cover faces.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** Short human summary shown on the wizard's preview step. */
export function summarizeHomegoingScene(input: HomegoingInput): string {
  const pets = input.pets ? ` ${input.pets} are nearby.` : '';
  return (
    `${departedLabel(input)} shares a tearful goodbye embrace with ${familyLabel(input)} ` +
    `${input.setting}.${pets} Jesus arrives, reassures the family, and walks hand in hand ` +
    `with ${input.departedName || 'the departed'} into a beautiful sky.`
  );
}

/** Public metadata stored with a completed video (drives the share page). */
export interface HomegoingMeta {
  id: string;
  departedName: string;
  departedRelationship: string;
  aspectRatio: HomegoingAspectRatio;
  duration: HomegoingDuration;
  createdAt: number;
}

/** Job states persisted in KV while a generation is in flight. */
export type HomegoingJobStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface HomegoingJob {
  id: string;
  status: HomegoingJobStatus;
  /** xAI request_id once submitted. */
  requestId?: string;
  /** Public path of the stored video once done, e.g. /api/heaven/<id>/video (legacy R2-hosted jobs). */
  videoPath?: string;
  /** xAI-hosted public CDN URL (files-cdn.x.ai) once done — preferred; bytes stay on xAI. */
  externalUrl?: string;
  /** xAI Files API id of the stored video — needed to revoke/delete it later. */
  externalFileId?: string;
  error?: string;
  /** Redacted upstream error snippet for operator debugging (never sent to clients). */
  debug?: string;
  meta: HomegoingMeta;
  prompt: string;
  createdAt: number;
}
