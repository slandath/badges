#!/usr/bin/env node
/**
 * Seeding helper: converts a Credly export CSV into issued-badges.json
 * Usage:
 *   node scripts/seed-issued-badges.js [credly-export.csv] [issued-badges.json]
 *   node scripts/seed-issued-badges.js --help
 *
 * Handles BOM, CRLF, RFC 4180 quoted fields, header column detection,
 * whitespace trimming, and merges with existing state (backup + dedup).
 */
import fs from 'node:fs/promises';

const DEFAULT_INPUT = 'credly-export.csv';
const DEFAULT_OUTPUT = 'issued-badges.json';
const DEFAULT_DATE = new Date().toISOString().slice(0, 10);

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node scripts/seed-issued-badges.js [input.csv] [output.json] [--date YYYY-MM-DD]
  Defaults: input=${DEFAULT_INPUT} output=${DEFAULT_OUTPUT} date=${DEFAULT_DATE}
  Detects columns "Badge Template ID" and "Recipient Email" (case-insensitive) from header.`);
    process.exit(0);
  }
  let date = DEFAULT_DATE;
  const dateIdx = args.indexOf('--date');
  if (dateIdx !== -1) {
    date = args[dateIdx + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error('--date must be YYYY-MM-DD');
      process.exit(1);
    }
    args.splice(dateIdx, 2);
  }
  const input = args[0] || DEFAULT_INPUT;
  const output = args[1] || DEFAULT_OUTPUT;
  return { input, output, date };
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
  // trim after unquoting, skip empty lines
  return rows.map(r => r.map(f => f.trim())).filter(r => r.length && !r.every(f => f === ''));
}

async function main() {
  const { input, output, date } = parseArgs();

  let raw;
  try {
    raw = await fs.readFile(input, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(`[seed] input not found: ${input}`);
      process.exit(1);
    }
    throw e;
  }

  const rows = parseCSV(raw);
  if (rows.length === 0) {
    console.error(`[seed] empty file: ${input}`);
    process.exit(1);
  }

  const header = rows[0].map(h => h.toLowerCase());
  const templateIdx = header.indexOf('badge template id');
  const emailIdx = header.indexOf('recipient email');
  if (templateIdx === -1 || emailIdx === -1) {
    console.error(`[seed] header must contain "Badge Template ID" and "Recipient Email" (case-insensitive). Got: ${rows[0].join(', ')}`);
    console.error('Expected Credly export header, e.g., Badge Template ID,Recipient Email,Issued At,...');
    process.exit(1);
  }
  const startRow = 1;
  const seen = new Set();
  const records = [];
  let skipped = 0;

  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    const lineNum = i + 1;
    if (row.length <= Math.max(templateIdx, emailIdx)) {
      console.warn(`[seed] line ${lineNum} skipped: expected columns, got ${row.length}`);
      skipped++;
      continue;
    }
    const templateId = row[templateIdx].trim();
    const emailRaw = row[emailIdx].trim();
    const email = emailRaw.trim().toLowerCase();
    if (!templateId) {
      console.warn(`[seed] line ${lineNum} skipped: empty Badge Template ID`);
      skipped++;
      continue;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      console.warn(`[seed] line ${lineNum} skipped: invalid email "${emailRaw}"`);
      skipped++;
      continue;
    }
    const key = `${email}|${templateId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({ email, badgeTemplateId: templateId, issuedDate: date });
  }

  console.log(`[seed] parsed ${records.length} valid records from ${rows.length - 1} data rows (${skipped} skipped), date=${date}`);

  // Merge with existing state if present: backup + dedup
  let existing = [];
  let existingRaw = null;
  try {
    existingRaw = await fs.readFile(output, 'utf8');
    const parsed = JSON.parse(existingRaw);
    if (Array.isArray(parsed)) existing = parsed;
    else throw new SyntaxError('State is not an array');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log(`[seed] no existing ${output}, will create new`);
    } else if (e instanceof SyntaxError) {
      const bak = `${output}.bak.${new Date().toISOString()}`;
      await fs.writeFile(bak, existingRaw, 'utf8');
      console.warn(`[seed] existing ${output} is corrupt, backed up to ${bak}, will overwrite`);
      existing = [];
    } else throw e;
  }

  const existingKeys = new Set(existing.map(r => `${String(r.email).toLowerCase().trim()}|${r.badgeTemplateId}`));
  const toAdd = records.filter(r => !existingKeys.has(`${r.email}|${r.badgeTemplateId}`));
  const merged = [...existing, ...toAdd];

  if (existing.length > 0) {
    console.log(`[seed] merging: ${existing.length} existing + ${toAdd.length} new = ${merged.length} total (${records.length - toAdd.length} already present)`);
    // Backup before overwrite
    const bak = `${output}.bak.${new Date().toISOString()}`;
    try {
      if (existingRaw !== null) await fs.writeFile(bak, existingRaw, 'utf8');
    } catch {}
  }

  // Sort for deterministic diff: email, then templateId
  merged.sort((a, b) => a.email.localeCompare(b.email) || a.badgeTemplateId.localeCompare(b.badgeTemplateId));

  await fs.writeFile(output, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log(`[seed] wrote ${merged.length} records to ${output} (${toAdd.length} added)`);
}

main().catch(e => {
  console.error(`[seed] fatal: ${e.stack || e.message}`);
  process.exit(1);
});
