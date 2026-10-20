// Motion lives in the dialog-motion and dialog-backdrop-motion utilities (index.css):
// a centered fade and subtle scale, with no slide on any breakpoint.
const DIALOG_BACKDROP_BASE_CLASS = "dialog-backdrop-motion fixed inset-0 z-50";

const DIALOG_BACKDROP_CLASS = `dialog-backdrop ${DIALOG_BACKDROP_BASE_CLASS}`;
const DIALOG_MEDIA_BACKDROP_CLASS = `${DIALOG_BACKDROP_BASE_CLASS} bg-black/75`;

const DIALOG_POPUP_BASE_CLASS =
  "dialog-motion relative flex min-h-0 w-full min-w-0 flex-col outline-none [-webkit-app-region:no-drag]";

const DIALOG_POPUP_CLASS = `dialog-glass surface-raised ${DIALOG_POPUP_BASE_CLASS} rounded-2xl border`;
const DIALOG_MEDIA_POPUP_CLASS = `${DIALOG_POPUP_BASE_CLASS} max-h-[92vh] w-auto max-w-[92vw] overflow-visible rounded-none border border-transparent bg-transparent p-0 shadow-none`;

export {
  DIALOG_BACKDROP_CLASS,
  DIALOG_MEDIA_BACKDROP_CLASS,
  DIALOG_POPUP_CLASS,
  DIALOG_MEDIA_POPUP_CLASS,
};
