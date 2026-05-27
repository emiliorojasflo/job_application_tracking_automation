/**
 * Job Application Tracker — Apps Script
 *
 * One-time setup:
 *   1. Open script.google.com → New project → paste this file as Code.gs
 *   2. Paste Classifier.gs as a separate file (Parser.gs is no longer needed)
 *   3. Open Project Settings → Script Properties → add:
 *        - ANTHROPIC_API_KEY  (your Claude API key)
 *   4. Run setup() once. Grant Gmail, Sheets, and Drive permissions when prompted.
 *   5. Run installTrigger() once. This installs a 5-minute polling trigger.
 *
 * After that, the script runs on its own. Open the Sheet to see your pipeline.
 */

// ---------------- Config ----------------

const CONFIG = {
  SHEET_NAME: 'Job Application Tracker',
  TAB_NAME: 'Applications',
  EVENTS_TAB: 'Event Log',
  BACKFILL_DAYS: 180,          // 6 months
  POLL_FREQUENCY_MIN: 5,        // trigger interval
  GMAIL_LABEL: 'JobTracker/Processed',  // emails we've handled get this label
  CONFIDENCE_THRESHOLD: 0.6,    // below this, we skip the email
};

const COLUMNS = [
  'Company',
  'Role',
  'Status',
  'Applied Date',
  'Last Update',
  'Source',
  'Salary Range',
  'Location',
  'Notes',
  'Email Thread',
  'Confidence',
  'Career Site',
];

const STATUSES = [
  'Applied',
  'Application Reviewed',
  'Assessment',
  'Interview Scheduled',
  'Interview Completed',
  'Offer',
  'Accepted',
  'Rejected',
  'Withdrawn',
  'Ghosted',
];

// ---------------- Setup ----------------

/**
 * Run once. Creates the Sheet, sets up tabs, and saves the Sheet ID.
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let sheetId = props.getProperty('SHEET_ID');

  // If we already have a sheet, just confirm and exit
  if (sheetId) {
    try {
      const existing = SpreadsheetApp.openById(sheetId);
      Logger.log('Sheet already exists: ' + existing.getUrl());
      return existing.getUrl();
    } catch (e) {
      Logger.log('Stored sheet ID invalid, creating new one.');
    }
  }

  // Create the spreadsheet
  const ss = SpreadsheetApp.create(CONFIG.SHEET_NAME);
  sheetId = ss.getId();
  props.setProperty('SHEET_ID', sheetId);

  // --- Applications tab ---
  const sheet = ss.getActiveSheet();
  sheet.setName(CONFIG.TAB_NAME);

  // Header row
  sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
  const headerRange = sheet.getRange(1, 1, 1, COLUMNS.length);
  headerRange.setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
  sheet.setFrozenRows(1);

  // Column widths (rough but reasonable defaults)
  const widths = [160, 200, 140, 110, 110, 110, 120, 140, 240, 100, 90, 180];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  // Data validation on Status column (index 3, 1-based)
  const statusCol = COLUMNS.indexOf('Status') + 1;
  const statusRange = sheet.getRange(2, statusCol, sheet.getMaxRows() - 1, 1);
  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES, true)
    .setAllowInvalid(false)
    .build();
  statusRange.setDataValidation(statusRule);

  // Date formatting
  const appliedCol = COLUMNS.indexOf('Applied Date') + 1;
  const updateCol = COLUMNS.indexOf('Last Update') + 1;
  sheet.getRange(2, appliedCol, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(2, updateCol, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');

  // --- Event Log tab (audit trail of every classification) ---
  const eventSheet = ss.insertSheet(CONFIG.EVENTS_TAB);
  const eventCols = ['Timestamp', 'Thread ID', 'From', 'Subject', 'Detected Status',
                     'Company', 'Role', 'Confidence', 'Method', 'Action Taken'];
  eventSheet.getRange(1, 1, 1, eventCols.length).setValues([eventCols]);
  eventSheet.getRange(1, 1, 1, eventCols.length)
    .setFontWeight('bold').setBackground('#5f6368').setFontColor('#ffffff');
  eventSheet.setFrozenRows(1);
  [180, 140, 220, 280, 150, 150, 180, 90, 100, 140]
    .forEach((w, i) => eventSheet.setColumnWidth(i + 1, w));

  // Create the Gmail label we'll use to mark processed emails
  getOrCreateLabel(CONFIG.GMAIL_LABEL);

  Logger.log('✓ Setup complete.');
  Logger.log('Sheet URL: ' + ss.getUrl());
  Logger.log('Next step: run installTrigger() to enable automatic polling.');
  return ss.getUrl();
}

/**
 * Run once after setup(). Installs the time-based polling trigger.
 */
function installTrigger() {
  // Remove any existing triggers for this function (idempotent)
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'pollGmail')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('pollGmail')
    .timeBased()
    .everyMinutes(CONFIG.POLL_FREQUENCY_MIN)
    .create();

  Logger.log(`✓ Polling trigger installed (every ${CONFIG.POLL_FREQUENCY_MIN} min).`);
}

/**
 * Diagnostic. Run this when emails are not showing up in the sheet.
 * Walks through each layer (Gmail search → label state → classifier) and
 * prints what's happening so you can see exactly where the pipeline drops it.
 *
 * Edit the SEARCH variable below to test specific phrases.
 */
function diagnose() {
  Logger.log('===== DIAGNOSE =====');

  // 1. Is the API key set?
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  Logger.log('API key present: ' + (apiKey ? 'yes (' + apiKey.slice(0, 10) + '...)' : 'NO — set it in Project Settings'));

  // 2. Does the sheet exist?
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  Logger.log('Sheet ID present: ' + (sheetId ? sheetId : 'NO — run setup() first'));

  // 3. How many threads match our full query?
  const fullQuery = `newer_than:7d -label:${CONFIG.GMAIL_LABEL} ${getJobEmailQuery()}`;
  const matched = GmailApp.search(fullQuery, 0, 20);
  Logger.log('Threads matching FULL query (last 7d, not yet processed): ' + matched.length);

  // 4. Show the first 5 matched subjects so we can see what got through
  matched.slice(0, 5).forEach((t, i) => {
    const m = t.getMessages()[t.getMessageCount() - 1];
    Logger.log(`  [${i + 1}] from="${m.getFrom()}"  subject="${m.getSubject()}"`);
  });

  // 5. Try a broader test — just "linkedin" sender, no other filters
  const linkedinTest = GmailApp.search('from:linkedin.com newer_than:7d', 0, 10);
  Logger.log('Raw LinkedIn emails in last 7d (any subject): ' + linkedinTest.length);
  linkedinTest.slice(0, 5).forEach((t, i) => {
    const m = t.getMessages()[t.getMessageCount() - 1];
    const labels = t.getLabels().map(l => l.getName()).join(', ');
    Logger.log(`  [${i + 1}] subject="${m.getSubject()}"  labels=[${labels}]`);
  });

  // 6. How many threads already have our "processed" label?
  const alreadyProcessed = GmailApp.search(`label:${CONFIG.GMAIL_LABEL} newer_than:7d`, 0, 1);
  Logger.log('Threads already labeled as processed (last 7d): ' + (alreadyProcessed.length > 0 ? 'at least 1' : '0'));

  // 7. Test the classifier directly on a hardcoded LinkedIn-style email
  Logger.log('--- Testing classifier on a sample email ---');
  const sample = classifyAndExtract({
    from: 'LinkedIn <jobs-noreply@linkedin.com>',
    subject: 'Se ha enviado tu solicitud a CAPTRUST',
    body: 'Se ha enviado tu solicitud a CAPTRUST.\nSenior Business Analyst\nCAPTRUST · Raleigh, NC (Presencial)\nSolicitado el 26 de mayo de 2026',
  });
  Logger.log('Sample result: ' + JSON.stringify(sample, null, 2));

  Logger.log('===== END DIAGNOSE =====');
  Logger.log('Interpretation:');
  Logger.log('  - If "Threads matching FULL query" is 0 but "Raw LinkedIn" > 0,');
  Logger.log('    your emails are being filtered out by getJobEmailQuery().');
  Logger.log('  - If both are 0, the emails are older than 7 days or in a different account.');
  Logger.log('  - If "already labeled as processed" is > 0, the script processed them');
  Logger.log('    on an earlier run — check the Event Log tab for what happened.');
  Logger.log('  - If "Sample result" shows is_application=false or confidence < 0.6,');
  Logger.log('    the LLM is rejecting them — check the prompt or the threshold.');
}

/**
 * Run once after setup() to import the last 6 months of job emails.
 * Apps Script has a 6-minute execution limit, so this processes in chunks.
 * Re-run until you see "✓ Backfill complete."
 */
function backfill() {
  const props = PropertiesService.getScriptProperties();
  const cursor = parseInt(props.getProperty('BACKFILL_CURSOR') || '0', 10);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - CONFIG.BACKFILL_DAYS);
  const afterStr = Utilities.formatDate(startDate, 'UTC', 'yyyy/MM/dd');

  // Same query as pollGmail, but date-bounded and without the "unprocessed" filter
  const query = `after:${afterStr} ${getJobEmailQuery()}`;
  const threads = GmailApp.search(query, cursor, 50);

  if (threads.length === 0) {
    Logger.log('✓ Backfill complete.');
    props.deleteProperty('BACKFILL_CURSOR');
    return;
  }

  Logger.log(`Backfilling threads ${cursor}..${cursor + threads.length}`);
  processThreads(threads);
  props.setProperty('BACKFILL_CURSOR', String(cursor + threads.length));

  // If we got a full page, there's likely more — re-run.
  if (threads.length === 50) {
    Logger.log('More threads remain. Re-run backfill() to continue.');
  } else {
    Logger.log('✓ Backfill complete.');
    props.deleteProperty('BACKFILL_CURSOR');
  }
}

// ---------------- Main poll loop ----------------

/**
 * The trigger entry point. Runs every CONFIG.POLL_FREQUENCY_MIN minutes.
 */
function pollGmail() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('Another pollGmail is already running; skipping.');
    return;
  }

  try {
    // Look at the last 2 days of unprocessed mail. Cheap and covers most cases.
    const query = `newer_than:2d -label:${CONFIG.GMAIL_LABEL} ${getJobEmailQuery()}`;
    const threads = GmailApp.search(query, 0, 50);
    if (threads.length === 0) return;
    Logger.log(`pollGmail: found ${threads.length} candidate threads`);
    processThreads(threads);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Gmail search query for things that *might* be job emails.
 * Casts a wide net — the LLM classifier filters precisely.
 * Includes English and Spanish subject + body terms.
 *
 * Note: Gmail's search matches across subject AND body by default
 * (unless you prefix with subject:), so these terms catch the email
 * even when LinkedIn puts the company name in the subject and the
 * confirmation phrase only in the body.
 */
function getJobEmailQuery() {
  const subjectTerms = [
    // English — application confirmations
    '"thank you for applying"',
    '"thanks for applying"',
    '"application received"',
    '"application was sent"',
    '"application has been sent"',
    '"application for"',
    '"your application"',
    '"you applied"',
    '"applied to"',
    // English — pipeline events
    '"interview"',
    '"next steps"',
    '"we regret"',
    '"unfortunately"',
    '"offer"',
    '"position"',
    '"role at"',
    // Spanish — application confirmations
    '"se ha enviado tu solicitud"',
    '"tu solicitud fue enviada"',
    '"solicitud enviada"',
    '"se envió tu solicitud"',
    '"gracias por postular"',
    '"gracias por postularte"',
    '"gracias por aplicar"',
    '"gracias por tu aplicación"',
    '"gracias por tu postulación"',
    '"gracias por tu interés"',
    '"hemos recibido tu aplicación"',
    '"hemos recibido tu postulación"',
    '"hemos recibido tu solicitud"',
    '"tu candidatura"',
    '"tu postulación"',
    '"solicitaste"',
    '"postulaste"',
    // Spanish — pipeline events
    '"proceso de selección"',
    '"entrevista"',
    '"siguientes pasos"',
    '"próximos pasos"',
    '"lamentamos"',
    '"lamentablemente"',
    '"oferta"',
    '"vacante"',
    '"puesto de"',
  ].join(' OR ');

  const senderTerms = [
    'from:greenhouse.io',
    'from:lever.co',
    'from:myworkday.com',
    'from:ashbyhq.com',
    'from:smartrecruiters.com',
    'from:workable.com',
    'from:icims.com',
    'from:taleo.net',
    'from:jobvite.com',
    'from:recruiterbox.com',
    'from:bamboohr.com',
    'from:rippling-mail.com',
    // LinkedIn — jobs-noreply@linkedin.com and similar
    'from:linkedin.com',
    // Indeed application confirmations
    'from:indeed.com',
    'from:indeedemail.com',
    // Glassdoor
    'from:glassdoor.com',
    // Other job boards
    'from:wellfound.com',
    'from:ziprecruiter.com',
  ].join(' OR ');

  return `(${subjectTerms}) OR (${senderTerms})`;
}

/**
 * Process a batch of Gmail threads: classify, upsert, label.
 */
function processThreads(threads) {
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  const sheet = ss.getSheetByName(CONFIG.TAB_NAME);
  const eventLog = ss.getSheetByName(CONFIG.EVENTS_TAB);
  const processedLabel = getOrCreateLabel(CONFIG.GMAIL_LABEL);

  // Load all existing rows once so we can do in-memory matching
  const existing = loadExisting(sheet);

  threads.forEach(thread => {
    try {
      // We only need the latest message for status, but the first one for "applied date".
      const messages = thread.getMessages();
      const latest = messages[messages.length - 1];
      const earliest = messages[0];

      const subject = latest.getSubject() || '';
      const from = latest.getFrom() || '';
      const bodySnippet = (latest.getPlainBody() || '').slice(0, 1500);
      const threadUrl = `https://mail.google.com/mail/u/0/#inbox/${thread.getId()}`;

      // Single AI call does classification AND extraction
      const result = classifyAndExtract({ subject, from, body: bodySnippet });

      eventLog.appendRow([
        new Date(), thread.getId(), from, subject,
        result.status || '',
        result.company || '',
        result.role || '',
        result.confidence,
        result.method,
        result.confidence >= CONFIG.CONFIDENCE_THRESHOLD && result.is_application
          ? 'upserted'
          : 'skipped (' + (result.is_application ? 'low confidence' : 'not an application') + ')',
      ]);

      if (!result.is_application || result.confidence < CONFIG.CONFIDENCE_THRESHOLD) {
        // Label so we don't reprocess every poll cycle
        thread.addLabel(processedLabel);
        return;
      }
      if (!result.company || !result.role) {
        thread.addLabel(processedLabel);
        return;
      }

      // Upsert into the sheet — result has everything we need
      upsertApplication(sheet, existing, {
        company: result.company,
        role: result.role,
        status: result.status || 'Applied',
        appliedDate: earliest.getDate(),
        lastUpdate: latest.getDate(),
        source: result.source,
        salaryRange: result.salaryRange,
        location: result.location,
        notes: result.notes,
        threadUrl: threadUrl,
        confidence: result.confidence,
        careerSite: result.careerSite,
      });

      thread.addLabel(processedLabel);
    } catch (err) {
      Logger.log(`Error processing thread ${thread.getId()}: ${err.message}`);
      eventLog.appendRow([new Date(), thread.getId(), '', '', '', '', '', 0, 'error', err.message]);
    }
  });
}

// ---------------- Sheet I/O ----------------

/**
 * Load existing applications into a Map keyed by normalized (company, role).
 */
function loadExisting(sheet) {
  const lastRow = sheet.getLastRow();
  const map = new Map();
  if (lastRow < 2) return map;

  const data = sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).getValues();
  data.forEach((row, idx) => {
    const company = row[COLUMNS.indexOf('Company')];
    const role = row[COLUMNS.indexOf('Role')];
    if (!company || !role) return;
    const key = normalizeKey(company, role);
    map.set(key, { rowIndex: idx + 2, data: row });
  });
  return map;
}

/**
 * Insert a new row or update an existing one.
 * Status only advances forward (we never overwrite "Offer" with "Applied").
 */
function upsertApplication(sheet, existing, app) {
  const key = normalizeKey(app.company, app.role);
  const existingEntry = existing.get(key);

  if (existingEntry) {
    // Update in place — but only advance status, never regress
    const row = existingEntry.rowIndex;
    const currentStatus = existingEntry.data[COLUMNS.indexOf('Status')];
    const newStatus = pickLatestStatus(currentStatus, app.status);

    // Always bump last-update timestamp
    sheet.getRange(row, COLUMNS.indexOf('Last Update') + 1).setValue(app.lastUpdate);
    if (newStatus !== currentStatus) {
      sheet.getRange(row, COLUMNS.indexOf('Status') + 1).setValue(newStatus);
    }

    // Fill in any blank optional fields without overwriting user edits
    fillIfBlank(sheet, row, 'Source', app.source);
    fillIfBlank(sheet, row, 'Salary Range', app.salaryRange);
    fillIfBlank(sheet, row, 'Location', app.location);
    fillIfBlank(sheet, row, 'Career Site', app.careerSite);

    // Append notes rather than overwrite
    if (app.notes) {
      const notesCol = COLUMNS.indexOf('Notes') + 1;
      const existingNotes = existingEntry.data[COLUMNS.indexOf('Notes')] || '';
      const newNotes = existingNotes
        ? `${existingNotes}\n${formatDate(app.lastUpdate)}: ${app.notes}`
        : `${formatDate(app.lastUpdate)}: ${app.notes}`;
      sheet.getRange(row, notesCol).setValue(newNotes);
    }
  } else {
    // New application
    const newRow = COLUMNS.map(col => {
      switch (col) {
        case 'Company': return app.company;
        case 'Role': return app.role;
        case 'Status': return app.status;
        case 'Applied Date': return app.appliedDate;
        case 'Last Update': return app.lastUpdate;
        case 'Source': return app.source || '';
        case 'Salary Range': return app.salaryRange || '';
        case 'Location': return app.location || '';
        case 'Notes': return app.notes ? `${formatDate(app.lastUpdate)}: ${app.notes}` : '';
        case 'Email Thread': return app.threadUrl;
        case 'Confidence': return app.confidence.toFixed(2);
        case 'Career Site': return app.careerSite || '';
      }
    });
    sheet.appendRow(newRow);

    // Add to in-memory map so subsequent threads in this batch see it
    existing.set(key, { rowIndex: sheet.getLastRow(), data: newRow });
  }
}

function fillIfBlank(sheet, row, columnName, value) {
  if (!value) return;
  const col = COLUMNS.indexOf(columnName) + 1;
  const current = sheet.getRange(row, col).getValue();
  if (!current) sheet.getRange(row, col).setValue(value);
}

// ---------------- Helpers ----------------

function normalizeKey(company, role) {
  const norm = s => String(s)
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|gmbh|co)\.?\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${norm(company)}::${norm(role)}`;
}

/**
 * Pick the more advanced of two statuses. Terminal states always win.
 * If we see "Offer" then later a "Rejected", we keep "Rejected" (latest signal wins for terminals).
 */
function pickLatestStatus(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;

  const order = STATUSES.indexOf.bind(STATUSES);
  const terminals = ['Rejected', 'Withdrawn', 'Accepted', 'Ghosted'];

  // Terminal incoming always wins (final state)
  if (terminals.includes(incoming)) return incoming;
  // Don't regress from a terminal
  if (terminals.includes(current)) return current;
  // Otherwise advance to whichever is later in pipeline
  return order(incoming) > order(current) ? incoming : current;
}

function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function formatDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
