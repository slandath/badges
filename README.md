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
├── generate-credly-csv.js       # Main script (Node 22, ESM, no deps)
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

Quick conversion helper (Node):

```js
import fs from 'node:fs';
// credly-export.csv has header: Badge Template ID,Recipient Email,...
const rows = fs.readFileSync('credly-export.csv','utf8').split('\n').slice(1);
const records = rows.filter(l=>l.trim()).map(l=>{
  const [templateId,email] = l.split(','); // adapt to actual Credly export columns
  return { email: email.toLowerCase().trim(), badgeTemplateId: templateId.trim(), issuedDate: '2026-05-01' };
});
fs.writeFileSync('issued-badges.json', JSON.stringify(records,null,2)+'\n');
```

4. Commit and push `issued-badges.json` before enabling the schedule. Verify count matches Credly.

If you skip this, the first run will generate a CSV with the entire historical list.

### 3. Add a New Badge Source

Edit `config.json` and commit:

```json
{
  "sources": [
    {
      "repo": "org/subproject-a",
      "path": "badges/recipients.csv",
      "branch": "main",
      "badgeTemplateId": "abc-123-def"
    },
    {
      "repo": "org/new-project",
      "path": "badges/recipients.csv",
      "branch": "main",
      "badgeTemplateId": "new-template-id-from-credly"
    }
  ]
}
```

- `repo`: `owner/name` exactly
- `path`: path to CSV within source repo (usually `badges/recipients.csv`)
- `branch`: branch to fetch from (usually `main`)
- `badgeTemplateId`: Credly badge template ID (found in Credly URL when viewing template)

After adding, ensure `BADGE_READ_TOKEN` has Contents: Read on the new repo (edit fine-grained token -> Select repositories -> add new repo -> Regenerate token -> update secret). Test with manual workflow dispatch.

Provide the template CSV to the subproject team:

```csv
First Name,Last Name,GitHub ID,Email,Squad,Role
```
Only `First Name`, `Last Name`, `Email` are used; whitespace is trimmed; quoted fields with commas/quotes are handled per RFC 4180.

## Monthly Routine

1. **Check run:** Actions tab -> Credly Badge CSV -> latest run on 1st of month should be green. If orange (partial fetch failure), check logs for `[fetch] Failed` but artifact is still valid for successful sources.
2. **Download artifact:** Click successful run -> Artifacts -> `credly-csv` -> downloads zip containing `credly-YYYY-MM-DD.csv`
3. **Review:** Open CSV, verify row count and `email -> badgeTemplateId` pairs in logs. Check warnings in logs for `[validate]` skipped rows (fix source files for next month).
4. **Upload to Credly:** Credly Organization -> Badges -> Bulk Issue -> Upload CSV (or per-template bulk upload). The CSV header is exactly Credly's `Badge Template ID,Recipient Email,Issued To First Name,Issued To Middle Name,Issued To Last Name,Issued At`; `Issued At` is UTC `YYYY-MM-DD`; fields with commas/quotes are quoted per RFC 4180.
5. **Verify state:** After run, `issued-badges.json` is auto-committed as `github-actions[bot]`. Confirm push succeeded (no concurrency conflict).

If no new recipients, no CSV is produced (logs show `No new recipients`) and state is unchanged.

## Local Development

Requires Node 22+:

```bash
node generate-credly-csv.js
# uses GH_TOKEN or BADGE_READ_TOKEN env var for private sources
GH_TOKEN=ghp_xxx node generate-credly-csv.js
```

Logs: summary to `stdout`, warnings/errors to `stderr`. Exit 1 if any source fetch failed (CSV still emitted for others).

## Troubleshooting

- **Missing corrupt state file:** Check logs for `[state] corrupt JSON` and backup `issued-badges.json.bak.*` locally; restore from `git log` or backup.
- **Invalid email/empty name skipped:** Fix source `badges/recipients.csv` in the source repo; will be picked up next run (not retroactive).
- **Fetch 404:** Verify `repo`, `path`, `branch`, and token has access to that repo.

## Future

Design does not preclude Credly API `POST /organizations/{org_id}/badges` replacement for manual upload.
