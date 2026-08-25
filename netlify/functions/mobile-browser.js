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
  if (/API has not been used|disabled/i.test(message)) return 'The Google mobile speed service is not enabled for this project.';
  if (/quota/i.test(message)) return 'The Google mobile speed service has reached its usage limit.';
  if (/referer|referrer|restriction|forbidden|permission/i.test(message)) return 'Google rejected the security settings for this request.';
  if (/billing/i.test(message)) return 'Google says billing or account activation is required for this request.';
  if (status === 429) return 'Google is temporarily limiting speed-test requests.';
  if (status === 403) return 'Google returned a permission error for the mobile speed test.';
  if (status >= 500) return `Google's mobile speed test returned HTTP ${status}${message ? `: ${message.slice(0, 140)}` : '.'}`;
  return message ? message.slice(0, 180) : `Google returned HTTP ${status}.`;
}

exports.handler = async (event) => {
  const url = normalizeUrl(event.queryStringParameters && event.queryStringParameters.url);
  if (!url) {
    return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Please enter a valid website address.' }) };
  }

  const key = process.env.GOOGLE_PSI_API_KEY;
  if (!key) {
    return { statusCode: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ configured: false, available: false, diagnostic: 'The mobile speed test is not fully connected yet.' }) };
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
    if (status === 'good') text = 'Google’s phone test found strong performance. The site should feel quick for most mobile visitors.';
    else if (status === 'could-be-better') text = 'Google’s phone test found noticeable room for improvement. Fast Wi-Fi or strong 5G may hide some of this waiting.';
    else text = 'Google’s phone test found significant speed problems. Visitors on ordinary or weaker mobile connections are more likely to notice them.';

    const field = data.loadingExperience || {};
    const fieldMetrics = field.metrics || {};
    const fieldLcp = fieldMetric(fieldMetrics, 'LARGEST_CONTENTFUL_PAINT_MS', 1000);
    const fieldInp = fieldMetric(fieldMetrics, 'INTERACTION_TO_NEXT_PAINT', 1);
    const fieldCls = fieldMetric(fieldMetrics, 'CUMULATIVE_LAYOUT_SHIFT_SCORE', 100);
    const hasField = fieldLcp !== null || fieldInp !== null || fieldCls !== null;

    let realVisitors = null;
    if (hasField) {
      const parts = [];
      if (fieldLcp !== null) parts.push(`main content about ${fieldLcp.toFixed(1)} sec at the slower end of normal visits`);
      if (fieldInp !== null) parts.push(`tap/click response about ${Math.round(fieldInp)} ms`);
      if (fieldCls !== null) parts.push(`page movement ${fieldCls.toFixed(2)}`);
      realVisitors = { available: true, category: field.overall_category || null, text: `Google has enough real Chrome visitor data for this site. It shows ${parts.join(', ')}.` };
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({
        configured: true,
        available: true,
        label: 'Google phone speed test',
        status,
        text,
        detail: `Google mobile score: ${score}/100; main content ${msToSeconds(lcpMs) || 'n/a'}; first visible content ${msToSeconds(fcpMs) || 'n/a'}; browser waiting ${Number.isFinite(tbtMs) ? Math.round(tbtMs) + ' ms' : 'n/a'}; page movement ${Number.isFinite(cls) ? cls.toFixed(2) : 'n/a'}`,
        realVisitors,
        note: 'Google tests the site as if it were being opened on a phone. Actual results still vary by phone, signal strength, carrier, and location.'
      })
    };
  } catch (error) {
    const diagnostic = error && error.name === 'AbortError'
      ? 'Google’s phone speed test took longer than 55 seconds and was stopped.'
      : 'Google’s phone speed test did not return a usable result.';
    return { statusCode: 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ configured: true, available: false, diagnostic }) };
  }
};
