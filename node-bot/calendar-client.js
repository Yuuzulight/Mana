// #906: calendar reads (and adding an event) without an npm dependency.
// Two kinds of calendar, told apart by whether a username is set:
//   - CalDAV (username + app password): iCloud, Fastmail, Nextcloud, most
//     self-hosted servers. Read and add. The URL may be the server's root
//     (https://caldav.icloud.com): the first calendar is found from it.
//   - An iCal feed URL (no username): Google's "secret address in iCal
//     format" or Outlook's published-calendar ICS link. Read-only; the URL
//     itself is the secret. Adding to Google/Outlook needs OAuth (not built).
// Fetched on each ask, never kept around.
const crypto = require("node:crypto");

const TIMEOUT_MS = 20000;
const DAY = 24 * 60 * 60 * 1000;
// Guards a runaway rule (FREQ=DAILY from 1990 with no end).
const MAX_OCCURRENCE_STEPS = 20000;

// ---- iCalendar parsing ----

function unescapeText(value) {
  return value.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

function escapeText(value) {
  // Any line break, a lone \r too, so a title can't start a new property.
  return String(value).replace(/[\\;,]/g, "\\$&").replace(/\r\n|\r|\n/g, "\\n");
}

// ms offset of timeZone from UTC at utcMs.
function zoneOffset(utcMs, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(utcMs)) {
    parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs;
}

// An iCalendar DATE or DATE-TIME -> { ms, allDay }. TZID is an IANA zone
// where the feed uses one; anything else (Outlook's Windows zone names) or
// a floating time is read as this PC's local time.
// ponytail: no VTIMEZONE parsing -- right for the user's own zone, off by
// the zone difference for a Windows-named zone elsewhere.
function parseDate(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1, 7).map((v) => Number(v || 0));
  if (!m[4]) return { ms: new Date(y, mo - 1, d).getTime(), allDay: true };
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  if (params.TZID) {
    try {
      const guess = Date.UTC(y, mo - 1, d, h, mi, s);
      const first = guess - zoneOffset(guess, params.TZID);
      return { ms: guess - zoneOffset(first, params.TZID), allDay: false };
    } catch {
      // not an IANA zone: local time below
    }
  }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false };
}

function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [w, d, h, mi, s] = m.slice(2).map((v) => Number(v || 0));
  return (m[1] === "-" ? -1 : 1) * ((w * 7 + d) * DAY + (h * 3600 + mi * 60 + s) * 1000);
}

// All VEVENTs in an iCalendar text (nested VALARMs skipped).
function parseEvents(ics) {
  const lines = String(ics).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let event = null;
  let nested = 0;
  for (const line of lines) {
    const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    if (colon < 0) continue;
    const [name, ...paramParts] = line.slice(0, colon).split(";");
    const value = line.slice(colon + 1);
    const key = name.toUpperCase();
    if (key === "BEGIN") {
      if (value.toUpperCase() === "VEVENT" && !event) event = { exdates: [] };
      else if (event) nested++;
      continue;
    }
    if (key === "END") {
      if (event && nested) nested--;
      else if (event && value.toUpperCase() === "VEVENT") {
        events.push(event);
        event = null;
      }
      continue;
    }
    if (!event || nested) continue;
    const params = Object.fromEntries(
      paramParts.map((p) => {
        const [k, v = ""] = p.split("=");
        return [k.toUpperCase(), v.replace(/^"|"$/g, "")];
      }),
    );
    if (key === "SUMMARY" || key === "LOCATION" || key === "UID" || key === "STATUS" || key === "TRANSP") {
      event[key.toLowerCase()] = unescapeText(value);
    } else if (key === "DTSTART" || key === "DTEND" || key === "RECURRENCE-ID") {
      event[key.toLowerCase()] = parseDate(value, params);
    } else if (key === "DURATION") {
      event.duration = parseDuration(value);
    } else if (key === "RRULE") {
      event.rrule = Object.fromEntries(value.split(";").map((p) => p.split("=")).map(([k, v]) => [k.toUpperCase(), v]));
    } else if (key === "EXDATE") {
      for (const v of value.split(",")) {
        const parsed = parseDate(v, params);
        if (parsed) event.exdates.push(parsed.ms);
      }
    }
  }
  return events.filter((e) => e.dtstart);
}

// ---- recurrence ----

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const SUPPORTED_RULE_KEYS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "WKST"]);

// The date (ms, time of day kept) of spec ("1TU", "-1FR") in monthStart's month.
function nthWeekday(monthStart, spec) {
  const [, n, day] = /^([+-]?\d)(\w\w)$/.exec(spec);
  const weekday = WEEKDAYS.indexOf(day);
  const d = new Date(monthStart);
  if (Number(n) > 0) d.setDate(1 + ((weekday - d.getDay() + 7) % 7) + (Number(n) - 1) * 7);
  else {
    d.setMonth(d.getMonth() + 1, 0); // last day of the month
    d.setDate(d.getDate() - ((d.getDay() - weekday + 7) % 7) + (Number(n) + 1) * 7);
  }
  return d.getMonth() === monthStart.getMonth() ? d.getTime() : null;
}

// Occurrence starts of a repeating event, from its first, in order. Local
// wall-clock stepping, so a weekly 20:00 raid stays at 20:00 across DST.
// Only rules canExpand() accepts.
function* occurrences(start, rule) {
  const freq = rule.FREQ;
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const byDay = rule.BYDAY ? rule.BYDAY.split(",") : null;
  const first = new Date(start);
  if (freq === "WEEKLY" && byDay) {
    const days = byDay.map((d) => WEEKDAYS.indexOf(d)).sort((a, b) => a - b);
    const weekStart = new Date(first);
    weekStart.setDate(first.getDate() - first.getDay());
    for (let week = 0; ; week += interval) {
      for (const day of days) {
        const d = new Date(weekStart);
        d.setDate(weekStart.getDate() + week * 7 + day);
        if (d.getTime() >= start) yield d.getTime();
      }
    }
  }
  if (freq === "MONTHLY" && byDay) {
    for (let i = 0; ; i += interval) {
      const month = new Date(first.getFullYear(), first.getMonth() + i, 1, first.getHours(), first.getMinutes(), first.getSeconds());
      const dates = byDay.map((spec) => nthWeekday(month, spec)).filter((t) => t !== null);
      for (const t of dates.sort((a, b) => a - b)) if (t >= start) yield t;
    }
  }
  for (let i = 0; ; i += interval) {
    const d = new Date(first);
    if (freq === "DAILY") d.setDate(first.getDate() + i);
    else if (freq === "WEEKLY") d.setDate(first.getDate() + i * 7);
    else if (freq === "MONTHLY") d.setMonth(first.getMonth() + i);
    else d.setFullYear(first.getFullYear() + i);
    // The 31st in a 30-day month (or Feb 29 off a leap year) is skipped.
    if (d.getDate() !== first.getDate()) continue;
    yield d.getTime();
  }
}

// Plain rules, weekly on set days, and monthly "2nd Tuesday"/"last Friday".
// Not BYSETPOS, BYMONTHDAY lists, yearly-by-weekday...
function canExpand(rule) {
  const days = rule.BYDAY ? rule.BYDAY.split(",") : [];
  return (
    ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.FREQ) &&
    Object.keys(rule).every((k) => SUPPORTED_RULE_KEYS.has(k)) &&
    (!days.length ||
      (rule.FREQ === "WEEKLY" && days.every((d) => WEEKDAYS.includes(d))) ||
      (rule.FREQ === "MONTHLY" && days.every((d) => /^([+-]?[1-5])(SU|MO|TU|WE|TH|FR|SA)$/.test(d))))
  );
}

// Events overlapping [fromMs, toMs), repeating ones expanded, sorted.
function eventsBetween(events, fromMs, toMs) {
  const moved = new Set(events.filter((e) => e.uid && e["recurrence-id"]).map((e) => `${e.uid}@${e["recurrence-id"].ms}`));
  const out = [];
  const push = (e, startMs, extra = {}) => {
    const length = e.dtend ? e.dtend.ms - e.dtstart.ms : e.duration ?? (e.dtstart.allDay ? DAY : 0);
    const endMs = startMs + Math.max(0, length);
    if (startMs < toMs && (endMs > fromMs || startMs >= fromMs)) out.push({ e, startMs, endMs, ...extra });
  };
  for (const e of events) {
    if (String(e.status).toUpperCase() === "CANCELLED") continue;
    if (!e.rrule || e["recurrence-id"]) {
      push(e, e.dtstart.ms);
      continue;
    }
    const until = e.rrule.UNTIL ? parseDate(e.rrule.UNTIL)?.ms ?? Infinity : Infinity;
    if (!canExpand(e.rrule)) {
      // Said rather than dropped: it may well fall in the range.
      if (e.dtstart.ms < toMs && until >= fromMs) {
        out.push({ e, startMs: e.dtstart.ms, endMs: e.dtstart.ms, repeatNote: `repeats by a rule I can't unroll (${e.rrule.FREQ || "custom"}); this is its first date -- check the calendar for this range` });
      }
      continue;
    }
    const count = Number(e.rrule.COUNT) || Infinity;
    const excluded = new Set(e.exdates);
    let n = 0;
    let steps = 0;
    for (const startMs of occurrences(e.dtstart.ms, e.rrule)) {
      if (++steps > MAX_OCCURRENCE_STEPS || startMs > until || n >= count || startMs >= toMs) break;
      n++;
      if (excluded.has(startMs) || moved.has(`${e.uid}@${startMs}`)) continue;
      push(e, startMs);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

// ---- HTTP ----

function feedUrl(url) {
  return String(url || "").trim().replace(/^webcal:\/\//i, "https://");
}

async function request(fetchImpl, url, { method = "GET", account, headers = {}, body } = {}) {
  const auth = account.user
    ? { Authorization: `Basic ${Buffer.from(`${account.user}:${account.password || ""}`).toString("base64")}` }
    : {};
  const response = await fetchImpl(url, {
    method,
    headers: { ...auth, ...headers },
    body,
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("calendar login failed -- check the username and app password");
  }
  if (!response.ok && response.status !== 207) throw new Error(`calendar server answered ${response.status}`);
  return response.text();
}

// The contents of each <tag> (any namespace prefix). A self-closing <tag/>
// has none -- and mustn't run on into the next element's </tag>.
function xmlValues(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}\\s*>`, "gi");
  return [...String(xml).matchAll(re)].map((m) => m[1]);
}

function xmlUnescape(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#13;/g, "\r")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

const PROPFIND = (props) =>
  `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${props}</d:prop></d:propfind>`;

async function propfind(fetchImpl, url, account, props, depth = 0) {
  return request(fetchImpl, url, {
    method: "PROPFIND",
    account,
    headers: { Depth: String(depth), "Content-Type": "application/xml; charset=utf-8" },
    body: PROPFIND(props),
  });
}

function isCalendar(responseXml) {
  return xmlValues(responseXml, "resourcetype").some((t) => /<(?:[\w-]+:)?calendar[\s/>]/i.test(t));
}

// The calendar collection to use: the URL itself when it is one, else the
// first calendar that takes events under the account's calendar home.
// Remembered per URL for this run.
const discovered = new Map();
async function calendarUrl(fetchImpl, account) {
  const start = feedUrl(account.url);
  const cacheKey = `${account.user}@${start}`;
  if (discovered.has(cacheKey)) return discovered.get(cacheKey);
  let found = null;
  if (isCalendar(await propfind(fetchImpl, start, account, "<d:resourcetype/>"))) found = start;
  else {
    const principalXml = await propfind(fetchImpl, start, account, "<d:current-user-principal/>");
    const principal = xmlValues(xmlValues(principalXml, "current-user-principal")[0] || "", "href")[0];
    const homeXml = await propfind(fetchImpl, new URL(principal || start, start).href, account, "<c:calendar-home-set/>");
    const home = xmlValues(xmlValues(homeXml, "calendar-home-set")[0] || "", "href")[0];
    if (!home) throw new Error("no calendars found at that URL -- use your calendar's CalDAV address");
    const homeUrl = new URL(home, start).href;
    const listXml = await propfind(fetchImpl, homeUrl, account, "<d:resourcetype/><c:supported-calendar-component-set/>", 1);
    for (const response of xmlValues(listXml, "response")) {
      const components = xmlValues(response, "supported-calendar-component-set")[0];
      if (isCalendar(response) && (!components || /VEVENT/i.test(components))) {
        found = new URL(xmlUnescape(xmlValues(response, "href")[0]), homeUrl).href;
        break;
      }
    }
    if (!found) throw new Error("no calendars found at that URL -- use your calendar's CalDAV address");
  }
  discovered.set(cacheKey, found);
  return found;
}

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// -> [{ title, startMs, endMs, allDay, location, free, repeatNote }]
async function listEvents(account, fromMs, toMs, { fetch: fetchImpl = fetch } = {}) {
  if (!account || !account.url) throw new Error("calendar isn't set up (Settings > Calendar & email)");
  let events;
  if (!account.user) {
    events = parseEvents(await request(fetchImpl, feedUrl(account.url), { account }));
  } else {
    const range = `start="${utcStamp(fromMs)}" end="${utcStamp(toMs)}"`;
    // expand: the server unrolls repeats itself where it can; whatever comes
    // back unexpanded is unrolled below the same way as a feed.
    const xml = await request(fetchImpl, await calendarUrl(fetchImpl, account), {
      method: "REPORT",
      account,
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body:
        `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
        `<d:prop><c:calendar-data><c:expand ${range}/></c:calendar-data></d:prop>` +
        `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${range}/>` +
        `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
    });
    events = xmlValues(xml, "calendar-data").flatMap((data) => parseEvents(xmlUnescape(data)));
  }
  return eventsBetween(events, fromMs, toMs).map(({ e, startMs, endMs, repeatNote }) => ({
    title: e.summary || "(no title)",
    startMs,
    endMs,
    allDay: Boolean(e.dtstart.allDay),
    ...(e.location ? { location: e.location } : {}),
    ...(String(e.transp).toUpperCase() === "TRANSPARENT" ? { free: true } : {}),
    ...(repeatNote ? { repeatNote } : {}),
  }));
}

function icsDate(ms, allDay) {
  if (!allDay) return `:${utcStamp(ms)}`;
  const d = new Date(ms);
  return `;VALUE=DATE:${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// event: { title, startMs, endMs, allDay, location, notes }. CalDAV only.
async function addEvent(account, event, { fetch: fetchImpl = fetch, now = Date.now } = {}) {
  if (!account || !account.url) throw new Error("calendar isn't set up (Settings > Calendar & email)");
  if (!account.user) {
    throw new Error("this calendar is a read-only iCal feed; adding events needs a CalDAV calendar (username + app password)");
  }
  const uid = `${crypto.randomUUID()}@mana`;
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mana//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(now())}`,
    `DTSTART${icsDate(event.startMs, event.allDay)}`,
    `DTEND${icsDate(event.endMs, event.allDay)}`,
    `SUMMARY:${escapeText(event.title)}`,
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    ...(event.notes ? [`DESCRIPTION:${escapeText(event.notes)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const base = await calendarUrl(fetchImpl, account);
  await request(fetchImpl, new URL(`${uid}.ics`, base.endsWith("/") ? base : `${base}/`).href, {
    method: "PUT",
    account,
    headers: { "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*" },
    body: ics,
  });
  return { uid };
}

// Settings' Test button: the feed parses, or the CalDAV calendar is found.
async function checkCalendar(account, options = {}) {
  const fetchImpl = options.fetch || fetch;
  if (!account.user) {
    const events = parseEvents(await request(fetchImpl, feedUrl(account.url), { account }));
    return { readOnly: true, events: events.length };
  }
  await calendarUrl(fetchImpl, account);
  return { readOnly: false };
}

module.exports = { addEvent, checkCalendar, eventsBetween, listEvents, parseEvents };
