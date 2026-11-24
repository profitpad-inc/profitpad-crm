import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressFrom, autocompleteBody, searchPart, suggestionsFrom } from './address.js';

// Shapes are Google Places (New) responses, as the n8n flow "Test CRM: address autocomplete" handled them.

test('place details become address parts', () => {
  const a = addressFrom({
    formattedAddress: '400-1200 Merivale Rd, Ottawa, ON K2C 3P4, Canada',
    addressComponents: [
      { longText: '400', shortText: '400', types: ['subpremise'] },
      { longText: '1200', shortText: '1200', types: ['street_number'] },
      { longText: 'Merivale Road', shortText: 'Merivale Rd', types: ['route'] },
      { longText: 'Ottawa', shortText: 'Ottawa', types: ['locality', 'political'] },
      { longText: 'Ontario', shortText: 'ON', types: ['administrative_area_level_1', 'political'] },
      { longText: 'Canada', shortText: 'CA', types: ['country', 'political'] },
      { longText: 'K2C 3P4', shortText: 'K2C 3P4', types: ['postal_code'] }
    ]
  });
  assert.deepEqual(a, {
    street_1: '1200 Merivale Road',
    street_2: '400',
    city: 'Ottawa',
    province_code: 'ON',
    province_name: 'Ontario',
    postal_code: 'K2C 3P4',
    country_code: 'CA',
    country_name: 'Canada',
    formatted: '400-1200 Merivale Rd, Ottawa, ON K2C 3P4, Canada'
  });
});

test('a UK address takes its city from postal_town', () => {
  const a = addressFrom({ addressComponents: [{ longText: 'London', shortText: 'London', types: ['postal_town'] }] });
  assert.equal(a.city, 'London');
  assert.equal(a.street_1, '');
});

test('suggestions: at most six, place predictions only', () => {
  const p = (i: number) => ({ placePrediction: { placeId: `ChIJ${i}xxxxxxxx`, text: { text: `${i} Main St, Toronto` }, structuredFormat: { mainText: { text: `${i} Main St` }, secondaryText: { text: 'Toronto, ON' } } } });
  const s = suggestionsFrom({ suggestions: [{ queryPrediction: { text: { text: 'main' } } }, ...[1, 2, 3, 4, 5, 6, 7].map(p)] });
  assert.equal(s.length, 6);
  assert.deepEqual(s[0], { place_id: 'ChIJ1xxxxxxxx', main: '1 Main St', secondary: 'Toronto, ON', label: '1 Main St, Toronto' });
  assert.deepEqual(suggestionsFrom({}), []);
});

test('each box searches its own kind of place', () => {
  assert.deepEqual(autocompleteBody('90210', ['US'], undefined, 'postal_code'), { input: '90210', includedPrimaryTypes: ['postal_code'], includedRegionCodes: ['us'] });
  assert.deepEqual(autocompleteBody('Otta', [], 'abcdefgh', 'city'), { input: 'Otta', includedPrimaryTypes: ['(cities)'], sessionToken: 'abcdefgh' });
  assert.deepEqual(autocompleteBody('K2C 3P4', [], undefined, 'postal_code').includedPrimaryTypes, ['postal_code']);
  assert.deepEqual(autocompleteBody('1 Main', []), { input: '1 Main' });
  // a whole address in the postal code or city box searches every place
  assert.equal('includedPrimaryTypes' in autocompleteBody('1200 Merivale Rd, Ottawa', [], undefined, 'postal_code'), false);
  assert.equal('includedPrimaryTypes' in autocompleteBody('1200 Merivale Rd', [], undefined, 'city'), false);
  assert.equal(searchPart('country'), 'country');
  assert.equal(searchPart('street_2'), 'street_1');
  assert.equal(searchPart('__proto__'), 'street_1');
  assert.equal(searchPart(undefined), 'street_1');
});
