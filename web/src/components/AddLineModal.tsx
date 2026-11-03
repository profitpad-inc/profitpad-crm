import { useEffect, useState } from 'react';
import { Package, X } from 'lucide-react';
import { api, ApiError, getSchema, type CrmRecord, type ObjectDef, type Property, type SearchResult } from '../lib/api';
import { formatValue } from '../lib/display';
import { AMOUNT_PARENTS, lineAmount, money, parentTotals, setParentAmount, type ParentTotals } from '../lib/lines';
import { useApp } from '../lib/app-context';
import { Modal, PropertyInput, fromInput, isEditable, toInput } from './ui';

// New line item: pick a product (its name, SKU, price, cost and unit fill the
// line and the line links to it) or write a custom line. With a parent the line
// is created on it (a deal, quote, invoice, ...); from the Lines table it has
// none. On a deal, quote, invoice, cart or order it offers to set the parent's
// amount to the new total of its lines.
const LINE_FIELDS = ['name', 'sku', 'quantity', 'uom', 'unit_price', 'unit_cost', 'discount'];
// product property -> line property
const FROM_PRODUCT: [string, string][] = [['name', 'name'], ['sku', 'sku'], ['price', 'unit_price'], ['cost', 'unit_cost'], ['uom', 'uom']];

export function AddLineModal({ parent, onClose, onCreated }: {
  parent?: { object: string; id: string };
  onClose: () => void;
  onCreated: (r: CrmRecord) => void;
}) {
  const [schema, setSchema] = useState<ObjectDef | null>(null);
  const [mode, setMode] = useState<'product' | 'custom'>('product');
  const [product, setProduct] = useState<CrmRecord | null>(null);
  const [products, setProducts] = useState<ObjectDef | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CrmRecord[]>([]);
  const [values, setValues] = useState<Record<string, string>>({ quantity: '1' });
  const [error, setError] = useState<{ message: string; property?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { objectByName } = useApp();
  const [deal, setDeal] = useState<ParentTotals | null>(null);
  const [updateDeal, setUpdateDeal] = useState(true);
  const parentLabel = parent ? (objectByName.get(parent.object)?.label_singular ?? parent.object).toLowerCase() : '';
  // set once the line exists, so a retry after a failed deal update does not add it twice
  const [added, setAdded] = useState<CrmRecord | null>(null);

  useEffect(() => {
    if (parent && AMOUNT_PARENTS.includes(parent.object)) parentTotals(parent.object, parent.id).then(setDeal).catch(() => undefined);
  }, [parent?.object, parent?.id]);

  useEffect(() => {
    getSchema('lines').then(setSchema).catch((err) => setError({ message: (err as Error).message }));
    getSchema('products').then(setProducts).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (mode !== 'product' || product) return;
    const h = setTimeout(async () => {
      try {
        const res = await api<SearchResult>('POST', '/v1/objects/products/search', { query: q.trim() || undefined, limit: 8, properties: FROM_PRODUCT.map(([from]) => from) });
        setResults(res.results);
      } catch (err) {
        setError({ message: (err as Error).message });
      }
    }, 250);
    return () => clearTimeout(h);
  }, [mode, product, q]);

  const editable = schema?.properties.filter((p) => isEditable(p) && p.api_name !== 'created_at') ?? [];
  const fields: Property[] = [
    ...LINE_FIELDS.map((n) => editable.find((p) => p.api_name === n)).filter((p): p is Property => !!p),
    ...editable.filter((p) => !p.is_base && !LINE_FIELDS.includes(p.api_name))
  ];
  const priceProp = products?.properties.find((p) => p.api_name === 'price');

  function pickProduct(r: CrmRecord) {
    setProduct(r);
    const filled: Record<string, string> = {};
    for (const [from, to] of FROM_PRODUCT) {
      const prop = schema?.properties.find((p) => p.api_name === to);
      if (!prop) continue;
      let v = toInput(prop, r.properties[from]);
      // a unit added to products but not to lines is left blank
      if (prop.type === 'dropdown' && v && !prop.dropdown_options?.some((o) => o.api_value === v && o.record_status === 'active')) v = '';
      filled[to] = v;
    }
    setValues((s) => ({ ...s, ...filled }));
  }

  function switchMode(m: 'product' | 'custom') {
    setMode(m);
    setProduct(null);
    setError(null);
    setValues({ quantity: values.quantity ?? '1' });
  }

  async function save() {
    if (!schema) return;
    if (mode === 'product' && !product) {
      setError({ message: 'Pick a product, or switch to a custom line.' });
      return;
    }
    setBusy(true);
    setError(null);
    const properties: Record<string, unknown> = {};
    for (const p of fields) {
      const v = values[p.api_name];
      if (v !== undefined && v !== '') properties[p.api_name] = fromInput(p, v);
    }
    if (!properties.name) {
      setError({ message: 'Give the line a name.', property: 'name' });
      setBusy(false);
      return;
    }
    const associations = [
      ...(product ? [{ object: 'products', id: product.id }] : []),
      ...(parent ? [parent] : [])
    ];
    let created = added;
    try {
      if (!created) {
        created = await api<CrmRecord>('POST', '/v1/objects/lines', { properties, associations });
        setAdded(created);
      }
      // the total from the stored lines, not the preview
      if (deal && updateDeal && parent) await setParentAmount(parent.object, parent.id, (await parentTotals(parent.object, parent.id)).total);
      onCreated(created);
    } catch (err) {
      if (created) {
        setError({ message: `The line was added, but the ${parentLabel} amount was not updated: ${(err as Error).message}` });
        setBusy(false);
        return;
      }
      const property = err instanceof ApiError ? err.details?.property : undefined;
      setError({ message: (err as Error).message, property: fields.some((p) => p.api_name === property) ? property : undefined });
      setBusy(false);
    }
  }

  const showFields = mode === 'custom' || product;
  return (
    <Modal
      title="Add line item"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => (added ? onCreated(added) : onClose())}>{added ? 'Close' : 'Cancel'}</button>
          <button className="btn primary" onClick={save} disabled={busy || !schema}>{busy ? 'Adding…' : added ? 'Try again' : 'Add'}</button>
        </>
      }
    >
      <div className="form">
        <div className="line-mode" role="tablist">
          {(['product', 'custom'] as const).map((m) => (
            <div key={m} className={`tab${mode === m ? ' active' : ''}`}>
              <button role="tab" aria-selected={mode === m} onClick={() => switchMode(m)}>{m === 'product' ? 'Product' : 'Custom line'}</button>
            </div>
          ))}
        </div>
        {mode === 'product' && (product ? (
          <div className="line-product">
            <span className="card-icon"><Package size={15} strokeWidth={1.75} /></span>
            <div className="line-product-main">
              <div className="line-product-name">{String(product.properties.name ?? product.id)}</div>
              <div className="small muted">
                {[product.properties.sku, priceProp && product.properties.price != null ? formatValue(priceProp, product.properties.price) : null].filter(Boolean).join(', ')}
              </div>
            </div>
            <button className="icon-btn push-right" onClick={() => setProduct(null)} aria-label="Pick another product"><X size={16} /></button>
          </div>
        ) : (
          <div className="card-add line-search">
            <input autoFocus placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
            {results.map((r) => (
              <button key={r.id} className="card-pick" onClick={() => pickProduct(r)}>
                <span className="card-pick-name">{String(r.properties.name ?? r.id)}</span>
                {priceProp && r.properties.price != null && <span className="muted">{formatValue(priceProp, r.properties.price)}</span>}
              </button>
            ))}
            {results.length === 0 && <div className="muted small">No products found.</div>}
          </div>
        ))}
        {showFields && fields.map((p, i) => (
          <label key={p.api_name} className="field">
            <span>{p.label}</span>
            <PropertyInput property={p} value={values[p.api_name] ?? ''} autoFocus={mode === 'custom' && i === 0} onChange={(v) => setValues((s) => ({ ...s, [p.api_name]: v }))} />
            {error?.property === p.api_name && <div className="error prop-error" role="alert">{error.message}</div>}
          </label>
        ))}
        {deal && showFields && (
          <div className="checks">
            <label>
              <input type="checkbox" checked={updateDeal} onChange={(e) => setUpdateDeal(e.target.checked)} />
              Update the {parentLabel} amount from {money(deal.amount, deal.currency)} to {money(deal.total + lineAmount(values), deal.currency)}
            </label>
          </div>
        )}
        {error && !error.property && <div className="error">{error.message}</div>}
      </div>
    </Modal>
  );
}
