function normalizeUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch { return null; }
}

function statusFromScore(score) {
  if (score >= 90) return 'good';
  if (score >= 50) return 'could-be-better';
  return 'needs-attention';
}

function msToSeconds(value) {
  return Number.isFinite(value) ? `${(value / 1000).toFixed(1)} sec` : null;
}

function metricValue(audits, id) {
  const audit = audits && audits[id];
  return audit && Number.isFinite(audit.numericValue) ? audit.numericValue : null;
}

function fieldMetric(metrics, key, divisor = 1) {
  const metric = metrics && metrics[key];
  if (!metric || !Number.isFinite(metric.percentile)) return null;
  return metric.percentile / divisor;
}

function safeGoogleError(data, status) {
  const message = data && data.error && data.error.message ? String(data.error.message) : '';
  if (/API key not valid/i.test(message)) return 'Google rejected the API key.';
  if (/API has not been used|disabled/i.test(message)) return 'The PageSpeed Insights API is not enabled for this Google project.';
  if (/quota/i.test(message)) return 'Google PageSpeed quota was exceeded.';
  if (/referer|referrer|restriction|forbidden|permission/i.test(message)) return 'Google rejected the API-key restrictions for this server request.';
  if (/billing/i.test(message)) return 'Google says billing or account activation is required for this request.';
  if (status === 429) return 'Google is rate-limiting PageSpeed requests.';
  if (status === 403) return 'Google returned a permission error for the PageSpeed request.';
  if (status >= 500) return `Google PageSpeed returned HTTP ${status}${message ? `: ${message.slice(0, 140)}` : '.'}`;
  return message ? message.slice(0, 180) : `Google returned HTTP ${status}.`;
}

exports.handler = async (event) => {
  const url = normalizeUrl(event.queryStringParameters && event.queryStringParameters.url);
  if (!url) {
    return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Please enter a valid website address.' }) };
  }

  const key = process.env.GOOGLE_PSI_API_KEY;
  if (!key) {
    return { statusCode: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ configured: false, available: false, diagnostic: 'The Netlify function cannot see GOOGLE_PSI_API_KEY.' }) };
  }

  try {
    const endpoint = new URL('https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed');
    endpoint.searchParams.set('url', url);
    endpoint.searchParams.set('strategy', 'mobile');
    endpoint.searchParams.set('category', 'performance');
    endpoint.searchParams.set('key', key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55000);
    let response;
    try {
      response = await fetch(endpoint.toString(), { headers: { accept: 'application/json' }, signal: controller.signal });
    } finally { clearTimeout(timer); }

    let data = {};
    try { data = await response.json(); } catch {}

    if (!response.ok || !data.lighthouseResult) {
      return {
        statusCode: 502,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({ configured: true, available: false, diagnostic: safeGoogleError(data, response.status), googleStatus: response.status })
      };
    }

    const lighthouse = data.lighthouseResult;
    const audits = lighthouse.audits || {};
    const score = Math.round((((lighthouse.categories || {}).performance || {}).score || 0) * 100);
    const status = statusFromScore(score);
    const lcpMs = metricValue(audits, 'largest-contentful-paint');
    const fcpMs = metricValue(audits, 'first-contentful-paint');
    const tbtMs = metricValue(audits, 'total-blocking-time');
    const cls = metricValue(audits, 'cumulative-layout-shift');

    let text;
    if (status === 'good') text = 'A simulated mobile browser also found strong performance. This is a tougher test than simply checking whether the server responds quickly.';
    else if (status === 'could-be-better') text = 'A simulated mobile browser found noticeable room for improvement. Fast Wi-Fi or strong 5G may hide some of this waiting.';
    else text = 'A simulated mobile browser found significant performance problems. Visitors on ordinary or weaker mobile conditions are more likely to notice them.';

    const field = data.loadingExperience || {};
    const fieldMetrics = field.metrics || {};
    const fieldLcp = fieldMetric(fieldMetrics, 'LARGEST_CONTENTFUL_PAINT_MS', 1000);
    const fieldInp = fieldMetric(fieldMetrics, 'INTERACTION_TO_NEXT_PAINT', 1);
    const fieldCls = fieldMetric(fieldMetrics, 'CUMULATIVE_LAYOUT_SHIFT_SCORE', 100);
    const hasField = fieldLcp !== null || fieldInp !== null || fieldCls !== null;

    let realVisitors = null;
    if (hasField) {
      const parts = [];
      if (fieldLcp !== null) parts.push(`main content about ${fieldLcp.toFixed(1)} sec at the 75th percentile`);
      if (fieldInp !== null) parts.push(`interaction response about ${Math.round(fieldInp)} ms`);
      if (fieldCls !== null) parts.push(`layout shift ${fieldCls.toFixed(2)}`);
      realVisitors = { available: true, category: field.overall_category || null, text: `Google has enough Chrome usage data for this site. Among real visitors, ${parts.join(', ')}.` };
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({
        configured: true,
        available: true,
        label: 'Simulated phone browser',
        status,
        text,
        detail: `Lighthouse mobile test: ${score}/100; main content ${msToSeconds(lcpMs) || 'n/a'}; first content ${msToSeconds(fcpMs) || 'n/a'}; browser blocking ${Number.isFinite(tbtMs) ? Math.round(tbtMs) + ' ms' : 'n/a'}; layout shift ${Number.isFinite(cls) ? cls.toFixed(2) : 'n/a'}`,
        realVisitors,
        note: 'This is an actual Lighthouse mobile-browser simulation. Google still cannot reproduce every phone, signal strength, carrier, or location.'
      })
    };
  } catch (error) {
    const diagnostic = error && error.name === 'AbortError'
      ? 'The Google PageSpeed request took longer than 55 seconds and was stopped.'
      : 'The PageSpeed request failed before Google returned a usable result.';
    return { statusCode: 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ configured: true, available: false, diagnostic }) };
  }
};
