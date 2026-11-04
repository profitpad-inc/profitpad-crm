import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal } from './ui';

// The app's own confirm and alert, used instead of the browser's
// window.confirm / window.alert everywhere. Each call mounts a Modal on
// <body> and resolves once it is answered: confirmDialog resolves true for
// the confirm button and false for Cancel, the X, Escape or a click outside.
//
//   if (!(await confirmDialog('Delete this view?', { confirmLabel: 'Delete', danger: true }))) return;

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // red confirm button, for deletes and other changes that are hard to undo
  danger?: boolean;
}

function ConfirmModal({ message, title, confirmLabel, cancelLabel, danger, alertOnly, done }: ConfirmOptions & {
  message: string; alertOnly?: boolean; done: (ok: boolean) => void;
}) {
  // focus starts on the safe choice: Cancel for a risky (danger) action,
  // otherwise the confirm button, so Enter does the expected thing
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => (danger && !alertOnly ? cancelRef : okRef).current?.focus(), [danger, alertOnly]);
  return (
    <Modal
      title={title ?? (alertOnly ? 'Notice' : 'Are you sure?')}
      className="discard-confirm"
      onClose={() => done(false)}
      footer={
        <>
          {!alertOnly && <button ref={cancelRef} className="btn" onClick={() => done(false)}>{cancelLabel ?? 'Cancel'}</button>}
          <button ref={okRef} className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => done(true)}>
            {confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <p className="confirm-message">{message}</p>
    </Modal>
  );
}

function show(message: string, opts: ConfirmOptions, alertOnly: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      root.unmount();
      host.remove();
      resolve(ok);
    };
    root.render(<ConfirmModal {...opts} message={message} alertOnly={alertOnly} done={done} />);
  });
}

export function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  return show(message, opts, false);
}

export async function alertDialog(message: string, opts: Pick<ConfirmOptions, 'title' | 'confirmLabel'> = {}): Promise<void> {
  await show(message, opts, true);
}
