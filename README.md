# Credly Badge CSV Generator

Automated monthly collection of badge recipients from subproject repos. Produces a drop-in Credly bulk-upload CSV and tracks issued badges to prevent re-issuance.

## How It Works

- Fetches `badges/recipients.csv` from each configured source repo via `raw.githubusercontent.com` (Bearer token)
- Validates, deduplicates against `issued-badges.json`, and emits `credly-YYYY-MM-DD.csv`
- Runs on the 1st of each month at 13:00 UTC via GitHub Actions, plus manual `workflow_dispatch`
- Human downloads artifact and uploads to Credly manually

## Repository Layout

```
/
├── config.json                  # Source definitions
├── issued-badges.json           # State: previously issued badges
├── generate-credly-csv.js       # Main script (Node 24, ESM, no deps)
├── scripts/seed-issued-badges.js # One-time seeding helper (Credly export -> state)
├── scripts/diff-issued-vs-csv.js # Verification helper (state vs CSV diff)
├── package.json                 # { "type": "module" } for ESM
├── .github/workflows/credly.yml # Scheduled workflow
└── README.md
```

## Setup

### 1. Create `BADGE_READ_TOKEN`

The workflow needs read access to all source repos (private repos require it; public repos benefit from higher rate limits).

1. GitHub Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens -> Generate new token
2. Resource owner: your org
3. Repository access: Only select repositories -> choose each `org/subproject-*` source repo
4. Permissions -> Repository -> Contents: Read-only
5. Expiration: 90 days recommended (set calendar reminder), or 1 year if org policy allows
6. Copy token
7. In this automation repo: Settings -> Secrets and variables -> Actions -> New repository secret -> Name `BADGE_READ_TOKEN`, Value = token
8. Test: trigger workflow manually (Actions tab -> Credly Badge CSV -> Run workflow) and check green check + artifact

**Rotate:** Generate new fine-grained token as above -> update secret `BADGE_READ_TOKEN` in repo settings -> revoke old token under Developer settings -> test with manual dispatch.

### 2. Seed `issued-badges.json` Before First Run (Critical)

Source files are append-only and contain **full history**. An empty state file would re-issue badges to everyone already awarded.

Before the first automated run, seed from Credly historical exports:

1. In Credly, export issued badges for each `badgeTemplateId` in `config.json` (Organization -> Badges -> Badge Template -> Issued -> Export CSV)
2. Extract `Recipient Email` and `Badge Template ID` per row
3. Convert to JSON array format, lowercasing emails:

```json
[
  {
    "email": "alice@example.com",
    "badgeTemplateId": "abc-123-def",
    "issuedDate": "2026-05-01"
  },
  {
    "email": "bob@example.com",
    "badgeTemplateId": "xyz-789-ghi",
    "issuedDate": "2026-05-01"
  }
]
```

Run the seeding helper (handles BOM, CRLF, quoted fields, header detection, and merges with existing state):

```bash
node scripts/seed-issued-badges.js credly-export.csv
# or: node scripts/seed-issued-badges.js credly-export.csv issued-badges.json --date 2026-05-01
# see: node scripts/seed-issued-badges.js --help
```

4. Commit and push `issued-badges.json` before enabling the schedule. Verify count matches Credly.

If you skip this, the first run will generate a CSV with the entire historical list.

### 3. Add a New Badge Source (and Badge Pools)

`config.json` has top-level `pools` — per-repo allowed badge templates. Each `sources[].badgeTemplateId` must be in `pools[repo]`; this enforces that a subproject can only distribute badges from its own pool (see `SPEC.md:40`). For a subproject distributing multiple badges, add *multiple* `sources` entries sharing the same `repo` but with different `path`/`badgeTemplateId`, all validated against the same `pools[repo]`.

Edit `config.json` and commit:

```json
{
  "pools": {
    "org/subproject-a": ["abc-123-def"],
    "org/new-project": ["new-template-id-1", "new-template-id-2"]
  },
  "sources": [
    {
      "repo": "org/subproject-a",
      "path": "badges/recipients.csv",
      "branch": "main",
      "badgeTemplateId": "abc-123-def"
    },
    {
      "repo": "org/new-project",
      "path": "badges/recipients-a.csv",
      "branch": "main",
      "badgeTemplateId": "new-template-id-1"
    },
    {
      "repo": "org/new-project",
      "path": "badges/recipients-b.csv",
      "branch": "main",
      "badgeTemplateId": "new-template-id-2"
    }
  ]
}
```

- `pools`: `owner/name` → array of allowed Credly badge template IDs for that subproject (required, every `repo` in `sources` must have an entry)
- `repo`: `owner/name` exactly
- `path`: path to CSV within source repo (usually `badges/recipients.csv` or `COMMITTERS.csv` at root)
- `branch`: branch to fetch from (usually `main` or `master` — check the repo's default branch)
- `badgeTemplateId`: Credly badge template ID (found in Credly URL when viewing template) — must be in `pools[repo]`, otherwise the run fails fast with `[config] Pool violation` to `stderr` and `exit 1`. If the CSV itself has a `Badge Template ID` column (case-insensitive), per-row value is **required with no default** — a row with empty per-row badge is skipped with `[validate] Badge Template ID not specified per row` to `stderr` and must also be in `pools[repo]`; otherwise the fallback `sources[].badgeTemplateId` applies (for single-badge files or multi-file per-badge setups).

After adding, ensure `BADGE_READ_TOKEN` has Contents: Read on the new repo (edit fine-grained token -> Select repositories -> add new repo -> Regenerate token -> update secret). Test with manual workflow dispatch.

Provide the template CSV to the subproject team:

```csv
First Name,Last Name,GitHub ID,Email,Squad,Role
```
Only `First Name`, `Last Name`, `Email` are used; whitespace is trimmed; quoted fields with commas/quotes are handled per RFC 4180.

**For a 3-badge pool where one person earns multiple badges (e.g., `openmainframeproject/omp-education`):** Add a `Badge Template ID` column as the last column — when this column is present, per-row is **required with no default** (empty per-row → skipped with `Badge Template ID not specified per row` warning) and must still be in `pools[repo]`. Example for John Doe earning 2 badges from the pool:

```csv
Recipient Email,Issued To First Name,Issued To Middle Name,Issued To Last Name,Badge Template ID
john.doe@example.com,John,,Doe,9cbdc4ec-7b33-4287-b0d9-299ba011a16e
john.doe@example.com,John,,Doe,37bf4b27-ad43-4c78-a733-4f77b57b3d1b
```
Same `email` with different per-row IDs yields two output rows (`email|template` dedup key per `SPEC.md:130`). Without the `Badge Template ID` column, each file maps to its `sources[].badgeTemplateId` fallback — use multiple `sources` entries for multiple files as shown above.

## Monthly Routine

1. **Check run:** Actions tab -> Credly Badge CSV -> latest run on 1st of month should be green. If orange (partial fetch failure), check logs for `[fetch] Failed` but artifact is still valid for successful sources.
2. **Download artifact:** Click successful run -> Artifacts -> `credly-csv` -> downloads zip containing `credly-YYYY-MM-DD.csv`
3. **Review:** Open CSV, verify row count and `email -> badgeTemplateId` pairs in logs. Check warnings in logs for `[validate]` skipped rows (fix source files for next month).
4. **Upload to Credly:** Credly Organization -> Badges -> Bulk Issue -> Upload CSV (or per-template bulk upload). The CSV header is exactly Credly's `Badge Template ID,Recipient Email,Issued To First Name,Issued To Middle Name,Issued To Last Name,Issued At`; `Issued At` is UTC `YYYY-MM-DD`; fields with commas/quotes are quoted per RFC 4180.
5. **Verify state:** After run, `issued-badges.json` is auto-committed as `github-actions[bot]`. Confirm push succeeded (no concurrency conflict).

If no new recipients, no CSV is produced (logs show `No new recipients`) and state is unchanged.

## Local Development

Requires Node 24+:

```bash
node generate-credly-csv.js
# uses GH_TOKEN or BADGE_READ_TOKEN env var for private sources
GH_TOKEN=ghp_xxx node generate-credly-csv.js
```

Logs: summary to `stdout`, warnings/errors to `stderr`. Exit 1 if any source fetch failed (CSV still emitted for others).

## Verification

Compare `issued-badges.json` against any CSV to audit what would be issued or what is missing. Handles BOM, CRLF, RFC 4180 quoted fields, and lowercases emails. Auto-detects Credly export vs source recipients format.

**Credly export vs state** (should be 0 diff after seeding):

```bash
node scripts/diff-issued-vs-csv.js ~/Downloads/credly-export.csv
# CSV: 341, State: 341, Only in CSV: 0, Only in state: 0
```

**Source recipients CSV vs state** (requires `--template`):

```bash
node scripts/diff-issued-vs-csv.js badges/recipients.csv --template 605608ea-8467-43a4-9236-715ceb0edbf4
# Only in CSV (would be issued next run): 1
#   + newperson@example.com -> 605608ea-8467-43a4-9236-715ceb0edbf4
```

**Options:**

```bash
node scripts/diff-issued-vs-csv.js <csv> --state ./my-state.json --template <id> --json
node scripts/diff-issued-vs-csv.js --help
```

`--json` prints machine-readable `{counts, onlyInCsv, onlyInState, inBoth}` sorted by email. Use `--state` to compare against a different state file.

## Troubleshooting

- **Missing corrupt state file:** Check logs for `[state] corrupt JSON` and backup `issued-badges.json.bak.*` locally; restore from `git log` or backup.
- **Invalid email/empty name skipped:** Fix source `badges/recipients.csv` in the source repo; will be picked up next run (not retroactive).
- **Fetch 404:** Verify `repo`, `path`, `branch`, and token has access to that repo.

## Future

Design does not preclude Credly API `POST /organizations/{org_id}/badges` replacement for manual upload.
