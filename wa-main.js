// Runs in WhatsApp Web's own page context (not the extension's isolated one).
// Gentle Sender moves this tab from chat to chat by loading a new URL, and
// WhatsApp's "Leave app?" prompt would block that. Living in the page, this
// keeps working even after the extension is reloaded.

(() => {
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (type === 'beforeunload' && this === window) return;
    return add.call(this, type, fn, opts);
  };
  Object.defineProperty(window, 'onbeforeunload', { get: () => null, set: () => {}, configurable: true });
})();
