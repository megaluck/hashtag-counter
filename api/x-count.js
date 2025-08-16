// api/x-count.js
const BUFFER_MS = 30 * 1000;
const CACHE_SECONDS = 900;           // 15 minutes at the edge to avoid rate hits
const GRANULARITY_DEFAULT = "hour";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=600`);

  try {
    const { q, granularity = GRANULARITY_DEFAULT, retweets = "1" } = req.query || {};
    if (!q) return res.status(400).json({ error: "Missing ?q=" });

    const token = process.env.X_BEARER_TOKEN;
    if (!token) return res.status(500).json({ error: "Missing X_BEARER_TOKEN env" });

    const now = Date.now();
    const end = new Date(now - BUFFER_MS);
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

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

    // If rate-limited, tell client exactly when to retry
    if (r.status === 429) {
      const resetEpoch = Number(rate.reset);
      const retryAt = isFinite(resetEpoch) ? new Date(resetEpoch * 1000) : new Date(Date.now() + 15 * 60 * 1000);
      const retryAfterSec = Math.max(1, Math.ceil((retryAt - new Date()) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(200).json({
        query: q, evaluated_query: xQuery,
        start_time: start.toISOString(), end_time: end.toISOString(),
        total: null, per: [],
        note: "Rate-limited by X; retry after reset.",
        rate_limit: rate,
        retry_at: retryAt.toISOString(),
        retry_after_ms: Math.max(0, retryAt - new Date()),
      });
    }

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: "X API error", status: r.status, body: text, rate_limit: rate });
    }

    const data = await r.json();
    const per = (data?.data || []).map(d => ({ start: d.start, end: d.end, count: d.tweet_count }));
    const total = (data?.meta && typeof data.meta.total_tweet_count === "number")
      ? data.meta.total_tweet_count
      : per.reduce((s, b) => s + (b.count || 0), 0);

    return res.status(200).json({
      query: q, evaluated_query: xQuery,
      start_time: start.toISOString(), end_time: end.toISOString(),
      total, granularity, per, rate_limit: rate,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
