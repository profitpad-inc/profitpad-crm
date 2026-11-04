# Exchange rate providers (checked 2026-11-03)

Which free source the CRM looks up exchange rates from (Settings → Currencies, `api/src/currency-rates.ts`). The defense package needs USD, EUR, GBP, AUD, CAD, JPY, SAR, AED, ILS and KRW.

**Chosen: [Frankfurter](https://frankfurter.dev) v2 (`https://api.frankfurter.dev/v2/rates`), with the [European Central Bank](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html) as the second built-in provider.**

## Comparison

| Provider | Key | Limits | SAR, AED, ILS, KRW, JPY | Terms | Notes |
| --- | --- | --- | --- | --- | --- |
| Google | n/a | n/a | n/a | n/a | No official, documented free exchange rate API found. Results were vendor blogs and third-party scrapers branded "Google" (not Google products). Google Sheets' `GOOGLEFINANCE` gives rates inside Sheets but is not an API. I did not find Google's own page stating this, so treat it as unverified. |
| [Frankfurter](https://frankfurter.dev) | none | "no quotas", but rate limited against abuse (no number published) | all five, checked live 2026-11-03 | blended rates "free to use, including commercially"; per-provider endpoints follow each source's terms | Open source, [MIT](https://github.com/lineofflight/frankfurter) (repo last pushed 2026-10-30). Rates from 106 central banks and official sources and 228 currencies, per its site; history back to 1948 (`?date=`). Responses are cached by Cloudflare (`cache-control: max-age=75593` seen). Each quote carries its own publication date (ILS was a day behind the others). Can be self-hosted with Docker. |
| [ECB reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html) | none | none stated | ILS, KRW, JPY yes; **SAR and AED no** | "for information purposes only"; using them for transactions is "strongly discouraged" | About 30 currencies against EUR, around 16:00 CET on working days. The official source, so a good fallback, but it misses two of the defense currencies. |
| [open.er-api.com](https://www.exchangerate-api.com/docs/free) (ExchangeRate-API's open endpoint) | none | rate limited: HTTP 429 for 20 minutes when exceeded (no number published) | AED seen live; the others not checked | **attribution required** ("Rates By Exchange Rate API" link); may cache, may not redistribute | Updates once a day. Historical data on the open endpoint not stated. The attribution rule makes it awkward inside a CRM's reports. |
| [exchangerate.host](https://exchangerate.host) | **required** (a live call without one returned `missing_access_key`) | free plan 100 requests a month | not checked | not checked | Its documentation is hosted on apilayer's site. Ruled out by the key and the 100-request cap. |

Not checked: Open Exchange Rates, Fixer, currencyapi and other key-based services.

## Why Frankfurter

- No key, so nothing to store or rotate per tenant.
- Covers every currency the defense package needs, including SAR and AED, which the ECB lacks.
- Commercial use of its blended rates is allowed on its site; MIT licensed, so we can self-host it if the public service goes away or rate limits us.
- One request per fetch (all currencies in one call); even daily, that is about 30 calls a month per tenant.

Risks: it is a community project with no published uptime promise (I found none), and its rate limit has no published number. The provider is a setting, so a tenant can switch to the ECB (no SAR or AED) and pin those two by hand, and a new provider is one object in `PROVIDERS` (`api/src/currency-rates.ts`).

These are reference rates (central bank mid rates), fine for reporting and pipeline totals. They are not the rate a bank would give for a payment.
