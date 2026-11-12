/**
 * Calendar bridge for the Home wall panel (home.html).
 *
 * Lets the tablet read and edit one Google Calendar without signing in on the
 * tablet. It runs in your Google account and only answers requests that carry
 * the SECRET below.
 *
 * Set up (about 5 minutes):
 *  1. Go to script.google.com > New project. Delete what's there and paste this file.
 *  2. Change SECRET to a long random phrase. You'll type the same phrase on the tablet.
 *  3. Set CALENDAR_ID: 'primary' for your main calendar, or a shared calendar's ID
 *     (Google Calendar > Settings > the calendar > Integrate calendar > Calendar ID).
 *     To share with your partner: Settings > the calendar > Share with specific people
 *     > add them with "Make changes to events".
 *  4. Project Settings (cog) > Time zone: Europe/London.
 *  5. Deploy > New deployment > type Web app.
 *     Execute as: Me.  Who has access: Anyone.  Deploy, then allow access when asked.
 *  6. Copy the Web app URL (ends in /exec) into the tablet: Settings > Calendar.
 *  7. For birthdays: in the editor's left bar, Services (+) > Google Calendar API > Add.
 *  8. Optional, Discord messages: in Discord, Server Settings > Integrations > Webhooks > New Webhook,
 *     pick the channel, Copy Webhook URL, and paste it into DISCORD_WEBHOOK below. Then pick
 *     testDiscord in the function menu at the top of the editor and press Run: it asks for
 *     permission to "connect to an external service" once and posts a test message.
 *
 * If you change this code later: Deploy > Manage deployments > edit > Version: New version.
 */

const SECRET = 'change-this-to-a-long-random-phrase';
const CALENDAR_ID = 'primary';

// Shown on the tablet as well, read-only. Set to '' / false to leave them out.
const HOLIDAYS_ID = 'en.uk#holiday@group.v.calendar.google.com';   // Google's "Holidays in United Kingdom"
const SHOW_BIRTHDAYS = true;   // birthdays from your Google Contacts (Google keeps them in your main calendar)

// Colours set on events so they match on your phones too (Google's colour IDs).
const WHO_COLOURS = {p1: '9', p2: '4', both: '3'};   // Blueberry, Flamingo, Grape

// Discord: post a message when an event is added from the tablet. Leave '' to turn it off.
const DISCORD_WEBHOOK = '';
const DISCORD_ON = {add: true, update: false, delete: false};   // which tablet changes get a message
const DISCORD_NAME = 'Home calendar';                           // who the message shows as from
const DISCORD_COLOURS = {p1: 0x5484ED, p2: 0xE67C73, both: 0x8E24AA, '': 0xD6A266};

function doGet(e) { return handle_(e.parameter || {}); }

function doPost(e) {
  let p = {};
  try { p = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) {}
  return handle_(p);
}

function handle_(p) {
  if (SECRET === 'change-this-to-a-long-random-phrase') return out_({ok: false, error: 'Set SECRET in the script first'});
  if (p.secret !== SECRET) return out_({ok: false, error: 'Wrong secret'});
  const cal = CALENDAR_ID === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) return out_({ok: false, error: 'Calendar not found. Check CALENDAR_ID.'});
  try {
    switch (p.action) {
      case 'list': {
        const from = new Date(p.from), to = new Date(p.to);
        let events = cal.getEvents(from, to).filter(e => !(SHOW_BIRTHDAYS && isBirthday_(e))).map(toJson_);
        if (HOLIDAYS_ID) events = events.concat(holidays_(from, to));
        if (SHOW_BIRTHDAYS) events = events.concat(birthdays_(from, to));
        return out_({ok: true, name: cal.getName(), tz: Session.getScriptTimeZone(), events: events});
      }
      case 'add': {
        const ev = p.allDay
          ? cal.createAllDayEvent(p.title, day_(p.start), day_(p.end), opts_(p))
          : cal.createEvent(p.title, new Date(p.start), new Date(p.end), opts_(p));
        style_(ev, p);
        discord_('add', cal, ev, p);
        return out_({ok: true, event: toJson_(ev)});
      }
      case 'update': {
        const ev = find_(cal, p);
        if (ev.isRecurringEvent()) return out_({ok: false, error: 'Repeating events can only be changed in Google Calendar'});
        ev.setTitle(p.title);
        if (p.allDay) ev.setAllDayDates(day_(p.start), day_(p.end));
        else ev.setTime(new Date(p.start), new Date(p.end));
        ev.setLocation(p.location || '');
        ev.setDescription(p.notes || '');
        style_(ev, p);
        discord_('update', cal, ev, p);
        return out_({ok: true, event: toJson_(ev)});
      }
      case 'delete': {
        const ev = find_(cal, p);
        if (ev.isRecurringEvent()) return out_({ok: false, error: 'Repeating events can only be deleted in Google Calendar'});
        const gone = {title: ev.getTitle(), when: when_(ev), who: ev.getTag('who') || ''};
        ev.deleteEvent();
        discord_('delete', cal, null, Object.assign({}, p, gone));
        return out_({ok: true});
      }
      default:
        return out_({ok: false, error: 'Unknown action'});
    }
  } catch (err) {
    return out_({ok: false, error: String(err && err.message || err)});
  }
}

// ---- Discord ----

function discord_(action, cal, ev, p) {
  if (!DISCORD_WEBHOOK || !DISCORD_ON[action]) return;
  try {
    const who = p.who || '', heads = {add: 'New event, added on the wall panel', update: 'Event changed on the wall panel', delete: 'Event deleted on the wall panel'};
    const fields = [];
    if (p.whoName) fields.push({name: 'Who', value: p.whoName, inline: true});
    if (ev && ev.getLocation()) fields.push({name: 'Where', value: ev.getLocation(), inline: true});
    if (ev && ev.getDescription()) fields.push({name: 'Notes', value: ev.getDescription().slice(0, 1000)});
    const embed = {
      author: {name: heads[action]},
      title: (ev ? ev.getTitle() : p.title || 'Event').slice(0, 250),
      description: ev ? when_(ev) : (p.when || ''),
      color: DISCORD_COLOURS[who] || DISCORD_COLOURS[''],
      fields: fields,
    };
    if (ev) { const url = link_(cal, ev); if (url) embed.url = url; }
    post_({username: DISCORD_NAME, embeds: [embed]});
  } catch (err) {
    console.warn('Discord message failed: ' + err);   // never stop the calendar change because of Discord
  }
}

function post_(body) {
  const r = UrlFetchApp.fetch(DISCORD_WEBHOOK, {method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true});
  if (r.getResponseCode() >= 300) throw new Error('Discord replied ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
}

// "Sat 14 Nov · 19:00–21:00", "Sat 14 Nov · All day", "Sat 14 – Mon 16 Nov"
function when_(ev) {
  const tz = Session.getScriptTimeZone(), f = (d, x) => Utilities.formatDate(d, tz, x);
  if (ev.isAllDayEvent()) {
    const s = ev.getAllDayStartDate(), e = new Date(ev.getAllDayEndDate().getTime() - 864e5);
    if (f(s, 'yyyyMMdd') === f(e, 'yyyyMMdd')) return f(s, 'EEE d MMM') + ' · All day';
    return f(s, f(s, 'MMM') === f(e, 'MMM') ? 'EEE d' : 'EEE d MMM') + ' – ' + f(e, 'EEE d MMM');
  }
  const s = ev.getStartTime(), e = ev.getEndTime();
  const sameDay = f(s, 'yyyyMMdd') === f(e, 'yyyyMMdd');
  return f(s, 'EEE d MMM') + ' · ' + f(s, 'HH:mm') + '–' + (sameDay ? f(e, 'HH:mm') : f(e, 'EEE d MMM HH:mm'));
}

// Link that opens the event in Google Calendar.
function link_(cal, ev) {
  try {
    const eid = Utilities.base64Encode(ev.getId().split('@')[0] + ' ' + cal.getId()).replace(/=+$/, '');
    return 'https://www.google.com/calendar/event?eid=' + eid;
  } catch (err) { return ''; }
}

// Run this once from the editor (function menu > testDiscord > Run) to allow it and check the webhook.
function testDiscord() {
  if (!DISCORD_WEBHOOK) throw new Error('Paste your webhook URL into DISCORD_WEBHOOK first');
  post_({username: DISCORD_NAME, embeds: [{title: 'Calendar messages are working', color: DISCORD_COLOURS[''],
    description: 'Events added on the wall panel will show up here.'}]});
}

function isBirthday_(e) {
  try { return e.getEventType() === CalendarApp.EventType.BIRTHDAY; } catch (err) { return false; }
}

function holidays_(from, to) {
  try {
    let hc = CalendarApp.getCalendarById(HOLIDAYS_ID);
    if (!hc) hc = CalendarApp.subscribeToCalendar(HOLIDAYS_ID);
    return hc.getEvents(from, to).map(e => Object.assign(toJson_(e), {
      kind: 'holiday', readOnly: true, observance: /observance/i.test(e.getDescription() || ''),
    }));
  } catch (err) { return []; }
}

function birthdays_(from, to) {
  try {
    // The Calendar API service (step 7) can ask for birthdays directly.
    if (typeof Calendar !== 'undefined' && Calendar.Events) {
      const res = Calendar.Events.list('primary', {eventTypes: ['birthday'], singleEvents: true, maxResults: 250,
        timeMin: from.toISOString(), timeMax: to.toISOString()});
      return (res.items || []).filter(it => it.start && it.start.date).map(it => ({
        id: 'birthday:' + it.id, title: it.summary || 'Birthday', allDay: true, start: it.start.date, end: it.end.date,
        location: '', notes: '', color: '', who: '', recurring: true, kind: 'birthday', readOnly: true,
      }));
    }
    return CalendarApp.getDefaultCalendar().getEvents(from, to).filter(isBirthday_)
      .map(e => Object.assign(toJson_(e), {kind: 'birthday', readOnly: true}));
  } catch (err) { return []; }
}

function find_(cal, p) {
  const ev = cal.getEventById(p.id);
  if (!ev) throw new Error('That event no longer exists');
  return ev;
}

function opts_(p) { return {location: p.location || '', description: p.notes || ''}; }

function style_(ev, p) {
  if (p.who && WHO_COLOURS[p.who]) { ev.setColor(WHO_COLOURS[p.who]); ev.setTag('who', p.who); }
}

// 'YYYY-MM-DD' -> Date at midnight in the script's time zone
function day_(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); }

function toJson_(e) {
  const tz = Session.getScriptTimeZone(), allDay = e.isAllDayEvent();
  return {
    id: e.getId(),
    title: e.getTitle(),
    allDay: allDay,
    start: allDay ? Utilities.formatDate(e.getAllDayStartDate(), tz, 'yyyy-MM-dd') : e.getStartTime().toISOString(),
    end: allDay ? Utilities.formatDate(e.getAllDayEndDate(), tz, 'yyyy-MM-dd') : e.getEndTime().toISOString(),
    location: e.getLocation(),
    notes: e.getDescription(),
    color: e.getColor(),
    who: e.getTag('who') || '',
    recurring: e.isRecurringEvent(),
  };
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
