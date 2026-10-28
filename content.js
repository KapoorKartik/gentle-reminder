// Runs on web.whatsapp.com. When the background has just opened a
// /send?phone=…&text=… URL in this tab, wait for the chat to load with the
// text prefilled, press send, and report back.

const START_URL = location.href; // captured before WhatsApp rewrites the URL
const TIMEOUT_MS = 90_000;

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

const visible = (el) => { const r = el?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0; };

// True when nothing is drawn over the middle of `el`. WhatsApp opens the media
// preview *over* the chat, so the chat's box and button stay in the page
// (text and all) — only what's on top tells the two apart.
function onTop(el) {
  if (!visible(el)) return false;
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
}

const SEND_SEL = '[aria-label*="send" i], [title*="send" i], [data-icon*="send" i], [data-testid*="send" i]';

// The media preview's Send button: a send-looking control that isn't covered.
function mediaSendButton() {
  const els = [...document.querySelectorAll(SEND_SEL)]
    .map((el) => el.closest('button, [role="button"]') || el)
    .filter(onTop);
  return els[els.length - 1] || null;
}

// For the log when the preview's button can't be found.
function describeButtons() {
  const labels = [...document.querySelectorAll('[role="button"], button, [data-icon]')]
    .filter(onTop)
    .map((el) => el.getAttribute('aria-label') || el.getAttribute('title') || (el.dataset.icon && `icon:${el.dataset.icon}`))
    .filter(Boolean);
  return [...new Set(labels)].slice(-25).join(', ') || '(none)';
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

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

function dataUrlToFile({ dataUrl, name, type }) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type });
}

// Press send for whatever is in the compose box and wait for the ✓.
async function pressSend() {
  const box = composeBox();
  const btn = sendButton();
  if (!btn) note('send button not found, trying Enter key');
  if (btn) btn.click();
  else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (!hasText(composeBox())) {
      note('message left the box, waiting for ✓');
      return waitDelivered(60);
    }
  }
  return { ok: false, error: 'Pressed send but the message stayed in the box' };
}

async function waitDelivered(tries) {
  await sleep(1500);
  for (let j = 0; j < tries && lastMessagePending(); j++) await sleep(500);
  return lastMessagePending()
    ? { ok: true, error: `Still pending (clock icon) after ${tries / 2}s — check your connection` }
    : { ok: true };
}

const pressKey = (el, key, keyCode) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true }));

// Paste the file into the chat; WhatsApp opens its media preview and usually
// moves the typed text into the caption. Rather than hunt for the preview's
// buttons (their markup keeps changing), press Enter in the caption and treat
// a new outgoing message in the chat as success.
async function sendWithAttachment(box) {
  const { attachment } = await chrome.storage.local.get('attachment');
  if (!attachment?.dataUrl) return { ok: false, error: 'Attachment missing — re-attach it in Compose' };
  const file = dataUrlToFile(attachment);
  const dt = () => { const d = new DataTransfer(); d.items.add(file); return d; };
  const previewOpen = () => !box.isConnected || !onTop(box); // something now covers the chat box

  note(`attaching ${attachment.name}`);
  box.focus();
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt(), bubbles: true, cancelable: true }));
  if (!(await waitFor(previewOpen, 10_000))) {
    note('paste did not open the media preview, trying drag-and-drop');
    const main = document.querySelector('#main') || box;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      main.dispatchEvent(new DragEvent(type, { dataTransfer: dt(), bubbles: true, cancelable: true }));
      await sleep(200);
    }
    if (!(await waitFor(previewOpen, 10_000))) {
      note(`buttons on screen: ${describeButtons()}`);
      return { ok: false, error: 'Could not attach file (media preview never opened)' };
    }
  }

  await sleep(rand(2000, 3500)); // let the preview finish loading
  const caption = [...document.querySelectorAll('[contenteditable="true"]')].find((el) => el !== box && onTop(el));
  const carried = caption ? hasText(caption) : null;
  note(`media preview open, caption ${carried == null ? 'box not found' : carried ? 'has the message' : 'is empty'}`);

  // The preview closes once it has sent, uncovering the chat box again. (Counting
  // messages doesn't work: WhatsApp only keeps the visible ones in the page.)
  const sent = () => onTop(composeBox());
  const btn = mediaSendButton();
  if (btn) btn.click();
  else pressKey(caption || document.activeElement || document.body, 'Enter', 13);
  if (!(await waitFor(sent, 10_000))) {
    note(`preview still open after ${btn ? 'clicking Send' : 'pressing Enter'}; buttons on screen: ${describeButtons()}`);
    if (btn) pressKey(caption || document.activeElement || document.body, 'Enter', 13);
    else mediaSendButton()?.click();
    if (!(await waitFor(sent, 20_000))) {
      pressKey(document.activeElement || document.body, 'Escape', 27); // don't leave the preview open
      return { ok: false, error: "Media preview opened but couldn't press its Send button" };
    }
  }

  // Only send the text separately when it clearly didn't go as the caption,
  // so nobody gets the message twice.
  await sleep(1500);
  if (carried === false && hasText(composeBox())) {
    note('caption was empty — sending the text separately');
    await sleep(rand(1000, 2000));
    return pressSend();
  }
  note('attachment sent, waiting for ✓');
  return waitDelivered(120); // uploads take a while
}

async function trySend(task) {
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
      return task.attachment ? sendWithAttachment(box) : pressSend();
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
    result = await trySend(task);
  } catch (e) {
    result = { ok: false, error: `Script error: ${e?.message || e}` };
  }
  await chrome.runtime.sendMessage({ type: 'result', idx: task.idx, ...result }).catch((e) => console.error('[Gentle Sender] could not report result', e));
})();
