// Tracking parameters every form submission keeps from its page URL. Same
// list as api/src/form-tracking.ts (a test checks they match).
export const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id'
] as const;
