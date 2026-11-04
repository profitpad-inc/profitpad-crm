import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { api, type CrmRecord, type SearchResult } from '../lib/api';
import { AMOUNT_PARENTS, money, parentTotals, setParentAmount, type ParentTotals } from '../lib/lines';
import { useApp } from '../lib/app-context';
import { Modal } from './ui';

// The Line items card's +: every line of a parent (deal, quote, invoice, ...)
// in one grid, edited together and saved at once. A product line is picked by
// searching products (name, SKU, price, cost and unit come from the product);
// a custom line is made in its own dialog, optionally as a variation of a
// product (the line links to it), and is stored with line_type "custom" and
// its customizations. Ins adds a line, Enter moves along a row.
// Opened from a line on the card (target), that line's product or quantity
// is highlighted (the quantity also takes focus) until the grid is used.

interface Picked { id: string; name: string; sku: string; price: number | null; cost: number | null; uom: string }

interface Row {
  key: number;
  id?: string;
  custom: boolean;
  product: Picked | null;
  name: string;
  sku: string;
  qty: string;
  price: string;
  cost: string;
  uom: string;
  discount: number;
  customizations: string;
  // what was loaded, to tell edited lines apart
  saved?: string;
}

const LINE_PROPS = ['name', 'sku', 'quantity', 'unit_price', 'unit_cost', 'uom', 'discount', 'line_type', 'customizations'];
const PRODUCT_PROPS = ['name', 'sku', 'unit_price', 'unit_cost', 'uom'];

let nextKey = 1;
const str = (v: unknown): string => (Array.isArray(v) ? str(v[0]) : v === null || v === undefined ? '' : String(v));
const num = (v: string) => (v.trim() === '' || !isFinite(Number(v)) ? null : Number(v));
const blankRow = (): Row => ({ key: nextKey++, custom: false, product: null, name: '', sku: '', qty: '1', price: '', cost: '', uom: '', discount: 0, customizations: '' });
const isBlank = (r: Row) => !r.id && !r.custom && !r.product;
const ext = (r: Row) => Math.round(((num(r.qty) ?? 0) * (num(r.price) ?? 0) - r.discount) * 100) / 100;
const picked = (r: { id: string; properties?: Record<string, unknown> }): Picked => {
  const p = r.properties ?? {};
  return { id: r.id, name: str(p.name), sku: str(p.sku), price: num(str(p.unit_price)), cost: num(str(p.unit_cost)), uom: str(p.uom) };
};

function lineProps(r: Row): Record<string, unknown> {
  return {
    name: r.name.trim(),
    sku: r.sku.trim() || null,
    quantity: num(r.qty) ?? 0,
    unit_price: num(r.price),
    unit_cost: num(r.cost),
    uom: r.uom || null,
    line_type: r.custom ? 'custom' : 'product',
    customizations: r.custom ? r.customizations.trim() || null : null
  };
}
// the unit price must be at least 1 cent above the unit cost
const minPrice = (r: { cost: string }) => (num(r.cost) === null ? null : Math.round((num(r.cost)! + 0.01) * 100) / 100);
const priceTooLow = (r: { cost: string; price: string }) => {
  const min = minPrice(r);
  return min !== null && (num(r.price) ?? 0) < min - 1e-9;
};
const snapshot = (r: Row) => JSON.stringify([lineProps(r), r.product?.id ?? null]);

export type LineTarget = { lineId: string; field: 'product' | 'qty' };

export function LineItemsEditor({ parent, target, onClose, onSaved }: {
  parent: { object: string; id: string };
  target?: LineTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { objectByName } = useApp();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const [totals, setTotals] = useState<ParentTotals | null>(null);
  const [updateAmount, setUpdateAmount] = useState(true);
  const [custom, setCustom] = useState<{ key: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // rows whose unit price was raised to the minimum on leaving the box
  const [raised, setRaised] = useState<Record<number, string>>({});
  // the line (row key) and field opened from the card
  const [hl, setHl] = useState<{ key: number; field: LineTarget['field'] } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const parentLabel = (objectByName.get(parent.object)?.label_singular ?? parent.object).toLowerCase();
  const withAmount = AMOUNT_PARENTS.includes(parent.object);

  useEffect(() => {
    (async () => {
      const p = await api<CrmRecord>('GET', `/v1/objects/${parent.object}/${parent.id}?associations=lines`);
      const ids = (p.associations?.lines ?? []).map((l) => l.id);
      const loaded: Row[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        const res = await api<{ results: CrmRecord[] }>('POST', '/v1/objects/lines/batch/read', {
          ids: ids.slice(i, i + 100), properties: LINE_PROPS, associations: [{ object: 'products', properties: PRODUCT_PROPS }]
        });
        for (const l of res.results) {
          const pr = l.associations?.products?.[0];
          const v = l.properties;
          const row: Row = {
            key: nextKey++,
            id: l.id,
            custom: str(v.line_type) === 'custom' || (!pr && str(v.line_type) !== 'product'),
            product: pr ? picked(pr) : null,
            name: str(v.name),
            sku: str(v.sku),
            qty: str(v.quantity) || '0',
            price: str(v.unit_price),
            cost: str(v.unit_cost),
            uom: str(v.uom),
            discount: num(str(v.discount)) ?? 0,
            customizations: str(v.customizations)
          };
          row.saved = snapshot(row);
          loaded.push(row);
        }
      }
      setRows([...loaded, blankRow()]);
      const t = target ? loaded.findIndex((r) => r.id === target.lineId) : -1;
      if (t >= 0) {
        setHl({ key: loaded[t].key, field: target!.field });
        // a product line's quantity takes focus; a product only shows as highlighted
        // (focusing its tile would turn it into the search box)
        if (target!.field === 'qty' && !loaded[t].custom) focusCell(t, 1);
        else requestAnimationFrame(() => gridRef.current?.querySelector('.le-hl')?.scrollIntoView({ block: 'nearest' }));
      } else focusCell(loaded.length, 0);
      if (withAmount) setTotals(await parentTotals(parent.object, parent.id));
    })().catch((err) => setError((err as Error).message));
  }, [parent.object, parent.id]);

  const all = rows ?? [];
  const real = all.filter((r) => !isBlank(r));
  const total = Math.round(real.reduce((s, r) => s + ext(r), 0) * 100) / 100;
  const cost = Math.round(real.reduce((s, r) => s + (num(r.qty) ?? 0) * (num(r.cost) ?? 0), 0) * 100) / 100;
  const currency = totals?.currency ?? 'USD';
  const dirty = removed.length > 0 || real.some((r) => !r.id || snapshot(r) !== r.saved);
  const amountChanges = withAmount && totals && totals.amount !== total;

  function focusCell(r: number, c: number) {
    // after React has drawn a newly added row
    requestAnimationFrame(() => {
      const el = gridRef.current?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`);
      el?.focus();
      if (el instanceof HTMLInputElement) el.select();
    });
  }

  function patch(key: number, change: Partial<Row>) {
    setRows((rs) => rs && rs.map((r) => (r.key === key ? { ...r, ...change } : r)));
  }

  // a new blank line after `at` (default: the end), unless the last line is already blank
  function addLine(at?: number) {
    if (!rows) return;
    const i = at === undefined ? rows.length : at + 1;
    if (at === undefined && rows.length && isBlank(rows[rows.length - 1])) return focusCell(rows.length - 1, 0);
    setRows([...rows.slice(0, i), blankRow(), ...rows.slice(i)]);
    focusCell(i, 0);
  }

  function pickProduct(r: number, p: Picked) {
    if (!rows) return;
    const row = rows[r];
    const next = rows.map((x, i) => (i === r ? {
      ...x,
      product: p,
      name: p.name,
      sku: p.sku,
      price: p.price === null ? '' : String(p.price),
      cost: p.cost === null ? '' : String(p.cost),
      uom: p.uom,
      qty: x.qty || '1'
    } : x));
    // picking on the last line opens a new blank one under it
    if (r === rows.length - 1 && isBlank(row)) next.push(blankRow());
    setRows(next);
    focusCell(r, 1);
  }

  function removeLine(r: number) {
    if (!rows) return;
    const row = rows[r];
    if (row.id) setRemoved((ids) => [...ids, row.id!]);
    const next = rows.filter((_, i) => i !== r);
    setRows(next.length && isBlank(next[next.length - 1]) ? next : [...next, blankRow()]);
  }

  function saveCustom(line: Row) {
    if (!rows || !custom) return;
    if (custom.key !== null) {
      setRows(rows.map((r) => (r.key === custom.key ? line : r)));
    } else {
      // in place of a trailing blank line, which moves down
      const last = rows.length - 1;
      setRows(isBlank(rows[last]) ? [...rows.slice(0, last), line, rows[last]] : [...rows, line, blankRow()]);
    }
    setCustom(null);
  }

  function close() {
    if (busy) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  }

  // Enter on Qty or Unit price: the next line's product (a new line after the last)
  function nextLine(r: number) {
    if (!rows) return;
    if (r === rows.length - 1) addLine(r);
    else focusCell(r + 1, 0);
  }

  // Cmd+Enter (Ctrl+Enter on Windows) saves, unless a dialog is open on top
  const saveRef = useRef(save);
  saveRef.current = save;
  const keysLive = !custom && !confirmClose;
  useEffect(() => {
    if (!keysLive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      saveRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keysLive]);

  async function save() {
    if (!rows || busy || !dirty) return;
    const missing = rows.findIndex((r) => !isBlank(r) && !r.name.trim());
    if (missing >= 0) {
      setError(`Line ${missing + 1} needs a description.`);
      return;
    }
    const low = rows.findIndex((r) => !isBlank(r) && priceTooLow(r));
    if (low >= 0) {
      setError(`Line ${low + 1}: the unit price must be at least ${money(minPrice(rows[low]), currency)}, 1 cent above the unit cost.`);
      focusCell(low, 2);
      return;
    }
    setBusy(true);
    setError(null);
    // ids are kept as lines are saved, so trying again never adds a line twice
    const next = [...rows];
    let gone = [...removed];
    try {
      for (const id of removed) {
        await api('DELETE', `/v1/objects/lines/${id}`);
        gone = gone.filter((g) => g !== id);
      }
      for (let i = 0; i < next.length; i++) {
        const r = next[i];
        if (isBlank(r)) continue;
        const properties = lineProps(r);
        if (!r.id) {
          const created = await api<CrmRecord>('POST', '/v1/objects/lines', {
            properties,
            associations: [...(r.product ? [{ object: 'products', id: r.product.id }] : []), parent]
          });
          next[i] = { ...r, id: created.id, saved: snapshot(r) };
          continue;
        }
        if (snapshot(r) === r.saved) continue;
        const [, oldProduct] = JSON.parse(r.saved ?? '[null,null]') as [unknown, string | null];
        await api('PATCH', `/v1/objects/lines/${r.id}`, { properties });
        if (oldProduct !== (r.product?.id ?? null)) {
          if (oldProduct) await api('DELETE', `/v1/objects/lines/${r.id}/associations/products/${oldProduct}`);
          if (r.product) await api('PUT', `/v1/objects/lines/${r.id}/associations/products/${r.product.id}`);
        }
        next[i] = { ...r, saved: snapshot(r) };
      }
      // the total from the stored lines, not the grid
      if (amountChanges && updateAmount) await setParentAmount(parent.object, parent.id, (await parentTotals(parent.object, parent.id)).total);
      onSaved();
    } catch (err) {
      setRows(next);
      setRemoved(gone);
      setError((err as Error).message);
      setBusy(false);
    }
  }

  function onKey(e: ReactKeyboardEvent) {
    if (e.key === 'Insert' && !custom) {
      e.preventDefault();
      addLine();
    }
  }

  return (
    <>
      <Modal
        title="Line items"
        className="line-editor"
        onClose={close}
        locked={!!custom || busy || confirmClose}
        footer={
          <>
            {amountChanges && (
              <label className="le-amount">
                <input type="checkbox" checked={updateAmount} onChange={(e) => setUpdateAmount(e.target.checked)} />
                Update the {parentLabel} amount from {money(totals!.amount, currency)} to {money(total, currency)}
              </label>
            )}
            <button className="btn" onClick={close} disabled={busy}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={busy || !rows || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
          </>
        }
      >
        <div onKeyDown={onKey}>
          {!rows && !error && <div className="muted">Loading…</div>}
          {rows && (
            <div className="le-scroll">
              <div className="le-grid" role="table" aria-label="Line items" ref={gridRef} onMouseDown={() => setHl(null)} onKeyDown={(e) => e.key !== 'Tab' && setHl(null)}>
                <div className="le-row le-head" role="row">
                  <div className="le-num">#</div>
                  <div>Product</div>
                  <div className="le-desc">Description</div>
                  <div className="le-r">Qty</div>
                  <div className="le-r">Unit price</div>
                  <div className="le-r">Unit cost</div>
                  <div className="le-r">Ext.</div>
                  <div />
                </div>
                {rows.map((row, r) => {
                  const hlField = hl?.key === row.key ? hl.field : null;
                  const hlCell = (f: LineTarget['field']) => (hlField === f ? ' le-hl-cell' : '');
                  return (
                  <div key={row.key} className={`le-row${row.custom ? ' le-custom' : ''}${hlField ? ' le-hl' : ''}`} role="row">
                    <div className="le-num" role="cell">{r + 1}</div>
                    {row.custom ? (
                      <>
                        <div className={hlCell('product').trim() || undefined} role="cell">
                          <button className="le-tag" data-r={r} data-c={0} onClick={() => setCustom({ key: row.key })} title="Edit custom line">Custom</button>
                        </div>
                        <div className="le-desc" role="cell">
                          {row.name}
                          {(row.product || row.customizations.trim()) && (
                            <span className="le-sub">
                              {[
                                row.product ? `Variation of ${[row.product.sku, row.product.name].filter(Boolean).join(' ')}` : '',
                                ...row.customizations.split(/\r?\n/).map((s) => s.trim())
                              ].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </div>
                        <div className={`le-r le-text${hlCell('qty')}`} role="cell">{row.qty}</div>
                        <div className="le-r le-text" role="cell">{num(row.price) === null ? '' : money(num(row.price), currency)}</div>
                      </>
                    ) : (
                      <>
                        <div className={hlCell('product').trim() || undefined} role="cell">
                          <ProductSearch
                            product={row.product}
                            cell={{ r, c: 0 }}
                            onPick={(p) => pickProduct(r, p)}
                            onEnter={() => (row.product ? focusCell(r, 1) : undefined)}
                          />
                        </div>
                        <div className="le-desc" role="cell">{row.name}</div>
                        <div className={hlCell('qty').trim() || undefined} role="cell">
                          <span className="le-qty">
                            <input
                              className="le-in"
                              data-r={r}
                              data-c={1}
                              inputMode="decimal"
                              value={row.qty}
                              aria-label={`Quantity, line ${r + 1}`}
                              style={row.uom ? { paddingRight: `${row.uom.length + 2}ch` } : undefined}
                              onChange={(e) => patch(row.key, { qty: e.target.value })}
                              onKeyDown={(e) => e.key === 'Enter' && !e.metaKey && !e.ctrlKey && nextLine(r)}
                            />
                            {row.uom && <span className="le-uom">{row.uom}</span>}
                          </span>
                        </div>
                        <div role="cell">
                          <input
                            className={`le-in${!isBlank(row) && priceTooLow(row) ? ' invalid' : ''}`}
                            data-r={r}
                            data-c={2}
                            title={minPrice(row) === null ? undefined : `At least ${money(minPrice(row), currency)}`}
                            inputMode="decimal"
                            value={row.price}
                            aria-label={`Unit price, line ${r + 1}`}
                            onChange={(e) => {
                              patch(row.key, { price: e.target.value });
                              setRaised(({ [row.key]: _, ...rest }) => rest);
                            }}
                            onBlur={() => {
                              if (isBlank(row) || !priceTooLow(row)) return;
                              const min = money(minPrice(row), currency);
                              patch(row.key, { price: minPrice(row)!.toFixed(2) });
                              setRaised((m) => ({ ...m, [row.key]: `Raised to ${min}, 1 cent above cost` }));
                            }}
                            onKeyDown={(e) => e.key === 'Enter' && !e.metaKey && !e.ctrlKey && nextLine(r)}
                          />
                          {raised[row.key] && <span className="le-note" role="status">{raised[row.key]}</span>}
                        </div>
                      </>
                    )}
                    <div className="le-r le-text le-money" role="cell" title={row.custom ? 'Estimated unit cost' : undefined}>
                      {num(row.cost) === null ? '' : money(num(row.cost), currency)}
                    </div>
                    <div className="le-r le-text le-money" role="cell">{isBlank(row) ? '' : money(ext(row), currency)}</div>
                    <div role="cell">
                      <button className="icon-btn faint-btn" tabIndex={-1} onClick={() => removeLine(r)} aria-label={`Remove line ${r + 1}`}>
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          )}
          {rows && (
            <div className="le-foot">
              <div className="le-tools">
                <button className="btn le-pill" onClick={() => addLine()}>+ Add line <span className="le-key">Ins</span></button>
                <button className="btn le-pill" onClick={() => setCustom({ key: null })}>+ Custom line</button>
              </div>
              <div className="le-sum">
                <span className="le-sum-label">Total</span>
                <span className="le-sum-figs">
                  <strong>{money(total, currency)}</strong>
                  <span className="small">Cost {money(cost, currency)}</span>
                </span>
              </div>
            </div>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      </Modal>
      {confirmClose && (
        <Modal
          className="discard-confirm"
          title="Discard your changes?"
          onClose={() => setConfirmClose(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmClose(false)} autoFocus>Keep editing</button>
              <button className="btn danger" onClick={onClose}>Discard</button>
            </>
          }
        >
          <p>Closing now loses any changes you haven't saved.</p>
        </Modal>
      )}
      {custom && (
        <CustomLineModal
          row={custom.key === null ? null : all.find((r) => r.key === custom.key) ?? null}
          currency={currency}
          onClose={() => setCustom(null)}
          onSave={saveCustom}
        />
      )}
    </>
  );
}

// Product search box: the picked product shows as an SKU tile (a cell) or a
// box with the tile and the name (a field); clicking it, or focus reaching it,
// turns it back into the search box. Suggestions open under the box.
function ProductSearch({ product, onPick, cell, onEnter, invalid, id, autoFocus }: {
  product: Picked | null;
  onPick: (p: Picked) => void;
  cell?: { r: number; c: number };
  onEnter?: () => void;
  invalid?: boolean;
  id?: string;
  autoFocus?: boolean;
}) {
  const [editing, setEditing] = useState(!product);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Picked[]>([]);
  const [hi, setHi] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cellAttrs = cell ? { 'data-r': cell.r, 'data-c': cell.c } : {};
  const open = editing && q.trim() !== '' && results.length > 0 && rect !== null;

  useEffect(() => setEditing(!product), [product?.id]);

  useEffect(() => {
    const query = q.trim();
    if (!editing || !query) return setResults([]);
    let live = true;
    const h = setTimeout(async () => {
      try {
        const res = await api<SearchResult>('POST', '/v1/objects/products/search', { query, limit: 8, properties: PRODUCT_PROPS });
        if (!live) return;
        setResults(res.results.map(picked));
        setHi(0);
      } catch {
        if (live) setResults([]);
      }
    }, 200);
    return () => { live = false; clearTimeout(h); };
  }, [q, editing]);

  useLayoutEffect(() => {
    if (!editing || !inputRef.current) return setRect(null);
    const place = () => inputRef.current && setRect(inputRef.current.getBoundingClientRect());
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [editing, results.length]);

  function edit() {
    setEditing(true);
    setQ('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function pick(p: Picked) {
    setQ('');
    setResults([]);
    setEditing(false);
    onPick(p);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.metaKey || e.ctrlKey) return;
    if (open && e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
    else if (open && e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (open) pick(results[hi]);
      else onEnter?.();
    } else if (e.key === 'Escape' && (open || (product && q === ''))) {
      // closes the list (or goes back to the picked product), not the dialog
      e.stopPropagation();
      if (open) setResults([]);
      else setEditing(false);
    }
  }

  if (product && !editing) {
    return cell ? (
      <button className="le-tile" {...cellAttrs} onClick={edit} onFocus={edit} title={`Change product: ${product.name}`}>
        {product.sku || product.id}
      </button>
    ) : (
      <button className="le-picked" id={id} onClick={edit} title={`Change product: ${product.name}`}>
        <span className="le-tile">{product.sku || product.id}</span>
        <span className="le-picked-name">{product.name}</span>
      </button>
    );
  }
  return (
    <>
      <input
        ref={inputRef}
        id={id}
        className={`le-in le-search${invalid ? ' invalid' : ''}`}
        {...cellAttrs}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        placeholder="Search…"
        value={q}
        aria-expanded={open}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setResults([]);
          if (product) setEditing(false);
        }}
      />
      {open && createPortal(
        <div className="menu le-ac" role="listbox" style={{ top: rect!.bottom + 4, left: rect!.left }}>
          {results.map((p, i) => (
            <button
              key={p.id}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? 'active' : undefined}
              onMouseDown={(e) => { e.preventDefault(); pick(p); }}
              onMouseEnter={() => setHi(i)}
            >
              <span className="le-tile">{p.sku || p.id}</span>
              <span className="le-ac-name">{p.name}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

// Add or edit one custom line: made to order, or a variation of a product
// (picking one fills the name, price and cost the user left blank).
function CustomLineModal({ row, currency, onClose, onSave }: {
  row: Row | null;
  currency: string;
  onClose: () => void;
  onSave: (r: Row) => void;
}) {
  const [variation, setVariation] = useState(!!row?.product);
  const [product, setProduct] = useState<Picked | null>(row?.product ?? null);
  const [name, setName] = useState(row?.name ?? '');
  const [qty, setQty] = useState(row?.qty ?? '1');
  const [price, setPrice] = useState(row?.price ?? '');
  const [cost, setCost] = useState(row?.cost ?? '');
  const [customizations, setCustomizations] = useState(row?.customizations ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [raised, setRaised] = useState('');

  function pick(p: Picked) {
    setProduct(p);
    if (!name.trim()) setName(p.name);
    if (!price.trim() && p.price !== null) setPrice(String(p.price));
    if (!cost.trim() && p.cost !== null) setCost(String(p.cost));
  }

  function save() {
    const er: Record<string, string> = {};
    if (variation && !product) er.product = 'Pick the product this is a variation of.';
    if (!name.trim()) er.name = 'Give the line a name.';
    const q = num(qty);
    if (q === null || q <= 0) er.qty = 'Enter a quantity above 0.';
    if (price.trim() && num(price) === null) er.price = 'Enter a number.';
    if (cost.trim() && (num(cost) === null || num(cost)! < 0)) er.cost = 'Enter a number, 0 or more.';
    else if (!er.price && priceTooLow({ cost, price })) er.price = `At least ${money(minPrice({ cost }), currency)}, 1 cent above the unit cost.`;
    setErrors(er);
    if (Object.keys(er).length) return;
    onSave({
      ...(row ?? blankRow()),
      custom: true,
      product: variation ? product : null,
      name: name.trim(),
      sku: '',
      qty: qty.trim(),
      price: price.trim(),
      cost: cost.trim(),
      uom: variation ? product?.uom ?? '' : '',
      customizations
    });
  }

  function onKey(e: ReactKeyboardEvent) {
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement) && !e.defaultPrevented) {
      e.preventDefault();
      save();
    }
  }

  const err = (k: string) => errors[k] && <div className="error prop-error" role="alert">{errors[k]}</div>;
  const hint = (v: number | null) => (variation && product && v !== null ? <span className="small muted">Original: {money(v, currency)}</span> : null);
  return (
    <Modal
      title={row ? 'Edit custom line' : 'Add custom line'}
      className="custom-line"
      onClose={onClose}
      footer={
        <>
          <button className="btn le-pill" onClick={onClose}>Cancel <span className="le-key">Esc</span></button>
          <button className="btn primary le-pill" onClick={save}>{row ? 'Save' : 'Add line'} <span className="le-key">Enter</span></button>
        </>
      }
    >
      <div className="form cl-form" onKeyDown={onKey}>
        <label className="cl-wide cl-switch">
          <input type="checkbox" role="switch" checked={variation} onChange={(e) => setVariation(e.target.checked)} />
          Variation of an existing product
        </label>
        {variation && (
          <div className="field cl-wide">
            <span>Existing product</span>
            <ProductSearch product={product} onPick={pick} invalid={!!errors.product} autoFocus={!product} />
            {err('product')}
          </div>
        )}
        <label className="field cl-wide">
          <span>Suggested name</span>
          <input value={name} maxLength={200} autoFocus={!variation} onChange={(e) => setName(e.target.value)} />
          {err('name')}
        </label>
        <label className="field">
          <span>Quantity</span>
          <input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
          {err('qty')}
        </label>
        <label className="field">
          <span>Unit price</span>
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={price}
            onChange={(e) => { setPrice(e.target.value); setRaised(''); }}
            onBlur={() => {
              // only a typed price is raised; an empty one is caught on save
              if (!price.trim() || num(price) === null || !priceTooLow({ cost, price })) return;
              setPrice(minPrice({ cost })!.toFixed(2));
              setRaised(`Raised to ${money(minPrice({ cost }), currency)}, 1 cent above cost`);
            }}
          />
          {raised && <span className="small le-note-inline" role="status">{raised}</span>}
          {hint(product?.price ?? null)}
          {err('price')}
        </label>
        <label className="field">
          <span>Unit cost (estimate)</span>
          <input inputMode="decimal" placeholder="0.00" value={cost} onChange={(e) => setCost(e.target.value)} />
          {hint(product?.cost ?? null)}
          {err('cost')}
        </label>
        <label className="field cl-wide">
          <span>Customizations <span className="muted cl-note">(one per line, e.g. 3" rear fill)</span></span>
          <textarea rows={3} value={customizations} onChange={(e) => setCustomizations(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
