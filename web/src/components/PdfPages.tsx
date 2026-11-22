import { useEffect, useRef, useState } from 'react';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Loading } from './Loading';

// PDF pages drawn with pdf.js, for the file viewer (FileViewer.tsx). File
// links refuse to load in frames (X-Frame-Options DENY), so the pages are
// drawn onto canvases here instead of in the browser's own PDF viewer. Loaded
// on its own (lazy) so pdf.js is only downloaded when a PDF is opened.
GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export default function PdfPages({ url, onError }: { url: string; onError: (message: string) => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  // page 1's height over width, the placeholder shape until a page has loaded
  const [ratio, setRatio] = useState(1.294);
  // 1 fits the page width to the viewer
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // no WebAssembly: the CRM's CSP has no wasm-unsafe-eval (only JPEG 2000
    // images inside a PDF need it)
    const task = getDocument({ url, useWasm: false });
    let live = true;
    task.promise.then(async (d) => {
      const first = await d.getPage(1);
      const v = first.getViewport({ scale: 1 });
      if (!live) return;
      setRatio(v.height / v.width);
      setDoc(d);
    }).catch((err) => live && onError((err as Error).message || 'Could not read this PDF.'));
    return () => {
      live = false;
      void task.destroy();
    };
  }, [url]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth - 32);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pageWidth = Math.max(0, Math.round(width * zoom));
  const step = (dir: 1 | -1) => {
    const i = ZOOMS.indexOf(zoom);
    setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + dir))]);
  };

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <span className="muted small">{doc ? `${doc.numPages} ${doc.numPages === 1 ? 'page' : 'pages'}` : ''}</span>
        <span className="pdf-zoom">
          <button className="icon-btn" onClick={() => step(-1)} disabled={zoom === ZOOMS[0]} aria-label="Zoom out"><ZoomOut size={15} /></button>
          <span className="small pdf-zoom-value">{Math.round(zoom * 100)}%</span>
          <button className="icon-btn" onClick={() => step(1)} disabled={zoom === ZOOMS[ZOOMS.length - 1]} aria-label="Zoom in"><ZoomIn size={15} /></button>
          <button className="icon-btn" onClick={() => setZoom(1)} disabled={zoom === 1} aria-label="Fit to width"><Maximize2 size={14} /></button>
        </span>
      </div>
      <div className="pdf-pages" ref={scroller}>
        {!doc && <Loading label="Loading PDF" />}
        {doc && pageWidth > 0 && Array.from({ length: doc.numPages }, (_, i) => (
          <PdfPage key={i} doc={doc} number={i + 1} width={pageWidth} ratio={ratio} root={scroller.current} />
        ))}
      </div>
    </div>
  );
}

// One page: a placeholder of the right shape, drawn once it scrolls near view
// and drawn again when the width changes.
function PdfPage({ doc, number, width, ratio, root }: { doc: PDFDocumentProxy; number: number; width: number; ratio: number; root: HTMLElement | null }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(number <= 2);
  const [page, setPage] = useState<PDFPageProxy | null>(null);

  useEffect(() => {
    if (near || !box.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true);
    }, { root, rootMargin: '800px 0px' });
    io.observe(box.current);
    return () => io.disconnect();
  }, [near, root]);

  useEffect(() => {
    if (!near) return;
    let live = true;
    doc.getPage(number).then((p) => live && setPage(p)).catch(() => {});
    return () => {
      live = false;
    };
  }, [near, doc, number]);

  useEffect(() => {
    const c = canvas.current;
    if (!page || !c) return;
    const base = page.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (width / base.width) * dpr });
    c.width = Math.floor(viewport.width);
    c.height = Math.floor(viewport.height);
    let task: RenderTask | null = page.render({ canvas: c, viewport });
    task.promise.catch(() => {}).finally(() => {
      task = null;
    });
    return () => task?.cancel();
  }, [page, width]);

  const shape = page ? (() => { const v = page.getViewport({ scale: 1 }); return v.height / v.width; })() : ratio;
  return (
    <div className="pdf-page" ref={box} style={{ width, height: Math.round(width * shape) }}>
      {page && <canvas ref={canvas} aria-label={`Page ${number}`} />}
    </div>
  );
}
