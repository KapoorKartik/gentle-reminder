// Shared by background.js and dashboard.js.

const DEFAULT_SETTINGS = {
  minGap: 5,        // minutes between messages
  maxGap: 10,
  breakEvery: 15,   // take a longer break after this many messages (0 = never)
  breakMin: 15,     // minutes
  breakMax: 30,
  dailyCap: 80,     // max messages per calendar day (0 = no cap)
  startHour: 9,     // only send between these hours (equal = any time)
  endHour: 21,
};

// {name}, {fullname}, {phone}; {name|friend} falls back to "friend" when empty.
function renderMessage(tpl, c) {
  return tpl.replace(/\{(name|fullname|phone)(?:\|([^}]*))?\}/gi, (_, key, fallback) => {
    const v = { name: c.name, fullname: c.fullname, phone: c.phone }[key.toLowerCase()];
    return v || fallback || '';
  });
}

function randBetween(a, b) {
  return a + Math.random() * (b - a);
}
