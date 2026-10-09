import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import {
  buildCuratedEvent,
  curatedEventKeywords,
  parseCuratedEvent,
} from './curatedSets';

const ADMIN = 'a'.repeat(64);
const STRANGER = 'b'.repeat(64);

function eventFrom(
  template: { kind: number; content: string; tags: string[][] },
  pubkey: string,
): NostrEvent {
  return {
    id: 'c'.repeat(64),
    pubkey,
    sig: 'd'.repeat(128),
    created_at: 1,
    kind: template.kind,
    content: template.content,
    tags: template.tags,
  };
}

describe('buildCuratedEvent', () => {
  it('normalizes the keyword and keeps aliases on k tags', () => {
    const built = buildCuratedEvent({
      keyword: 'Saved!',
      aliases: ['salvation', 'born again'],
      links: [{
        title: 'What it means to be saved',
        url: 'https://example.com/saved',
        snippet: 'A short explanation.',
      }],
    });
    expect(built).not.toBeNull();
    expect(built!.tags).toContainEqual(['d', 'savedd:curated:saved']);
    expect(built!.tags).toContainEqual(['t', 'savedd-curated']);
    expect(built!.tags).toContainEqual(['k', 'saved']);
    expect(built!.tags).toContainEqual(['k', 'salvation']);
    expect(built!.tags).toContainEqual(['k', 'born again']);
    expect(JSON.parse(built!.content)).toEqual([{
      title: 'What it means to be saved',
      url: 'https://example.com/saved',
      snippet: 'A short explanation.',
    }]);
  });

  it('drops links with a bad url and rejects an empty keyword', () => {
    const built = buildCuratedEvent({
      keyword: 'saved',
      aliases: [],
      links: [
        { title: 'Nope', url: 'javascript:alert(1)', snippet: '' },
        { title: 'Yes', url: 'https://example.com/yes', snippet: '' },
      ],
    });
    expect(JSON.parse(built!.content)).toEqual([
      { title: 'Yes', url: 'https://example.com/yes', snippet: '' },
    ]);
    expect(buildCuratedEvent({ keyword: '!!!', aliases: [], links: [] })).toBeNull();
  });
});

describe('parseCuratedEvent', () => {
  const trusted = new Set([ADMIN]);

  it('accepts a trusted author and ignores everyone else', () => {
    const built = buildCuratedEvent({
      keyword: 'saved',
      aliases: ['salvation'],
      links: [{ title: 'Saved', url: 'https://example.com/saved', snippet: 'Hope.' }],
    })!;
    const trustedEvent = eventFrom(built, ADMIN);
    expect(parseCuratedEvent(trustedEvent, trusted)).toEqual([
      { title: 'Saved', url: 'https://example.com/saved', snippet: 'Hope.' },
    ]);
    expect(parseCuratedEvent(eventFrom(built, STRANGER), trusted)).toBeNull();
    expect(curatedEventKeywords(trustedEvent)).toEqual(['saved', 'salvation']);
  });

  it('treats an empty list from a trusted author as a clear', () => {
    const built = buildCuratedEvent({ keyword: 'saved', aliases: [], links: [] })!;
    expect(parseCuratedEvent(eventFrom(built, ADMIN), trusted)).toEqual([]);
  });
});
