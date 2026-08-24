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

exports.handler = async (event) => {
  const url = normalizeUrl(event.queryStringParameters && event.queryStringParameters.url);
  if (!url) {
    return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Please enter a valid website address.' }) };
  }

  const key = process.env.GOOGLE_PSI_API_KEY;
  if (!key) {
    return { statusCode: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ configured: false }) };
  }

  try {
    const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    endpoint.searchParams.set('url', url);
    endpoint.searchParams.set('strategy', 'mobile');
    endpoint.searchParams.set('category', 'performance');
    endpoint.searchParams.set('key', key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    let response;
    try {
      response = await fetch(endpoint.toString(), { headers: { accept: 'application/json' }, signal: controller.signal });
    } finally { clearTimeout(timer); }

    const data = await response.json();
    if (!response.ok || !data.lighthouseResult) {
      return { statusCode: 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ configured: true, available: false }) };
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
      realVisitors = {
        available: true,
        category: field.overall_category || null,
        text: `Google has enough Chrome usage data for this site. Among real visitors, ${parts.join(', ')}.`
      };
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
  } catch {
    return { statusCode: 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ configured: true, available: false }) };
  }
};
