/**
 * Spike Radar — background watcher (Cloudflare Worker, free plan)
 * Runs on a cron trigger (every 2 minutes) and pushes alerts to your phone through the ntfy app,
 * even when Spike Radar is closed.
 *
 * Required bindings / variables (Worker → Settings):
 *   ALERTS       KV namespace binding
 *   FINNHUB_KEY  your Finnhub API key (Secret)
 *   NTFY_TOPIC   your private ntfy topic (same one as in the app)
 * Optional:
 *   APP_URL      link to your Spike Radar app (tapping a notification opens it)
 *   TICKERS      comma-separated list (defaults to the app's 30)
 *   THR=7  WARN=4  (alert thresholds in %)
 *
 * Test it: open https://<your-worker>.workers.dev/test  → sends a test push.
 *          open https://<your-worker>.workers.dev/run   → runs one check now and shows what it saw.
 */
const DEFAULT_TICKERS = "SNDK,MU,AMD,MRVL,VST,AVGO,CRWV,QCOM,NVDA,CEG,SPY,QQQ,SMH,XLK,IWM,XLU,DIA,MSFT,AAPL,GOOGL,AMZN,META,TSLA,ORCL,PLTR,TSM,GEV,VRT,NBIS,IREN";
const LOSERS_COUNT = 10;
const AUX = ["VIXY", "TLT"];

const POL = /\b(congress|senate|house (democrats|republicans|speaker)|midterm|election|governor|white house|trump|democrat|republican|gop|lawmaker|legislat|bill\b|moratorium|executive order|antitrust|ftc|doj\b|tariff|sanction|export (control|ban|curb)|regulat|subpoena|hearing|shutdown|china|beijing|taiwan|russia|iran|commerce department|supreme court|veto)/i;
const FED = /\b(fed\b|federal reserve|powell|fomc|rate (hike|cut)|interest rate|inflation|cpi\b|ppi\b|payrolls|jobs report|unemployment|treasury|yields?\b|recession)/i;
const AI = /\b(ai\b|artificial intelligence|data.?cent|chips?\b|semiconductor|gpu|capex|hyperscaler|power demand|nuclear|grid|memory|hbm)/i;
const NEG = /\b(plunge|plummet|crash|tumble|sink|slump|slide|fall|falls|fell|drop|cut|ban|probe|investigat|lawsuit|downgrade|miss|warn|halt|pause|moratorium|block|reject|delay|fear|sell-?off|tariff|sanction|restrict|curb|crackdown|scrutiny|hike|weak)/gi;
const POS = /\b(surge|soar|jump|rally|rise|gain|beat|upgrade|approve|record|deal|boost|strong|rebound|ease|relief|exempt|truce)/gi;
const FLIP = /\b(reject|block|lift|end|scrap|overturn|drop|pause|delay|ease|kill|strike down|veto)\w*\s+(\S+\s+){0,3}(ban|moratorium|tariffs?|restrictions?|sanctions?|probe|curbs?|rules?|hike)/i;

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); },
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path === "/test") {
      await push(env, { title: "Spike Radar watcher is connected", message: "Background alerts will arrive here.", priority: 4, tags: ["white_check_mark"] });
      return new Response("Test push sent to " + env.NTFY_TOPIC);
    }
    if (path === "/run") return Response.json(await run(env, true));
    return new Response("Spike Radar watcher is running. Try /test or /run.");
  },
};

function nyClock() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  const h = +g("hour") % 24, m = +g("minute"), wd = g("weekday");
  const mins = h * 60 + m, weekday = !["Sat", "Sun"].includes(wd);
  return { day: `${g("year")}-${g("month")}-${g("day")}`, h, mins, weekday, open: weekday && mins >= 570 && mins <= 965 };
}

async function fh(env, path) {
  const r = await fetch(`https://finnhub.io/api/v1/${path}${path.includes("?") ? "&" : "?"}token=${env.FINNHUB_KEY}`);
  if (!r.ok) throw new Error("finnhub " + r.status);
  return r.json();
}

async function push(env, { title, message, priority = 3, tags = [] }) {
  if (!env.NTFY_TOPIC) return;
  const body = { topic: env.NTFY_TOPIC, title: title.slice(0, 250), message: message.slice(0, 3500), priority, tags };
  if (env.APP_URL) body.click = env.APP_URL;
  await fetch("https://ntfy.sh/", { method: "POST", body: JSON.stringify(body) });
}

const pct = (v, d = 1) => (v > 0 ? "+" : "") + (v * 100).toFixed(d) + "%";

async function run(env, verbose = false) {
  const clk = nyClock();
  const THR = (+env.THR || 7) / 100, WARN = (+env.WARN || 4) / 100;
  const tickers = (env.TICKERS || DEFAULT_TICKERS).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);
  let state = (await env.ALERTS.get("state", "json")) || {};
  if (state.day !== clk.day) state = { day: clk.day, fired: {}, seen: (state.seen || []).slice(-300), lastNews: state.lastNews || 0, lastDigest: state.lastDigest || 0 };
  let dirty = false;
  const lines = [], report = { clock: clk, alerts: [], news: [] };
  let topPriority = 0;
  const mark = (key) => { if (state.fired[key]) return false; state.fired[key] = 1; dirty = true; return true; };

  /* ---------- price checks (market hours) ---------- */
  if (clk.open || verbose) {
    const syms = [...tickers, ...AUX], q = {};
    for (let i = 0; i < syms.length; i += 10) {
      await Promise.all(syms.slice(i, i + 10).map(async (s) => {
        try { const d = await fh(env, "quote?symbol=" + s); if (d && d.c && d.pc) q[s] = { c: d.c, dp: d.c / d.pc - 1 }; } catch (e) {}
      }));
      await new Promise((r) => setTimeout(r, 400));
    }
    for (const s of tickers) {
      const x = q[s]; if (!x) continue;
      if (Math.abs(x.dp) >= THR) {
        if (mark(s + ":spike")) { lines.push(`${x.dp > 0 ? "🚀" : "🔻"} ${s} ${pct(x.dp)} at $${x.c.toFixed(2)} — past your ±${Math.round(THR * 1000) / 10}% line`); topPriority = Math.max(topPriority, 5); }
      } else if (Math.abs(x.dp) >= WARN) {
        if (mark(s + ":warn" + (x.dp > 0 ? "u" : "d"))) { lines.push(`⚠️ ${s} ${pct(x.dp)} — early warning`); topPriority = Math.max(topPriority, 3); }
      }
    }
    // storm signals (same ideas as the app's gauge)
    const have = tickers.filter((s) => q[s]);
    const down = have.filter((s) => q[s].dp <= -0.02).length;
    const losers = tickers.slice(0, LOSERS_COUNT).filter((s) => q[s]);
    const lAvg = losers.length ? losers.reduce((a, s) => a + q[s].dp, 0) / losers.length : 0;
    const sig = [];
    if (q.VIXY && q.VIXY.dp >= 0.1) sig.push(`fear gauge ${pct(q.VIXY.dp)}`);
    if (q.SMH && q.SMH.dp <= -0.03) sig.push(`chips ${pct(q.SMH.dp)}`);
    if (have.length && down / have.length >= 0.5) sig.push(`${down}/${have.length} names down 2%+`);
    if (lAvg <= -0.04) sig.push(`Nov 5 losers avg ${pct(lAvg)}`);
    if (q.QQQ && q.SPY && q.QQQ.dp - q.SPY.dp <= -0.012) sig.push(`tech lagging S&P by ${pct(q.QQQ.dp - q.SPY.dp)}`);
    if (q.VIXY && q.VIXY.dp <= -0.08) sig.push(`fear collapsing ${pct(q.VIXY.dp)} (Nov 4-style complacency)`);
    if (sig.length >= 3 && mark("storm3")) { state.fired.storm2 = 1; lines.unshift(`🌩️ STORM WARNING: ${sig.join(", ")}`); topPriority = 5; }
    else if (sig.length >= 2 && !state.fired.storm3 && mark("storm2")) { lines.unshift(`🌩️ Storm watch: ${sig.join(", ")}`); topPriority = Math.max(topPriority, 4); }
    report.quotes = q; report.signals = sig;
  }

  /* ---------- news: high-impact checks every 10 min, digest every hour (6am–11pm ET, every day) ---------- */
  const now = Date.now();
  if ((now - (state.lastNews || 0) >= 10 * 60e3 && clk.h >= 6 && clk.h <= 23) || verbose) {
    state.lastNews = now; dirty = true;
    let news = [];
    try { news = await fh(env, "news?category=general"); } catch (e) {}
    const seen = new Set(state.seen || []);
    const scored = news.filter((n) => n.url && n.datetime * 1000 > now - 70 * 60e3).map((n) => {
      const txt = `${n.headline} ${n.summary || ""}`;
      let neg = (txt.match(NEG) || []).length, pos = (txt.match(POS) || []).length;
      if (FLIP.test(txt)) { pos += 2; neg = Math.max(0, neg - 2); }
      const pol = POL.test(txt), fed = FED.test(txt), ai = AI.test(txt);
      const tick = tickers.filter((t) => new RegExp("\\b" + t + "\\b").test(n.headline));
      const impact = Math.min(5, 1 + (pol ? 2 : 0) + (fed ? 1 : 0) + (ai ? 1 : 0) + (tick.length ? 1 : 0));
      return { url: n.url, headline: n.headline, source: n.source, pol, fed, ai, tick, impact, sent: pos - neg };
    }).filter((n) => n.pol || n.fed || n.ai || n.tick.length);
    // immediate political risk alerts
    for (const n of scored) {
      if (n.pol && n.sent < 0 && n.impact >= 4 && !seen.has(n.url)) {
        seen.add(n.url);
        lines.push(`🏛️ Political risk: ${n.headline} (${n.source})`); topPriority = Math.max(topPriority, 4);
      }
    }
    // hourly digest
    if (now - (state.lastDigest || 0) >= 58 * 60e3 && scored.length) {
      state.lastDigest = now;
      const top = scored.sort((a, b) => (b.pol - a.pol) || (b.impact - a.impact)).slice(0, 6);
      const polCount = scored.filter((n) => n.pol).length;
      const tone = scored.reduce((a, n) => a + Math.sign(n.sent) * n.impact, 0);
      await push(env, {
        title: `📰 Hourly: ${polCount} political, ${scored.length} market-moving headlines · tone ${tone > 2 ? "positive" : tone < -2 ? "negative" : "mixed"}`,
        message: top.map((n) => `${n.sent < 0 ? "▼" : n.sent > 0 ? "▲" : "•"} ${n.pol ? "[Politics] " : n.fed ? "[Fed] " : "[AI] "}${n.headline}`).join("\n"),
        priority: 3, tags: ["newspaper"],
      });
      report.digest = top.length;
    }
    state.seen = [...seen].slice(-300);
    report.news = scored.slice(0, 10);
  }

  if (lines.length) {
    await push(env, { title: lines[0].slice(0, 120), message: lines.join("\n"), priority: topPriority || 3, tags: ["chart_with_downwards_trend"] });
    report.alerts = lines;
  }
  if (dirty) await env.ALERTS.put("state", JSON.stringify(state), { expirationTtl: 60 * 60 * 24 * 3 });
  return verbose ? report : { ok: true };
}
