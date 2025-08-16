// Read-only endpoint for your UI. No calls to X here.
// Returns the most recently cached payload plus a small rolling history.

import { kv } from '@vercel/kv';

const KEY_LATEST = 'hashtag:21MWithPrivacy:latest';
const KEY_HISTORY = 'hashtag:21MWithPrivacy:history';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');

  try {
    const latest = await kv.get(KEY_LATEST);
    const historyRaw = await kv.lrange(KEY_HISTORY, 0, 100);
    const history = (historyRaw || []).map(x => {
      try { return JSON.parse(x); } catch { return null; }
    }).filter(Boolean);

    if (!latest) {
      return res.status(200).json({ ready: false, note: 'No data cached yet. Wait for the cron to run.' });
    }

    return res.status(200).json({
      ready: true,
      ...latest,
      history
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
