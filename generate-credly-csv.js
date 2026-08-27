import fs from 'node:fs/promises';

const CONFIG_PATH = 'config.json';
const STATE_PATH = 'issued-badges.json';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  // Skip header row if first field is "First Name" case-insensitive
  if (trimmedRows.length > 0 && trimmedRows[0][0].toLowerCase() === 'first name') {
    trimmedRows.shift();
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
    for (let i = 0; i < config.sources.length; i++) {
      const s = config.sources[i];
      if (!s.repo || !s.path || !s.branch || !s.badgeTemplateId) {
        console.error(`[config] Invalid source at index ${i}: missing required field (repo, path, branch, badgeTemplateId)`);
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

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const lineNumber = idx + 2; // +1 for header, +1 for 1-indexed

      if (row.length < 4) {
        console.warn(`[validate] ${label}:${lineNumber} skipped - expected >=4 columns, got ${row.length}`);
        continue;
      }

      const firstName = row[0].trim();
      const lastName = row[1].trim();
      const emailRaw = row[3].trim();
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

      const key = `${email}|${source.badgeTemplateId}`;
      if (seenInRun.has(key)) {
        continue;
      }
      if (stateKeys.has(key)) {
        continue;
      }
      seenInRun.add(key);
      newRecipients.push({
        email,
        badgeTemplateId: source.badgeTemplateId,
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
