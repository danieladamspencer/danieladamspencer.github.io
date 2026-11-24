/**
 * Dinner booking backend for dancmdstat.com/dinner/
 *
 * A Google Apps Script web app that runs as you. It:
 *   - answers "which nights are free?" from your (and optionally Lisa's) calendar free/busy,
 *     never revealing event details;
 *   - takes a friend's request for a night and emails you Yes / No buttons;
 *   - on Yes, puts the dinner on your calendar (inviting the friend) and emails them;
 *     on No, emails them a polite note.
 *
 * Settings live in Project Settings -> Script properties (none of them are in this file,
 * because this file is public on GitHub):
 *   PASSWORD          required. The password you give friends.
 *   CHECK_CALENDARS   optional. Extra calendar IDs whose busy time also blocks a night,
 *                     comma-separated (e.g. Lisa's address). Your own calendar is always checked.
 *   NOTIFY_EMAIL      optional. Where requests go. Defaults to your own address.
 *   WEB_APP_URL       optional. The /exec URL, if the links in request emails ever point
 *                     at the wrong place.
 *
 * Setup steps are in dinner/README.md.
 */

const CONFIG = {
  TIME_ZONE: 'America/New_York',
  HOSTS: 'Dan & Lisa',       // how you're named in emails to friends
  EVENING_START: 17,         // a night is "busy" if anything overlaps 5pm...
  EVENING_END: 22,           // ...to 10pm
  DINNER_START: 18,          // the event created when you say yes: 6pm...
  DINNER_END: 21,            // ...to 9pm
  DAYS_AHEAD: 90,            // how far ahead friends can book
  MIN_DAYS_AHEAD: 1,         // 1 = tomorrow is the first bookable night
  INVITE_FRIEND: true,       // add the friend as a guest on the calendar event
  MAX_PENDING: 15,           // stop taking new requests if this many await an answer
};

const KIND_LABEL = {
  host: 'come over to our place',
  visit: 'have us over at their place',
};

// ---------------------------------------------------------------- web entry points

/** POST from the website. Body is JSON sent as text/plain (avoids a CORS preflight). */
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  try {
    if (!checkPassword_(body.password)) return json_({ ok: false, error: 'bad_password' });
    if (body.action === 'availability') return json_(availability_());
    if (body.action === 'request') return json_(createRequest_(body));
    return json_({ ok: false, error: 'bad_request' });
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: 'server_error' });
  }
}

/** GET: the Yes/No page you reach from the request email. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const req = p.id ? loadRequest_(p.id) : null;
  if (!req || !p.t || !safeEqual_(p.t, req.token)) {
    return page_('<h1>Link not valid</h1><p>This request link is invalid or has expired.</p>');
  }
  const t = HtmlService.createTemplate(RESPOND_HTML);
  t.req = req;
  t.dateLabel = dateLabel_(req.date);
  t.kindLabel = KIND_LABEL[req.kind];
  t.preselect = p.d === 'yes' || p.d === 'no' ? p.d : '';
  return t.evaluate()
    .setTitle('Dinner request')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called from the Yes/No page via google.script.run. */
function respond(id, token, decision, message) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const req = loadRequest_(id);
    if (!req || !safeEqual_(String(token || ''), req.token)) return { ok: false, error: 'This link is not valid.' };
    if (req.status !== 'pending') return { ok: false, error: 'Already answered: ' + req.status + '.' };
    if (decision !== 'yes' && decision !== 'no') return { ok: false, error: 'Bad decision.' };
    message = String(message || '').slice(0, 1000).trim();

    if (decision === 'yes') req.eventId = createDinnerEvent_(req).getId();
    req.status = decision === 'yes' ? 'accepted' : 'declined';
    req.answered = new Date().toISOString();
    saveRequest_(req); // save before emailing so a mail hiccup can't lead to a second event
    try {
      sendFriendEmail_(req, decision === 'yes', message);
    } catch (err) {
      console.error(err);
      return { ok: true, status: req.status, warning: 'Saved, but the email to them failed: ' + err.message };
    }
    return { ok: true, status: req.status };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Run this once from the editor (select it, click Run) to grant permissions,
 * and again any time to check your settings. It sends nothing.
 */
function authorize() {
  const props = PropertiesService.getScriptProperties();
  console.log('Password set: ' + Boolean(props.getProperty('PASSWORD')));
  console.log('Calendars checked: ' + calendarIds_().join(', '));
  console.log('Requests go to: ' + notifyEmail_());
  const nights = availability_().nights;
  const free = nights.filter(function (n) { return n.status === 'free'; }).length;
  console.log('Next ' + nights.length + ' nights: ' + free + ' free, ' + (nights.length - free) + ' not.');
  console.log('Calendar access check: ' + CalendarApp.getDefaultCalendar().getName());
  console.log('Mail quota left today: ' + MailApp.getRemainingDailyQuota());
}

// ---------------------------------------------------------------- availability

/** Returns { ok, timeZone, nights: [{date: 'yyyy-MM-dd', status: free|busy|requested}] }. */
function availability_() {
  const dates = bookableDates_();
  const busy = busyIntervals_(dates[0], dates[dates.length - 1]);
  const pending = pendingDates_();
  const nights = dates.map(function (date) {
    let status = 'free';
    if (nightIsBusy_(date, busy)) status = 'busy';
    else if (pending[date]) status = 'requested';
    return { date: date, status: status };
  });
  return { ok: true, timeZone: CONFIG.TIME_ZONE, nights: nights };
}

function bookableDates_() {
  const today = Utilities.formatDate(new Date(), CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  const out = [];
  for (let i = CONFIG.MIN_DAYS_AHEAD; i <= CONFIG.DAYS_AHEAD; i++) out.push(addDays_(today, i));
  return out;
}

/** Busy intervals [{start: ms, end: ms}] across the calendars, from the free/busy API. */
function busyIntervals_(firstDate, lastDate) {
  const items = calendarIds_().map(function (id) { return { id: id }; });
  const out = [];
  // The free/busy API limits how long one query may span; ask a month at a time.
  for (let from = firstDate; from <= lastDate; from = addDays_(from, 30)) {
    let to = addDays_(from, 30);
    if (to > addDays_(lastDate, 1)) to = addDays_(lastDate, 1);
    // `Calendar` is the "Google Calendar API" advanced service (editor sidebar: Services +).
    const res = Calendar.Freebusy.query({
      timeMin: at_(from, 0).toISOString(),
      timeMax: at_(to, 0).toISOString(),
      timeZone: CONFIG.TIME_ZONE,
      items: items,
    });
    const cals = res.calendars || {};
    Object.keys(cals).forEach(function (id) {
      if (cals[id].errors) console.warn('Calendar ' + id + ' not readable: ' + JSON.stringify(cals[id].errors));
      (cals[id].busy || []).forEach(function (b) {
        out.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
      });
    });
  }
  return out;
}

function nightIsBusy_(date, busy) {
  const s = at_(date, CONFIG.EVENING_START).getTime();
  const e = at_(date, CONFIG.EVENING_END).getTime();
  return busy.some(function (b) { return b.start < e && b.end > s; });
}

// ---------------------------------------------------------------- requests

function createRequest_(body) {
  const name = clean_(body.name, 80);
  const email = clean_(body.email, 120).toLowerCase();
  const note = clean_(body.note, 600);
  const kind = body.kind;
  const date = String(body.date || '');
  if (!name) return { ok: false, error: 'missing_name' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'bad_email' };
  if (!KIND_LABEL[kind]) return { ok: false, error: 'bad_request' };
  if (bookableDates_().indexOf(date) < 0) return { ok: false, error: 'bad_date' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const pending = pendingDates_();
    if (pending[date]) return { ok: false, error: 'already_requested' };
    if (Object.keys(pending).length >= CONFIG.MAX_PENDING) return { ok: false, error: 'too_many' };
    if (nightIsBusy_(date, busyIntervals_(date, date))) return { ok: false, error: 'not_free' };

    const req = {
      id: Utilities.getUuid().replace(/-/g, '').slice(0, 16),
      token: Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''),
      date: date, name: name, email: email, kind: kind, note: note,
      status: 'pending', created: new Date().toISOString(),
    };
    saveRequest_(req);
    sendOwnerEmail_(req);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** { 'yyyy-MM-dd': true } for nights with a request awaiting your answer. Also prunes old requests. */
function pendingDates_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const today = Utilities.formatDate(new Date(), CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  const out = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('req_') !== 0) return;
    let r;
    try { r = JSON.parse(all[k]); } catch (err) { return; }
    if (r.date < addDays_(today, -30)) { props.deleteProperty(k); return; }
    if (r.status === 'pending' && r.date >= today) out[r.date] = true;
  });
  return out;
}

function loadRequest_(id) {
  if (!/^[0-9a-f]{16}$/.test(String(id))) return null;
  const raw = PropertiesService.getScriptProperties().getProperty('req_' + id);
  return raw ? JSON.parse(raw) : null;
}

function saveRequest_(req) {
  PropertiesService.getScriptProperties().setProperty('req_' + req.id, JSON.stringify(req));
}

// ---------------------------------------------------------------- calendar + email

function createDinnerEvent_(req) {
  const title = req.kind === 'host' ? 'Dinner: ' + req.name + ' at ours' : 'Dinner at ' + req.name + "'s";
  const desc = [
    'Booked through dancmdstat.com/dinner.',
    req.name + ' <' + req.email + '> would like to ' + KIND_LABEL[req.kind] + '.',
    req.note ? 'Note: ' + req.note : '',
  ].filter(String).join('\n');
  const opts = { description: desc };
  if (CONFIG.INVITE_FRIEND) { opts.guests = req.email; opts.sendInvites = true; }
  return CalendarApp.getDefaultCalendar().createEvent(
    title, at_(req.date, CONFIG.DINNER_START), at_(req.date, CONFIG.DINNER_END), opts);
}

function sendOwnerEmail_(req) {
  const base = webAppUrl_() + '?id=' + req.id + '&t=' + req.token;
  const btn = function (label, d, color) {
    return '<a href="' + base + '&d=' + d + '" style="display:inline-block;padding:10px 22px;margin-right:8px;' +
      'border-radius:6px;background:' + color + ';color:#fff;text-decoration:none;font-weight:600">' + label + '</a>';
  };
  const html =
    '<p><strong>' + esc_(req.name) + '</strong> (' + esc_(req.email) + ') would like to <strong>' +
    KIND_LABEL[req.kind] + '</strong> on <strong>' + dateLabel_(req.date) + '</strong>.</p>' +
    (req.note ? '<blockquote style="border-left:3px solid #ccc;margin:0;padding-left:10px">' + esc_(req.note) + '</blockquote>' : '') +
    '<p style="margin:20px 0">' + btn('Yes', 'yes', '#1f7a3a') + btn('No', 'no', '#a8322d') + '</p>' +
    '<p style="color:#666;font-size:13px">Each button opens a page where you confirm and can add a note. ' +
    'Yes puts it on your calendar' + (CONFIG.INVITE_FRIEND ? ' and sends ' + esc_(req.name) + ' an invite' : '') +
    '; either way they get an email. Replying to this email goes straight to them.</p>';
  MailApp.sendEmail({
    to: notifyEmail_(),
    replyTo: req.email,
    subject: 'Dinner request: ' + req.name + ', ' + dateLabel_(req.date),
    htmlBody: html,
  });
}

function sendFriendEmail_(req, yes, message) {
  const first = req.name.split(/\s+/)[0];
  const when = dateLabel_(req.date);
  const what = req.kind === 'host' ? 'dinner at our place' : 'dinner at yours';
  const lines = yes
    ? ['Hi ' + first + ',', '', "We'd love to! " + when + ', ' + what + ". It's on our calendar" +
       (CONFIG.INVITE_FRIEND ? ', and a calendar invite is on its way.' : '.')]
    : ['Hi ' + first + ',', '', "Thanks so much for asking. Unfortunately " + when +
       " doesn't work for us after all. Please pick another night: https://dancmdstat.com/dinner/"];
  if (message) lines.push('', message);
  lines.push('', CONFIG.HOSTS);
  MailApp.sendEmail({
    to: req.email,
    subject: (yes ? "Yes to dinner, " : "Dinner on ") + when,
    body: lines.join('\n'),
    name: CONFIG.HOSTS,
  });
}

// ---------------------------------------------------------------- helpers

function checkPassword_(given) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pw_fails') || 0);
  if (fails >= 30) return false; // too many wrong guesses lately: lock for ~10 minutes
  const want = PropertiesService.getScriptProperties().getProperty('PASSWORD');
  if (!want) throw new Error('PASSWORD script property is not set');
  const ok = safeEqual_(String(given || '').trim(), want.trim());
  if (!ok) cache.put('pw_fails', String(fails + 1), 600);
  return ok;
}

function calendarIds_() {
  const extra = (PropertiesService.getScriptProperties().getProperty('CHECK_CALENDARS') || '')
    .split(',').map(function (s) { return s.trim(); }).filter(String);
  return ['primary'].concat(extra);
}

function notifyEmail_() {
  return PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL') ||
    Session.getEffectiveUser().getEmail();
}

function webAppUrl_() {
  return PropertiesService.getScriptProperties().getProperty('WEB_APP_URL') || ScriptApp.getService().getUrl();
}

/** The Date for hour `hour` on local date 'yyyy-MM-dd' in CONFIG.TIME_ZONE. */
function at_(date, hour) {
  return Utilities.parseDate(date + ' ' + (hour < 10 ? '0' : '') + hour + ':00', CONFIG.TIME_ZONE, 'yyyy-MM-dd HH:mm');
}

/** Calendar arithmetic on 'yyyy-MM-dd' strings (timezone-free, so DST can't shift it). */
function addDays_(date, n) {
  const p = date.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}

function dateLabel_(date) {
  return Utilities.formatDate(at_(date, 12), CONFIG.TIME_ZONE, 'EEEE, MMMM d');
}

function clean_(s, max) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function page_(inner) {
  return HtmlService.createHtmlOutput('<div style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 16px">' +
    inner + '</div>').setTitle('Dinner request').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// The Yes/No confirmation page. <?= ?> escapes values, so names and notes are safe to print.
const RESPOND_HTML = `<!doctype html>
<html><head><base target="_top">
<style>
  body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #fbfaf7; color: #1f2328; }
  main { max-width: 32rem; margin: 2rem auto; padding: 0 16px; }
  h1 { font: 600 1.5rem Georgia, serif; margin: 0 0 1rem; }
  .card { background: #f2efe8; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  .note { border-left: 3px solid #ccc; padding-left: .75rem; color: #444; white-space: pre-wrap; }
  textarea { width: 100%; box-sizing: border-box; font: inherit; padding: .5rem; border: 1px solid #ccc; border-radius: 6px; }
  .row { display: flex; gap: .75rem; margin-top: 1rem; }
  button { flex: 1; font: 600 1rem system-ui, sans-serif; padding: .8rem; border: 0; border-radius: 6px; color: #fff; cursor: pointer; }
  .yes { background: #1f7a3a; } .no { background: #a8322d; }
  button.dim { opacity: .45; }
  button:disabled { opacity: .5; cursor: default; }
  .muted { color: #5d636b; font-size: .9rem; }
</style></head>
<body><main>
  <h1>Dinner request</h1>
  <div class="card">
    <p style="margin:0"><strong><?= req.name ?></strong> (<?= req.email ?>) would like to
      <strong><?= kindLabel ?></strong> on <strong><?= dateLabel ?></strong>.</p>
    <? if (req.note) { ?><p class="note"><?= req.note ?></p><? } ?>
  </div>
  <? if (req.status !== 'pending') { ?>
    <p>You already answered this one: <strong><?= req.status ?></strong>.</p>
  <? } else { ?>
    <div id="form">
      <label for="msg" class="muted">Add a note to your reply (optional)</label>
      <textarea id="msg" rows="3"></textarea>
      <div class="row">
        <button class="yes" id="yes" onclick="go('yes')">Yes, book it</button>
        <button class="no" id="no" onclick="go('no')">No, decline</button>
      </div>
      <p class="muted">Yes adds it to your calendar and emails <?= req.name ?>. No sends a polite decline.</p>
    </div>
    <p id="done" hidden></p>
  <? } ?>
</main>
<script>
  // id and token are hex and preselect is yes/no/'', so raw JSON here is safe.
  var ID = <?!= JSON.stringify(req.id) ?>, TOKEN = <?!= JSON.stringify(req.token) ?>, PRE = <?!= JSON.stringify(preselect) ?>;
  if (PRE) { var other = document.getElementById(PRE === 'yes' ? 'no' : 'yes'); if (other) other.classList.add('dim'); }
  function go(decision) {
    document.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    google.script.run
      .withSuccessHandler(function (r) {
        var done = document.getElementById('done');
        done.hidden = false;
        if (r.ok) {
          document.getElementById('form').hidden = true;
          done.textContent = r.warning || (r.status === 'accepted' ? 'Booked. It is on your calendar and they have been emailed.' : 'Declined. They have been emailed.');
        } else {
          done.textContent = r.error;
          document.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
        }
      })
      .withFailureHandler(function (err) {
        var done = document.getElementById('done');
        done.hidden = false; done.textContent = 'Something went wrong: ' + err.message;
        document.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      })
      .respond(ID, TOKEN, decision, document.getElementById('msg').value);
  }
</script>
</body></html>`;
