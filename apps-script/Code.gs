/**
 * ALICE BEAUTY STUDIO — BOOKING BACKEND
 * ──────────────────────────────────────
 * Deploy: Apps Script editor → Deploy → New deployment → "Web app"
 *   Execute as:    Me
 *   Who has access: Anyone
 *
 * Spreadsheet is created automatically on first run (function `setup`).
 * Run `setup` once after pasting this code (Editor → Run → setup → Allow).
 */

// ============== CONFIG — edit these ==============
const CONFIG = {
  businessName:  'Alice Beauty Studio',
  businessEmail: 'karolyi.zsigmond1@gmail.com',  // bookings get CC'd here; FOR THE LIVE COPY change to alice's email
  businessPhone: '+36 20 547 3128',
  adminPassword: 'alice2026',                    // change after first deploy via Admin → Beállítások
  timezone:      'Europe/Budapest',
  defaultSlotDurationMin: 60
};

const SHEET_SLOTS    = 'Slots';
const SHEET_BOOKINGS = 'Bookings';
const SHEET_SETTINGS = 'Settings';

const PROP_SHEET_ID = 'BOOKING_SHEET_ID';

// ============== ROUTING ==============

function doGet(e) {
  e = e || { parameter: {} };
  const p = e.parameter || {};

  // Admin UI
  if (p.admin !== undefined) {
    return HtmlService.createTemplateFromFile('Admin').evaluate()
      .setTitle(CONFIG.businessName + ' · Admin')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  const action = (p.action || '').toLowerCase();

  if (action === 'slots') {
    return jsonOk_({
      slots: getPublicSlots_(p.from, p.to),
      business: { name: CONFIG.businessName }
    });
  }

  if (action === 'next') {
    return jsonOk_({ slots: getNextSlots_(parseInt(p.n || '5', 10)) });
  }

  return jsonOk_({ ok: true, service: 'alice-booking', version: '1.0' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = (body.action || '').toLowerCase();

    if (action === 'book') {
      return jsonOk_(createBooking_(body));
    }
    return jsonErr_('Unknown action');
  } catch (err) {
    return jsonErr_(err.message || String(err));
  }
}

// ============== ADMIN-ONLY (called via google.script.run from Admin.html) ==============

function adminAuth(password) {
  return password === CONFIG.adminPassword;
}

function adminGetState() {
  ensureSetup_();
  return {
    business: {
      name: CONFIG.businessName,
      email: CONFIG.businessEmail,
      phone: CONFIG.businessPhone
    },
    slots: getAllSlots_(),
    bookings: getAllBookings_()
  };
}

function adminAddSlot(password, dateIso, time) {
  if (!adminAuth(password)) throw new Error('Hibás jelszó');
  return addSlot_(dateIso, time);
}

function adminRemoveSlot(password, dateIso, time) {
  if (!adminAuth(password)) throw new Error('Hibás jelszó');
  return removeSlot_(dateIso, time);
}

function adminAddDayPreset(password, dateIso, preset) {
  if (!adminAuth(password)) throw new Error('Hibás jelszó');
  const times = ({
    standard:  ['09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00'],
    morning:   ['09:00','10:00','11:00','12:00'],
    afternoon: ['13:00','14:00','15:00','16:00','17:00'],
    saturday:  ['09:00','10:00','11:00','12:00','13:00','14:00']
  })[preset] || [];
  const sh = sheet_(SHEET_SLOTS);
  const data = sh.getDataRange().getValues();
  const have = {};
  for (let i = 1; i < data.length; i++) have[data[i][0] + '|' + data[i][1]] = true;
  const rows = [];
  times.forEach(function(t) {
    if (!have[dateIso + '|' + t]) rows.push([dateIso, t, 'free', '']);
  });
  if (rows.length) {
    const startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, rows.length, 4).setValues(rows);
  }
  return { added: rows.length };
}

function adminClearDay(password, dateIso) {
  if (!adminAuth(password)) throw new Error('Hibás jelszó');
  const sh = sheet_(SHEET_SLOTS);
  return batchDelete_(sh, function(row) {
    return row[0] === dateIso && !(row[2] === 'booked' && row[3] && row[3] !== 'manual');
  });
}

function adminCancelBooking(password, bookingId) {
  if (!adminAuth(password)) throw new Error('Hibás jelszó');
  return cancelBooking_(bookingId);
}

/**
 * One-click bulk fill: adds 1-hour slots to the next N days.
 * Weekdays (H–P): 09–17 (9 slots), Saturday: 09–14 (6 slots), Sunday: skipped.
 * Existing slots are kept; duplicates skipped.
 */
function adminBulkFill(password, days) {
  if (!adminAuth(password)) throw new Error('Hibás jelszó');
  days = Math.max(1, Math.min(parseInt(days || 30, 10), 90));
  const sh = sheet_(SHEET_SLOTS);
  const data = sh.getDataRange().getValues();
  const have = {};
  for (let i = 1; i < data.length; i++) have[data[i][0] + '|' + data[i][1]] = true;

  const weekday = ['09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00'];
  const saturday = ['09:00','10:00','11:00','12:00','13:00','14:00'];
  const rowsToAdd = [];
  let skipped = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let n = 1; n <= days; n++) {
    const d = new Date(today.getTime() + n * 86400000);
    const dow = d.getDay();
    if (dow === 0) continue;
    const iso = Utilities.formatDate(d, CONFIG.timezone, 'yyyy-MM-dd');
    const pool = dow === 6 ? saturday : weekday;
    for (let k = 0; k < pool.length; k++) {
      const t = pool[k];
      if (have[iso + '|' + t]) { skipped++; continue; }
      rowsToAdd.push([iso, t, 'free', '']);
      have[iso + '|' + t] = true;
    }
  }
  // SINGLE batch write — orders of magnitude faster than appendRow in a loop
  if (rowsToAdd.length) {
    const startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, rowsToAdd.length, 4).setValues(rowsToAdd);
  }
  return { added: rowsToAdd.length, skipped: skipped, days: days };
}

/**
 * Toggle a slot's status: free → booked-manual, booked-manual → free.
 * Real bookings (with bookingId) cannot be toggled this way — cancel them instead.
 */
function adminToggleSlot(password, dateIso, time) {
  if (!adminAuth(password)) throw new Error('Hibás jelszó');
  const sh = sheet_(SHEET_SLOTS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === dateIso && data[i][1] === time) {
      const status = data[i][2];
      const bookingId = data[i][3];
      if (status === 'booked' && bookingId) {
        throw new Error('Ez egy valódi foglalás — a Foglalások fülön mondhatod le.');
      }
      const newStatus = status === 'free' ? 'booked' : 'free';
      sh.getRange(i + 1, 3).setValue(newStatus);
      if (newStatus === 'free') sh.getRange(i + 1, 4).setValue('');
      else sh.getRange(i + 1, 4).setValue('manual');
      return { ok: true, status: newStatus };
    }
  }
  throw new Error('Nem található időpont');
}

/**
 * Wipe ALL future slots (booked included won't be touched if they have a real bookingId).
 * Use for "start over" with bulk fill.
 */
function adminWipeFuture(password) {
  if (!adminAuth(password)) throw new Error('Hibás jelszó');
  const sh = sheet_(SHEET_SLOTS);
  const today = todayIso_();
  return batchDelete_(sh, function(row) {
    return row[0] >= today && !(row[2] === 'booked' && row[3] && row[3] !== 'manual');
  });
}

/**
 * Delete rows matching a predicate in contiguous batches.
 * Far faster than deleteRow() in a loop because contiguous ranges
 * become a single deleteRows(start, count) call.
 */
function batchDelete_(sh, pred) {
  const data = sh.getDataRange().getValues();
  const toDeleteRows = [];
  for (let i = 1; i < data.length; i++) {
    if (pred(data[i])) toDeleteRows.push(i + 1);
  }
  // walk from bottom up, grouping contiguous rows
  toDeleteRows.sort(function(a, b) { return b - a; });
  let i = 0;
  while (i < toDeleteRows.length) {
    let j = i;
    while (j + 1 < toDeleteRows.length && toDeleteRows[j + 1] === toDeleteRows[j] - 1) j++;
    const top = toDeleteRows[j];
    const count = j - i + 1;
    sh.deleteRows(top, count);
    i = j + 1;
  }
  return { removed: toDeleteRows.length };
}

// ============== BOOKING ==============

function createBooking_(b) {
  if (!b.date || !b.time || !b.name || !b.email) {
    throw new Error('Hiányzó adat: date, time, name, email kötelező');
  }
  if (!/.+@.+\..+/.test(b.email)) throw new Error('Érvénytelen e-mail');

  ensureSetup_();
  const sh = sheet_(SHEET_SLOTS);
  const data = sh.getDataRange().getValues();
  let slotRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === b.date && data[i][1] === b.time) {
      slotRow = i + 1;
      if (data[i][2] !== 'free') throw new Error('Ez az időpont már nem szabad');
      break;
    }
  }
  if (slotRow === -1) throw new Error('Nem létező időpont');

  const bookingId = 'BK-' + Utilities.getUuid().substring(0, 8).toUpperCase();
  sh.getRange(slotRow, 3).setValue('booked');
  sh.getRange(slotRow, 4).setValue(bookingId);

  const bk = sheet_(SHEET_BOOKINGS);
  bk.appendRow([
    bookingId,
    new Date(),
    b.date,
    b.time,
    b.service || '',
    b.serviceName || '',
    b.serviceMeta || '',
    b.name,
    b.phone || '',
    b.email,
    b.note || '',
    'confirmed'
  ]);

  try { sendEmails_(b, bookingId); } catch (e) {
    Logger.log('Email send failed: ' + e.message);
  }
  return { ok: true, bookingId: bookingId };
}

function cancelBooking_(bookingId) {
  const bk = sheet_(SHEET_BOOKINGS);
  const bdata = bk.getDataRange().getValues();
  let date = null, time = null, row = -1;
  for (let i = 1; i < bdata.length; i++) {
    if (bdata[i][0] === bookingId) { row = i + 1; date = bdata[i][2]; time = bdata[i][3]; break; }
  }
  if (row === -1) throw new Error('Nem található foglalás');
  bk.getRange(row, 12).setValue('cancelled');

  const sh = sheet_(SHEET_SLOTS);
  const sdata = sh.getDataRange().getValues();
  for (let i = 1; i < sdata.length; i++) {
    if (sdata[i][0] === date && sdata[i][1] === time) {
      sh.getRange(i + 1, 3).setValue('free');
      sh.getRange(i + 1, 4).setValue('');
      break;
    }
  }
  return { ok: true };
}

// ============== SLOT MANAGEMENT ==============

function addSlot_(dateIso, time) {
  ensureSetup_();
  const sh = sheet_(SHEET_SLOTS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === dateIso && data[i][1] === time) {
      throw new Error('Ez az időpont már létezik');
    }
  }
  sh.appendRow([dateIso, time, 'free', '']);
  return { ok: true };
}

function removeSlot_(dateIso, time) {
  const sh = sheet_(SHEET_SLOTS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === dateIso && data[i][1] === time) {
      if (data[i][2] === 'booked') throw new Error('Foglalt időpontot először mondj le');
      sh.deleteRow(i + 1);
      return { ok: true };
    }
  }
  throw new Error('Nem található időpont');
}

function getPublicSlots_(from, to) {
  ensureSetup_();
  const sh = sheet_(SHEET_SLOTS);
  const data = sh.getDataRange().getValues();
  const today = todayIso_();
  const fromD = from || today;
  const toD = to || addDaysIso_(today, 60);
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const d = data[i][0];
    if (d < fromD || d > toD) continue;
    if (data[i][2] === 'free') {
      out.push({ date: d, time: data[i][1] });
    }
  }
  out.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.time < b.time ? -1 : 1; });
  return out;
}

function getNextSlots_(n) {
  const all = getPublicSlots_();
  return all.slice(0, n);
}

function getAllSlots_() {
  const sh = sheet_(SHEET_SLOTS);
  const data = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    out.push({ date: data[i][0], time: data[i][1], status: data[i][2], bookingId: data[i][3] || '' });
  }
  return out;
}

function getAllBookings_() {
  const bk = sheet_(SHEET_BOOKINGS);
  const data = bk.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    out.push({
      bookingId: data[i][0],
      created:   data[i][1] instanceof Date ? data[i][1].toISOString() : data[i][1],
      date:      data[i][2],
      time:      data[i][3],
      service:   data[i][4],
      serviceName: data[i][5],
      serviceMeta: data[i][6],
      name:      data[i][7],
      phone:     data[i][8],
      email:     data[i][9],
      note:      data[i][10],
      status:    data[i][11]
    });
  }
  out.sort(function(a, b) {
    const ad = a.date + ' ' + a.time, bd = b.date + ' ' + b.time;
    return ad < bd ? 1 : ad > bd ? -1 : 0;
  });
  return out;
}

// ============== EMAIL ==============

function sendEmails_(b, bookingId) {
  const subjectClient = CONFIG.businessName + ' — Foglalás visszaigazolás';
  const subjectOwner  = '✿ Új foglalás · ' + b.serviceName + ' · ' + b.date + ' ' + b.time;
  const dateLabel = formatDateHu_(b.date) + ' · ' + b.time;

  const clientHtml =
    '<div style="font-family:Georgia,serif;color:#2a1822;max-width:520px;margin:0 auto;padding:32px;background:#faf5f6;">' +
    '<div style="text-align:center;font-size:14px;letter-spacing:0.3em;color:#a4615c;text-transform:uppercase;margin-bottom:24px;">✿ ' + CONFIG.businessName + ' ✿</div>' +
    '<h1 style="font-family:\'DM Serif Display\',Georgia,serif;font-weight:400;font-size:32px;line-height:1.15;margin:0 0 16px;color:#2a1822;">Köszönöm a foglalást, <em style="color:#a4615c;">' + escapeHtml_(b.name) + '</em>.</h1>' +
    '<p style="font-size:16px;line-height:1.6;color:#4a2e3d;margin:0 0 24px;">Várom a stúdióban — itt vannak az időpontod részletei:</p>' +
    '<table style="width:100%;background:#fff;border-radius:8px;padding:20px;border-collapse:collapse;">' +
    '<tr><td style="padding:8px 0;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#8e7680;">Szolgáltatás</td><td style="padding:8px 0;text-align:right;font-family:Georgia,serif;font-size:16px;color:#2a1822;">' + escapeHtml_(b.serviceName || '') + '</td></tr>' +
    '<tr><td style="padding:8px 0;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#8e7680;border-top:1px solid #f3eced;">Időpont</td><td style="padding:8px 0;text-align:right;font-family:Georgia,serif;font-size:16px;color:#2a1822;border-top:1px solid #f3eced;">' + dateLabel + '</td></tr>' +
    '<tr><td style="padding:8px 0;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#8e7680;border-top:1px solid #f3eced;">Foglalási szám</td><td style="padding:8px 0;text-align:right;font-family:Georgia,serif;font-size:16px;color:#2a1822;border-top:1px solid #f3eced;">' + bookingId + '</td></tr>' +
    '</table>' +
    '<p style="font-size:14px;line-height:1.7;color:#4a2e3d;margin:24px 0 0;">Cím: 1143 Budapest, Gizella út 35. II. emelet.<br/>Ha bármi miatt nem tudsz jönni, kérlek hívj: <a style="color:#a4615c;" href="tel:' + CONFIG.businessPhone + '">' + CONFIG.businessPhone + '</a>.</p>' +
    '<p style="font-size:13px;line-height:1.6;color:#8e7680;margin:32px 0 0;font-style:italic;">— Alice</p>' +
    '</div>';

  const ownerHtml =
    '<div style="font-family:Georgia,serif;color:#2a1822;max-width:520px;margin:0 auto;padding:24px;">' +
    '<h2 style="margin:0 0 16px;color:#a4615c;">✿ Új foglalás</h2>' +
    '<table style="width:100%;border-collapse:collapse;">' +
    '<tr><td style="padding:6px 0;color:#8e7680;">Vendég</td><td style="padding:6px 0;text-align:right;"><b>' + escapeHtml_(b.name) + '</b></td></tr>' +
    '<tr><td style="padding:6px 0;color:#8e7680;">Telefon</td><td style="padding:6px 0;text-align:right;">' + escapeHtml_(b.phone || '—') + '</td></tr>' +
    '<tr><td style="padding:6px 0;color:#8e7680;">E-mail</td><td style="padding:6px 0;text-align:right;">' + escapeHtml_(b.email) + '</td></tr>' +
    '<tr><td style="padding:6px 0;color:#8e7680;">Szolgáltatás</td><td style="padding:6px 0;text-align:right;">' + escapeHtml_(b.serviceName || '') + '</td></tr>' +
    '<tr><td style="padding:6px 0;color:#8e7680;">Időpont</td><td style="padding:6px 0;text-align:right;"><b>' + dateLabel + '</b></td></tr>' +
    '<tr><td style="padding:6px 0;color:#8e7680;">Foglalási szám</td><td style="padding:6px 0;text-align:right;">' + bookingId + '</td></tr>' +
    (b.note ? '<tr><td colspan="2" style="padding:14px 0 0;color:#8e7680;border-top:1px solid #eee;margin-top:8px;">Megjegyzés:<br/><i>' + escapeHtml_(b.note) + '</i></td></tr>' : '') +
    '</table>' +
    '</div>';

  MailApp.sendEmail({
    to: b.email,
    subject: subjectClient,
    htmlBody: clientHtml,
    name: CONFIG.businessName,
    replyTo: CONFIG.businessEmail
  });
  MailApp.sendEmail({
    to: CONFIG.businessEmail,
    subject: subjectOwner,
    htmlBody: ownerHtml,
    name: CONFIG.businessName + ' (auto)',
    replyTo: b.email
  });
}

// ============== SETUP & HELPERS ==============

function setup() {
  ensureSetup_();
  return 'OK · sheet ready · ' + getSheetUrl_();
}

function ensureSetup_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(PROP_SHEET_ID);
  let ss;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { id = null; }
  }
  if (!id) {
    ss = SpreadsheetApp.create(CONFIG.businessName + ' · Booking');
    props.setProperty(PROP_SHEET_ID, ss.getId());
  }
  const slots = ss.getSheetByName(SHEET_SLOTS) || ss.insertSheet(SHEET_SLOTS);
  if (slots.getLastRow() === 0) {
    slots.appendRow(['date (YYYY-MM-DD)', 'time (HH:MM)', 'status', 'bookingId']);
    slots.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#f3eced');
    slots.setFrozenRows(1);
  }
  const bk = ss.getSheetByName(SHEET_BOOKINGS) || ss.insertSheet(SHEET_BOOKINGS);
  if (bk.getLastRow() === 0) {
    bk.appendRow(['bookingId','created','date','time','service','serviceName','serviceMeta','name','phone','email','note','status']);
    bk.getRange(1, 1, 1, 12).setFontWeight('bold').setBackground('#f3eced');
    bk.setFrozenRows(1);
  }
  // Default sheet ("Sheet1") cleanup
  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  return ss;
}

function sheet_(name) {
  const ss = ensureSetup_();
  return ss.getSheetByName(name);
}

function getSheetUrl_() {
  const id = PropertiesService.getScriptProperties().getProperty(PROP_SHEET_ID);
  return id ? 'https://docs.google.com/spreadsheets/d/' + id : '';
}

function adminGetSheetUrl(password) {
  if (!adminAuth(password)) throw new Error('Hibás jelszó');
  return getSheetUrl_();
}

function jsonOk_(payload) {
  return ContentService.createTextOutput(JSON.stringify(Object.assign({ ok: true }, payload)))
    .setMimeType(ContentService.MimeType.JSON);
}
function jsonErr_(msg) {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

function todayIso_() {
  const tz = CONFIG.timezone;
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}
function addDaysIso_(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, CONFIG.timezone, 'yyyy-MM-dd');
}

function formatDateHu_(iso) {
  const MONTHS = ['január','február','március','április','május','június','július','augusztus','szeptember','október','november','december'];
  const DAYS = ['vasárnap','hétfő','kedd','szerda','csütörtök','péntek','szombat'];
  const d = new Date(iso + 'T00:00:00');
  return DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + '.';
}

function escapeHtml_(s) {
  return String(s || '').replace(/[&<>"']/g, function(c) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}
