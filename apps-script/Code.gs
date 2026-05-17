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
const SHEET_SERVICES = 'Services';

// durationMin is what's used internally to block consecutive 30-min slots.
// `duration` is just the display label shown to customers.
// All durationMin values should be multiples of 30 (the slot granularity).
const SLOT_GRANULARITY_MIN = 30;
const DEFAULT_SERVICES = [
  { order: 1, key: 'hajfestes',   name: 'Hajfestés & balayage',     description: 'Bőrtónushoz illesztett, természetes átmenetek és divatos színek prémium festékekkel.', duration: '90–180 perc', durationMin: 120, price: '26 000 Ft-tól', featured: false },
  { order: 2, key: 'alkalmi',     name: 'Alkalmi konty & smink',    description: 'Esküvő, ballagás, fotózás. Teljes look egy kézből — próbafestéssel és kipróbálással.', duration: '60–120 perc', durationMin: 90,  price: '22 000 Ft-tól', featured: true },
  { order: 3, key: 'keratin',     name: 'Keratinos kezelés',        description: 'Selymes, fényes, könnyen kezelhető haj — hetekre szóló simaság, töredezés nélkül.',   duration: '120 perc',    durationMin: 120, price: '32 000 Ft-tól', featured: false },
  { order: 4, key: 'vagas',       name: 'Hajvágás & formázás',      description: 'Arcformához igazított vonalvezetés. Ollóval — nem gépezettel.',                       duration: '45–60 perc',  durationMin: 60,  price: '9 000 Ft-tól',  featured: false },
  { order: 5, key: 'konty',       name: 'Klasszikus konty',         description: 'Esküvőhöz, alkalomhoz, hosszú estéhez. Tartós, kényelmes, fotózásálló.',              duration: '75 perc',     durationMin: 90,  price: '18 000 Ft-tól', featured: false },
  { order: 6, key: 'konzultacio', name: 'Konzultáció',              description: '30 perces beszélgetés — szín, forma, alkalom. Mielőtt bármit elköteleznél.',         duration: '30 perc',     durationMin: 30,  price: 'díjmentes',     featured: false }
];

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

  if (action === 'services') {
    return jsonOk_({ services: getServices_() });
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
    bookings: getAllBookings_(),
    services: getServices_()
  };
}

// ============== SERVICES ADMIN ==============

function adminSaveServices(password, services) {
  if (!adminAuth(password)) throw new Error('Hibás jelszó');
  if (!Array.isArray(services)) throw new Error('Services must be an array');
  return writeServices_(services);
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
  // Half-hour granularity so different service durations stack cleanly
  const times = ({
    standard:  ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30'],
    morning:   ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30'],
    afternoon: ['13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30'],
    saturday:  ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30']
  })[preset] || [];
  const sh = sheet_(SHEET_SLOTS);
  const data = sh.getDataRange().getValues();
  const have = {};
  for (let i = 1; i < data.length; i++) {
    have[asDateStr_(data[i][0]) + '|' + asTimeStr_(data[i][1])] = true;
  }
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
    const bid = String(row[3] || '');
    return asDateStr_(row[0]) === dateIso && !(String(row[2]) === 'booked' && bid && bid !== 'manual');
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
  for (let i = 1; i < data.length; i++) {
    have[asDateStr_(data[i][0]) + '|' + asTimeStr_(data[i][1])] = true;
  }

  // 30-min granularity so multi-slot bookings (90, 120 min) line up cleanly
  const weekday = ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30'];
  const saturday = ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30'];
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
    if (asDateStr_(data[i][0]) === dateIso && asTimeStr_(data[i][1]) === time) {
      const status = String(data[i][2]);
      const bookingId = String(data[i][3] || '');
      if (status === 'booked' && bookingId && bookingId !== 'manual') {
        throw new Error('Ez egy valódi foglalás — a Foglalások fülön mondhatod le.');
      }
      const newStatus = status === 'free' ? 'booked' : 'free';
      sh.getRange(i + 1, 3).setValue(newStatus);
      sh.getRange(i + 1, 4).setValue(newStatus === 'free' ? '' : 'manual');
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
    const bid = String(row[3] || '');
    return asDateStr_(row[0]) >= today && !(String(row[2]) === 'booked' && bid && bid !== 'manual');
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
  batchDeleteRows_(sh, toDeleteRows);
  return { removed: toDeleteRows.length };
}

// ============== BOOKING ==============

function createBooking_(b) {
  if (!b.date || !b.time || !b.name || !b.email) {
    throw new Error('Hiányzó adat: date, time, name, email kötelező');
  }
  if (!/.+@.+\..+/.test(b.email)) throw new Error('Érvénytelen e-mail');

  ensureSetup_();

  // Look up service duration so we know how many consecutive slots to block
  let durationMin = parseInt(b.durationMin, 10);
  if (!durationMin || durationMin <= 0) {
    // Fall back to service definition
    if (b.service) {
      const svcs = getServices_();
      const svc = svcs.filter(function(s) { return s.key === b.service; })[0];
      if (svc) durationMin = svc.durationMin;
    }
  }
  if (!durationMin || durationMin <= 0) durationMin = SLOT_GRANULARITY_MIN;
  durationMin = Math.ceil(durationMin / SLOT_GRANULARITY_MIN) * SLOT_GRANULARITY_MIN;
  const slotsNeeded = durationMin / SLOT_GRANULARITY_MIN;

  // Find the starting slot and verify N consecutive 30-min slots are free
  const sh = sheet_(SHEET_SLOTS);
  const data = sh.getDataRange().getValues();
  const expectedTimes = consecutiveTimes_(b.time, slotsNeeded); // ['10:00','10:30','11:00']
  const rowByTime = {};
  for (let i = 1; i < data.length; i++) {
    if (asDateStr_(data[i][0]) !== b.date) continue;
    const t = asTimeStr_(data[i][1]);
    rowByTime[t] = { row: i + 1, status: String(data[i][2]), bookingId: String(data[i][3] || '') };
  }
  // Verify every expected slot exists and is free
  for (let k = 0; k < expectedTimes.length; k++) {
    const t = expectedTimes[k];
    const r = rowByTime[t];
    if (!r) throw new Error('Hiányzó idősáv ehhez a szolgáltatáshoz: ' + t + '. Az adminnak hozzá kell adnia.');
    if (r.status !== 'free') throw new Error('Az időpont egy része már foglalt: ' + t);
  }

  const bookingId = 'BK-' + Utilities.getUuid().substring(0, 8).toUpperCase();
  // Block all consecutive slots with the same bookingId
  expectedTimes.forEach(function(t) {
    const r = rowByTime[t];
    sh.getRange(r.row, 3).setValue('booked');
    sh.getRange(r.row, 4).setValue(bookingId);
  });

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

  let emailWarning = null;
  try {
    sendEmails_(b, bookingId);
  } catch (e) {
    emailWarning = e.message || String(e);
    Logger.log('Email send failed: ' + emailWarning);
  }
  return { ok: true, bookingId: bookingId, emailWarning: emailWarning };
}

function cancelBooking_(bookingId) {
  const bk = sheet_(SHEET_BOOKINGS);
  const bdata = bk.getDataRange().getValues();
  let row = -1;
  let booking = null;
  for (let i = 1; i < bdata.length; i++) {
    if (String(bdata[i][0]) === bookingId) {
      row = i + 1;
      booking = {
        bookingId:   String(bdata[i][0]),
        date:        asDateStr_(bdata[i][2]),
        time:        asTimeStr_(bdata[i][3]),
        service:     String(bdata[i][4] || ''),
        serviceName: String(bdata[i][5] || ''),
        serviceMeta: String(bdata[i][6] || ''),
        name:        String(bdata[i][7] || ''),
        phone:       String(bdata[i][8] || ''),
        email:       String(bdata[i][9] || ''),
        note:        String(bdata[i][10] || '')
      };
      break;
    }
  }
  if (row === -1) throw new Error('Nem található foglalás');
  bk.getRange(row, 12).setValue('cancelled');

  // Free ALL slots tied to this bookingId (multi-slot bookings span N rows)
  const sh = sheet_(SHEET_SLOTS);
  const sdata = sh.getDataRange().getValues();
  let freedCount = 0;
  for (let i = 1; i < sdata.length; i++) {
    if (String(sdata[i][3]) === booking.bookingId) {
      sh.getRange(i + 1, 3).setValue('free');
      sh.getRange(i + 1, 4).setValue('');
      freedCount++;
    }
  }
  // Fallback: if no row carried the bookingId (old single-slot data), free the start slot
  if (freedCount === 0) {
    for (let i = 1; i < sdata.length; i++) {
      if (asDateStr_(sdata[i][0]) === booking.date && asTimeStr_(sdata[i][1]) === booking.time) {
        sh.getRange(i + 1, 3).setValue('free');
        sh.getRange(i + 1, 4).setValue('');
        break;
      }
    }
  }

  let emailWarning = null;
  try {
    sendCancellationEmails_(booking);
  } catch (e) {
    emailWarning = e.message || String(e);
    Logger.log('Cancellation email failed: ' + emailWarning);
  }
  return { ok: true, emailWarning: emailWarning };
}

function sendCancellationEmails_(b) {
  const dateLabel = formatDateHu_(b.date) + ' · ' + b.time;
  const subjectClient = CONFIG.businessName + ' — Foglalás lemondva';
  const subjectOwner  = '✕ Foglalás lemondva · ' + b.serviceName + ' · ' + b.date + ' ' + b.time;

  const clientHtml =
    '<div style="font-family:Georgia,serif;color:#2a1822;max-width:520px;margin:0 auto;padding:32px;background:#faf5f6;">' +
    '<div style="text-align:center;font-size:14px;letter-spacing:0.3em;color:#a4615c;text-transform:uppercase;margin-bottom:24px;">✿ ' + CONFIG.businessName + ' ✿</div>' +
    '<h1 style="font-family:\'DM Serif Display\',Georgia,serif;font-weight:400;font-size:30px;line-height:1.15;margin:0 0 16px;color:#2a1822;">Kedves <em style="color:#a4615c;">' + escapeHtml_(b.name) + '</em>,</h1>' +
    '<p style="font-size:16px;line-height:1.65;color:#4a2e3d;margin:0 0 18px;">Sajnálattal értesítlek, hogy a következő időpontodat sajnos le kellett mondanom:</p>' +
    '<table style="width:100%;background:#fff;border-radius:8px;padding:20px;border-collapse:collapse;margin-bottom:24px;">' +
    '<tr><td style="padding:8px 0;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#8e7680;">Szolgáltatás</td><td style="padding:8px 0;text-align:right;font-family:Georgia,serif;font-size:16px;color:#2a1822;">' + escapeHtml_(b.serviceName || '') + '</td></tr>' +
    '<tr><td style="padding:8px 0;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#8e7680;border-top:1px solid #f3eced;">Lemondott időpont</td><td style="padding:8px 0;text-align:right;font-family:Georgia,serif;font-size:16px;color:#2a1822;text-decoration:line-through;border-top:1px solid #f3eced;">' + dateLabel + '</td></tr>' +
    '<tr><td style="padding:8px 0;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#8e7680;border-top:1px solid #f3eced;">Foglalási szám</td><td style="padding:8px 0;text-align:right;font-family:Georgia,serif;font-size:16px;color:#2a1822;border-top:1px solid #f3eced;">' + escapeHtml_(b.bookingId) + '</td></tr>' +
    '</table>' +
    '<p style="font-size:15px;line-height:1.7;color:#4a2e3d;margin:0 0 8px;">Ha szeretnél új időpontot, kérlek hívj a <a style="color:#a4615c;font-weight:600;text-decoration:none;" href="tel:' + CONFIG.businessPhone + '">' + CONFIG.businessPhone + '</a> számon, vagy írj az <a style="color:#a4615c;font-weight:600;text-decoration:none;" href="mailto:' + CONFIG.businessEmail + '">' + CONFIG.businessEmail + '</a> címre.</p>' +
    '<p style="font-size:14px;line-height:1.7;color:#8e7680;margin:18px 0 0;font-style:italic;">Elnézést a kellemetlenségért — találjunk egy új időpontot, ami mindkettőnknek megfelel.</p>' +
    '<p style="font-size:13px;line-height:1.6;color:#8e7680;margin:24px 0 0;font-style:italic;">— Alice</p>' +
    '</div>';

  const ownerHtml =
    '<div style="font-family:Georgia,serif;color:#2a1822;max-width:520px;margin:0 auto;padding:24px;">' +
    '<h2 style="margin:0 0 16px;color:#b6463f;">✕ Foglalás lemondva</h2>' +
    '<p style="color:#8e7680;font-style:italic;margin-bottom:16px;">Visszaigazoló e-mail elküldve a vendégnek. Az idősáv újra szabad a foglalóban.</p>' +
    '<table style="width:100%;border-collapse:collapse;">' +
    '<tr><td style="padding:6px 0;color:#8e7680;">Vendég</td><td style="padding:6px 0;text-align:right;"><b>' + escapeHtml_(b.name) + '</b></td></tr>' +
    '<tr><td style="padding:6px 0;color:#8e7680;">Telefon</td><td style="padding:6px 0;text-align:right;">' + escapeHtml_(b.phone || '—') + '</td></tr>' +
    '<tr><td style="padding:6px 0;color:#8e7680;">E-mail</td><td style="padding:6px 0;text-align:right;">' + escapeHtml_(b.email) + '</td></tr>' +
    '<tr><td style="padding:6px 0;color:#8e7680;">Szolgáltatás</td><td style="padding:6px 0;text-align:right;">' + escapeHtml_(b.serviceName || '') + '</td></tr>' +
    '<tr><td style="padding:6px 0;color:#8e7680;">Lemondott időpont</td><td style="padding:6px 0;text-align:right;text-decoration:line-through;"><b>' + dateLabel + '</b></td></tr>' +
    '<tr><td style="padding:6px 0;color:#8e7680;">Foglalási szám</td><td style="padding:6px 0;text-align:right;">' + escapeHtml_(b.bookingId) + '</td></tr>' +
    '</table>' +
    '</div>';

  if (b.email) {
    MailApp.sendEmail({
      to: b.email,
      subject: subjectClient,
      htmlBody: clientHtml,
      name: CONFIG.businessName,
      replyTo: CONFIG.businessEmail
    });
  }
  MailApp.sendEmail({
    to: CONFIG.businessEmail,
    subject: subjectOwner,
    htmlBody: ownerHtml,
    name: CONFIG.businessName + ' (auto)',
    replyTo: b.email || CONFIG.businessEmail
  });
}

// ============== SLOT MANAGEMENT ==============

function addSlot_(dateIso, time) {
  ensureSetup_();
  const sh = sheet_(SHEET_SLOTS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (asDateStr_(data[i][0]) === dateIso && asTimeStr_(data[i][1]) === time) {
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
    if (asDateStr_(data[i][0]) === dateIso && asTimeStr_(data[i][1]) === time) {
      if (String(data[i][2]) === 'booked' && data[i][3] && String(data[i][3]) !== 'manual') {
        throw new Error('Foglalt időpontot először mondj le');
      }
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
    const d = asDateStr_(data[i][0]);
    if (!d || d < fromD || d > toD) continue;
    if (String(data[i][2]) === 'free') {
      out.push({ date: d, time: asTimeStr_(data[i][1]) });
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
    const dateStr = asDateStr_(data[i][0]);
    if (!dateStr) continue;
    out.push({
      date: dateStr,
      time: asTimeStr_(data[i][1]),
      status: String(data[i][2] || 'free'),
      bookingId: String(data[i][3] || '')
    });
  }
  return out;
}

function getAllBookings_() {
  const bk = sheet_(SHEET_BOOKINGS);
  const data = bk.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    out.push({
      bookingId:   String(data[i][0]),
      created:     data[i][1] instanceof Date ? data[i][1].toISOString() : String(data[i][1] || ''),
      date:        asDateStr_(data[i][2]),
      time:        asTimeStr_(data[i][3]),
      service:     String(data[i][4] || ''),
      serviceName: String(data[i][5] || ''),
      serviceMeta: String(data[i][6] || ''),
      name:        String(data[i][7] || ''),
      phone:       String(data[i][8] || ''),
      email:       String(data[i][9] || ''),
      note:        String(data[i][10] || ''),
      status:      String(data[i][11] || 'confirmed')
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

/**
 * RUN THIS ONCE from the editor (after `setup`) to grant Gmail send permission.
 * Sends a single test email to CONFIG.businessEmail.
 * If you skip this, the booking endpoint will succeed but emails won't be sent
 * because Apps Script never requested the MailApp scope.
 */
function enableEmail() {
  MailApp.sendEmail({
    to: CONFIG.businessEmail,
    subject: '✿ ' + CONFIG.businessName + ' — e-mail teszt',
    htmlBody: '<div style="font-family:Georgia,serif;color:#2a1822;max-width:480px;margin:0 auto;padding:24px;">' +
              '<h2 style="font-family:Georgia,serif;font-weight:400;color:#a4615c;">Sikeres e-mail teszt ✿</h2>' +
              '<p>Ez azt jelenti, hogy a foglalási rendszer mostantól valódi visszaigazoló e-maileket fog küldeni neked és a vendégeidnek.</p>' +
              '<p style="color:#8e7680;font-size:13px;margin-top:24px;font-style:italic;">— Alice Beauty Studio booking system</p>' +
              '</div>',
    name: CONFIG.businessName
  });
  return 'Teszt e-mail elküldve: ' + CONFIG.businessEmail + ' — nézd meg az Inboxot (vagy Spam mappát).';
}

/**
 * One-time cleanup: removes duplicate (date|time) rows from the Slots sheet,
 * keeping the row with the highest-priority status (booked > free).
 */
function dedupeSlots() {
  const sh = sheet_(SHEET_SLOTS);
  const data = sh.getDataRange().getValues();
  const seen = {};   // key -> { row, status, bid, priority }
  const dups = [];   // rows to delete

  function priorityOf(status, bid) {
    if (status === 'booked' && bid && bid !== 'manual') return 3; // real booking
    if (status === 'booked') return 2;                            // manual block
    return 1;                                                     // free
  }

  for (let i = 1; i < data.length; i++) {
    const date = asDateStr_(data[i][0]);
    const time = asTimeStr_(data[i][1]);
    if (!date || !time) { dups.push(i + 1); continue; }
    const key = date + '|' + time;
    const status = String(data[i][2] || 'free');
    const bid = String(data[i][3] || '');
    const p = priorityOf(status, bid);

    if (!seen[key]) {
      seen[key] = { row: i + 1, priority: p };
      continue;
    }
    if (p > seen[key].priority) {
      dups.push(seen[key].row);
      seen[key] = { row: i + 1, priority: p };
    } else {
      dups.push(i + 1);
    }
  }

  if (!dups.length) return { removed: 0, kept: Object.keys(seen).length };
  batchDeleteRows_(sh, dups);
  return { removed: dups.length, kept: Object.keys(seen).length };
}

/**
 * Delete a set of row numbers in batched contiguous-range calls.
 * Far fewer API calls than one deleteRow per row, and immune to the
 * "Service Spreadsheets failed" error you get when looping deleteRow.
 * Also handles the "can't delete all unfrozen rows" edge case.
 */
function batchDeleteRows_(sh, rowNumbers) {
  if (!rowNumbers || !rowNumbers.length) return;
  const lastRow = sh.getLastRow();
  const totalDataRows = lastRow - 1; // minus header
  // Edge case: deleting every data row → use clearContent instead
  if (rowNumbers.length >= totalDataRows && totalDataRows > 0) {
    sh.getRange(2, 1, totalDataRows, sh.getLastColumn()).clearContent();
    return;
  }
  // Walk from bottom up, grouping contiguous rows
  const sorted = rowNumbers.slice().sort(function(a, b) { return b - a; });
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] - 1) j++;
    const top = sorted[j];
    const count = j - i + 1;
    sh.deleteRows(top, count);
    i = j + 1;
  }
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
  // Force columns to plain text so Sheets doesn't auto-parse '09:00' or '2026-05-20'
  slots.getRange('A:D').setNumberFormat('@');

  const bk = ss.getSheetByName(SHEET_BOOKINGS) || ss.insertSheet(SHEET_BOOKINGS);
  if (bk.getLastRow() === 0) {
    bk.appendRow(['bookingId','created','date','time','service','serviceName','serviceMeta','name','phone','email','note','status']);
    bk.getRange(1, 1, 1, 12).setFontWeight('bold').setBackground('#f3eced');
    bk.setFrozenRows(1);
  }
  bk.getRange('A:L').setNumberFormat('@');

  // SERVICES sheet — seeded with defaults on first run
  const sv = ss.getSheetByName(SHEET_SERVICES) || ss.insertSheet(SHEET_SERVICES);
  if (sv.getLastRow() === 0) {
    sv.appendRow(['order', 'key', 'name', 'description', 'duration', 'durationMin', 'price', 'featured']);
    sv.getRange(1, 1, 1, 8).setFontWeight('bold').setBackground('#f3eced');
    sv.setFrozenRows(1);
    const seedRows = DEFAULT_SERVICES.map(function(s) {
      return [s.order, s.key, s.name, s.description, s.duration, s.durationMin, s.price, s.featured ? 'TRUE' : 'FALSE'];
    });
    sv.getRange(2, 1, seedRows.length, 8).setValues(seedRows);
  } else {
    // Backfill: if sheet exists but lacks the durationMin column (8th), insert it
    const headers = sv.getRange(1, 1, 1, sv.getLastColumn()).getValues()[0];
    if (headers.length < 8 || headers[5] !== 'durationMin') {
      // Insert column F (durationMin) between 'duration' and 'price'
      sv.insertColumnAfter(5);
      sv.getRange(1, 6).setValue('durationMin').setFontWeight('bold').setBackground('#f3eced');
      // Backfill rows with default 60 if blank
      const lastRow = sv.getLastRow();
      if (lastRow > 1) {
        const vals = sv.getRange(2, 6, lastRow - 1, 1).getValues();
        for (let i = 0; i < vals.length; i++) if (!vals[i][0]) vals[i][0] = 60;
        sv.getRange(2, 6, lastRow - 1, 1).setValues(vals);
      }
    }
  }
  sv.getRange('A:H').setNumberFormat('@');

  // Default sheet ("Sheet1") cleanup
  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  return ss;
}

function getServices_() {
  ensureSetup_();
  const sh = sheet_(SHEET_SERVICES);
  const data = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][1]) continue; // need a key
    let durationMin = parseInt(data[i][5], 10);
    if (!durationMin || durationMin <= 0) durationMin = 60;
    // round up to next SLOT_GRANULARITY_MIN
    durationMin = Math.ceil(durationMin / SLOT_GRANULARITY_MIN) * SLOT_GRANULARITY_MIN;
    out.push({
      order:       parseInt(data[i][0], 10) || (i),
      key:         String(data[i][1] || '').trim(),
      name:        String(data[i][2] || '').trim(),
      description: String(data[i][3] || '').trim(),
      duration:    String(data[i][4] || '').trim(),
      durationMin: durationMin,
      price:       String(data[i][6] || '').trim(),
      featured:    String(data[i][7] || '').toUpperCase() === 'TRUE'
    });
  }
  out.sort(function(a, b) { return a.order - b.order; });
  return out;
}

function writeServices_(services) {
  const sh = sheet_(SHEET_SERVICES);
  const totalRows = sh.getLastRow();
  if (totalRows > 1) sh.getRange(2, 1, totalRows - 1, 8).clearContent();
  if (!services.length) return { ok: true, count: 0 };
  const rows = services.map(function(s, i) {
    let dm = parseInt(s.durationMin, 10) || 60;
    if (dm < SLOT_GRANULARITY_MIN) dm = SLOT_GRANULARITY_MIN;
    dm = Math.ceil(dm / SLOT_GRANULARITY_MIN) * SLOT_GRANULARITY_MIN;
    return [
      i + 1,
      String(s.key || ('svc' + (i + 1))).trim(),
      String(s.name || '').trim(),
      String(s.description || '').trim(),
      String(s.duration || '').trim(),
      dm,
      String(s.price || '').trim(),
      s.featured ? 'TRUE' : 'FALSE'
    ];
  });
  sh.getRange(2, 1, rows.length, 8).setValues(rows);
  return { ok: true, count: rows.length };
}

/**
 * Coerce a cell value (which may be a Date if Sheets auto-typed it) to YYYY-MM-DD string.
 */
function asDateStr_(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.timezone, 'yyyy-MM-dd');
  return String(v).trim();
}

/**
 * Coerce a cell value to HH:MM string. Handles raw strings, Date (sheet auto-typed time),
 * and numbers (Sheets stores time as a fraction-of-day number).
 */
function asTimeStr_(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.timezone, 'HH:mm');
  if (typeof v === 'number') {
    const totalMin = Math.round(v * 24 * 60);
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2);
  }
  return String(v).trim();
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

/** Given a start time like '10:00' and count N, return ['10:00','10:30',...] of N times. */
function consecutiveTimes_(startTime, n) {
  const parts = String(startTime).split(':');
  let mins = parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10);
  const out = [];
  for (let i = 0; i < n; i++) {
    const h = Math.floor(mins / 60), m = mins % 60;
    out.push(('0' + h).slice(-2) + ':' + ('0' + m).slice(-2));
    mins += SLOT_GRANULARITY_MIN;
  }
  return out;
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
