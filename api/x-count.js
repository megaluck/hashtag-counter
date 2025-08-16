// Counts hashtag (or any X/Twitter query) mentions in the last 24h.
// Env: X_BEARER_TOKEN (X API v2 Bearer token)
//
// Deploy on Vercel:
// - Put this file at /api/x-count.js
// - Set Project → Settings → Environment Variables → X_BEARER_TOKEN
//
// Usage examples:
//   /api/x-count?q=%23zec               (counts #zec, includes retweets)
//   /api/x-count?q=%23zec&retweets=0    (exclude retweets)
//   /api/x-count?q=%24ZEN               (cashtag)
//   /api/x-count?q=%23zec%20OR%20%24ZEC (combined rule)
//
// Returns:
//   { total, per: [{start,end,count}], rate_limit: {...}, ... }

const BUFFER_MS = 30 * 1000;      // avoid "too recent" errors by ending a bit before now
const CACHE_SECONDS = 60;          // CDN edge cache
const GRANULARITY_DEFAULT = "hour";// "minute" | "hour" | "day"

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=600`);

  try {
    const { q, granularity = GRANULARITY_DEFAULT, retweets = "1" } = req.query || {};
    if (!q) {
      return res.status(400).json({ error: "Missing ?q= query (e.g., %23zec for #zec)" });
    }

    const token = process.env.X_BEARER_TOKEN;
    if (!token) {
      return res.status(500).json({ error: "Server not configured: missing X_BEARER_TOKEN env" });
    }

    const now = Date.now();
    const end = new Date(now - BUFFER_MS);
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000); // last 24h

    let xQuery = q;
    if (retweets === "0") xQuery += " -is:retweet";

    const params = new URLSearchParams({
      query: xQuery,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      granularity,
    });

    const url = `https://api.x.com/2/tweets/counts/recent?${params.toString()}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    const rate = {
      remaining: r.headers.get("x-rate-limit-remaining"),
      limit: r.headers.get("x-rate-limit-limit"),
      reset: r.headers.get("x-rate-limit-reset"),
    };

    if (r.status === 429) {
      return res.status(200).json({
        query: q,
        evaluated_query: xQuery,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        total: null,
        per: [],
        note: "Rate-limited by X; retry after reset.",
        rate_limit: rate,
      });
    }

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: "X API error", status: r.status, body: text, rate_limit: rate });
    }

    const data = await r.json();
    const per = (data?.data || []).map(d => ({
      start: d.start,
      end: d.end,
      count: d.tweet_count,
    }));

    const total =
      (data?.meta && typeof data.meta.total_tweet_count === "number")
        ? data.meta.total_tweet_count
        : per.reduce((sum, b) => sum + (b.count || 0), 0);

    return res.status(200).json({
      query: q,
      evaluated_query: xQuery,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      total,
      granularity,
      per,
      rate_limit: rate,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
