type Data = {
  quote: Record<string, any> & { _text: Record<string, string> };
  lines: (Record<string, any> & { _text: Record<string, string> })[];
  company: Record<string, any> | null;
  queries: { summary: { line_count: number; total: number }[] };
};

export default function Quote({ data }: { data: Data }) {
  const q = data.quote;
  const s = data.queries.summary[0];
  return (
    <div style={{ fontFamily: 'Arial, sans-serif', padding: 40, fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h1 style={{ margin: 0 }}>Quote {q.name}</h1>
        <img src={`https://barcode.invalid/qrcode?text=${encodeURIComponent(q.name)}`} style={{ width: 80, height: 80 }} />
      </div>
      <p>For {data.company?.name}, valid until {q._text.expiration_date}</p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th align="left">Item</th><th align="right">Qty</th><th align="right">Amount</th></tr></thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.id}><td>{l.sku} {l.name}</td><td align="right">{l.quantity}</td><td align="right">{l._text.amount}</td></tr>
          ))}
        </tbody>
      </table>
      <p style={{ textAlign: 'right' }}><b>{s.line_count} lines, {s.total.toFixed(2)} total (from SQL)</b></p>
    </div>
  );
}
