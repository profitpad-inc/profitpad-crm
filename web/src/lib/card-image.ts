// Image work for the card scanner (pages/CardScanner.tsx), all in the browser:
// open the photo, straighten the card from four corners (Claude's, or the
// ones the person drags), and make a clean black and white copy for
// Tesseract. Straightening matters: in scripts/card-bench Tesseract filed
// 90% of fields right on straightened phone photos and 64% on the photos as
// taken. (A corner finder of our own was removed: it often missed the card.)

export type Point = { x: number; y: number };
// corners in photo pixels: top left, top right, bottom right, bottom left
export type Quad = [Point, Point, Point, Point];

const WORK_MAX = 2000;
const OUT_MAX = 1600;

// The photo as a canvas no wider or taller than 2000px, turned upright
// (browsers apply the camera's orientation when drawing an <img>).
export async function loadPhoto(file: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode().catch(() => {
      throw new Error("This photo can't be opened here. Try a JPEG or PNG (on an iPhone: Settings → Camera → Formats → Most Compatible).");
    });
    const scale = Math.min(1, WORK_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Corners a little inside the photo's edges: where dragging starts when there are none.
export function insetQuad(w: number, h: number, inset = 0.06): Quad {
  const dx = w * inset;
  const dy = h * inset;
  return [{ x: dx, y: dy }, { x: w - dx, y: dy }, { x: w - dx, y: h - dy }, { x: dx, y: h - dy }];
}

// Solves the 3x3 homography taking `from` corners to `to` corners.
function homography(from: Quad, to: Quad): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let k = 0; k < 4; k++) {
    const { x, y } = from[k];
    const { x: u, y: v } = to[k];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gaussian elimination with partial pivoting
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = new Array(8).fill(0);
  for (let r = 7; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < 8; k++) s -= A[r][k] * h[k];
    h[r] = s / A[r][r];
  }
  return [...h, 1];
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

// The card cut out along the quad and straightened, its long side 1600px.
export function straighten(photo: HTMLCanvasElement, quad: Quad): HTMLCanvasElement {
  const [tl, tr, br, bl] = quad;
  let cw = Math.max(dist(tl, tr), dist(bl, br));
  let ch = Math.max(dist(tl, bl), dist(tr, br));
  const k = OUT_MAX / Math.max(cw, ch);
  cw = Math.max(1, Math.round(cw * k));
  ch = Math.max(1, Math.round(ch * k));
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  const src = photo.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, photo.width, photo.height);
  const dst = out.getContext('2d')!.createImageData(cw, ch);
  // maps output pixels back to photo pixels
  const H = homography([{ x: 0, y: 0 }, { x: cw, y: 0 }, { x: cw, y: ch }, { x: 0, y: ch }], quad);
  const sw = src.width, sh = src.height, s = src.data, d = dst.data;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const z = H[6] * x + H[7] * y + H[8];
      const sx = (H[0] * x + H[1] * y + H[2]) / z;
      const sy = (H[3] * x + H[4] * y + H[5]) / z;
      const o = (y * cw + x) * 4;
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) { d[o + 3] = 255; continue; }
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        d[o + c] = (s[i00 + c] * (1 - fx) + s[i10 + c] * fx) * (1 - fy) + (s[i01 + c] * (1 - fx) + s[i11 + c] * fx) * fy;
      }
      d[o + 3] = 255;
    }
  }
  out.getContext('2d')!.putImageData(dst, 0, 0);
  return out;
}

// Black and white, stretched to full contrast, and turned light-on-dark when
// the card is dark (Tesseract reads dark text on a light ground best).
export function forOcr(card: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = card.width;
  out.height = card.height;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(card, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  const n = d.length / 4;
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const g = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    gray[i] = g;
    hist[gray[i]]++;
    sum += g;
  }
  const invert = sum / n < 110;
  const pct = (p: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= p * n) return v;
    return 255;
  };
  const lo = pct(0.02), hi = Math.max(pct(0.98), lo + 1);
  for (let i = 0; i < n; i++) {
    let v = ((gray[i] - lo) / (hi - lo)) * 255;
    if (invert) v = 255 - v;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

export function toBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.88): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not make an image'))), type, quality));
}

export async function toBase64(canvas: HTMLCanvasElement): Promise<string> {
  const buf = await (await toBlob(canvas, 'image/jpeg', 0.9)).arrayBuffer();
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
