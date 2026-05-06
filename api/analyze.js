// Vercel Serverless Function — keeps the API key on the server side.
// The browser calls /api/analyze, this function adds the key and forwards to Anthropic.

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server. Set ANTHROPIC_API_KEY in Vercel environment variables.' });
  }

  // Optional shared password to prevent strangers from using your URL
  const requiredPassword = process.env.APP_PASSWORD;
  if (requiredPassword) {
    const providedPassword = req.headers['x-app-password'];
    if (providedPassword !== requiredPassword) {
      return res.status(401).json({ error: 'Invalid password.' });
    }
  }

  try {
    // Read body — Vercel parses JSON automatically when Content-Type is application/json
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { /* leave as-is */ }
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
