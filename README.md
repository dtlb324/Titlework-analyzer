# Mineral Title Analyzer — Deployment Guide  

This is a web app for landmen to analyze courthouse documents and build chain of title. Deploy it once to Vercel, then anyone with the URL can use it from any browser, anywhere.
**The analyzer only works with Claude AI right now.**

**Total deployment time: ~30 minutes**

---

## What you'll end up with

A URL like `https://titlework-analyzer-yourname.vercel.app` that you and your coworker can both bookmark. No API key needed on his end. You control access with an optional password.

---

## What you need before starting

1. The `Titlework-analyzer` folder (this folder, with `api/`, `public/`, etc.)
2. Your Anthropic API key (from `console.anthropic.com/settings/keys`). 
3. An email address

---

## Step 1: Create a GitHub account (5 min)

GitHub stores your code so Vercel can deploy it.

1. Go to **https://github.com/signup**
2. Sign up with your email
3. Verify your email when GitHub sends the confirmation
4. You're done — no payment info needed

---

## Step 2: Upload this folder to GitHub (5 min)

The easiest way (no command line needed):

1. While logged into GitHub, click the **+** icon top-right → **New repository**
2. Repository name: `Titlework-analyzer` (or whatever you want)
3. Set to **Private** (important — keeps your code from being public)
4. Click **Create repository**
5. On the next page, click **"uploading an existing file"** (it's a link in the middle of the page)
6. Drag the entire contents of the `Titlework-analyzer` folder into the upload box. **Important:** drag the *contents* (the `api` folder, `public` folder, `vercel.json`, `package.json`) — NOT the parent folder itself
7. Scroll down and click **Commit changes**

Your code is now on GitHub.

---

## Step 3: Create a Vercel account (3 min)

Vercel runs the actual web app.

1. Go to **https://vercel.com/signup**
2. Click **Continue with GitHub** (easiest — connects to the account you just made)
3. Authorize Vercel to access your GitHub
4. Pick the **Hobby** (free) plan when asked

---

## Step 4: Deploy the app (3 min)

1. On the Vercel dashboard, click **Add New...** → **Project**
2. You'll see a list of your GitHub repositories. Find `title-analyzer` and click **Import**
3. **Don't click Deploy yet.** First, expand the **Environment Variables** section
4. Add this environment variable:
   - **Name:** `ANTHROPIC_API_KEY` - Case-Sensitive so make sure you copy the name exatly. 
   - **Value:** paste your Anthropic API key (starts with `sk-ant-...`)
   - Click **Add**
5. *(Optional but recommended)* Add a second environment variable for password protection:
   - **Name:** `APP_PASSWORD`
   - **Value:** any password you want (e.g., `Joe2026`)
   - Click **Add**
6. Click **Deploy**
7. Wait ~30 seconds for it to build

Done. You'll see a confetti animation and a link to your live site.

---

## Step 5: Use it

1. Click the URL Vercel gives you (something like `Titlework-analyzer-abc123.vercel.app`)
2. If you set a password, enter it
3. Upload documents, click "Build Chain of Title"
4. Bookmark the URL
5. Share the URL (and password, if set) with your coworker

That's it. Your coworker just visits the URL and uses it. No installation, no API key on his end, works from any browser, on any network (the firewall issue is gone because the API call happens from Vercel, not his office network).

---

## Costs

- **GitHub:** Free
- **Vercel Hobby tier:** Free (more than enough for two users)
- **Anthropic API:** Pay-per-use to your existing account (~$0.10–$0.50 per analysis)

Set a monthly spending limit at https://console.anthropic.com/settings/limits as a safety cap.

---

## How to update the app later

If you ever want to change something in your cloned repository (system prompt, styling, etc.):

1. Edit the file on GitHub directly (click the pencil icon)
2. Commit the change
3. Vercel auto-redeploys in ~30 seconds

You don't need to do anything else — it's automatic.

---

## How to give access to a third person

Just share the URL (and password). No setup on their end.

## How to revoke access

1. Go to your Vercel project → Settings → Environment Variables
2. Edit `APP_PASSWORD` to a new value
3. Click Save → Vercel redeploys automatically
4. The old password no longer works; share the new one only with people who should have access

---

## Troubleshooting

**"API key not configured"** — You forgot to add the `ANTHROPIC_API_KEY` environment variable in Vercel. Go to project Settings → Environment Variables, add it, redeploy.

**"Invalid password"** — Wrong password, or the password was changed. Check the `APP_PASSWORD` env var in Vercel.

**Errors about credit balance** — Your Anthropic account is out of credits. Add credit at console.anthropic.com/settings/billing.

**Build fails on Vercel** — Make sure you uploaded the *contents* of the `title-analyzer` folder, not the folder itself. The `api/` folder, `public/` folder, `vercel.json`, and `package.json` should all be at the top level of your GitHub repository.
