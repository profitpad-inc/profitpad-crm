import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api, ApiError, getSchema, type CrmRecord, type ObjectDef, type Property, type SearchResult } from '../lib/api';
import { formatValue } from '../lib/display';
import { Modal, PropertyInput, fromInput, isEditable, toInput } from './ui';

// New line item: pick a product (its name, SKU and price fill the line and the
// line links to it) or write a custom line. With a parent the line is created
// on it (a deal, quote, invoice, ...); from the Lines table it has none.
const LINE_FIELDS = ['name', 'sku', 'quantity', 'unit_price', 'discount'];

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

  useEffect(() => {
    getSchema('lines').then(setSchema).catch((err) => setError({ message: (err as Error).message }));
    getSchema('products').then(setProducts).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (mode !== 'product' || product) return;
    const h = setTimeout(async () => {
      try {
        const res = await api<SearchResult>('POST', '/v1/objects/products/search', { query: q.trim() || undefined, limit: 8, properties: ['name', 'sku', 'price'] });
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
  const unitPrice = schema?.properties.find((p) => p.api_name === 'unit_price');

  function pickProduct(r: CrmRecord) {
    setProduct(r);
    const p = r.properties;
    setValues((s) => ({
      ...s,
      name: typeof p.name === 'string' ? p.name : '',
      sku: typeof p.sku === 'string' ? p.sku : '',
      unit_price: unitPrice && p.price !== null && p.price !== undefined ? toInput(unitPrice, p.price) : ''
    }));
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
    try {
      onCreated(await api<CrmRecord>('POST', '/v1/objects/lines', { properties, associations }));
    } catch (err) {
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
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !schema}>{busy ? 'Adding…' : 'Add'}</button>
        </>
      }
    >
      <div className="form">
        <div className="tabs line-mode" role="tablist">
          {(['product', 'custom'] as const).map((m) => (
            <div key={m} className={`tab${mode === m ? ' active' : ''}`}>
              <button role="tab" aria-selected={mode === m} onClick={() => switchMode(m)}>{m === 'product' ? 'Product' : 'Custom line'}</button>
            </div>
          ))}
        </div>
        {mode === 'product' && (product ? (
          <div className="line-product">
            <div>
              <div>{String(product.properties.name ?? product.id)}</div>
              <div className="small muted">
                {[product.properties.sku, priceProp && product.properties.price != null ? formatValue(priceProp, product.properties.price) : null].filter(Boolean).join(' · ')}
              </div>
            </div>
            <button className="icon-btn push-right" onClick={() => setProduct(null)} aria-label="Pick another product"><X size={16} /></button>
          </div>
        ) : (
          <div className="card-add">
            <input autoFocus placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
            {results.map((r) => (
              <button key={r.id} className="card-pick" onClick={() => pickProduct(r)}>
                {String(r.properties.name ?? r.id)}
                {priceProp && r.properties.price != null && <span className="muted"> · {formatValue(priceProp, r.properties.price)}</span>}
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
        {error && !error.property && <div className="error">{error.message}</div>}
      </div>
    </Modal>
  );
}
