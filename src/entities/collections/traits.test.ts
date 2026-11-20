// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { groupDigits, traitRows } from './traits';

// The Sports collection's keys as the chain read merges them into an item.
const SPORTS = {
  name: 'Sports',
  traits: 'top_speed,contact,difficulty,kcal_hour,fanbase',
  traitLabels: 'Top speed,Contact,Difficulty,Energy burn,Fanbase',
  traitUnits: 'km/h,0-100,scale 10-100,kcal/h,million fans',
  traitScoreMax: '100,100,100,100,100',
};

const BOBSLEIGH = {
  ...SPORTS,
  name: 'Bobsleigh',
  archetype: 'bobsleigh',
  rarity: '3',
  top_speed: '156',
  top_speed_score: '75',
  contact: '0',
  contact_score: '0',
  difficulty: '49.25',
  difficulty_score: '24',
  kcal_hour: '490',
  kcal_hour_score: '38',
  fanbase: '10',
  fanbase_score: '11',
};

describe('traitRows', () => {
  it('lists the traits in the collection order with their labels, units and scores', () => {
    expect(traitRows(BOBSLEIGH)).toEqual([
      {
        key: 'top_speed',
        label: 'Top speed',
        unit: 'km/h',
        value: '156',
        score: { text: '75', max: '100', fill: 0.75 },
      },
      { key: 'contact', label: 'Contact', unit: '0-100', value: '0', score: { text: '0', max: '100', fill: 0 } },
      {
        key: 'difficulty',
        label: 'Difficulty',
        unit: 'scale 10-100',
        value: '49.25',
        score: { text: '24', max: '100', fill: 0.24 },
      },
      {
        key: 'kcal_hour',
        label: 'Energy burn',
        unit: 'kcal/h',
        value: '490',
        score: { text: '38', max: '100', fill: 0.38 },
      },
      {
        key: 'fanbase',
        label: 'Fanbase',
        unit: 'million fans',
        value: '10',
        score: { text: '11', max: '100', fill: 0.11 },
      },
    ]);
  });

  it('reads the bag the chain read returns, which has no prototype', () => {
    const bag = Object.assign(Object.create(null) as Record<string, string>, BOBSLEIGH);
    expect(traitRows(bag).map((row) => row.key)).toEqual([
      'top_speed',
      'contact',
      'difficulty',
      'kcal_hour',
      'fanbase',
    ]);
  });

  it('shows nothing for an item whose collection describes no traits', () => {
    expect(traitRows(undefined)).toEqual([]);
    expect(traitRows({ name: 'Mazagran', caffeine: '120' })).toEqual([]);
  });

  it('shows nothing when the four lists disagree in length', () => {
    const { traitUnits: _units, ...noUnits } = BOBSLEIGH;
    expect(traitRows({ ...BOBSLEIGH, traitLabels: 'Top speed,Contact' })).toEqual([]);
    expect(traitRows(noUnits)).toEqual([]);
  });

  it('leaves out a trait the item holds no value for', () => {
    const { contact: _contact, ...rest } = BOBSLEIGH;
    expect(traitRows(rest).map((row) => row.key)).toEqual(['top_speed', 'difficulty', 'kcal_hour', 'fanbase']);
    expect(traitRows({ ...BOBSLEIGH, contact: '  ' }).map((row) => row.key)).not.toContain('contact');
  });

  it('draws no bar for a missing or unreadable score, or a maximum of 0', () => {
    const { top_speed_score: _score, ...noScore } = BOBSLEIGH;
    expect(traitRows(noScore)[0]).toEqual({ key: 'top_speed', label: 'Top speed', unit: 'km/h', value: '156' });
    expect(traitRows({ ...BOBSLEIGH, top_speed_score: 'fast' })[0]!.score).toBeUndefined();
    expect(traitRows({ ...BOBSLEIGH, top_speed_score: '' })[0]!.score).toBeUndefined();
    expect(traitRows({ ...BOBSLEIGH, traitScoreMax: '0,100,100,100,100' })[0]!.score).toBeUndefined();
  });

  it('keeps the bar between empty and full', () => {
    expect(traitRows({ ...BOBSLEIGH, top_speed_score: '140' })[0]!.score).toEqual({ text: '140', max: '100', fill: 1 });
    expect(traitRows({ ...BOBSLEIGH, top_speed_score: '-5' })[0]!.score).toEqual({ text: '-5', max: '100', fill: 0 });
  });

  it('scores against each trait its own maximum', () => {
    const row = traitRows({ ...BOBSLEIGH, traitScoreMax: '10,100,100,100,100', top_speed_score: '4' })[0]!;
    expect(row.score).toEqual({ text: '4', max: '10', fill: 0.4 });
  });

  it('never reads a key a plain object inherits', () => {
    expect(traitRows({ traits: 'toString', traitLabels: 'Name', traitUnits: 'text', traitScoreMax: '100' })).toEqual(
      [],
    );
  });

  it('groups a long whole number and leaves a year as written', () => {
    const jobs = {
      traits: 'pay,headcount,first_year',
      traitLabels: 'Pay,Rarity,First recorded',
      traitUnits: 'USD/yr,workers,year',
      traitScoreMax: '100,100,100',
      pay: '63190',
      headcount: '1100000',
      first_year: '1650',
    };
    expect(traitRows(jobs).map((row) => row.value)).toEqual(['63,190', '1,100,000', '1650']);
  });
});

describe('groupDigits', () => {
  it('groups five digits or more in threes', () => {
    expect(groupDigits('12345')).toBe('12,345');
    expect(groupDigits('821000')).toBe('821,000');
    expect(groupDigits('-1234567.89')).toBe('-1,234,567.89');
  });

  it('leaves short numbers, decimals and words as written', () => {
    expect(groupDigits('1039')).toBe('1039');
    expect(groupDigits('0.15')).toBe('0.15');
    expect(groupDigits('49.25')).toBe('49.25');
    expect(groupDigits('Indoor')).toBe('Indoor');
    expect(groupDigits('12,345')).toBe('12,345');
  });
});
