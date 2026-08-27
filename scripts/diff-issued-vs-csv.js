#!/usr/bin/env node
/**
 * Diff helper: compares issued-badges.json against a CSV file and outputs differences.
 * Usage:
 *   node scripts/diff-issued-vs-csv.js <csv-file> [--state issued-badges.json] [--template <id>] [--json]
 *   node scripts/diff-issued-vs-csv.js --help
 *
 * Supports two CSV dialects (auto-detected):
 *   1) Credly export: header contains "Badge Template ID" and "Recipient Email"
 *   2) Source recipients: header contains "Email" (First Name, Last Name, GitHub ID, Email, Squad, Role)
 *      -> requires --template <badgeTemplateId> to form the dedupe key, or uses the first --template found.
 *
 * Output (stdout):
 *   - Count summary
 *   - "Only in CSV (would be issued next run)" : present in CSV but not in state
 *   - "Only in state (not in CSV)" : present in state but not in CSV
 *   All emails lowercased, trimmed. Handles BOM, CRLF, RFC 4180 quoting.
 *   --json prints machine-readable { onlyInCsv, onlyInState, inBoth } as JSON.
 */
import fs from 'node:fs/promises';

const DEFAULT_STATE = 'issued-badges.json';

function printHelp() {
  console.log(`Usage: node scripts/diff-issued-vs-csv.js <csv-file> [options]
Options:
  --state <path>      Path to issued-badges.json (default: ${DEFAULT_STATE})
  --template <id>     Badge template ID for source CSVs (required if CSV lacks Badge Template ID column)
  --json              Output JSON instead of human-readable
  --help, -h          Show this help

Examples:
  # Credly export vs state
  node scripts/diff-issued-vs-csv.js ~/Downloads/credly-export.csv

  # Source recipients CSV vs state (single template)
  node scripts/diff-issued-vs-csv.js badges/recipients.csv --template abc-123-def

  # Custom state path
  node scripts/diff-issued-vs-csv.js source.csv --state ./my-state.json --template xyz`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printHelp();
    process.exit(args.length === 0 ? 1 : 0);
  }
  let csvPath = null;
  let statePath = DEFAULT_STATE;
  let templateId = null;
  let jsonOut = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--state') statePath = args[++i];
    else if (a === '--template') templateId = args[++i];
    else if (a === '--json') jsonOut = true;
    else if (!a.startsWith('--') && !csvPath) csvPath = a;
    else {
      console.error(`Unknown arg: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  if (!csvPath) {
    console.error('Missing <csv-file>');
    printHelp();
    process.exit(1);
  }
  return { csvPath, statePath, templateId, jsonOut };
}

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"' && field === '') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.map(r => r.map(f => f.trim())).filter(r => r.length && !r.every(f => f === ''));
}

async function loadState(statePath) {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new SyntaxError('State is not an array');
    return parsed;
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(`[diff] state not found: ${statePath} (treating as empty)`);
      return [];
    }
    throw e;
  }
}

async function main() {
  const { csvPath, statePath, templateId, jsonOut } = parseArgs();

  const state = await loadState(statePath);
  const stateKeys = new Set();
  const stateMap = new Map(); // key -> record
  for (const r of state) {
    if (!r.email || !r.badgeTemplateId) continue;
    const key = `${String(r.email).toLowerCase().trim()}|${r.badgeTemplateId}`;
    stateKeys.add(key);
    stateMap.set(key, r);
  }

  let csvRaw;
  try {
    csvRaw = await fs.readFile(csvPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(`[diff] CSV not found: ${csvPath}`);
      process.exit(1);
    }
    throw e;
  }

  const rows = parseCSV(csvRaw);
  if (rows.length === 0) {
    console.error(`[diff] empty CSV: ${csvPath}`);
    process.exit(1);
  }

  const header = rows[0].map(h => h.toLowerCase());
  const hasCredlyCols = header.includes('badge template id') && header.includes('recipient email');
  const hasSourceCols = header.includes('email') && header.includes('first name');

  let csvKeys = new Set();
  let csvMap = new Map(); // key -> {email, badgeTemplateId, line}
  let skipped = 0;

  // Check for per-row Badge Template ID column (Option B)
  const badgeIdx = header.indexOf('badge template id');
  const hasPerRowBadge = badgeIdx !== -1;

  if (hasCredlyCols) {
    const tmplIdx = header.indexOf('badge template id');
    const emailIdx = header.indexOf('recipient email');
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length <= Math.max(tmplIdx, emailIdx)) { skipped++; continue; }
      const tmpl = row[tmplIdx].trim();
      const emailRaw = row[emailIdx].trim();
      const email = emailRaw.toLowerCase();
      if (!tmpl || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }
      const key = `${email}|${tmpl}`;
      if (!csvKeys.has(key)) {
        csvKeys.add(key);
        csvMap.set(key, { email, badgeTemplateId: tmpl, line: i + 1 });
      }
    }
    if (templateId) console.warn(`[diff] --template ignored for Credly export (template from CSV column)`);
  } else if (hasSourceCols || hasPerRowBadge) {
    // Source CSV may have per-row badge column (Option B): Recipient Email,...,Badge Template ID
    // If per-row badge exists, use it per row; else require --template
    if (!hasPerRowBadge && !templateId) {
      console.error(`[diff] source CSV detected (First Name, Email, ...) but --template <id> is required`);
      console.error('Example: node scripts/diff-issued-vs-csv.js badges/recipients.csv --template abc-123-def');
      console.error('Or add Badge Template ID column to CSV for per-row badges');
      process.exit(1);
    }
    // Determine column indices based on header dialect
    let emailIdx, firstNameIdx, lastNameIdx;
    if (header[0] === 'recipient email') {
      // CONTRIBUTORS: Recipient Email,Issued To First Name,Issued To Middle Name,Issued To Last Name
      emailIdx = header.indexOf('recipient email');
      firstNameIdx = header.indexOf('issued to first name');
      lastNameIdx = header.indexOf('issued to last name');
    } else if (header.includes('name') && header.includes('email') && !header.includes('first name')) {
      // Name,Email,GitHub ID
      emailIdx = header.indexOf('email');
      firstNameIdx = header.indexOf('name');
      lastNameIdx = -1; // split Name
    } else {
      // Spec: First Name, Last Name, GitHub ID, Email
      emailIdx = 3; firstNameIdx = 0; lastNameIdx = 1;
      if (header.indexOf('email') !== -1) emailIdx = header.indexOf('email');
      if (header.indexOf('first name') !== -1) firstNameIdx = header.indexOf('first name');
      if (header.indexOf('last name') !== -1) lastNameIdx = header.indexOf('last name');
    }
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // Use per-row badge if column exists, else --template
      let tmpl = templateId;
      if (hasPerRowBadge && row.length > badgeIdx && row[badgeIdx].trim()) tmpl = row[badgeIdx].trim();
      if (!tmpl) { skipped++; continue; }
      // Extract email/first/last based on dialect
      let emailRaw, firstName, lastName;
      if (emailIdx === 0 && firstNameIdx === 1) { // contributors
        if (row.length < 4) { skipped++; continue; }
        emailRaw = row[emailIdx] ? row[emailIdx].trim() : '';
        firstName = row[firstNameIdx] ? row[firstNameIdx].trim() : '';
        lastName = row[lastNameIdx] ? row[lastNameIdx].trim() : '';
      } else if (firstNameIdx === header.indexOf('name') && emailIdx === header.indexOf('email')) {
        if (row.length < 2) { skipped++; continue; }
        const name = row[firstNameIdx] ? row[firstNameIdx].trim() : '';
        const parts = name.split(/\s+/);
        firstName = parts[0] || '';
        lastName = parts.slice(1).join(' ') || '';
        emailRaw = row[emailIdx] ? row[emailIdx].trim() : '';
      } else {
        if (row.length < 4) { skipped++; continue; }
        emailRaw = row[emailIdx] ? row[emailIdx].trim() : '';
        firstName = row[firstNameIdx] ? row[firstNameIdx].trim() : '';
        lastName = row[lastNameIdx] ? row[lastNameIdx].trim() : '';
      }
      const email = emailRaw.toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }
      if (!firstName || !lastName) { skipped++; continue; }
      const key = `${email}|${tmpl}`;
      if (!csvKeys.has(key)) {
        csvKeys.add(key);
        csvMap.set(key, { email, badgeTemplateId: tmpl, line: i + 1 });
      }
    }
  } else {
    // Fallback: try to find any email column
    const emailIdx = header.findIndex(h => h === 'email' || h.includes('recipient email'));
    const tmplIdx = header.indexOf('badge template id');
    if (emailIdx === -1) {
      console.error(`[diff] unrecognized CSV header: ${rows[0].join(', ')}`);
      console.error('Expected Credly (Badge Template ID, Recipient Email) or source (First Name, Last Name, GitHub ID, Email)');
      process.exit(1);
    }
    const effectiveTmplIdx = tmplIdx !== -1 ? tmplIdx : null;
    if (effectiveTmplIdx === null && !templateId) {
      console.error(`[diff] no Badge Template ID column and no --template provided`);
      process.exit(1);
    }
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const emailRaw = (row[emailIdx] || '').trim();
      const email = emailRaw.toLowerCase();
      const tmpl = effectiveTmplIdx !== null ? (row[effectiveTmplIdx] || '').trim() : templateId;
      if (!email || !tmpl || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }
      const key = `${email}|${tmpl}`;
      if (!csvKeys.has(key)) {
        csvKeys.add(key);
        csvMap.set(key, { email, badgeTemplateId: tmpl, line: i + 1 });
      }
    }
  }

  const onlyInCsv = [...csvKeys].filter(k => !stateKeys.has(k));
  const onlyInState = [...stateKeys].filter(k => !csvKeys.has(k));
  const inBoth = [...csvKeys].filter(k => stateKeys.has(k));

  if (jsonOut) {
    const toObj = (keys, map) => keys.map(k => {
      const [email, badgeTemplateId] = k.split('|');
      return { email, badgeTemplateId };
    }).sort((a,b) => a.email.localeCompare(b.email) || a.badgeTemplateId.localeCompare(b.badgeTemplateId));
    console.log(JSON.stringify({
      csv: csvPath,
      state: statePath,
      counts: { csv: csvKeys.size, state: stateKeys.size, onlyInCsv: onlyInCsv.length, onlyInState: onlyInState.length, inBoth: inBoth.length, skipped },
      onlyInCsv: toObj(onlyInCsv, csvMap),
      onlyInState: onlyInState.map(k => stateMap.get(k)).sort((a,b) => a.email.localeCompare(b.email) || a.badgeTemplateId.localeCompare(b.badgeTemplateId)),
      inBoth: toObj(inBoth, csvMap),
    }, null, 2));
    return;
  }

  console.log(`CSV:   ${csvPath} (${csvKeys.size} unique email|template pairs, ${skipped} rows skipped)`);
  console.log(`State: ${statePath} (${stateKeys.size} records)`);
  console.log(`\nOnly in CSV (would be issued next run): ${onlyInCsv.length}`);
  if (onlyInCsv.length > 0) {
    for (const k of onlyInCsv.sort()) {
      const [email, tmpl] = k.split('|');
      console.log(`  + ${email} -> ${tmpl}`);
    }
  }
  console.log(`\nOnly in state (already issued, not in CSV): ${onlyInState.length}`);
  if (onlyInState.length > 0) {
    // Limit to 50 to avoid flooding
    const toShow = onlyInState.sort().slice(0, 50);
    for (const k of toShow) {
      const [email, tmpl] = k.split('|');
      console.log(`  - ${email} -> ${tmpl}`);
    }
    if (onlyInState.length > 50) console.log(`  ... and ${onlyInState.length - 50} more`);
  }
  console.log(`\nIn both: ${inBoth.length}`);
  if (skipped > 0) console.log(`(skipped ${skipped} malformed/invalid rows)`);
}

main().catch(e => {
  console.error(`[diff] fatal: ${e.stack || e.message}`);
  process.exit(1);
});
