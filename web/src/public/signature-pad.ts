// Draw-to-sign canvas, shared by the public quote page and the CRM
// countersign dialog. Pointer events cover mouse, pen and touch; the canvas
// keeps its 520 x 160 drawing size however wide CSS makes it.

export const SIGNATURE_WIDTH = 520;
export const SIGNATURE_HEIGHT = 160;

export interface SignaturePad {
  isEmpty: () => boolean;
  clear: () => void;
  toDataURL: () => string;
  destroy: () => void;
}

export function attachSignaturePad(canvas: HTMLCanvasElement, onChange?: (empty: boolean) => void): SignaturePad {
  canvas.width = SIGNATURE_WIDTH;
  canvas.height = SIGNATURE_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111111';
  let drawing = false;
  let drawn = false;
  let last: { x: number; y: number } | null = null;

  const point = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
  };
  const down = (e: PointerEvent) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    last = point(e);
    // a tap leaves a dot
    ctx.beginPath();
    ctx.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    if (!drawn) {
      drawn = true;
      onChange?.(false);
    }
  };
  const move = (e: PointerEvent) => {
    if (!drawing || !last) return;
    e.preventDefault();
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  };
  const up = () => {
    drawing = false;
    last = null;
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  return {
    isEmpty: () => !drawn,
    clear: () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawn = false;
      onChange?.(true);
    },
    toDataURL: () => canvas.toDataURL('image/png'),
    destroy: () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    }
  };
}
