// Scheduled every 15 minutes by vercel.json cron.
// Fetches X counts for the last 24h and stores in Vercel KV.
// Env: X_BEARER_TOKEN (X API v2 Bearer token)
// Env: KV_REST_API_URL, KV_REST_API_TOKEN (from Vercel KV)

import { kv } from '@vercel/kv';

const HASHTAG = '#21MWithPrivacy';
const INCLUDE_RETWEETS = true;  // set false to exclude retweets
const GRANULARITY = 'hour';     // "hour" is perfect for a 24h sparkline
const BUFFER_MS = 30 * 1000;    // avoid "too recent" window issues

const KEY_LATEST = 'hashtag:21MWithPrivacy:latest';
const KEY_HISTORY = 'hashtag:21MWithPrivacy:history'; // list of {ts,total}

export default async function handler(req, res) {
  try {
    const token = process.env.X_BEARER_TOKEN;
    if (!token) {
      return res.status(500).json({ error: 'Missing X_BEARER_TOKEN' });
    }

    const now = Date.now();
    const end = new Date(now - BUFFER_MS);
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const startISO = start.toISOString();
    const endISO = end.toISOString();

    let query = HASHTAG;
    if (!INCLUDE_RETWEETS) query += ' -is:retweet';

    const params = new URLSearchParams({
      query,
      start_time: startISO,
      end_time: endISO,
      granularity: GRANULARITY
    });

    // X (Twitter) Recent Post Counts endpoint
    const url = `https://api.x.com/2/tweets/counts/recent?${params.toString()}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    const rate = {
      remaining: r.headers.get('x-rate-limit-remaining'),
      limit: r.headers.get('x-rate-limit-limit'),
      reset: r.headers.get('x-rate-limit-reset'),
    };

    // If rate-limited, keep previous cache and exit gracefully
    if (r.status === 429) {
      return res.status(200).json({ ok: true, skipped: 'rate_limited', rate });
    }

    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: 'X API error', status: r.status, body, rate });
    }

    const data = await r.json();
    const per = (data?.data || []).map(d => ({
      start: d.start,
      end: d.end,
      count: d.tweet_count,
    }));

    const total = (data?.meta && typeof data.meta.total_tweet_count === 'number')
      ? data.meta.total_tweet_count
      : per.reduce((s, b) => s + (b.count || 0), 0);

    const payload = {
      hashtag: HASHTAG,
      include_retweets: INCLUDE_RETWEETS,
      granularity: GRANULARITY,
      start_time: startISO,
      end_time: endISO,
      total,
      per,
      fetched_at: new Date().toISOString(),
      rate_limit: rate,
    };

    // Store "latest"
    await kv.set(KEY_LATEST, payload);          // small JSON object
    // Append to rolling history (keep ~ 24h of 15-min snapshots = ~96 entries)
    await kv.lpush(KEY_HISTORY, JSON.stringify({ ts: Date.now(), total }));
    await kv.ltrim(KEY_HISTORY, 0, 100);

    return res.status(200).json({ ok: true, saved: { latest: KEY_LATEST, history_pushed: true }, rate });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
