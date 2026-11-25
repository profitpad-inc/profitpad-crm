import { useState, useMemo } from 'react'
import {
  Row, Badge, Button, Tabs, CodeBlock, TextInput, HtmlPreview, Loading, ErrorBox, Empty,
  useQuery, useParams, setParams, useDebounced, openRecord, openUrl, copyText, crmUrl,
  formatDateTime, formatNumber
} from '@pcrm/view'

// Landing page workspace (template): pages in a list on the left, the open page
// on the right like the CRM's landing page record: Draft / Published switch,
// Preview / HTML / Details switch, Open draft, Open and Copy link, and whether
// the draft has unpublished changes. Address params: page (an id), version
// (draft | published), mode (preview | html | details), s (search).
//
// - Preview: <HtmlPreview landingPage={slug} draft />, the page drawn by its own
//   shell as visitors see it (the CRM draws it over the box the view keeps).
//   For HTML that is not a landing page (an email body, a generated document),
//   <HtmlPreview html={text} /> draws it without running scripts.
// - Links: crmUrl('/p/page/<slug>') is the full address; openUrl opens the CRM's
//   own pages in a new tab without asking, copyText puts a link on the clipboard.
// - Details: what search engines and link previews get, and an outline read
//   from the HTML (headings, embeds, links, images).
// - Publishing and editing the HTML happen on the record page ("Open in CRM") or
//   through the MCP landing page tools, not with updateRecord.
//
// To adapt it: the same shape suits anything that keeps text in two versions
// (draft and published templates, email bodies, proposal drafts): change the
// queries and the two columns read as draft and published.
export const frame = 'fill'

const CSS = `
.lp-root { height: 100vh; display: grid; grid-template-columns: 300px minmax(0, 1fr); background: var(--page-background); }
.lp-list { min-height: 0; overflow-y: auto; border-right: 1px solid var(--border); background: var(--surface); padding: 16px 12px; display: flex; flex-direction: column; gap: 8px; }
.lp-item { text-align: left; font: inherit; color: var(--text); background: #fff; border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
.lp-item:hover { border-color: color-mix(in srgb, var(--primary) 45%, var(--border)); }
.lp-item.on { outline: 2px solid var(--primary); outline-offset: -1px; }
.lp-main { min-height: 0; overflow-y: auto; padding: 20px 28px 32px; display: flex; flex-direction: column; gap: 16px; }
.lp-box { background: #fff; border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-card); }
.lp-box-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.lp-switches { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; padding: 0 16px; flex-wrap: wrap; }
.lp-body { padding: 16px; }
.lp-share { border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; max-width: 520px; }
.lp-share-img { height: 120px; background: var(--surface); display: grid; place-items: center; color: var(--muted-text); font-size: 12px; }
.lp-share-text { padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
.lp-outline { display: flex; flex-direction: column; gap: 6px; }
.lp-h { overflow-wrap: anywhere; }
.lp-h1 { font-size: 20px; font-weight: 700; }
.lp-h2 { font-size: 16px; font-weight: 600; padding-left: 14px; }
.lp-h3 { font-size: 14px; padding-left: 28px; color: var(--muted-text); }
.lp-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
.lp-fact { border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; }
.lp-fact b { display: block; font-size: 18px; }
@media (max-width: 860px) {
  .lp-root { grid-template-columns: minmax(0, 1fr); height: auto; min-height: 100vh; }
  .lp-list { max-height: 260px; border-right: 0; border-bottom: 1px solid var(--border); }
  .lp-main { padding: 16px; overflow: visible; }
}
`

// Text between tags, without inner tags or entities, for the outline.
const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
const all = (html, re) => [...String(html || '').matchAll(re)]

// What a reader (and a search engine) gets from the HTML, without drawing it.
function outlineOf(html) {
  const body = String(html || '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
  return {
    title: clean(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]),
    description: body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] || '',
    headings: all(body, /<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi).map((m) => ({ level: m[1].toLowerCase(), text: clean(m[2]) })).filter((h) => h.text),
    forms: all(body, /data-pcrm-form=["']([^"']+)["']/gi).map((m) => m[1]),
    bookings: all(body, /data-pcrm-booking=["']([^"']+)["']/gi).map((m) => m[1]),
    links: all(body, /<a\b[^>]*href=/gi).length,
    images: all(body, /<img\b/gi).length,
    iframes: all(body, /<iframe\b/gi).length,
    chars: String(html || '').length
  }
}

function Details({ page, html }) {
  const o = useMemo(() => outlineOf(html), [html])
  const shareTitle = page.meta_title || o.title || page.name
  const shareText = page.meta_description || o.description
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <div className="small muted" style={{ marginBottom: 6 }}>Search and link previews</div>
        <div className="lp-share">
          <div className="lp-share-img">{page.og_image ? 'Preview image set' : 'No preview image (og_image)'}</div>
          <div className="lp-share-text">
            <span className="small muted">/p/page/{page.slug}</span>
            <b>{shareTitle || '--'}</b>
            <span className="small">{shareText || <span className="muted">No description: search engines will pick text from the page.</span>}</span>
          </div>
        </div>
      </div>
      <div className="lp-facts">
        <div className="lp-fact"><b>{o.headings.length}</b><span className="small muted">Headings</span></div>
        <div className="lp-fact"><b>{o.forms.length + o.bookings.length}</b><span className="small muted">CRM forms and booking pages</span></div>
        <div className="lp-fact"><b>{o.links}</b><span className="small muted">Links</span></div>
        <div className="lp-fact"><b>{o.images}</b><span className="small muted">Images</span></div>
        <div className="lp-fact"><b>{o.iframes}</b><span className="small muted">Embeds</span></div>
        <div className="lp-fact"><b>{formatNumber(o.chars)}</b><span className="small muted">Characters</span></div>
      </div>
      <div>
        <div className="small muted" style={{ marginBottom: 6 }}>Outline</div>
        {o.headings.length ? (
          <div className="lp-outline">
            {o.headings.map((h, i) => <div key={i} className={`lp-h lp-${h.level}`}>{h.text}</div>)}
          </div>
        ) : <span className="muted">No headings.</span>}
      </div>
      {(o.forms.length > 0 || o.bookings.length > 0) && (
        <Row gap={6}>
          {o.forms.map((f) => <Badge key={`f${f}`} tone="primary">Form {f}</Badge>)}
          {o.bookings.map((b) => <Badge key={`b${b}`} tone="money">Booking {b}</Badge>)}
        </Row>
      )}
    </div>
  )
}

function PageDetail({ id, version, mode }) {
  const page = useQuery('page', { id })
  const p = page.data[0]
  // hooks before the early returns below (React needs the same hooks every render)
  const [copied, setCopied] = useState(false)
  if (page.loading) return <Loading />
  if (page.error) return <ErrorBox error={page.error} />
  if (!p) return <Empty>This page is not there, or you cannot see it.</Empty>

  const published = p.status === 'published'
  const html = version === 'published' ? p.html : p.draft_html
  const changed = published && (p.draft_html || '') !== (p.html || '')
  const draftLink = crmUrl(`/p/page/?draft=1#${p.slug}`)
  const liveLink = crmUrl(`/p/page/${p.slug}`)
  async function copy() {
    await copyText(liveLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <div>
        <Row gap={10}>
          <h1 style={{ margin: 0, fontSize: 24 }}>{p.name || '--'}</h1>
          <Badge tone={published ? 'money' : 'muted'}>{p.status_label || p.status}</Badge>
          {changed && <Badge tone="warning">Unpublished changes</Badge>}
        </Row>
        <div className="muted" style={{ marginTop: 4 }}>
          /p/page/{p.slug}{p.published_at ? ` · published ${formatDateTime(p.published_at)}` : ''}
        </div>
        {p.description && <div style={{ marginTop: 8 }}>{p.description}</div>}
      </div>

      <div className="lp-box">
        <div className="lp-box-head">
          <b>Page</b>
          <span className="muted">{published ? 'Published' : 'Draft only'}</span>
          <Row gap={8} style={{ marginLeft: 'auto' }}>
            <Button small onClick={() => openUrl(draftLink)}>Open draft</Button>
            {published && <Button small onClick={() => openUrl(liveLink)}>Open</Button>}
            {published && <Button small onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>}
            <Button small onClick={() => openRecord('landing_pages', p.id)}>Open in CRM</Button>
          </Row>
        </div>
        <div className="lp-switches">
          <Tabs tabs={[{ key: 'draft', label: 'Draft' }, { key: 'published', label: 'Published' }]} value={version}
            onChange={(k) => setParams({ version: k })} />
          <Tabs tabs={[{ key: 'preview', label: 'Preview' }, { key: 'html', label: 'HTML' }, { key: 'details', label: 'Details' }]} value={mode}
            onChange={(k) => setParams({ mode: k })} />
        </div>
        <div className="lp-body">
          {!html ? (
            <Empty>{version === 'published' ? 'Not published yet.' : 'The draft is empty.'}</Empty>
          ) : mode === 'html' ? (
            <CodeBlock code={html} lang="html" maxHeight={640} />
          ) : mode === 'details' ? (
            <Details page={p} html={html} />
          ) : (
            <HtmlPreview landingPage={p.slug} draft={version === 'draft'} height={640} title={`${p.name || p.slug} (${version})`} />
          )}
        </div>
      </div>
    </>
  )
}

export default function LandingPages() {
  const params = useParams()
  const [search, setSearch] = useState(params.s || '')
  const s = useDebounced(search.trim(), 250)
  const pages = useQuery('pages')
  const version = params.version === 'published' ? 'published' : 'draft'
  const mode = params.mode === 'html' || params.mode === 'details' ? params.mode : 'preview'
  const shown = pages.data.filter((p) => !s || `${p.name} ${p.slug}`.toLowerCase().includes(s.toLowerCase()))
  const openId = params.page || shown[0]?.id

  return (
    <div className="lp-root">
      <style>{CSS}</style>
      <aside className="lp-list">
        <b style={{ fontSize: 16, padding: '0 2px 4px' }}>Landing pages</b>
        <TextInput type="search" small value={search} onChange={setSearch} placeholder="Search pages" />
        {pages.loading ? <Loading /> : pages.error ? <ErrorBox error={pages.error} /> : !shown.length ? <Empty>No pages.</Empty> : shown.map((p) => (
          <button key={p.id} className={p.id === openId ? 'lp-item on' : 'lp-item'} onClick={() => setParams({ page: p.id })}>
            <b>{p.name || '--'}</b>
            <Row gap={6}>
              <Badge tone={p.status === 'published' ? 'money' : 'muted'}>{p.status_label || p.status}</Badge>
              {p.changed && <Badge tone="warning">Changed</Badge>}
            </Row>
            <span className="small muted">/p/page/{p.slug}</span>
          </button>
        ))}
      </aside>
      <main className="lp-main">
        {openId ? <PageDetail key={openId} id={openId} version={version} mode={mode} /> : !pages.loading && <Empty>Pick a page.</Empty>}
      </main>
    </div>
  )
}
