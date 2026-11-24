// Short note beside a disabled Save on a new record's form, saying which
// required fields are still empty: <SaveHint missing={[!name.trim() && 'a name', !url.trim() && 'a URL']} />
export function SaveHint({ missing }: { missing: (string | false | null | undefined)[] }) {
  const list = missing.filter((m): m is string => !!m);
  if (!list.length) return null;
  const text = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return <span className="save-hint" role="status">Needs {text}.</span>;
}
