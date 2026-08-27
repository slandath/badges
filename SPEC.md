# Spec: Credly Badge CSV Generator

## Overview

A scheduled automation that collects badge recipient lists from multiple GitHub repositories, deduplicates them against previously issued badges, and produces a single CSV file formatted for bulk upload to Credly. Runs monthly via GitHub Actions; a human downloads the CSV and uploads it to Credly manually.

## Goals

- Eliminate manual collection/collation of recipient lists from subproject repos
- Produce a drop-in Credly bulk-upload CSV in one automated step
- Never re-issue a badge: only net-new (email + badge template) pairs appear in output
- Keep human review in the loop before anything reaches Credly

## Non-Goals

- Direct integration with the Credly API (future enhancement; design should not preclude it)
- A UI or dashboard
- Modifying source recipient files in subproject repos

## Architecture

- **Language/Runtime:** Node.js 22+, plain JavaScript (ESM), no runtime dependencies beyond Node built-ins and native `fetch`
- **Hosting:** GitHub Actions in a dedicated automation repository
- **State:** JSON file (`issued-badges.json`) committed to the automation repo
- **Trigger:** Cron schedule (1st of each month) plus manual `workflow_dispatch`

## Repository Layout

```text
/
├── config.json                  # Source definitions
├── issued-badges.json           # State: previously issued badges
├── generate-credly-csv.js       # Main script (ESM, requires package.json type: module)
├── package.json                 # { "type": "module" } for ESM
├── .github/workflows/credly.yml # Scheduled workflow
└── README.md                    # Setup and monthly-routine docs
```

## Inputs

### 1. Config file: `config.json`

Defines the source files to fetch. Each source maps one CSV file to one Credly badge template ID.

```json
{
  "sources": [
    {
      "repo": "org/subproject-a",
      "path": "badges/recipients.csv",
      "branch": "main",
      "badgeTemplateId": "abc-123-def"
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `repo` | string | yes | GitHub `owner/name` |
| `path` | string | yes | Path to CSV file within the repo |
| `branch` | string | yes | Branch to fetch from |
| `badgeTemplateId` | string | yes | Credly badge template ID applied to every recipient in this file |

Expected scale: 7–10 sources.

### 2. Source recipient CSVs (fetched from remote repos)

Fetched via `https://raw.githubusercontent.com/{repo}/{branch}/{path}` with an `Authorization: Bearer $GH_TOKEN` header.

Format — header row followed by data rows:

```text
First Name, Last Name, GitHub ID, Email, Squad, Role
Elliot,Jalley,jalel01,elliot.jalley@broadcom.com, Zowe API Squad,
John,"Smith, Jr.",jsmith123,john@example.com,,
```

A template CSV is provided for each repo but is filled out manually by humans (typically via Excel/Sheets), so files may contain RFC 4180 quoting and human artifacts.

Parsing rules:
- Normalize line endings: handle both `LF` (`\n`) and `CRLF` (`\r\n`); strip `\r`
- Strip UTF-8 BOM (`\uFEFF`) if present at start of file
- Split on newlines; trim each line; skip empty lines
- Skip the header row (case-insensitive match on a line starting with `First Name` after trimming/BOM removal)
- Parse rows per RFC 4180: support quoted fields, commas inside quotes, escaped quotes (`""` -> `"`), and newlines inside quotes. Do not use naive `split(',')`
- After RFC 4180 unquoting, trim every field
- Rows are append-only over time; files contain the full historical list, not just new entrants
- Trailing fields (Squad, Role) may be empty or absent

Only First Name, Last Name, and Email are used in the output. GitHub ID, Squad, and Role are ignored.

### 3. State file: `issued-badges.json`

JSON array of previously issued records:

```json
[
  {
    "email": "elliot.jalley@broadcom.com",
    "badgeTemplateId": "abc-123-def",
    "issuedDate": "2026-08-01"
  }
]
```

- Emails stored lowercase
- Missing file: treat as empty and log a warning to `stderr` (do not fail) - expected on first run
- Unparseable/corrupt file (JSON `SyntaxError`): log an error to `stderr` including `error.message`, preserve the raw corrupt content to a local backup file `issued-badges.json.bak.<ISO-timestamp>` (e.g., `issued-badges.json.bak.2026-08-01T13:00:00.000Z`), do not commit the backup, and treat as empty for the current run. This prevents silent loss of history that would cause mass re-issuance. The backup allows recovery via git history or the `.bak` file.
- All state warnings/errors must go to `stderr` (`console.warn`/`console.error`) so `stdout` remains clean for summaries.

## Processing Logic

1. Load `config.json` and `issued-badges.json`
2. For each source: fetch the CSV, parse recipients per RFC 4180 rules above, tag each with the source's `badgeTemplateId`
3. **Validation** (per row, after trim+unquoting):
   - Row must have ≥ 4 columns; otherwise log a warning to `stderr` with source label and line number, skip row
   - `First Name` must be non-empty; otherwise log a warning to `stderr` with source label and line number, skip row (Credly rejects empty names)
   - `Last Name` must be non-empty; otherwise log a warning to `stderr` with source label and line number, skip row (Credly rejects empty names)
   - Email must match `^[^\s@]+@[^\s@]+\.[^\s@]+$` after trim and lowercasing; otherwise log a warning to `stderr`, skip row
4. **Deduplication:** dedupe key is `lowercase(trimmed(email)) + "|" + badgeTemplateId`
   - Drop duplicates within the current run (first occurrence wins)
   - Drop any key present in the state file
   - Note: the same email with different badge template IDs is valid and must be kept
5. If no new recipients remain: log "No new recipients" to `stdout`, exit 0, produce no CSV, do not modify state
6. Otherwise: write the output CSV (overwriting any existing file for the same date) and append the new records to `issued-badges.json`

### Error handling

- A failed fetch (non-2xx or network error) for any source: log an error to `stderr`, continue processing remaining sources, and set a nonzero exit code at the end so the workflow run is marked failed — but still emit the CSV/state for the sources that succeeded
- Log a per-run summary to `stdout`: count of new recipients and each `email -> badgeTemplateId` pair (emails are public and used in commit signatures, so logging is permitted)

## Output

### Credly CSV: `credly-YYYY-MM-DD.csv`

Exact header (order matters):

```text
Badge Template ID,Recipient Email,Issued To First Name,Issued To Middle Name,Issued To Last Name,Issued At
```

- One row per new (email, badge template) pair
- `Issued To Middle Name` is always empty
- `Issued At` is the run date in `YYYY-MM-DD` format (UTC, via `new Date().toISOString().slice(0,10)`)
- CSV escaping: quote fields containing commas, quotes, or newlines per RFC 4180; double embedded quotes
- File ends with a trailing newline
- If the workflow runs multiple times on the same date, the file is overwritten on disk and the artifact is replaced

### Updated state file

New records appended to `issued-badges.json`, pretty-printed (2-space indent), trailing newline.

## GitHub Actions Workflow

File: `.github/workflows/credly.yml`

- **Triggers:** `schedule: cron "0 13 1 * *"` (1st of month, 13:00 UTC) and `workflow_dispatch`
- **Permissions:** `contents: write`
- **Steps:**
  1. Checkout
  2. Setup Node 22
  3. Run `node generate-credly-csv.js` with `GH_TOKEN` set from secret `BADGE_READ_TOKEN`
  4. Upload `credly-*.csv` as artifact named `credly-csv` (`if-no-files-found: ignore`)
  5. Commit and push `issued-badges.json` if changed, as `github-actions[bot]`, message `Update issued badges YYYY-MM`

### Secrets

| Secret | Purpose |
|---|---|
| `BADGE_READ_TOKEN` | Fine-grained PAT with read access to all source repos (required for private repos; recommended regardless to avoid rate limits) |

## Acceptance Criteria

1. Given valid config and reachable sources, the script produces a CSV with the exact Credly header and only recipients not present in the state file
2. Re-running immediately after a successful run produces no CSV and no state change
3. A recipient appearing in two source files with different badge template IDs yields two output rows
4. A recipient appearing twice with the same badge template ID yields one output row
5. Malformed rows, invalid emails, and empty First/Last names are skipped with warnings to `stderr`; the run still succeeds
6. A single unreachable source does not prevent output for other sources, but the run exits nonzero
7. Missing state file is treated as empty with a warning to `stderr`, not an error; corrupt state file is backed up to `.bak.<timestamp>`, logged as error to `stderr`, and treated as empty for the run
8. Whitespace around fields (e.g., `" Zowe API Squad"`) is trimmed after RFC 4180 unquoting; quoted commas and escaped quotes (`""`) are handled correctly
9. The workflow commits the updated state file and exposes the CSV as a downloadable artifact; re-runs on same date overwrite the CSV

## Documentation Requirements (README)

- How to add a new badge source (config entry)
- How to seed `issued-badges.json` from historical Credly exports before first run (critical: source files contain full history; an empty state file would re-issue everything)
- The monthly routine: check run → download artifact → review → upload to Credly
- How to create/rotate `BADGE_READ_TOKEN`

## Future Enhancements (out of scope, don't block)

- Replace manual upload with per-recipient Credly API calls (`POST /organizations/{org_id}/badges`)
- Slack/email notification with run summary
- Verify `Issued At` date format against Credly's accepted formats if uploads fail
