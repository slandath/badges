import fs from 'node:fs/promises';

const CONFIG_PATH = 'config.json';
const STATE_PATH = 'issued-badges.json';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class MissingHeadersError extends Error {
  constructor(label, missing, actualHeader) {
    super(`Missing required headers for ${label}: expected [${missing.join(', ')}], got [${actualHeader.join(', ')}]`);
    this.name = 'MissingHeadersError';
    this.label = label;
    this.missing = missing;
    this.actualHeader = actualHeader;
  }
}

function getHeaderColumns(csvText) {
  const text = csvText.replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('**')) continue;
    const lower = trimmed.toLowerCase();
    if (lower.includes('first name') || lower.includes('recipient email') || lower.includes('name,')) {
      // Parse this header line with RFC 4180 awareness for header
      const cols = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
          if (c === '"' && i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') inQ = false;
          else cur += c;
        } else {
          if (c === '"' && cur === '') inQ = true;
          else if (c === ',') { cols.push(cur.trim()); cur = ''; }
          else cur += c;
        }
      }
      cols.push(cur.trim());
      return cols;
    }
  }
  return null;
}

function validateHeaders(headerCols, dialect, perRowBadgeIdx, label, source) {
  if (!headerCols) {
    throw new MissingHeadersError(label, ['First Name or Recipient Email or Name'], []);
  }
  const lower = headerCols.map(c => c.toLowerCase());
  let required = [];
  if (dialect === 'contributors') {
    required = ['recipient email', 'issued to first name', 'issued to last name'];
  } else if (dialect === 'name-email') {
    required = ['name', 'email'];
  } else {
    required = ['first name', 'last name', 'email'];
  }
  const missing = required.filter(r => !lower.includes(r));
  if (missing.length > 0) {
    throw new MissingHeadersError(label, missing, headerCols);
  }
  // For multi-badge pools, per-row Badge Template ID header must be present if CSV intends per-row
  // If pools[repo] has multiple badges and file is expected to be per-row, enforce header
  // Currently we enforce per-row header only when perRowBadgeIdx is expected but missing for multi-badge repos
  // This check is done in main loop after detecting perRowBadgeIdx; if repo has multiple badges and wants per-row but header lacks badge column, throw
}

function escapeCsvField(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

function parseCSV(text) {
  // Strip BOM if present
  if (text.length > 0 && text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }
  // Normalize CRLF and lone CR to LF for consistent parsing
  // This converts CRLF inside quoted fields to LF, which is acceptable and preserves newline handling
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        if (field === '') {
          inQuotes = true;
        } else {
          // stray quote inside unquoted field, treat as literal
          field += c;
        }
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
  }

  // Handle last row if file doesn't end with newline
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Post-process: trim every field after unquoting, skip empty lines, skip header
  const trimmedRows = [];
  for (const r of rows) {
    const trimmed = r.map(f => f.trim());
    // Skip empty lines: all fields empty after trim
    const isEmpty = trimmed.length === 0 || trimmed.every(f => f === '');
    if (isEmpty) continue;
    trimmedRows.push(trimmed);
  }

  // Skip header row if first field is "First Name" or "Recipient Email" case-insensitive (supports both source and Credly-export-like headers)
  if (trimmedRows.length > 0) {
    const first = trimmedRows[0][0].toLowerCase();
    if (first === 'first name' || first === 'recipient email' || first === 'name') {
      trimmedRows.shift();
    }
  }

  return trimmedRows;
}

async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const config = JSON.parse(raw);
    if (!config || !Array.isArray(config.sources)) {
      console.error(`[config] Invalid config: expected { sources: [...] } in ${CONFIG_PATH}`);
      process.exit(1);
    }
    if (!config.pools || typeof config.pools !== 'object' || Array.isArray(config.pools)) {
      console.error(`[config] Invalid config: expected { pools: { "owner/repo": ["badge-id", ...] } } in ${CONFIG_PATH}`);
      process.exit(1);
    }
    for (let i = 0; i < config.sources.length; i++) {
      const s = config.sources[i];
      if (!s.repo || !s.path || !s.branch || !s.badgeTemplateId) {
        console.error(`[config] Invalid source at index ${i}: missing required field (repo, path, branch, badgeTemplateId)`);
        process.exit(1);
      }
      const pool = config.pools[s.repo];
      if (!pool) {
        console.error(`[config] Pool violation at index ${i}: repo "${s.repo}" not in pools (add pools["${s.repo}"] = ["${s.badgeTemplateId}", ...])`);
        process.exit(1);
      }
      if (!Array.isArray(pool) || !pool.includes(s.badgeTemplateId)) {
        console.error(`[config] Pool violation at index ${i}: badgeTemplateId "${s.badgeTemplateId}" for repo "${s.repo}" not in pools["${s.repo}"] = [${Array.isArray(pool) ? pool.map(id => `"${id}"`).join(', ') : String(pool)}]`);
        process.exit(1);
      }
    }
    // Validate pools entries are arrays of strings and warn on unused pools
    for (const [repo, ids] of Object.entries(config.pools)) {
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string' && id.trim())) {
        console.error(`[config] Invalid pools["${repo}"]: expected non-empty array of badgeTemplateId strings`);
        process.exit(1);
      }
    }
    return config;
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(`[config] Missing ${CONFIG_PATH}`);
    } else if (e instanceof SyntaxError) {
      console.error(`[config] Invalid JSON in ${CONFIG_PATH}: ${e.message}`);
    } else {
      console.error(`[config] Failed to load ${CONFIG_PATH}: ${e.message}`);
    }
    process.exit(1);
  }
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new SyntaxError('State file is not a JSON array');
      }
      return { records: parsed, raw };
    } catch (e) {
      if (e instanceof SyntaxError) {
        console.error(`[state] corrupt JSON in ${STATE_PATH}: ${e.message}`);
        const timestamp = new Date().toISOString();
        const backupPath = `${STATE_PATH}.bak.${timestamp}`;
        try {
          await fs.writeFile(backupPath, raw, 'utf8');
          console.error(`[state] backed up corrupt file to ${backupPath}`);
        } catch (writeErr) {
          console.error(`[state] failed to backup corrupt file: ${writeErr.message}`);
        }
        console.warn(`[state] treating ${STATE_PATH} as empty for this run`);
        return { records: [], raw: null };
      }
      throw e;
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(`[state] ${STATE_PATH} not found - treating as empty`);
      return { records: [], raw: null };
    }
    // If we already handled SyntaxError, rethrow won't happen here
    if (e instanceof SyntaxError) {
      throw e;
    }
    console.error(`[state] Failed to read ${STATE_PATH}: ${e.message}`);
    console.warn(`[state] treating ${STATE_PATH} as empty for this run`);
    return { records: [], raw: null };
  }
}

async function main() {
  const config = await loadConfig();
  const { records: stateRecords } = await loadState();

  const stateKeys = new Set();
  for (const r of stateRecords) {
    if (r.email && r.badgeTemplateId) {
      const key = `${String(r.email).toLowerCase().trim()}|${r.badgeTemplateId}`;
      stateKeys.add(key);
    }
  }

  const seenInRun = new Set();
  const newRecipients = [];
  let hasFetchError = false;
  const token = process.env.GH_TOKEN || process.env.BADGE_READ_TOKEN || process.env.GITHUB_TOKEN || '';

  for (const source of config.sources) {
    const label = `${source.repo}/${source.path}@${source.branch}`;
    const url = `https://raw.githubusercontent.com/${source.repo}/${source.branch}/${source.path}`;
    let csvText;
    try {
      const headers = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.error(`[fetch] Failed ${label}: ${res.status} ${res.statusText} (${url})`);
        hasFetchError = true;
        continue;
      }
      csvText = await res.text();
    } catch (e) {
      console.error(`[fetch] Network error ${label}: ${e.message} (${url})`);
      hasFetchError = true;
      continue;
    }

    const rows = parseCSV(csvText);

    // Detect dialect from header to support both spec and CONTRIBUTORS formats
    // Spec: First Name, Last Name, GitHub ID, Email, Squad, Role (email col 3)
    // CONTRIBUTORS: Recipient Email,Issued To First Name,Issued To Middle Name,Issued To Last Name (email col 0, first col 1, last col 3)
    // Alt COMMITTERS: Name,Email,GitHub ID,Role... (name col 0 -> split into first/last, email col 1)
    const csvLower = csvText.replace(/^\uFEFF/, '').toLowerCase();
    let dialect = 'spec'; // 'spec' | 'contributors' | 'name-email'
    if (csvLower.includes('recipient email')) dialect = 'contributors';
    else if (csvLower.includes('name,email') && !csvLower.includes('first name')) dialect = 'name-email';

    // Detect optional per-row Badge Template ID column (for Option B: one file with multiple badges)
    // If header contains "Badge Template ID", each row can specify its badge; otherwise uses sources[].badgeTemplateId
    let perRowBadgeIdx = -1;
    if (csvLower.includes('badge template id')) {
      const allLines = csvText.replace(/^\uFEFF/, '').split('\n');
      for (const line of allLines) {
        if (line.toLowerCase().includes('badge template id')) {
          const cols = [];
          let cur = '', inQ = false;
          for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (inQ) {
              if (c === '"' && i + 1 < line.length && line[i+1] === '"') { cur += '"'; i++; }
              else if (c === '"') inQ = false;
              else cur += c;
            } else {
              if (c === '"' && cur === '') inQ = true;
              else if (c === ',') { cols.push(cur); cur = ''; }
              else cur += c;
            }
          }
          cols.push(cur);
          perRowBadgeIdx = cols.findIndex(c => c.trim().toLowerCase() === 'badge template id');
          break;
        }
      }
    }

    // Validate required headers for the detected dialect (throws MissingHeadersError)
    const headerCols = getHeaderColumns(csvText);
    try {
      validateHeaders(headerCols, dialect, perRowBadgeIdx, label, source);
      // For multi-badge pools where per-row is expected, ensure Badge Template ID header is present
      const poolSize = config.pools[source.repo]?.length || 0;
      if (poolSize > 1 && perRowBadgeIdx === -1) {
        // Check if this source is intended to be per-row (heuristic: CSV already has per-row column missing but pool has multiple)
        // For per-file multi-badge (multiple sources sharing repo), this is valid - each file maps to one badge via fallback, so no error
        // Only throw if the CSV itself contains multiple distinct per-row badges expected but header lacks column
        // We do not throw here; fallback will be used. If you want strict per-row for this repo, add Badge Template ID column to CSV
      }
    } catch (e) {
      if (e instanceof MissingHeadersError) {
        console.error(`[header] ${e.message} (${label})`);
        hasFetchError = true;
        continue;
      }
      throw e;
    }

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const lineNumber = idx + 2; // +1 for header, +1 for 1-indexed

      let firstName, lastName, emailRaw;

      if (dialect === 'contributors') {
        if (row.length < 4) {
          console.warn(`[validate] ${label}:${lineNumber} skipped - expected >=4 columns, got ${row.length}`);
          continue;
        }
        emailRaw = row[0].trim();
        firstName = row[1].trim();
        lastName = row[3].trim();
      } else if (dialect === 'name-email') {
        if (row.length < 2) {
          console.warn(`[validate] ${label}:${lineNumber} skipped - expected >=2 columns, got ${row.length}`);
          continue;
        }
        const name = row[0].trim();
        emailRaw = row[1].trim();
        // Split full Name into first/last: first token is first name, rest is last name
        const nameParts = name.split(/\s+/);
        firstName = nameParts[0] || '';
        lastName = nameParts.slice(1).join(' ') || '';
        // If Name was empty, fall back to GitHub ID? No, require first/last
      } else {
        if (row.length < 4) {
          console.warn(`[validate] ${label}:${lineNumber} skipped - expected >=4 columns, got ${row.length}`);
          continue;
        }
        firstName = row[0].trim();
        lastName = row[1].trim();
        emailRaw = row[3].trim();
      }
      const email = emailRaw.toLowerCase();

      if (!firstName) {
        console.warn(`[validate] ${label}:${lineNumber} skipped - First Name is empty`);
        continue;
      }
      if (!lastName) {
        console.warn(`[validate] ${label}:${lineNumber} skipped - Last Name is empty`);
        continue;
      }
      if (!EMAIL_REGEX.test(email)) {
        console.warn(`[validate] ${label}:${lineNumber} skipped - invalid email "${emailRaw}"`);
        continue;
      }

      // Per-row badge (Option B): if CSV has Badge Template ID column, per-row is required - no default
      // For sub-projects with multiple badges, each row must specify its badge; otherwise throw (skip) error
      let badgeTemplateId;
      if (perRowBadgeIdx !== -1) {
        const perRowVal = row.length > perRowBadgeIdx ? row[perRowBadgeIdx].trim() : '';
        if (!perRowVal) {
          console.warn(`[validate] ${label}:${lineNumber} skipped - Badge Template ID not specified per row (repo "${source.repo}" has multiple badges, no default)`);
          continue;
        }
        badgeTemplateId = perRowVal;
      } else {
        badgeTemplateId = source.badgeTemplateId;
      }
      // Validate badge is in repo's pool
      const pool = config.pools[source.repo];
      if (!pool.includes(badgeTemplateId)) {
        console.warn(`[validate] ${label}:${lineNumber} skipped - badgeTemplateId "${badgeTemplateId}" not in pools["${source.repo}"]`);
        continue;
      }

      const key = `${email}|${badgeTemplateId}`;
      if (seenInRun.has(key)) {
        continue;
      }
      if (stateKeys.has(key)) {
        continue;
      }
      seenInRun.add(key);
      newRecipients.push({
        email,
        badgeTemplateId,
        firstName,
        lastName,
      });
    }
  }

  // Summary logging
  if (newRecipients.length === 0) {
    console.log('No new recipients');
    if (hasFetchError) process.exitCode = 1;
    return;
  }

  console.log(`New recipients: ${newRecipients.length}`);
  for (const r of newRecipients) {
    console.log(`${r.email} -> ${r.badgeTemplateId}`);
  }

  const issuedAt = new Date().toISOString().slice(0, 10);
  const csvHeader = 'Badge Template ID,Recipient Email,Issued To First Name,Issued To Middle Name,Issued To Last Name,Issued At';
  const csvLines = [csvHeader];
  for (const r of newRecipients) {
    const cols = [
      escapeCsvField(r.badgeTemplateId),
      escapeCsvField(r.email),
      escapeCsvField(r.firstName),
      escapeCsvField(''), // Middle Name always empty
      escapeCsvField(r.lastName),
      escapeCsvField(issuedAt),
    ];
    csvLines.push(cols.join(','));
  }
  const csvContent = csvLines.join('\n') + '\n';
  const csvPath = `credly-${issuedAt}.csv`;

  await fs.writeFile(csvPath, csvContent, 'utf8');
  console.log(`Wrote ${csvPath}`);

  // Update state: append new records
  const newStateRecords = newRecipients.map(r => ({
    email: r.email,
    badgeTemplateId: r.badgeTemplateId,
    issuedDate: issuedAt,
  }));
  const updatedState = [...stateRecords, ...newStateRecords];
  const stateContent = JSON.stringify(updatedState, null, 2) + '\n';
  await fs.writeFile(STATE_PATH, stateContent, 'utf8');
  console.log(`Updated ${STATE_PATH} with ${newStateRecords.length} new records`);

  if (hasFetchError) process.exitCode = 1;
}

main().catch(e => {
  console.error(`[fatal] ${e.stack || e.message}`);
  process.exit(1);
});
