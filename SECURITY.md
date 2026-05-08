# Security Policy

## Supported Versions

Only the latest production deployment of this project is actively maintained and supported.

| Version | Supported |
|---------|-----------|
| Latest (main branch) | ✅ |
| Older releases | ❌ |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please do **not** open a public GitHub issue. Disclosing vulnerabilities publicly before they are fixed puts users at risk.

Instead, please report vulnerabilities privately:

- **Email:** loganb205@yahoo.com
- **Subject line:** `[SECURITY] title-analyzer vulnerability report`

Please include:
- A description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any suggested fix if you have one

## What to Expect

- You will receive an acknowledgment within **72 hours**
- We will investigate and provide an update within **7 days**
- If the vulnerability is confirmed, we will work to release a fix as quickly as possible
- We will credit you for the discovery if you wish

## Scope

The following are **in scope** for security reports:

- Authentication bypass (password gate)
- API key exposure
- Cross-site scripting (XSS)
- Data exposure or leakage
- Server-side vulnerabilities in the `/api/analyze` function

The following are **out of scope:**

- Vulnerabilities in third-party services (Anthropic API, Vercel infrastructure)
- Issues requiring physical access to a device
- Social engineering attacks

## Important Notes

This project uses the Anthropic API. API keys and access passwords are stored as Vercel environment variables and are never committed to this repository. If you believe an API key has been exposed, please also notify Anthropic at **security@anthropic.com** and revoke the key immediately at **console.anthropic.com/settings/keys**.
