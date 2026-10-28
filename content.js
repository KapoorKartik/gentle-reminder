// Runs on web.whatsapp.com. When the background has just opened a
// /send?phone=…&text=… URL in this tab, wait for the chat to load with the
// text prefilled, press send, and report back.

const START_URL = location.href; // captured before WhatsApp rewrites the URL
const TIMEOUT_MS = 90_000;

// WhatsApp asks "Leave site?" while it thinks something is unsaved. Let the
// navigation through only when the background is opening the next chat.
let leaving = false;
window.addEventListener('beforeunload', (e) => { if (leaving) e.stopImmediatePropagation(); }, true);
chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'navigating') leaving = true; });

const note = (text) => chrome.runtime.sendMessage({ type: 'note', text }).catch(() => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

function composeBox() {
  return (
    document.querySelector('#main footer div[contenteditable="true"]') ||
    document.querySelector('footer div[contenteditable="true"][role="textbox"]')
  );
}

function hasText(box) {
  return box && (box.innerText.replace(/\s/g, '').length > 0 || box.querySelector('img'));
}

function sendButton() {
  const root = document.querySelector('#main footer') || document;
  const btn = root.querySelector('button[aria-label="Send"], [data-testid="send"], [data-testid="compose-btn-send"]');
  if (btn) return btn.closest('button') || btn;
  const icon = root.querySelector('span[data-icon="send"], span[data-icon="wds-ic-send-filled"]');
  return icon && (icon.closest('button, [role="button"]') || icon);
}

// Outgoing message still showing the clock icon (not yet left the outbox).
function lastMessagePending() {
  const outs = document.querySelectorAll('#main .message-out');
  const last = outs[outs.length - 1];
  return !!last?.querySelector('[data-icon="msg-time"], [data-icon*="pending" i], [aria-label*="pending" i]');
}

function invalidDialog() {
  for (const d of document.querySelectorAll('[role="dialog"], [data-animate-modal-popup="true"]')) {
    if (/invalid|isn.t on whatsapp|not on whatsapp/i.test(d.innerText)) return d;
  }
  return null;
}

async function trySend() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const dlg = invalidDialog();
    if (dlg) {
      dlg.querySelector('button')?.click();
      return { ok: false, error: 'Number is not on WhatsApp / invalid' };
    }

    const box = composeBox();
    if (hasText(box)) {
      note('chat open with message, pressing send');
      await sleep(rand(1000, 3000)); // don't fire the instant the chat opens
      const btn = sendButton();
      if (!btn) note('send button not found, trying Enter key');
      if (btn) btn.click();
      else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

      for (let i = 0; i < 40; i++) {
        await sleep(250);
        if (!hasText(composeBox())) {
          note('message left the box, waiting for ✓');
          await sleep(1500);
          for (let j = 0; j < 60 && lastMessagePending(); j++) await sleep(500);
          return lastMessagePending()
            ? { ok: true, error: 'Still pending (clock icon) after 30s — check your connection' }
            : { ok: true };
        }
      }
      return { ok: false, error: 'Pressed send but the message stayed in the box' };
    }
    await sleep(500);
  }
  const loggedOut = document.querySelector('canvas[aria-label*="QR" i], [data-ref]');
  return {
    ok: false,
    error: loggedOut ? 'WhatsApp Web is not logged in' : 'Timed out waiting for the chat to open',
  };
}

(async () => {
  const task = await chrome.runtime.sendMessage({ type: 'ready' }).catch(() => null);
  if (!task || task.error) return;
  // Only act on the navigation the background made, not a manual refresh.
  if (new URL(START_URL).searchParams.get('phone') !== task.phone) {
    note('WhatsApp tab reloaded but not on the expected chat — waiting for timeout');
    return;
  }
  note('WhatsApp page loaded');
  let result;
  try {
    result = await trySend();
  } catch (e) {
    result = { ok: false, error: `Script error: ${e?.message || e}` };
  }
  await chrome.runtime.sendMessage({ type: 'result', idx: task.idx, ...result }).catch((e) => console.error('[Gentle Sender] could not report result', e));
})();
