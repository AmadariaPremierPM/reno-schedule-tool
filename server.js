require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3535;
const TOKEN = process.env.SMARTSHEET_API_TOKEN;
const API_BASE = 'https://api.smartsheet.com/2.0';

// ---------------------------------------------------------------------------
// Fixed infrastructure - these almost never change, unlike the templates
// themselves, so they're simple constants rather than something configured
// through a UI. Update here if any of these ever move.
// ---------------------------------------------------------------------------
const AUM_WORKSPACE_ID = 374562522195844; // "Schedule Templates - AUM"
const THIRD_PARTY_WORKSPACE_ID = 522652994561924; // "Schedule Templates - Third Party"
const DEFAULT_DESTINATION = { type: 'workspace', id: 946308568639364, label: 'Automated Schedule Builder' };
const GENERATION_LOG_SHEET_ID = 5918027802431364; // "Generation Log" sheet

const THIRD_PARTY_SCOPES = ['GUESTROOM', 'MODEL_ROOM', 'PUBLIC_SPACE'];
const ALL_SERVICES = ['Architecture', 'Interior Design', 'Procurement', 'Project Management'];

const SCOPE_LABELS = {
  GUESTROOM: 'Guestroom',
  MODEL_ROOM: 'Model Room',
  PUBLIC_SPACE: 'Public Space',
  PUBLIC_FULL: 'Public Space - Full Service',
  PUBLIC_SELECT: 'Public Space - Select Service',
};

// ---------------------------------------------------------------------------
// Live template discovery. Instead of a config file someone has to keep
// feeding, this reads the actual sheets sitting in your two Smartsheet
// template workspaces every time (with a short cache so rapid checkbox
// clicks in the app don't hammer the API), and figures out what each one is
// FOR purely from its name - the same convention already used across all 54+
// templates (e.g. "Arch & ID - GR, MR" = Architecture + Interior Design, for
// Guestroom + Model Room). Add a new template with the right name in
// Smartsheet, and the app picks it up automatically within a few seconds -
// nothing to import, nothing to configure.
// ---------------------------------------------------------------------------
const SCOPE_TOKEN_MAP = { GR: 'GUESTROOM', MR: 'MODEL_ROOM', PS: 'PUBLIC_SPACE' };

// Longest/most-specific prefixes first, so "Arch & ID" isn't mistakenly
// matched by a looser "Arch" check, etc.
const SERVICE_PREFIX_MAP = [
  ['All Services', ['Architecture', 'Interior Design', 'Procurement', 'Project Management']],
  ['Arch, ID, Proc', ['Architecture', 'Interior Design', 'Procurement']],
  ['ID, Proc, PM', ['Interior Design', 'Procurement', 'Project Management']],
  ['Arch & ID', ['Architecture', 'Interior Design']],
  ['ID & Proc', ['Interior Design', 'Procurement']],
  ['Arch', ['Architecture']],
  ['ID', ['Interior Design']],
  ['Proc', ['Procurement']],
  ['PM', ['Project Management']],
];

function parseThirdPartyTemplateName(name) {
  const idx = name.indexOf(' - ');
  if (idx === -1) return null;
  const prefix = name.slice(0, idx).trim();
  const scopePart = name.slice(idx + 3);
  const match = SERVICE_PREFIX_MAP.find(([key]) => key === prefix);
  if (!match) return null;
  const scopeTokens = scopePart.match(/GR|MR|PS/g);
  if (!scopeTokens || scopeTokens.length === 0) return null;
  const scopes = [...new Set(scopeTokens.map((t) => SCOPE_TOKEN_MAP[t]))];
  return { scopes, services: match[1] };
}

function scopeKey(scopes) {
  return [...scopes].sort().join(',');
}
function servicesKey(services) {
  return [...services].sort().join(',');
}

function findThirdPartyTemplate(templates, scopes, services) {
  const sKey = scopeKey(scopes);
  const svcKey = servicesKey(services);
  return templates.thirdParty.find((t) => scopeKey(t.scopes) === sKey && servicesKey(t.services) === svcKey);
}

let discoveryCache = { data: null, timestamp: 0 };
const DISCOVERY_CACHE_MS = 30000; // 30s - long enough to avoid hammering the API on rapid form clicks, short enough that a newly-added template shows up almost immediately.

async function discoverTemplates(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && discoveryCache.data && now - discoveryCache.timestamp < DISCOVERY_CACHE_MS) {
    return discoveryCache.data;
  }

  const [aumWs, tpWs] = await Promise.all([
    ss('GET', `/workspaces/${AUM_WORKSPACE_ID}`),
    ss('GET', `/workspaces/${THIRD_PARTY_WORKSPACE_ID}`),
  ]);

  const aum = {};
  for (const sheet of aumWs.sheets || []) {
    const name = sheet.name;
    if (/public space.*full/i.test(name)) aum.PUBLIC_FULL = { sheetId: sheet.id, sheetName: name };
    else if (/public space.*select/i.test(name)) aum.PUBLIC_SELECT = { sheetId: sheet.id, sheetName: name };
    else if (/guestroom/i.test(name)) aum.GUESTROOM = { sheetId: sheet.id, sheetName: name };
    else if (/model room/i.test(name)) aum.MODEL_ROOM = { sheetId: sheet.id, sheetName: name };
  }

  const thirdParty = [];
  const unrecognized = [];
  for (const sheet of tpWs.sheets || []) {
    const parsed = parseThirdPartyTemplateName(sheet.name);
    if (parsed) {
      thirdParty.push({ scopes: parsed.scopes, services: parsed.services, sheetId: sheet.id, sheetName: sheet.name });
    } else {
      unrecognized.push(sheet.name);
    }
  }

  const data = {
    aum,
    thirdParty,
    unrecognized, // sheet names in the workspace that didn't match the naming convention - surfaced on the status page, not used
    defaultDestination: DEFAULT_DESTINATION,
    generationLogSheetId: GENERATION_LOG_SHEET_ID,
    discoveredAt: new Date(now).toISOString(),
  };
  discoveryCache = { data, timestamp: now };
  return data;
}

// ---------------------------------------------------------------------------
// Smartsheet API helper
// ---------------------------------------------------------------------------
async function ss(method, urlPath, body) {
  if (!TOKEN) {
    throw new Error('No Smartsheet API token configured. Set SMARTSHEET_API_TOKEN and restart.');
  }
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.message || res.statusText;
    const extra = json?.detail ? ` — detail: ${JSON.stringify(json.detail)}` : '';
    const code = json?.errorCode ? ` (errorCode ${json.errorCode})` : '';
    const err = new Error(`Smartsheet API error (${res.status})${code}: ${msg}${extra}`);
    err.smartsheet = json;
    throw err;
  }
  return json;
}

async function deleteRowsBatched(sheetId, rowIds) {
  const ids = [...new Set(rowIds)].filter(Boolean);
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    await ss('DELETE', `/sheets/${sheetId}/rows?ids=${batch.join(',')}`);
  }
}

function findColumnId(columns, matcher) {
  const col = columns.find((c) => matcher.test(c.title));
  return col ? col.id : null;
}

function findPrimaryColumnId(columns) {
  const primary = columns.find((c) => c.primary);
  if (primary) return primary.id;
  return findColumnId(columns, /stage|primary column/i);
}

function cellText(row, columnId) {
  const cell = row.cells.find((c) => c.columnId === columnId);
  if (!cell) return '';
  return (cell.displayValue ?? cell.value ?? '').toString();
}

function rowSpanMs(row, startColId, endColId) {
  const start = cellText(row, startColId);
  const end = cellText(row, endColId);
  const startMs = start ? Date.parse(start) : NaN;
  const endMs = end ? Date.parse(end) : NaN;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  return endMs - startMs;
}

// True anchor: the leaf-level row (no children) that has no Predecessor
// value at all - the one genuinely independent starting point of the whole
// schedule, whatever it happens to be named. Verified against real template
// data across multiple service combinations: exactly one such row exists in
// each well-formed template (Arch SD when Architecture is included, Concept
// when it isn't, Pre-Bid Meeting for PM-only, etc.) - so this single generic
// rule replaces name-specific guessing entirely. Parent/summary rows are
// excluded since their dates are calculated rollups from children, not real
// predecessor-free starting points, even though they also show no
// Predecessor value. Blank spacer rows (no task name at all - some templates
// have a handful of these that don't show up consistently when reading the
// sheet) are also excluded - they have no predecessor and no children either,
// but they're not real tasks and should never receive a date. Read-only,
// used for the live date-preview endpoint.
function findIndependentLeafRows(rows, primaryColId, predColId) {
  const childrenOf = new Set();
  for (const r of rows) {
    if (r.parentId) childrenOf.add(r.parentId);
  }
  function hasPredecessor(row) {
    if (!predColId) return false;
    const cell = row.cells.find((c) => c.columnId === predColId);
    return Boolean(cell && (cell.value ?? '') !== '');
  }
  return rows.filter(
    (r) => !childrenOf.has(r.id) && !hasPredecessor(r) && cellText(r, primaryColId).trim() !== ''
  );
}

// ---------------------------------------------------------------------------
// Core generation logic
// ---------------------------------------------------------------------------
async function generateSchedule({ scopes, projectType, services, projectName, location, startDate, destination, templates }) {
  let template;
  if (projectType === 'AUM') {
    template = templates.aum[scopes[0]];
    if (!template || !template.sheetId) throw new Error(`Unknown scope: ${scopes[0]}`);
  } else {
    template = findThirdPartyTemplate(templates, scopes, services);
    if (!template || !template.sheetId) {
      throw new Error(
        'Unsupported schedule combination selected, please reach out to the Project Analyst for custom schedule.'
      );
    }
  }

  const newName = projectName;
  const dest = destination && destination.type ? destination : templates.defaultDestination;

  // 1. Copy the template sheet. include=data is required - without it
  //    Smartsheet copies an empty shell, no rows.
  const copyBody = { newName };
  copyBody.destinationType = dest.type === 'folder' ? 'folder' : dest.type === 'workspace' ? 'workspace' : 'home';
  if (dest.id) copyBody.destinationId = dest.id;

  const copyRes = await ss('POST', `/sheets/${template.sheetId}/copy?include=data`, copyBody);
  const newSheetId = copyRes.result?.id;
  if (!newSheetId) throw new Error('Smartsheet did not return a new sheet ID from the copy operation.');

  // 2. Fetch the full new sheet.
  const sheet = await ss('GET', `/sheets/${newSheetId}`);
  const columns = sheet.columns;
  const primaryColId = findPrimaryColumnId(columns);
  const startColId = findColumnId(columns, /start date/i);
  const predColId = findColumnId(columns, /predecessors/i);
  if (!primaryColId || !startColId) {
    throw new Error('Could not find the expected task-name / "Start Date" columns on the copied sheet.');
  }

  const rows = sheet.rows;
  if (!rows || rows.length === 0) {
    throw new Error('The copied sheet came back with no rows - the Copy Sheet call may be missing include=data.');
  }
  const rowById = new Map(rows.map((r) => [r.id, r]));

  // 3. Clear the Notes/Comments column on every row - keep the column, drop
  //    the content that came over from the template. Non-fatal: this is
  //    cosmetic cleanup, and a failure here should never block the actual
  //    date-setting step that follows.
  const notesColId = findColumnId(columns, /notes|comments/i);
  if (notesColId) {
    try {
      const rowsWithNotes = rows.filter((r) => r.cells.some((c) => c.columnId === notesColId && (c.value ?? '') !== ''));
      const CLEAR_BATCH = 400;
      for (let i = 0; i < rowsWithNotes.length; i += CLEAR_BATCH) {
        const batch = rowsWithNotes.slice(i, i + CLEAR_BATCH).map((r) => ({
          id: r.id,
          cells: [{ columnId: notesColId, value: '' }],
        }));
        if (batch.length) await ss('PUT', `/sheets/${newSheetId}/rows`, batch);
      }
    } catch (err) {
      console.warn('Could not clear Notes/Comments column (non-fatal):', err.message, JSON.stringify(err.smartsheet));
    }
  }

  // 5. Set the schedule's start date. The real anchor is the leaf-level row
  //    (no children) with no Predecessor value at all - the one genuinely
  //    independent starting point of the schedule, whatever it's named.
  //    Verified directly against real template data across multiple service
  //    combinations: this generic rule correctly finds "Arch SD" when
  //    Architecture is included, "Concept" when it isn't, "Pre-Bid Meeting"
  //    for PM-only, etc. - without needing to know any row names in advance.
  //    Setting it directly lets Smartsheet's own dependency engine cascade
  //    everything else automatically. If more than one independent leaf
  //    exists in the same sheet (e.g. Procurement-only templates combining
  //    multiple scopes, each with its own "Specs received" starting point),
  //    prefer the Model Room one if present - Guestroom/Public Space stay at
  //    their template defaults in that case, matching the established rule -
  //    otherwise set all of them.
  function ancestorScopeLabel(row) {
    let current = row;
    while (current && current.parentId) {
      const parent = rowById.get(current.parentId);
      if (!parent) break;
      const label = cellText(parent, primaryColId).trim();
      if (/guestroom/i.test(label)) return 'GUESTROOM';
      if (/public space/i.test(label)) return 'PUBLIC_SPACE';
      if (/model room/i.test(label)) return 'MODEL_ROOM';
      current = parent;
    }
    return null;
  }

  const independentLeaves = findIndependentLeafRows(rows, primaryColId, predColId);
  let targets;
  if (independentLeaves.length <= 1) {
    targets = independentLeaves;
  } else {
    const modelRoomOnes = independentLeaves.filter((r) => ancestorScopeLabel(r) === 'MODEL_ROOM');
    targets = modelRoomOnes.length ? modelRoomOnes : independentLeaves;
  }
  if (!targets.length) {
    throw new Error('Could not find any independent (predecessor-free) row to set the start date on this template.');
  }

  const dateUpdates = targets.map((r) => ({ id: r.id, cells: [{ columnId: startColId, value: startDate }] }));
  let succeededCount = 0;
  const failures = [];
  for (const update of dateUpdates) {
    try {
      await ss('PUT', `/sheets/${newSheetId}/rows`, [update]);
      succeededCount++;
    } catch (err) {
      // A row that looked like an independent leaf but turned out to be a
      // calculated parent/rollup (or some other edge case) shouldn't take
      // down the whole generation if at least one other target succeeds -
      // log it and keep going.
      console.warn('Date update failed for one target row, continuing:', JSON.stringify(update));
      console.warn('Smartsheet detail:', JSON.stringify(err.smartsheet));
      failures.push(err);
    }
  }
  if (succeededCount === 0 && failures.length) {
    throw failures[0];
  }

  // 6. Record Location and the start date as Sheet Summary fields.
  const dateFieldTitle = projectType === 'AUM' ? 'Construction Start Date' : 'Project Start Date';
  try {
    const createRes = await ss('POST', `/sheets/${newSheetId}/summary/fields`, [
      { title: 'Location', type: 'TEXT_NUMBER' },
      { title: dateFieldTitle, type: 'DATE' },
    ]);
    const created = createRes.result || [];
    const locField = created.find((f) => f.title === 'Location');
    const dateField = created.find((f) => f.title === dateFieldTitle);
    const updates = [];
    if (locField && location) updates.push({ id: locField.id, objectValue: location });
    if (dateField) updates.push({ id: dateField.id, objectValue: startDate });
    if (updates.length) await ss('PUT', `/sheets/${newSheetId}/summary/fields`, updates);
  } catch (err) {
    console.warn('Could not set Sheet Summary fields:', err.message);
  }

  const final = await ss('GET', `/sheets/${newSheetId}?include=permalink`);
  return { sheetId: newSheetId, name: newName, permalink: final.permalink || copyRes.result?.permalink };
}

// ---------------------------------------------------------------------------
// Generation log
// ---------------------------------------------------------------------------
async function appendGenerationLog(entry) {
  if (!GENERATION_LOG_SHEET_ID) return { ok: false, reason: 'No Generation Log sheet configured.' };

  const sheet = await ss('GET', `/sheets/${GENERATION_LOG_SHEET_ID}`);
  const columns = sheet.columns;
  const numberColId = findColumnId(columns, /^#$/);
  const dateColId = findColumnId(columns, /^date$/i);
  const generatorColId = findColumnId(columns, /^generator$/i);
  const projectNameColId = findColumnId(columns, /^project name$/i);
  const typeColId = findColumnId(columns, /aum or 3p/i);
  const scopeColId = findColumnId(columns, /^scope$/i);
  const servicesColId = findColumnId(columns, /services rendered/i);
  const startColId = findColumnId(columns, /construction start.*start date/i);

  const nextNumber = (sheet.rows || []).length + 1;
  const todayStr = new Date().toISOString().slice(0, 10);

  const cells = [];
  if (numberColId) cells.push({ columnId: numberColId, value: nextNumber });
  if (dateColId) cells.push({ columnId: dateColId, value: todayStr });
  if (generatorColId) cells.push({ columnId: generatorColId, value: entry.generatedBy });
  if (projectNameColId) cells.push({ columnId: projectNameColId, value: entry.projectName });
  if (typeColId) cells.push({ columnId: typeColId, value: entry.typeLabel });
  if (scopeColId) cells.push({ columnId: scopeColId, value: entry.scopeLabel });
  if (servicesColId) cells.push({ columnId: servicesColId, value: entry.servicesLabel });
  if (startColId) cells.push({ columnId: startColId, value: entry.startDate });

  await ss('POST', `/sheets/${GENERATION_LOG_SHEET_ID}/rows`, [{ toBottom: true, cells }]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Optional shared-password gate for the whole app.
const APP_PASSWORD = process.env.APP_PASSWORD;
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const match = header.match(/^Basic (.+)$/);
    if (match) {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const password = decoded.split(':').slice(1).join(':');
      if (password === APP_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Renovation Schedule Tool"');
    res.status(401).send('Password required to access this app.');
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
app.get('/', (req, res, next) => {
  if (fs.existsSync(INDEX_HTML_PATH)) return next();
  res.status(500).send(`
    <div style="font-family: sans-serif; max-width: 640px; margin: 60px auto; line-height: 1.6;">
      <h2>Setup problem: public/index.html not found</h2>
      <p>Check that your repository's <code>public</code> folder contains <code>index.html</code>
      and <code>admin.html</code> directly - not nested inside another folder.</p>
    </div>
  `);
});

app.get('/api/status', (req, res) => {
  res.json({ tokenConfigured: Boolean(TOKEN) });
});

// Live-discovered template list - what the generator form checks against,
// and what the status page displays. No config file involved.
app.get('/api/templates', async (req, res) => {
  try {
    const templates = await discoverTemplates(req.query.refresh === '1');
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.smartsheet });
  }
});

// Estimate a date without writing anything to Smartsheet.
app.post('/api/estimate', async (req, res) => {
  try {
    const { projectType, scopes, services, startDate } = req.body;
    if (!projectType || !Array.isArray(scopes) || scopes.length === 0 || !startDate) {
      return res.status(400).json({ error: 'projectType, scopes, and startDate are required.' });
    }

    const templates = await discoverTemplates();
    let sheetId;
    if (projectType === 'AUM') {
      const template = templates.aum[scopes[0]];
      if (!template) return res.status(400).json({ error: 'No matching AUM template for this scope.' });
      sheetId = template.sheetId;
    } else {
      const template = findThirdPartyTemplate(templates, scopes, services || []);
      if (!template) return res.status(400).json({ error: 'No matching template for this combination yet.' });
      sheetId = template.sheetId;
    }

    const sheet = await ss('GET', `/sheets/${sheetId}`);
    const columns = sheet.columns;
    const primaryColId = findPrimaryColumnId(columns);
    const startColId = findColumnId(columns, /start date/i);
    const endColId = findColumnId(columns, /end date/i);
    const predColId = findColumnId(columns, /predecessors/i);
    const rows = sheet.rows || [];
    if (!primaryColId || !startColId || !endColId || rows.length === 0) {
      return res.status(400).json({ error: 'Could not read this template to estimate a date.' });
    }

    const independentLeaves = findIndependentLeafRows(rows, primaryColId, predColId);
    if (!independentLeaves.length) {
      return res.status(400).json({ error: 'Could not find an anchor row on this template.' });
    }
    // Pick whichever independent row starts earliest - that best represents
    // the true beginning of the project (this is the row the actual
    // generation writes the input date onto).
    const anchorRow = independentLeaves.reduce((earliest, r) => {
      const t = Date.parse(cellText(r, startColId));
      const eT = Date.parse(cellText(earliest, startColId));
      return !Number.isNaN(t) && t < eT ? r : earliest;
    }, independentLeaves[0]);
    const anchorOriginalStartMs = Date.parse(cellText(anchorRow, startColId));
    if (Number.isNaN(anchorOriginalStartMs)) {
      return res.status(400).json({ error: 'Could not compute dates from this template.' });
    }
    const inputMs = Date.parse(startDate);
    function estimateFromOffset(originalMs) {
      if (Number.isNaN(originalMs)) return null;
      return new Date(inputMs + (originalMs - anchorOriginalStartMs)).toISOString().slice(0, 10);
    }

    const estimates = [];

    if (projectType === 'AUM') {
      // Show the real Arch SD date (may be well before or after the input,
      // depending on the template's actual predecessor chain - not simply
      // equal to the input) and the Construction row's end date.
      const archSdRow = rows.find((r) => cellText(r, primaryColId).trim().toLowerCase() === 'arch sd');
      if (archSdRow) {
        const d = estimateFromOffset(Date.parse(cellText(archSdRow, startColId)));
        if (d) estimates.push({ label: 'Estimated project start date (Arch SD)', date: d });
      }
      const constructionRow = rows.find((r) => cellText(r, primaryColId).trim().toLowerCase() === 'construction');
      if (constructionRow) {
        const d = estimateFromOffset(Date.parse(cellText(constructionRow, endColId)));
        if (d) estimates.push({ label: 'Estimated construction complete date', date: d });
      }
      if (!estimates.length) {
        // Fall back to at least showing something rather than nothing.
        estimates.push({ label: 'Estimated project start date', date: startDate });
      }
    } else {
      let maxEndMs = -Infinity;
      for (const r of rows) {
        const endMs = Date.parse(cellText(r, endColId));
        if (!Number.isNaN(endMs) && endMs > maxEndMs) maxEndMs = endMs;
      }
      const d = estimateFromOffset(maxEndMs);
      if (d) estimates.push({ label: 'Estimated completion date', date: d });
    }

    res.json({ estimates });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.smartsheet });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { scopes, projectType, services, projectName, generatedBy, location, startDate, destination } = req.body;
    const templates = await discoverTemplates();

    if (!projectType || !['THIRD_PARTY', 'AUM'].includes(projectType)) {
      return res.status(400).json({ error: 'Invalid or missing projectType.' });
    }
    if (!Array.isArray(scopes) || scopes.length === 0) {
      return res.status(400).json({ error: 'Select at least one scope of renovation.' });
    }
    if (projectType === 'AUM' && scopes.length !== 1) {
      return res.status(400).json({ error: 'AUM projects use a single scope.' });
    }
    if (projectType === 'AUM' && !templates.aum[scopes[0]]) {
      return res.status(400).json({ error: 'Invalid scope for an AUM project.' });
    }
    if (projectType === 'THIRD_PARTY') {
      const invalid = scopes.find((s) => !THIRD_PARTY_SCOPES.includes(s));
      if (invalid) return res.status(400).json({ error: `Invalid scope for a Third Party project: ${invalid}` });
      if (!findThirdPartyTemplate(templates, scopes, services || [])) {
        return res.status(400).json({
          error: 'Unsupported schedule combination selected, please reach out to the Project Analyst for custom schedule.',
        });
      }
    }
    if (!projectName || !projectName.trim()) return res.status(400).json({ error: 'Project name is required.' });
    if (!generatedBy || !generatedBy.trim()) return res.status(400).json({ error: 'Your name is required.' });
    if (!startDate) return res.status(400).json({ error: 'Start date is required.' });
    if (projectType === 'THIRD_PARTY' && (!Array.isArray(services) || services.length === 0)) {
      return res.status(400).json({ error: 'Select at least one service for a Third Party project.' });
    }

    const dest = destination && destination.type ? destination : templates.defaultDestination;

    const result = await generateSchedule({
      scopes,
      projectType,
      services: services || [],
      projectName: projectName.trim(),
      location: (location || '').trim(),
      startDate,
      destination: dest,
      templates,
    });

    try {
      const scopeLabel = scopes.map((s) => SCOPE_LABELS[s] || s).join(', ');
      const servicesLabel = projectType === 'AUM' ? ALL_SERVICES.join(', ') : (services || []).join(', ');
      const logResult = await appendGenerationLog({
        generatedBy: generatedBy.trim(),
        projectName: projectName.trim(),
        typeLabel: projectType === 'AUM' ? 'AUM' : '3P',
        scopeLabel,
        servicesLabel,
        startDate,
      });
      result.logStatus = logResult;
    } catch (logErr) {
      console.warn('Generation log append failed:', logErr.message);
      result.logStatus = { ok: false, reason: logErr.message };
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, detail: err.smartsheet });
  }
});

app.listen(PORT, () => {
  console.log(`\nRenovation Schedule Tool running at http://localhost:${PORT}\n`);
  if (!TOKEN) {
    console.warn('WARNING: SMARTSHEET_API_TOKEN is not set.\n');
  }
});
