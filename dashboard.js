const $ = (id) => document.getElementById(id);
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
const COUNTRY_CODE = '91';

const MAX_VARIANTS = 5;
const MAX_ATTACHMENT = 16 * 1024 * 1024; // WhatsApp's media limit

let draft = { contacts: [], invalid: [], messages: [''], skipToday: true, settings: { ...DEFAULT_SETTINGS } };
let activeV = 0; // variant shown in the editor
let attachment = null; // { name, type, size, dataUrl }, kept in storage under its own key
let state = null;
let history = [];

// ---- parsing ---------------------------------------------------------------

// Indian mobiles: 10 digits starting 6-9, optionally with 0 / 91 / +91 in front.
// Numbers written with +<other country> are accepted as-is.
function normPhone(raw) {
  let s = String(raw).trim();
  let intl = s.startsWith('+') || s.startsWith('00');
  let d = s.replace(/\D/g, '');
  if (s.startsWith('00')) d = d.slice(2);
  if (d.length === 12 && d.startsWith(COUNTRY_CODE) && /^[6-9]/.test(d[2])) return d;
  if (intl) return d.length >= 8 && d.length <= 15 ? d : null;
  if (d.length === 10 && /^[6-9]/.test(d)) return COUNTRY_CODE + d;
  if (d.length === 11 && d[0] === '0' && /^[6-9]/.test(d[1])) return COUNTRY_CODE + d.slice(1);
  return null;
}

// "reva circle 01 Mahir, Dharwar, 3rd year" → fullname "Mahir", name "Mahir"
// "reva circle 02 Mohan jit, class 12th"     → fullname "Mohan jit", name "Mohan"
function cleanName(raw) {
  let s = String(raw || '').trim();
  const afterNumber = s.replace(/^.*?\b\d{1,4}\s+/, '');
  if (afterNumber && afterNumber !== s && /[a-z]/i.test(afterNumber)) s = afterNumber;
  let fullname = s.split(',')[0].trim();
  if (/^(na|n\/a|none|unknown|-+)$/i.test(fullname)) fullname = '';
  let name = fullname.split(/\s+/)[0] || '';
  if (/\d/.test(name)) name = '';
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return { name, fullname };
}

function decodeQuotedPrintable(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.substr(i + 1, 2))) {
      bytes.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else bytes.push(s.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function parseVcf(text) {
  text = text
    .replace(/=\r?\n/g, '') // quoted-printable soft breaks
    .replace(/\r?\n[ \t]/g, ''); // folded lines
  const out = [];
  for (const card of text.split(/BEGIN:VCARD/i).slice(1)) {
    let fn = '', n = '', tel = '';
    for (const line of card.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const head = line.slice(0, colon).toUpperCase();
      let value = line.slice(colon + 1).trim();
      if (head.includes('QUOTED-PRINTABLE')) value = decodeQuotedPrintable(value);
      value = value.replace(/\\([,;\\])/g, '$1');
      const prop = head.split(';')[0].replace(/^ITEM\d+\./, '');
      if (prop === 'FN') fn = value;
      else if (prop === 'N' && !n) n = value.split(';').filter(Boolean).reverse().join(' ');
      else if (prop === 'TEL' && !tel) tel = value;
    }
    out.push({ rawName: fn || n, rawPhone: tel });
  }
  return out;
}

function splitCsvLine(line) {
  const cells = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t' || ch === ';') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

const PHONE_RE = /\+?\d[\d\s\-().]{7,}\d/;

// One contact per line. Finds the phone-looking part; everything else is the name.
function parseLoose(line) {
  const m = line.match(PHONE_RE);
  if (!m) return { rawName: line.trim(), rawPhone: '' };
  const rawName = (line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ').replace(/^[\s,;|:-]+|[\s,;|:-]+$/g, '');
  return { rawName, rawPhone: m[0] };
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const phoneCol = header.findIndex((h) => /phone|mobile|number|tel|contact|whatsapp/.test(h));
  const nameCol = header.findIndex((h) => /name/.test(h) && !/last|sur/.test(h));
  if (phoneCol >= 0 && !PHONE_RE.test(lines[0])) {
    return lines.slice(1).map((l) => {
      const cells = splitCsvLine(l);
      return { rawName: nameCol >= 0 ? cells[nameCol] : '', rawPhone: cells[phoneCol] || '' };
    });
  }
  return lines.map(parseLoose);
}

function addContacts(entries, source) {
  const seen = new Set(draft.contacts.map((c) => c.phone));
  let added = 0, dupes = 0;
  for (const e of entries) {
    const phone = normPhone(e.rawPhone || '');
    const names = cleanName(e.rawName);
    if (!phone) {
      draft.invalid.push({ name: e.rawName || '(no name)', phone: e.rawPhone || '(no number)', source });
    } else if (seen.has(phone)) {
      dupes++;
    } else {
      seen.add(phone);
      draft.contacts.push({ ...names, phone, source });
      added++;
    }
  }
  flash(`Added ${added} from ${source}` + (dupes ? `, skipped ${dupes} duplicate(s)` : ''));
  saveDraft();
  renderAll();
}

// ---- persistence -----------------------------------------------------------

let saveTimer;
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ draft }), 300);
}

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (res?.error) alert(res.error);
  return res;
}

// ---- rendering -------------------------------------------------------------

const STATUS_LABEL = {
  pending: 'Waiting',
  sending: 'Sending…',
  sent: 'Sent ✅',
  failed: 'Failed ❌',
  unsure: 'Check ⚠️',
};
const statusCell = (c) =>
  `<td class="st-${esc(c.status)}" title="${esc(c.error)}">${STATUS_LABEL[c.status] || esc(c.status)}` +
  (c.error ? `<div class="err">${esc(c.error)}</div>` : '') + '</td>';

const campaignActive = () => state && ['running', 'paused', 'stopped'].includes(state.run) && state.contacts.length > 0;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let flashMsg = '';
function flash(text) {
  flashMsg = text;
  setTimeout(() => { flashMsg = ''; renderSummary(); }, 5000);
}

// Phones that got a message today, in the live campaign or any archived one.
function sentTodayPhones() {
  const lists = [state?.contacts || [], ...history.map((h) => h.contacts)];
  return new Set(lists.flat().filter((c) => c.status === 'sent' && isToday(c.at)).map((c) => c.phone));
}

function toSend() {
  if (!draft.skipToday) return draft.contacts;
  const done = sentTodayPhones();
  return draft.contacts.filter((c) => !done.has(c.phone));
}

function renderSummary() {
  const n = draft.contacts.length;
  $('contactSummary').textContent = `${n} valid contact${n === 1 ? '' : 's'} ready` + (flashMsg ? ` — ${flashMsg}` : '');
  const done = sentTodayPhones();
  const already = draft.contacts.filter((c) => done.has(c.phone)).length;
  $('todayWarn').hidden = !already;
  $('todayText').textContent = `⚠️ ${already} of these already got a message today`;
  $('skipToday').checked = draft.skipToday;
  $('invalidBox').hidden = !draft.invalid.length;
  $('invalidSummary').textContent = `${draft.invalid.length} skipped (invalid number) — click to see`;
  $('invalidList').innerHTML = draft.invalid
    .map((i) => `<li>${esc(i.name)} — <b>${esc(i.phone)}</b> <span class="muted">(${esc(i.source)})</span></li>`)
    .join('');
}

function renderTable() {
  $('tableTitle').textContent = `Contacts to send (${draft.contacts.length})`;
  const done = sentTodayPhones();
  $('rows').innerHTML = draft.contacts.length
    ? draft.contacts
        .map((c, i) => `<tr class="${done.has(c.phone) && draft.skipToday ? 'skipped' : ''}">
          <td>${i + 1}</td><td>${esc(c.name)}</td><td>${esc(c.fullname)}</td>
          <td>+${esc(c.phone)}${done.has(c.phone) ? '<span class="tag-today">✓ sent today</span>' : ''}</td>
          <td class="del"><button data-del="${i}" title="Remove">×</button></td>
        </tr>`)
        .join('')
    : '<tr><td colspan="5" class="muted center">No contacts yet — upload a file or paste above.</td></tr>';

  const live = campaignActive() ? state.contacts : [];
  $('liveTitle').textContent = `Contacts (${live.length})`;
  $('liveRows').innerHTML = live
    .map((c, i) => `<tr>
      <td>${i + 1}</td><td>${esc(c.fullname || c.name)}</td><td>+${esc(c.phone)}</td>${statusCell(c)}
      <td class="muted">${c.at ? new Date(c.at).toLocaleTimeString() : ''}</td>
    </tr>`)
    .join('');
}

function renderPreview() {
  const c = draft.contacts[0];
  const variant = draft.messages.length > 1 ? ` · variant ${activeV + 1}` : '';
  $('previewWho').textContent = (c ? `${c.fullname} (+${c.phone})` : 'sample contact') + variant;
  $('previewText').textContent = renderMessage(draft.messages[activeV], c || { name: 'Rohith', fullname: 'Rohith', phone: '' });
  const img = attachment?.type.startsWith('image/');
  $('previewImg').hidden = !img;
  if (img && $('previewImg').src !== attachment.dataUrl) $('previewImg').src = attachment.dataUrl;
  if (!img) $('previewImg').removeAttribute('src');
  $('previewFile').hidden = !attachment || img;
  $('previewFile').textContent = attachment ? `📄 ${attachment.name}` : '';
}

function renderVariants() {
  const n = draft.messages.length;
  $('variantTabs').innerHTML = n > 1 || draft.messages[0]
    ? draft.messages
        .map((_, i) => `<button data-v="${i}" class="${i === activeV ? 'active' : ''}">V${i + 1}` +
          (i > 0 && i === activeV ? `<span class="x" data-vdel="${i}" title="Remove this variant">×</span>` : '') + '</button>')
        .join('') + (n < MAX_VARIANTS ? '<button class="add" data-vadd title="Add another version of the message">+ Variant</button>' : '')
    : '';
  $('variantHint').textContent = n > 1 ? ` Each contact gets one of the ${n} variants at random.` : '';
  if ($('message').value !== draft.messages[activeV]) $('message').value = draft.messages[activeV];
}

const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);

function renderAttachment() {
  $('attachInfo').hidden = !attachment;
  $('attachLabel').hidden = !!attachment;
  $('attachName').textContent = attachment ? `📎 ${attachment.name} (${fmtSize(attachment.size)})` : '';
  renderPreview();
}

function readSettings() {
  const s = {};
  for (const k of SETTING_KEYS) s[k] = Number($('s_' + k).value) || 0;
  return s;
}

function renderEstimate() {
  const s = draft.settings;
  const count = toSend().length;
  $('startBtn').textContent = count ? `Send to ${count} contact${count === 1 ? '' : 's'}` : 'Add contacts to send';
  $('speedSummary').textContent =
    `${s.minGap}–${s.maxGap} min apart · max ${s.dailyCap || '∞'}/day · ${s.startHour}:00–${s.endHour}:00`;
  const n = count;
  if (!n) { $('estimate').textContent = ''; return; }
  const perMsg = ((s.minGap + s.maxGap) / 2) * 60 + 15 + (attachment ? 10 : 0); // + page load, upload
  let secs = n * perMsg;
  if (s.breakEvery > 0) secs += Math.floor(n / s.breakEvery) * ((s.breakMin + s.breakMax) / 2) * 60;
  const days = s.dailyCap > 0 ? Math.ceil(n / s.dailyCap) : 1;
  $('estimate').textContent =
    `Takes about ${(secs / 3600).toFixed(1)} h` + (days > 1 ? `, spread over ${days} days` : '');
}

function renderRun() {
  const s = state || { run: 'idle', contacts: [], log: [] };
  const counts = { sent: 0, failed: 0, pending: 0, sending: 0 };
  for (const c of s.contacts) counts[c.status] = (counts[c.status] || 0) + 1;
  const total = s.contacts.length;
  const done = counts.sent + counts.failed + (counts.unsure || 0);
  $('bar').style.width = total ? `${(done / total) * 100}%` : '0';
  $('runPct').textContent = `${total ? Math.floor((done / total) * 100) : 0}%`;
  $('runCount').textContent = `${done} of ${total} done`;
  $('statSent').textContent = counts.sent;
  $('statFailed').textContent = counts.failed;
  $('statUnsure').textContent = counts.unsure || 0;
  $('statLeft').textContent = counts.pending + counts.sending;

  const active = campaignActive();
  $('campaign').hidden = !active;
  $('noCampaign').hidden = active;

  let status = '';
  if (s.current === 'test') status = 'Sending test message…';
  else if (s.current != null) status = `Sending to ${s.contacts[s.current]?.fullname || 'contact'}…`;
  else if (s.run === 'running' && s.nextAt) {
    const secs = Math.max(0, Math.round((s.nextAt - Date.now()) / 1000));
    const wait = secs > 3600 ? new Date(s.nextAt).toLocaleString() : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
    status = s.nextReason === 'delay' ? `Next message in ${wait}` : `Waiting (${s.nextReason}) until ${wait}`;
  } else if (s.run === 'paused') status = 'Paused — press Resume to continue';
  else if (s.run === 'stopped') status = 'Stopped — Resume to continue, or Close campaign';
  $('runStatus').textContent = status;
  const label = { running: ['● Sending', 'on'], paused: ['Paused', 'warn'], stopped: ['Stopped', 'warn'], done: ['Finished', 'on'] }[s.run] || ['Idle', ''];
  $('runState').textContent = label[0];
  $('runState').className = 'pill ' + label[1];

  // Header badge only while there's something to keep an eye on.
  const pill = { running: ['● Sending', 'on'], paused: ['Paused', 'warn'], stopped: ['Stopped', 'warn'] }[s.run];
  $('headStatus').hidden = !pill;
  if (pill) {
    $('headStatus').textContent = pill[0] + (s.run === 'running' && status ? ` · ${status.replace('Next message in', 'next in')}` : '');
    $('headStatus').className = 'pill ' + pill[1];
  }
  $('progressBadge').hidden = !active;
  $('progressBadge').textContent = active ? `${done}/${total}` : '';

  const lastTest = [...s.log].reverse().find((l) => /^(Sending test|Test )/.test(l.text));
  const recent = lastTest && Date.now() - lastTest.t < 10 * 60_000;
  $('testStatus').className = 'small ' + (recent && /✅/.test(lastTest.text) ? 'ok' : recent && /failed/i.test(lastTest.text) ? 'bad' : 'muted');
  $('testStatus').textContent = s.current === 'test'
    ? '⏳ Sending test… (switch to the WhatsApp tab to watch)'
    : recent && lastTest.text.startsWith('Test ')
      ? (/✅/.test(lastTest.text) ? '✅ Test sent — check it on your phone. If it looks right, go to step 2.' : `❌ ${lastTest.text}`)
      : '';

  const blocking = ['running', 'paused'].includes(s.run);
  $('startNote').hidden = !blocking;
  $('startNote').innerHTML = blocking ? 'A campaign is in progress — see <a href="#" data-goto="progress">Progress</a>.' : '';

  const busy = s.current != null;
  $('startBtn').disabled = ['running', 'paused'].includes(s.run) || !toSend().length;
  $('pauseBtn').disabled = s.run !== 'running';
  $('resumeBtn').disabled = !['paused', 'stopped'].includes(s.run) || !counts.pending;
  $('stopBtn').disabled = !['running', 'paused'].includes(s.run);
  $('retryBtn').disabled = !counts.failed || s.run === 'running';
  $('exportBtn').disabled = !total;
  $('newBtn').disabled = !active || s.run === 'running';
  $('testBtn').disabled = busy || s.run === 'running';

  $('log').innerHTML = s.log
    .slice()
    .reverse()
    .map((l) => `<li>${new Date(l.t).toLocaleTimeString()} — ${esc(l.text)}</li>`)
    .join('');
}

function renderAll() {
  renderSummary();
  renderTable();
  renderVariants();
  renderAttachment();
  renderEstimate();
  renderRun();
  renderHistory();
}

// ---- tabs ------------------------------------------------------------------

function showTab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (tab) showTab(tab);
});
document.addEventListener('click', (e) => {
  const to = e.target.closest('[data-goto]')?.dataset.goto;
  if (to) { e.preventDefault(); showTab(to); }
});

// ---- events ----------------------------------------------------------------

$('files').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    const text = await file.text();
    const entries = /\.vcf$/i.test(file.name) || /BEGIN:VCARD/i.test(text) ? parseVcf(text) : parseCsv(text);
    addContacts(entries, file.name);
  }
  e.target.value = '';
});

function pastedEntries() {
  const text = $('paste').value;
  if (!text.trim()) return [];
  return /BEGIN:VCARD/i.test(text) ? parseVcf(text) : text.split(/\r?\n/).filter((l) => l.trim()).map(parseLoose);
}

function addPasted() {
  const entries = pastedEntries();
  if (!entries.length) return;
  addContacts(entries, 'pasted');
  $('paste').value = '';
  $('pasteHint').textContent = '';
}

$('addPaste').addEventListener('click', addPasted);
$('paste').addEventListener('input', () => {
  const n = pastedEntries().filter((e) => normPhone(e.rawPhone || '')).length;
  $('pasteHint').textContent = n ? `${n} number(s) found — press “Add pasted” (Start adds them too)` : '';
});

$('clearContacts').addEventListener('click', () => {
  if (!draft.contacts.length && !draft.invalid.length) return;
  if (!confirm('Clear the contact list?')) return;
  draft.contacts = [];
  draft.invalid = [];
  saveDraft();
  renderAll();
});

$('rows').addEventListener('click', (e) => {
  const i = e.target.dataset?.del;
  if (i == null) return;
  draft.contacts.splice(Number(i), 1);
  saveDraft();
  renderAll();
});

$('message').addEventListener('input', () => {
  const wasEmpty = !draft.messages[activeV];
  draft.messages[activeV] = $('message').value;
  saveDraft();
  renderPreview();
  if (wasEmpty !== !draft.messages[activeV]) renderVariants(); // show/hide the tab strip
});

$('variantTabs').addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset.vdel != null) {
    draft.messages.splice(Number(t.dataset.vdel), 1);
    activeV = Math.min(activeV, draft.messages.length - 1);
  } else if (t.dataset.vadd != null) {
    draft.messages.push('');
    activeV = draft.messages.length - 1;
  } else if (t.closest('[data-v]')) {
    activeV = Number(t.closest('[data-v]').dataset.v);
  } else return;
  saveDraft();
  renderVariants();
  renderPreview();
  $('message').focus();
});

$('attachFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MAX_ATTACHMENT) return alert(`That file is ${fmtSize(file.size)} — WhatsApp allows up to 16 MB.`);
  const reader = new FileReader();
  reader.onload = async () => {
    attachment = { name: file.name, type: file.type || 'application/octet-stream', size: file.size, dataUrl: reader.result };
    await chrome.storage.local.set({ attachment });
    renderAttachment();
    renderEstimate();
  };
  reader.readAsDataURL(file);
});

$('attachRemove').addEventListener('click', async () => {
  attachment = null;
  await chrome.storage.local.remove('attachment');
  renderAttachment();
  renderEstimate();
});

$('skipToday').addEventListener('change', () => {
  draft.skipToday = $('skipToday').checked;
  saveDraft();
  renderTable();
  renderEstimate();
  renderRun();
});

for (const k of SETTING_KEYS) {
  $('s_' + k).addEventListener('input', () => {
    draft.settings = readSettings();
    saveDraft();
    renderEstimate();
  });
}

// Firefox treats host permissions as optional in MV3, so ask on the first send.
// Must run before any other await, while the click still counts as a user gesture.
const ensureWaAccess = () =>
  chrome.permissions.request({ origins: ['https://web.whatsapp.com/*'] }).catch(() => {});

$('testBtn').addEventListener('click', async () => {
  await ensureWaAccess();
  const phone = normPhone($('testPhone').value);
  if (!phone) return alert('Enter a valid number (10-digit Indian mobile or +countrycode…)');
  const text = draft.messages[activeV];
  if (!text.trim()) return alert('Write a message first');
  const sample = draft.contacts[0] || { name: '', fullname: '', phone };
  await send({ type: 'test', phone, text: renderMessage(text, sample), attachment: !!attachment });
});

$('startBtn').addEventListener('click', async () => {
  await ensureWaAccess();
  addPasted();
  const s = readSettings();
  if (!draft.contacts.length) return alert('Add some contacts first');
  const messages = draft.messages.filter((m) => m.trim());
  if (!messages.length) return alert('Write a message first');
  const contacts = toSend();
  const skipped = draft.contacts.length - contacts.length;
  if (!contacts.length) return alert('Everyone on the list already got a message today. Untick “Skip them” to send again.');
  if (s.minGap < 0.5) return alert('Keep the minimum gap at 0.5 minutes or more');
  if (s.maxGap < s.minGap) return alert('Max gap must be ≥ min gap');
  if (s.breakEvery > 0 && s.breakMax < s.breakMin) return alert('Break max must be ≥ break min');
  if (state?.run === 'stopped' && !confirm('Start a new campaign? The stopped one is kept in History.')) return;
  const details = [
    skipped && `${skipped} skipped — already messaged today`,
    messages.length > 1 && `${messages.length} message variants`,
    attachment && `with ${attachment.name}`,
  ].filter(Boolean);
  if (!confirm(`Send to ${contacts.length} contacts?` + (details.length ? ` (${details.join(', ')})` : '') +
    '\n\nKeep WhatsApp Web logged in and this browser open.')) return;
  const res = await send({
    type: 'start', contacts, messages, settings: s,
    attachment: !!attachment, attachmentName: attachment?.name || '',
  });
  if (!res?.error) showTab('progress');
});

$('pauseBtn').addEventListener('click', () => send({ type: 'pause' }));
$('resumeBtn').addEventListener('click', () => send({ type: 'resume' }));
$('stopBtn').addEventListener('click', () => confirm('Stop sending? You can resume later.') && send({ type: 'stop' }));
$('retryBtn').addEventListener('click', () => send({ type: 'retryFailed' }));
$('newBtn').addEventListener('click', () => confirm('Close this campaign and go back to your list?') && send({ type: 'dismiss' }));

function exportCsv(contacts, when) {
  const rows = [['name', 'fullname', 'phone', 'variant', 'status', 'error', 'time']];
  for (const c of contacts) {
    const variant = c.v != null ? c.v + 1 : '';
    rows.push([c.name, c.fullname, '+' + c.phone, variant, c.status, c.error || '', c.at ? new Date(c.at).toLocaleString() : '']);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  const stamp = new Date(when || Date.now()).toLocaleString('sv').replace(/[: ]/g, '-').slice(0, 16);
  a.download = `gentle-sender-${stamp}.csv`;
  a.click();
}

$('exportBtn').addEventListener('click', () => exportCsv(state.contacts, state.startedAt));

// ---- history ---------------------------------------------------------------

const isToday = (t) => t && new Date(t).toDateString() === new Date().toDateString();

function tally(contacts) {
  const t = { sent: 0, failed: 0, unsure: 0, pending: 0 };
  for (const c of contacts) if (c.status in t) t[c.status]++;
  return t;
}

function renderHistory() {
  // Today = every contact handled today, in the live campaign or archived ones.
  const live = state?.contacts?.length ? [{ id: state.startedAt, contacts: state.contacts }] : [];
  const records = [...live, ...history.filter((h) => !live.length || h.id !== state.startedAt)];
  const todays = records.flatMap((r) => r.contacts.filter((c) => isToday(c.at)));
  const t = tally(todays);
  const campaignsToday = records.filter((r) => r.contacts.some((c) => isToday(c.at))).length;
  $('today').innerHTML = todays.length
    ? `<b>Today:</b> ${t.sent} sent ✅ · ${t.failed} failed ❌` + (t.unsure ? ` · ${t.unsure} to check ⚠️` : '') +
      ` <span class="muted">across ${campaignsToday} campaign${campaignsToday === 1 ? '' : 's'}</span>`
    : '<span class="muted">Nothing sent today yet.</span>';

  $('history').innerHTML = history.length
    ? history.map((h) => {
        const k = tally(h.contacts);
        const firstLine = (h.message || '').split('\n')[0].slice(0, 60);
        const rows = h.contacts
          .map((c) => `<tr><td>${esc(c.fullname || c.name)}</td><td>+${esc(c.phone)}</td>
            ${statusCell(c)}
            <td class="muted">${c.at ? new Date(c.at).toLocaleTimeString() : ''}</td></tr>`)
          .join('');
        return `<details class="hist">
          <summary><b>${new Date(h.startedAt).toLocaleString()}</b> · ${h.contacts.length} contacts ·
            <span class="st-sent">${k.sent} sent</span> · <span class="st-failed">${k.failed} failed</span>` +
            (k.unsure ? ` · <span class="st-unsure">${k.unsure} to check</span>` : '') +
            (k.pending ? ` · ${k.pending} not sent` : '') +
            `<div class="muted small">${esc(firstLine)}` +
            (h.messages?.length > 1 ? ` · ${h.messages.length} variants` : '') +
            (h.attachmentName ? ` · 📎 ${esc(h.attachmentName)}` : '') + `</div></summary>
          <div class="row"><button class="ghost" data-export="${h.id}">Export CSV</button>
            <button class="ghost danger" data-delete="${h.id}">Delete</button></div>
          <div class="tablewrap"><table><tbody>${rows}</tbody></table></div>
        </details>`;
      }).join('')
    : '<p class="muted small center">Finished and stopped campaigns will appear here.</p>';
}

$('history').addEventListener('click', (e) => {
  const exp = e.target.dataset?.export;
  const del = e.target.dataset?.delete;
  if (exp) {
    const h = history.find((x) => String(x.id) === exp);
    exportCsv(h.contacts, h.startedAt);
  }
  if (del && confirm('Delete this campaign from history?')) send({ type: 'deleteHistory', id: Number(del) });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.history) history = changes.history.newValue || [];
  if (changes.state) {
    state = changes.state.newValue;
    renderTable();
    renderRun();
  }
  if (changes.state || changes.history) {
    renderHistory();
    renderSummary(); // "sent today" depends on both
    if (!changes.state) renderTable();
    renderEstimate();
  }
});

setInterval(renderRun, 1000); // countdown
setInterval(() => state?.current != null && chrome.runtime.sendMessage({ type: 'tick' }).catch(() => {}), 30_000);

(async () => {
  const stored = await chrome.storage.local.get(['draft', 'state', 'history', 'attachment']);
  history = stored.history || [];
  attachment = stored.attachment || null;
  if (stored.state?.run === 'done' && !history.some((h) => h.id === stored.state.startedAt)) send({ type: 'archive' });
  if (stored.draft) {
    // Settings saved before gaps moved to minutes: start from the new defaults.
    const saved = 'minDelay' in (stored.draft.settings || {}) ? {} : stored.draft.settings;
    draft = { ...draft, ...stored.draft, settings: { ...DEFAULT_SETTINGS, ...saved } };
    // Drafts from before variants had a single `message`.
    if (!stored.draft.messages?.length) draft.messages = [stored.draft.message || ''];
    delete draft.message;
  }
  state = stored.state || null;
  for (const k of SETTING_KEYS) $('s_' + k).value = draft.settings[k];
  renderAll();
  if (campaignActive()) showTab('progress');
})();
