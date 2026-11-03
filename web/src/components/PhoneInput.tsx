import { useEffect, useRef, useState } from 'react';
import { composePhone, regionForNumber, regionLabel, regionShort, type PhoneRegions } from '../public/phone-regions';
import { Select } from './Select';

// What the API's phone check answers (POST /v1/phone/validate)
export interface PhoneResult {
  valid: boolean;
  // e.g. +1 613-222-0328 ext4
  display: string | null;
  region?: string | null;
  reason: string | null;
}

// Where the country list and the check come from: the API in the CRM, the
// page (bridge calls) in a custom view's frame, which has no network.
export interface PhoneSource {
  regions: () => Promise<PhoneRegions>;
  check: (number: string) => Promise<PhoneResult>;
}

// Phone properties: a country picker and the number. A number typed without
// + gets the picked country's code in front (composePhone); the API checks
// it with Google's libphonenumber and stores +16132220328ext4. Commits when
// focus leaves both controls, not when moving between them. With check (forms
// that save later, like Create), leaving them also checks the number: a valid
// one is shown formatted (+1 613-222-0328 ext4) and its country picked, an
// invalid one gets a message under the box.
export function PhoneInput({ value, onChange, autoFocus, onCommit, source, check, classes }: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  onCommit?: (value?: string) => void;
  source: PhoneSource;
  check?: boolean;
  classes?: { input?: string; select?: string; error?: string };
}) {
  const [regions, setRegions] = useState<PhoneRegions | null>(null);
  const [region, setRegion] = useState<string>('');
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  // the latest text, for check answers that come back after more typing
  const textRef = useRef(value);
  textRef.current = text;

  useEffect(() => {
    source.regions().then((r) => {
      setRegions(r);
      setRegion((cur) => cur || (regionForNumber(value, r.regions, r.default) ?? r.default));
    }).catch(() => undefined);
    // only the starting value picks the region
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const picked = regions?.regions.find((r) => r.region === region);
  const emit = (t: string, r = picked) => {
    const composed = composePhone(t, r);
    onChange(composed);
    return composed;
  };

  async function checkNow() {
    const typed = text;
    const composed = composePhone(typed, picked);
    if (!composed) {
      setError(null);
      return;
    }
    let result: PhoneResult;
    try {
      result = await source.check(composed);
    } catch {
      return; // offline or refused: the save checks it again
    }
    // changed while we asked
    if (typed !== textRef.current) return;
    if (result.valid && result.display) {
      setText(result.display);
      textRef.current = result.display;
      if (result.region && regions?.regions.some((r) => r.region === result.region)) setRegion(result.region);
      onChange(result.display);
      setError(null);
    } else {
      setError(`Not a valid phone number${result.reason ? ` (${result.reason})` : ''}`);
    }
  }
  return (
    <>
      <div
        className="phone-input"
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          if (onCommit) onCommit(composePhone(text, picked));
          if (check) checkNow();
        }}
      >
        {regions && (
          // the closed picker shows the flag; the open list has the names
          <Select
            className={['phone-country', classes?.select].filter(Boolean).join(' ')}
            value={region}
            face={regionShort(picked)}
            aria-label="Country"
            options={regions.regions.map((r) => ({ value: r.region, label: regionLabel(r) }))}
            onChange={(v) => {
              setRegion(v);
              emit(text, regions.regions.find((r) => r.region === v));
            }}
          />
        )}
        <input
          type="tel"
          className={classes?.input}
          value={text}
          autoFocus={autoFocus}
          placeholder="613-222-0328 ext4"
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
            emit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onCommit) onCommit(composePhone(text, picked));
          }}
        />
      </div>
      {error && <div className={classes?.error ?? 'error prop-error'} role="alert">{error}</div>}
    </>
  );
}
