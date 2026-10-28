// Runs the campaign queue. Timing lives here (chrome.alarms survive the
// service worker being suspended); the content script only clicks "send".

if (typeof importScripts === 'function' && typeof renderMessage === 'undefined') {
  importScripts('common.js');
}

const WA = 'https://web.whatsapp.com/';
const WATCHDOG_MS = 120_000;
// Uploading an attachment needs more time before we give up on the tab.
const watchdogMs = (s) => (s.current === 'test' ? s.test?.attachment : s.hasAttachment) ? 240_000 : WATCHDOG_MS;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// ---- state -----------------------------------------------------------------

const today = () => new Date().toLocaleDateString('en-CA');

function emptyState() {
  return {
    run: 'idle', // idle | running | paused | stopped | done
    contacts: [],
    message: '',
    messages: [], // variants; each contact gets one (contact.v)
    hasAttachment: false,
    attachmentName: '',
    settings: { ...DEFAULT_SETTINGS },
    current: null, // index being sent, 'test', or null
    test: null,
    tabId: null,
    nextAt: null,
    nextReason: '',
    sinceBreak: 0,
    daily: { date: today(), count: 0 },
    log: [],
  };
}

// Serialise read-modify-write so alarms and messages can't clobber each other.
let lock = Promise.resolve();
function update(fn) {
  const run = lock.then(async () => {
    const { state = emptyState() } = await chrome.storage.local.get('state');
    const out = await fn(state);
    await chrome.storage.local.set({ state });
    return out;
  });
  lock = run.catch(() => {});
  return run;
}

function log(s, text) {
  s.log.push({ t: Date.now(), text });
  if (s.log.length > 500) s.log.splice(0, s.log.length - 500);
}

// Upsert the campaign into history (keyed by start time), so a retried
// campaign updates its record instead of adding a second one.
async function archive(s) {
  if (!s.contacts.length) return;
  s.startedAt ||= s.log[0]?.t || Date.now();
  const rec = {
    id: s.startedAt,
    startedAt: s.startedAt,
    endedAt: Date.now(),
    message: s.message,
    messages: s.messages,
    attachmentName: s.hasAttachment ? s.attachmentName : '',
    contacts: s.contacts.map(({ name, fullname, phone, status, error, at, v }) => ({ name, fullname, phone, status, error, at, v })),
  };
  const { history = [] } = await chrome.storage.local.get('history');
  const rest = history.filter((h) => h.id !== rec.id);
  await chrome.storage.local.set({ history: [rec, ...rest].slice(0, 200) });
}

function rollDaily(s) {
  if (s.daily.date !== today()) s.daily = { date: today(), count: 0 };
}

// ---- scheduling ------------------------------------------------------------

const hasWindow = (st) => st.startHour < st.endHour;

function windowStart(daysAhead, st) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hasWindow(st) ? st.startHour : 0, Math.floor(randBetween(0, 15)), 0, 0);
  return d.getTime();
}

function fitWindow(t, st) {
  if (!hasWindow(st)) return t;
  const d = new Date(t);
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < st.startHour) {
    d.setHours(st.startHour, Math.floor(randBetween(0, 15)), 0, 0);
    return d.getTime();
  }
  if (h >= st.endHour) {
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
    return windowStart(days + 1, st);
  }
  return t;
}

// quick: nothing was sent (invalid number etc.), so skip the long gap.
function scheduleNext(s, quick = false) {
  const st = s.settings;
  let ms, why;
  if (quick) {
    ms = randBetween(30, 45) * 1000; // chrome.alarms won't fire sooner than 30s
    why = 'delay';
  } else if (st.breakEvery > 0 && s.sinceBreak >= st.breakEvery) {
    ms = randBetween(st.breakMin * 60, st.breakMax * 60) * 1000;
    s.sinceBreak = 0;
    why = 'break';
  } else {
    ms = randBetween(st.minGap, st.maxGap) * 60_000;
    why = 'delay';
  }
  let t = Date.now() + ms;

  rollDaily(s);
  if (st.dailyCap > 0 && s.daily.count >= st.dailyCap) {
    t = windowStart(1, st);
    why = 'daily cap reached';
  } else {
    const fitted = fitWindow(t, st);
    if (fitted !== t) why = 'outside sending hours';
    t = fitted;
  }

  s.nextAt = t;
  s.nextReason = why;
  chrome.alarms.create('next', { when: t });
  const when = new Date(t).toLocaleString();
  log(s, why === 'delay' ? `Next in ${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `Pausing (${why}) until ${when}`);
}

// Old campaigns (before variants) only have s.message.
const textFor = (s, c) => renderMessage(s.messages?.[c.v] ?? s.message, c);

async function openChat(s, phone, text) {
  const url = `${WA}send?phone=${phone}&text=${encodeURIComponent(text)}`;
  let tab = s.tabId ? await chrome.tabs.get(s.tabId).catch(() => null) : null;
  if (!tab?.url?.startsWith(WA)) [tab] = await chrome.tabs.query({ url: WA + '*' });
  if (tab) await chrome.tabs.update(tab.id, { url }); // wa-main.js stops the "Leave app?" prompt
  else tab = await chrome.tabs.create({ url, active: false });
  s.tabId = tab.id;
  s.sendingSince = Date.now();
  chrome.alarms.create('watchdog', { when: Date.now() + watchdogMs(s) });
}

// Safety net in case the watchdog alarm never fires (e.g. extension reloaded).
async function unstick(s) {
  if (s.current == null || Date.now() - (s.sendingSince || 0) < watchdogMs(s)) return;
  if (s.current === 'test') return finish(s, 'test', false, 'No confirmation from the WhatsApp tab');
  await finish(s, s.current, false, 'No confirmation from the WhatsApp tab — check the chat', 'unsure');
}

async function sendNext(s) {
  const idx = s.contacts.findIndex((c) => c.status === 'pending');
  s.nextAt = null;
  if (idx < 0) {
    s.run = 'done';
    log(s, 'All done ✅');
    await archive(s);
    return;
  }
  const c = s.contacts[idx];
  c.status = 'sending';
  s.current = idx;
  log(s, `Sending to ${c.fullname || c.phone} (+${c.phone})`);
  await openChat(s, c.phone, textFor(s, c));
}

async function finish(s, idx, ok, error, failStatus = 'failed') {
  chrome.alarms.clear('watchdog');
  s.current = null;

  if (idx === 'test') {
    log(s, ok ? `Test sent to +${s.test.phone} ✅` : `Test failed: ${error}`);
    s.test = null;
    return;
  }

  const c = s.contacts[idx];
  c.status = ok ? 'sent' : failStatus;
  c.error = error || '';
  c.at = Date.now();
  if (ok) {
    rollDaily(s);
    s.daily.count++;
    s.sinceBreak++;
    log(s, `Sent to ${c.fullname || c.phone} ✅` + (error ? ` (${error})` : ''));
  } else {
    log(s, `Failed for ${c.fullname || c.phone}: ${error}`);
  }

  if (s.run !== 'running') return;
  if (s.contacts.some((x) => x.status === 'pending')) scheduleNext(s, c.status === 'failed');
  else await sendNext(s); // marks the run done
}

// ---- events ----------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) =>
  update(async (s) => {
    await unstick(s);
    if (alarm.name === 'next' && s.run === 'running' && s.current == null) await sendNext(s);
    if (alarm.name === 'watchdog' && s.current != null) {
      await finish(s, s.current, false, 'Timed out — may or may not have sent, check the chat', 'unsure');
    }
  })
);

// If the browser closed mid-send we can't know whether it went out, so mark it
// failed (never resend blindly) and carry on.
chrome.runtime.onStartup.addListener(() =>
  update(async (s) => {
    if (s.current != null && s.current !== 'test') {
      const c = s.contacts[s.current];
      c.status = 'unsure';
      c.error = 'Browser closed mid-send — check the chat';
    }
    s.current = null;
    s.test = null;
    if (s.run === 'running') {
      const when = Math.max(s.nextAt || 0, Date.now() + 60_000);
      s.nextAt = when;
      chrome.alarms.create('next', { when });
    }
  })
);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'start':
      return update(async (s) => {
        if (s.run === 'running') throw new Error('A campaign is already running');
        await archive(s);
        chrome.alarms.clearAll();
        const fresh = emptyState();
        fresh.daily = s.daily; // the daily cap spans campaigns
        rollDaily(fresh);
        const messages = msg.messages?.length ? msg.messages : [msg.message];
        Object.assign(s, fresh, {
          run: 'running',
          // Pick the variant once, so a retry or resume sends the same text.
          contacts: msg.contacts.map((c) => ({ ...c, v: Math.floor(Math.random() * messages.length), status: 'pending', error: '' })),
          message: messages[0],
          messages,
          hasAttachment: !!msg.attachment,
          attachmentName: msg.attachmentName || '',
          settings: msg.settings,
          tabId: s.tabId,
          startedAt: Date.now(),
        });
        log(s, `Campaign started: ${s.contacts.length} contacts`);
        await sendNext(s);
      });

    case 'pause':
      return update((s) => {
        if (s.run !== 'running') return;
        s.run = 'paused';
        s.nextAt = null;
        chrome.alarms.clear('next');
        log(s, 'Paused');
      });

    case 'resume':
      return update(async (s) => {
        if (s.run !== 'paused' && s.run !== 'stopped') return;
        s.run = 'running';
        log(s, 'Resumed');
        await unstick(s);
        if (s.current == null && !(s.nextAt > Date.now())) await sendNext(s);
      });

    case 'stop':
      return update(async (s) => {
        s.run = 'stopped';
        s.nextAt = null;
        chrome.alarms.clear('next');
        log(s, 'Stopped');
        await archive(s);
      });

    case 'retryFailed':
      return update((s) => {
        let n = 0;
        for (const c of s.contacts) if (c.status === 'failed') { c.status = 'pending'; c.error = ''; n++; }
        if (n && s.run === 'done') s.run = 'paused';
        log(s, `${n} failed contact(s) queued again — press Resume`);
      });

    case 'dismiss':
      return update(async (s) => {
        if (s.run === 'running') throw new Error('Pause or stop the campaign first');
        await archive(s);
        chrome.alarms.clearAll();
        const daily = s.daily;
        Object.assign(s, emptyState(), { daily, tabId: s.tabId });
      });

    case 'test':
      return update(async (s) => {
        if (s.current != null) throw new Error('Busy sending — try again in a moment');
        if (s.run === 'running') throw new Error('Pause the campaign before sending a test');
        s.test = { phone: msg.phone, attachment: !!msg.attachment };
        s.current = 'test';
        log(s, `Sending test to +${msg.phone}`);
        await openChat(s, msg.phone, msg.text);
      });

    case 'archive':
      return update(archive);

    case 'deleteHistory':
      return update(async () => {
        const { history = [] } = await chrome.storage.local.get('history');
        await chrome.storage.local.set({ history: history.filter((h) => h.id !== msg.id) });
      });

    case 'tick':
      return update(unstick);

    // From content.js
    case 'note':
      return update((s) => log(s, `  ↳ ${msg.text}`));

    case 'ready':
      return update((s) => {
        if (s.current == null || s.tabId !== sender.tab?.id) return null;
        if (s.current === 'test') return { idx: 'test', phone: s.test.phone, attachment: s.test.attachment };
        const c = s.contacts[s.current];
        return c.status === 'sending' ? { idx: s.current, phone: c.phone, attachment: s.hasAttachment } : null;
      });

    case 'result':
      return update(async (s) => {
        if (msg.idx !== s.current) return;
        await finish(s, msg.idx, msg.ok, msg.error);
      });
  }
}
