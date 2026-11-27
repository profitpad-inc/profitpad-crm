import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketLabel, bucketShort, chartMarkdown, darkStep, nextBucket, type ChartCard } from './charts.js';

test('date buckets are named and stepped like a calendar', () => {
  assert.equal(bucketLabel('2026-11-01', 'month'), 'Nov 2026');
  assert.equal(bucketLabel('2026-10-01', 'quarter'), 'Q4 2026');
  assert.equal(bucketLabel('2026-11-23', 'week'), 'Week of Nov 23, 2026');
  assert.equal(bucketLabel('2026-01-01', 'year'), '2026');
  assert.equal(bucketShort('2026-11-23', 'day'), 'Nov 23');
  assert.equal(nextBucket('2026-12-01', 'month'), '2027-01-01');
  assert.equal(nextBucket('2026-10-01', 'quarter'), '2027-01-01');
  assert.equal(nextBucket('2026-11-23', 'week'), '2026-11-30');
  assert.equal(nextBucket('2024-02-28', 'day'), '2024-02-29');
});

test('dark mode steps bright colours down and leaves dark ones alone', () => {
  assert.equal(darkStep('#3b82f6'), '#3b82f6');
  assert.equal(darkStep('#f97316'), '#e96400');
  assert.equal(darkStep('#10b981'), '#00ad76');
  assert.equal(darkStep('not a colour'), 'not a colour');
});

test('the markdown copy lists every group, its share and the total', () => {
  const card: ChartCard = {
    view: 'chart', crm:{ title: 'ProfitPad CRM', url: null }, theme: { light: {}, dark: {} }, list_url: null,
    object: { api_name: 'deals', label: 'Deal', label_plural: 'Deals', icon: '' },
    chart: {
      type: 'pie', metric: 'count', axis: 'category', title: 'Deals by stage', measure: 'Number of deals', group_label: 'Stage', currency: null,
      records: 4, undated: 0, total: { value: 4, text: '4' },
      points: [
        { key: 'won', label: 'Closed won', short: 'Closed won', value: 3, text: '3', records: 3, share: 0.75, color: '#3b82f6', color_dark: '#3b82f6' },
        { key: null, label: 'Other (2)', short: 'Other (2)', value: 1, text: '1', records: 1, share: 0.25, color: '#6b7280', color_dark: '#6b7280', other: true }
      ]
    }
  };
  const md = chartMarkdown(card);
  assert.match(md, /^\*\*Deals by stage\*\* \(Number of deals, from 4 deals\)/);
  assert.match(md, /\| Closed won \| 3 \| 75\.0% \|/);
  assert.match(md, /\| Other \(2\) \| 1 \| 25\.0% \|/);
  assert.match(md, /\| \*\*Total\*\* \| \*\*4\*\* \| 100% \|$/);
});
