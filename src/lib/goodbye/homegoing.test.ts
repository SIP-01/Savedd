import { describe, expect, it } from 'vitest';

import {
  HOMEGOING_DURATIONS,
  HOMEGOING_ASPECT_RATIOS,
  WATERMARK_TEXT,
  buildHomegoingPrompt,
  sanitizeText,
  summarizeHomegoingScene,
  validateHomegoingInput,
  type HomegoingInput,
} from './homegoing';

const validInput: HomegoingInput = {
  departedName: 'Robert',
  departedRelationship: 'dad',
  familyNames: 'Michael',
  familyRelationship: 'his son',
  setting: 'in front of his RV at the lake',
  pets: 'their golden retriever, Daisy',
  details: 'late autumn, golden hour',
  aspectRatio: '9:16',
  duration: 12,
  consent: true,
};

describe('sanitizeText', () => {
  it('strips template-hostile characters and collapses whitespace', () => {
    expect(sanitizeText('hello <script>{{x}} `code` \\ path\n\nworld', 100)).toBe(
      'hello script x code path world',
    );
  });

  it('caps length', () => {
    expect(sanitizeText('a'.repeat(500), 10)).toBe('a'.repeat(10));
  });

  it('returns empty string for non-strings', () => {
    expect(sanitizeText(42, 10)).toBe('');
    expect(sanitizeText(undefined, 10)).toBe('');
  });
});

describe('validateHomegoingInput', () => {
  it('accepts a valid payload', () => {
    const result = validateHomegoingInput(validInput);
    expect(typeof result).not.toBe('string');
  });

  it('rejects missing consent', () => {
    const result = validateHomegoingInput({ ...validInput, consent: false });
    expect(typeof result).toBe('string');
  });

  it('rejects an empty setting', () => {
    const result = validateHomegoingInput({ ...validInput, setting: '  ' });
    expect(typeof result).toBe('string');
  });

  it('rejects non-object bodies', () => {
    expect(typeof validateHomegoingInput('nope')).toBe('string');
    expect(typeof validateHomegoingInput(null)).toBe('string');
  });

  it('falls back to defaults for unknown aspect ratio / duration', () => {
    const result = validateHomegoingInput({ ...validInput, aspectRatio: '21:9', duration: 99 });
    if (typeof result === 'string') throw new Error('should be valid');
    expect(result.aspectRatio).toBe(HOMEGOING_ASPECT_RATIOS[0]);
    expect(HOMEGOING_DURATIONS).toContain(result.duration);
  });
});

describe('buildHomegoingPrompt', () => {
  const prompt = buildHomegoingPrompt(validInput, 1, 2);

  it('always includes the four fixed story beats', () => {
    expect(prompt).toContain('STORY BEATS');
    expect(prompt).toContain('tearful embrace');
    expect(prompt).toContain('looks the remaining family in the eyes');
    expect(prompt).toContain('silent tearful goodbye');
    expect(prompt).toContain('hand in hand');
    expect(prompt).toContain('toward heaven');
  });

  it('always includes the guardrails', () => {
    expect(prompt).toContain('No speaking');
    expect(prompt).toContain('grave');
    expect(prompt).toContain('coffin');
    expect(prompt).toContain('All people depicted are adults');
    expect(prompt).toContain('Modest clothing');
  });

  it('watermark is Savedd.com with two Ds, bottom center', () => {
    expect(WATERMARK_TEXT).toBe('Savedd.com');
    expect(prompt).toContain('S-A-V-E-D-D, two Ds');
    expect(prompt).toContain('bottom center');
  });

  it('maps reference images: departed first, then family', () => {
    expect(prompt).toContain('Robert (their dad) (reference image 1)');
    expect(prompt).toContain('Michael (his son) (reference images 2, 3)');
  });

  it('includes pets and details when provided', () => {
    expect(prompt).toContain('Daisy');
    expect(prompt).toContain('late autumn, golden hour');
  });

  it('omits the details line when empty and declares no pets', () => {
    const bare = buildHomegoingPrompt({ ...validInput, pets: '', details: '' }, 1, 1);
    expect(bare).toContain('No pets in the scene.');
    expect(bare).not.toContain('Additional detail to honor');
  });

  it('falls back to relationship labels when names are missing', () => {
    const noNames = buildHomegoingPrompt(
      { ...validInput, departedName: '', familyNames: '' },
      1,
      1,
    );
    expect(noNames).toContain('the dad');
    expect(noNames).toContain('his son');
  });

  it('injects the chosen duration into the beats', () => {
    expect(buildHomegoingPrompt({ ...validInput, duration: 15 }, 1, 1)).toContain(
      '15 seconds total',
    );
  });
});

describe('summarizeHomegoingScene', () => {
  it('produces a readable one-line preview', () => {
    const summary = summarizeHomegoingScene(validInput);
    expect(summary).toContain('Robert');
    expect(summary).toContain('Michael');
    expect(summary).toContain('in front of his RV at the lake');
    expect(summary).toContain('Daisy');
  });
});
