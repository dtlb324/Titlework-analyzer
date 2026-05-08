# Mineral Ownership Builder — Title Research Tool

An AI-powered web application for oil and gas landmen to analyze courthouse documents, build chain of title, and determine mineral ownership. Powered by Anthropic's Claude API and deployed on Vercel.

> **Important:** This tool is an AI-assisted research aid, not a legal opinion. Always verify output against source documents and consult a licensed attorney before any drilling, leasing, or division order action.

---

## What You Need Before Starting

1. The `Titlework-analyzer` folder (this folder, with `api/`, `public/`, etc.)
2. An Anthropic API key from `console.anthropic.com/settings/keys`
3. About 20 minutes
4. An email address

---

## Step 1 — Create a GitHub Account (5 min)

GitHub stores your code so Vercel can deploy it.

1. Go to **https://github.com/signup**
2. Sign up with your email address
3. Verify your email when GitHub sends the confirmation

---

## Step 2 — Upload This Project to GitHub (5 min)

1. While logged into GitHub, click the **+** icon top-right → **New repository**
2. Repository name: `Titlework-analyzer` (or whatever you prefer)
3. Set visibility to **Private**
4. Click **Create repository**
5. On the next page, click **"uploading an existing file"**
6. Drag the **contents** of this folder into the upload box — the `api` folder, `public` folder, `vercel.json`, `package.json`, `README.md`, and `SECURITY.md`

> ⚠️ Drag the **contents**, not the parent folder. The `api/` folder, `public/` folder, `vercel.json`, and `package.json` must be at the **root level** of the repository.

7. Scroll down and click **Commit changes**

---

## Step 3 — Create a Vercel Account (3 min)

Vercel runs the actual web app.

1. Go to **https://vercel.com/signup**
2. Click **Continue with GitHub** — this connects to the account you just created
3. Authorize Vercel to access your GitHub repositories
4. Select the **Hobby** (free) plan when asked

---

## Step 4 — Deploy the App (5 min)

1. On the Vercel dashboard, click **Add New...** → **Project**
2. Find your `Titlework-analyzer` repository and click **Import**
3. **Before clicking Deploy**, expand **Environment Variables** and add:

| Name | Value |
|------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (starts with `sk-ant-...`) |
| `APP_PASSWORD` | A password to restrict access (recommended) |

4. Click **Deploy**
5. Wait ~30 seconds — Vercel builds and deploys automatically
6. You will see a confetti animation and a link to your live site

---

## Step 5 — Configure Public Access

By default Vercel locks your deployment behind a Vercel login screen. Turn that off so your coworkers can access it without a Vercel account:

1. Go to your Vercel project → **Settings** → **Deployment Protection**
2. Set to **Disabled** or **Only Preview Deployments**
3. Click **Save**

---

## Step 6 — Use It

1. Click the URL Vercel gave you (e.g. `Titlework-analyzer-abc123.vercel.app`)
2. Enter the password if you set one
3. Add a subject tract description (optional but helpful)
4. Upload documents and click **Build Chain of Title**
5. Bookmark the URL and share it with anyone who needs access

> ⚠️ Always use the Vercel URL in your browser. Never open the HTML file directly from your computer — the local file cannot connect to the server.

---

## Costs

| Service | Cost |
|---------|------|
| GitHub | Free |
| Vercel Hobby tier | Free |
| Anthropic API | Pay-per-use (~$0.10–$0.50 per analysis) |

**The Anthropic API is completely separate from any Claude.ai subscription.** A Claude.ai Pro subscription ($20/month) does not cover API usage. API charges are billed separately per use to a credit card on file at `console.anthropic.com`.

**Recommended:** Set a monthly spending limit at `console.anthropic.com/settings/limits` to cap costs. A $25/month limit is a reasonable starting point for light use.

**API cost estimates:**
- ~$0.10–$0.20 per analysis for a small run (3–5 documents)
- ~$0.30–$0.60 per analysis for a medium run (10 documents)
- ~$0.75–$1.50 per analysis for a large run (20+ documents)

---

## How to Update the App

All updates go through GitHub. Vercel auto-redeploys within ~30 seconds of any commit. No command line or local setup needed.

1. Go to your GitHub repository
2. Navigate to the file to edit (`public/index.html`, `api/analyze.js`, `vercel.json`, etc.)
3. Click the **pencil icon** to edit
4. Make your changes
5. Scroll down and click **Commit changes**

Vercel detects the change and redeploys automatically.

---

## How to Give Access to Another Person

Just share the URL and password. No account or installation needed on their end. Works from any browser on any network.

---

## How to Revoke Access

**Change password:**
1. Go to Vercel → project → **Settings** → **Environment Variables**
2. Click on `APP_PASSWORD` → edit the value to a new password
3. Click **Save** — Vercel redeploys automatically
4. The old password stops working immediately
5. Share the new password only with people who should have access

**Revoke API access entirely:**
1. Go to `console.anthropic.com/settings/keys`
2. Find the key → click the three dots → **Revoke**
3. The app stops making API calls until a new key is added

---

## What It Does

Upload courthouse documents and the AI analyzes them acting as a Texas-licensed oil and gas title attorney with 30 years of experience, producing a formal title opinion structure:

- **Document Abstract** — extracts every key fact from each document including grantor, grantee, recording reference, fraction conveyed, reservations, warranty type, and acknowledgment
- **Chain of Title** — chronological ownership flow with fractional math shown at every step
- **Mineral Interest Calculation** — tracks surface estate, mineral estate, royalty interest, NPRI, and outstanding leasehold separately
- **Title Defects & Curative Requirements** — flags every issue and specifies the curative document needed (Affidavit of Heirship, Stipulation of Interest, Release, Quitclaim, etc.)
- **Final Ownership Determination** — clean ownership table showing each owner, mineral interest, royalty/NPRI, subject to, and notes
- **Opinion Qualifications** — assumptions made, illegible documents noted, and formal disclaimer

The AI is instructed never to guess on illegible content — it writes **ILLEGIBLE — VERIFY MANUALLY** instead of filling in missing information.

---

## Features

### Document Analysis
- Two-stage analysis: individual document abstraction followed by full synthesis
- Documents processed in batches of 2 to balance speed and server reliability
- Animated spinner on each document row while it is actively being processed
- Each document gets its own progress row so you can see exactly which files are being read
- Progress bar tracks overall completion from start to finish

### Supported File Types

| Type | Notes |
|------|-------|
| PDF | Most common — deeds, probate, assignments, leases |
| JPG / PNG / TIFF / GIF / WEBP | Scanned document images |
| CSV | Converted to plain text — useful for division order schedules, ownership tables, lease summaries |

### Add More Documents
- After the initial analysis, click **Add More Documents** to upload additional batches
- The AI re-synthesizes the entire chain of title using all documents combined
- Use this when a chain of title spans more documents than fit in one upload

### Download PDF
- Click **Download PDF** after the analysis completes to save a formatted copy
- PDF includes the full analysis, styled tables, section headers, page numbers, and a disclaimer footer on every page
- Filename is auto-generated from the tract description and current date

### Follow-up Questions
- After the analysis, ask any follow-up question in plain language
- Examples: "What curative document do I need for the 1962 gap?", "What happens to the mineral interest if the 1987 deed is invalid?"

---

## How the AI Behaves

The AI follows strict rules for accuracy and caution:

1. Only use facts present in the document abstracts — never invent dates, parties, fractions, or recording references
2. If something is illegible or unclear, flag it as a curative item — do not guess
3. Show every fractional calculation step by step
4. If the chain has gaps that cannot be bridged with the provided documents, state so explicitly
5. End every analysis with formal opinion qualifications and a disclaimer that it is not a legal opinion

---

## Security

| Protection | Detail |
|-----------|--------|
| Password gate | Access restricted to users with the correct password |
| Brute-force protection | 5 failed password attempts locks the IP for 60 seconds |
| Constant-time password comparison | Prevents timing attacks |
| Rate limiting | 20 requests per IP per minute maximum |
| Input validation | All requests validated before reaching the Anthropic API |
| Model whitelist | Only approved Claude models accepted |
| XSS protection headers | On every server response |
| Content Security Policy | In both server headers and HTML meta tags |
| Clickjacking protection | X-Frame-Options: DENY |
| Cache-Control: no-store | Documents and analysis results never cached |
| No secrets in codebase | API key and password stored in Vercel environment variables only |
| Internal errors sanitized | Stack traces never exposed to the client |

---

## Allowed Claude Models

The following models are whitelisted in `api/analyze.js`:

- `claude-sonnet-4-5`
- `claude-sonnet-4-6`
- `claude-opus-4-6`
- `claude-opus-4-7`
- `claude-haiku-4-5`

To add a new model, update the `allowedModels` array in `api/analyze.js`.

---

## Project Structure

```
Titlework-analyzer/
├── api/
│   └── analyze.js        # Vercel serverless function — proxies to Anthropic API with security hardening
├── public/
│   └── index.html        # Entire frontend — single HTML file, no build step
├── vercel.json           # Vercel config — sets function timeout to 60 seconds
├── package.json          # Project metadata — type: module
├── SECURITY.md           # Security policy and vulnerability reporting
└── README.md             # This file
```

---

## Branch Protection

If you have branch protection enabled on your `main` branch, code changes must go through a pull request before merging. This prevents accidentally pushing broken code directly to production.

When Vercel creates automated pull requests (such as for Speed Insights or Analytics), you can either:
- **Approve and merge** the pull request through the Pull Requests tab
- **Close the pull request** if you do not want the feature

Do not let automated pull requests sit unresolved — merge conflicts can corrupt your files.

---

## Releases

Create a new GitHub release after major updates to permanently snapshot your working code:

1. GitHub repo → **Releases** (right sidebar) → **Draft a new release**
2. Click **Choose a tag** → type `v1.x` → **Create new tag**
3. Add a title and description of what changed
4. Click **Publish release**

If something breaks after an update, you can download the exact files from any previous release. Vercel also has an **Instant Rollback** button in the Deployments tab to revert the live site in one click.

---

## Troubleshooting

**"Failed to fetch"**
The app is being opened as a local file instead of via the Vercel URL. Always use the `https://...vercel.app` URL. Never open `index.html` directly from your computer.

**"API key not configured on server"**
The `ANTHROPIC_API_KEY` environment variable is missing. Go to Vercel → project → Settings → Environment Variables, add it, then redeploy.

**"Invalid password"**
Wrong password or the password was changed. Check the `APP_PASSWORD` value in Vercel Settings → Environment Variables.

**"Insufficient API credits"**
Your Anthropic account has no credit balance. Add credit at `console.anthropic.com/settings/billing`. A minimum top-up of $5 is required.

**"Rate limit exceeded"**
More than 20 requests were made from the same IP within 60 seconds. Wait 60 seconds and try again.

**"Too many failed attempts"**
5 incorrect password attempts were made from the same IP. Wait 60 seconds and try again with the correct password.

**"File too large"**
The documents in the batch exceed the server size limit. Try uploading fewer documents at a time. For large scanned PDFs, try scanning at 150 DPI instead of 300 DPI to reduce file size.

**"Forbidden" on the live URL**
Vercel's Deployment Protection is enabled. Go to project → Settings → Deployment Protection → set to Disabled or Only Preview Deployments.

**Merge conflict in GitHub**
This happens when Vercel creates an automated pull request that conflicts with your code. Go to the Pull Requests tab and close the automated PR if you do not want the feature, or resolve the conflict by accepting your version of the file.

**Yellow build warning about ESM/CommonJS**
This is harmless — Vercel automatically handles the conversion. The warning disappears if `package.json` includes `"type": "module"`.

**Stale error thumbnail in Vercel dashboard**
The preview screenshot only updates on a new deployment. Commit any small change to trigger a redeploy and refresh the thumbnail.

**Build fails on Vercel**
Make sure `api/`, `public/`, `vercel.json`, and `package.json` are at the root of the repository — not inside a subfolder.

---

## Reporting Security Issues

Do not open a public GitHub issue for security vulnerabilities. See `SECURITY.md` for the full security policy and private reporting contact.
