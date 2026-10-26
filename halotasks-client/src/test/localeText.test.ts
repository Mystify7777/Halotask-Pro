import { describe, expect, it } from 'vitest';
import { clockOf, namesDay, namesSomeDay, shortMonth, withoutClock } from './localeText';

// The helpers every locale-independent label assertion relies on, checked against the renderings real locales give.

describe('clockOf', () => {
  it.each([
    ['Due today, 5:30 PM', '17:30'], // en-US
    ['Due today, 5:30 pm', '17:30'], // en-IN, lowercase
    ['Due today, 5:30\u202fPM', '17:30'], // narrow no-break space before the day period (newer ICU)
    ['Due today, 5:30 p.m.', '17:30'], // dotted day period
    ['Due today, 17:30', '17:30'], // en-GB, de-DE, 24h
    ['Due today, 17:30 Uhr', '17:30'],
    ['for 05:30 pm.', '17:30'], // the reminder body uses a two-digit hour
    ['Starts 20 Oct, 3:00 pm', '15:00'],
    ['Starts Oct 19, 10:30 PM', '22:30'],
    ['Due today, 12:05 am', '00:05'], // just after midnight
    ['Due today, 12:05 pm', '12:05'], // just after noon
    ['Due today, 12:00 AM', '00:00'],
    ['Due today, 3:30 am', '03:30'],
  ])('%s -> %s', (label, expected) => {
    expect(clockOf(label)).toBe(expected);
  });

  it.each(['Due today', 'Due 20 Oct', ''])('is null when there is no clock: %j', (label) => {
    expect(clockOf(label)).toBeNull();
  });

  it('tells different readings apart, so an assertion on it is not vacuous', () => {
    expect(clockOf('5:30 pm')).not.toBe(clockOf('5:30 am'));
    expect(clockOf('5:30 pm')).not.toBe(clockOf('5:00 pm'));
  });
});

describe('namesDay', () => {
  const oct = shortMonth(10);
  const dec = shortMonth(12);

  it.each([`Due ${oct} 20`, `Due 20 ${oct}`, `Starts ${oct} 20, 3:00 pm`, `Starts 20 ${oct}, 15:00`])('%s names 20 October', (label) => {
    expect(namesDay(label, 10, 20)).toBe(true);
  });

  it('is exact about the day: 2 and 200 are not 20, and a neighbouring day is not it', () => {
    expect(namesDay(`Due ${oct} 2`, 10, 20)).toBe(false);
    expect(namesDay(`Due ${oct} 200`, 10, 20)).toBe(false);
    expect(namesDay(`Due ${oct} 19`, 10, 20)).toBe(false);
    expect(namesDay(`Due ${oct} 21`, 10, 20)).toBe(false);
  });

  it('is exact about the month, and ignores the clock when reading the day', () => {
    expect(namesDay(`Due ${dec} 20`, 10, 20)).toBe(false);
    expect(namesDay(`Starts ${oct} 20, 3:00 pm`, 10, 3)).toBe(false); // the 3 is the hour, not the day
  });

  it('a label with no date, or two numbers, does not match', () => {
    expect(namesDay('Due today', 10, 20)).toBe(false);
    expect(namesDay(`Due ${oct} 20 21`, 10, 20)).toBe(false);
  });

  it('namesSomeDay accepts any single month and day, and nothing else', () => {
    expect(namesSomeDay(`Due ${dec} 25`)).toBe(true);
    expect(namesSomeDay(`Due 7 ${oct}`)).toBe(true);
    expect(namesSomeDay('Due today')).toBe(false);
    expect(namesSomeDay('Due tomorrow')).toBe(false);
  });

  it('withoutClock leaves the date part', () => {
    expect(withoutClock('Starts 20 Oct, 3:00 pm').replace(/[\s,]+$/, '')).toBe('Starts 20 Oct');
  });
});
