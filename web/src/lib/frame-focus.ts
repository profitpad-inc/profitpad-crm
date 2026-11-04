// Clicks inside an iframe (a custom view, the frame on a view's page) never
// reach this document's mousedown listeners, so popups that close on an
// outside click stay open. The window loses focus to the frame instead:
// call cb when that happens. Returns the cleanup.
export function onFrameFocus(cb: () => void): () => void {
  const onBlur = () => setTimeout(() => {
    if (document.activeElement instanceof HTMLIFrameElement) cb();
  });
  window.addEventListener('blur', onBlur);
  return () => window.removeEventListener('blur', onBlur);
}
