const PSI_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

function normalizeUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function auditProblem(audits, ids, message) {
  for (const id of ids) {
    const audit = audits[id];
    if (!audit) continue;
    if (typeof audit.score === 'number' && audit.score < 0.9) {
      return message;
    }
  }
  return null;
}

exports.handler = async (event) => {
  const url = normalizeUrl(event.queryStringParameters && event.queryStringParameters.url);
  if (!url) {
    return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Please enter a valid website address.' }) };
  }

  try {
    const endpoint = new URL(PSI_URL);
    endpoint.searchParams.set('url', url);
    endpoint.searchParams.set('strategy', 'mobile');
    endpoint.searchParams.append('category', 'performance');

    const response = await fetch(endpoint.toString(), { headers: { 'accept': 'application/json' } });
    const data = await response.json();

    if (!response.ok || !data.lighthouseResult) {
      const message = data && data.error && data.error.message ? data.error.message : 'We could not check that website right now.';
      return { statusCode: response.status || 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: message }) };
    }

    const lighthouse = data.lighthouseResult;
    const audits = lighthouse.audits || {};
    const score = Math.round((((lighthouse.categories || {}).performance || {}).score || 0) * 100);
    const lcp = audits['largest-contentful-paint'];
    const pageWeight = audits['total-byte-weight'];

    const findings = [
      auditProblem(audits, ['image-delivery-insight', 'uses-optimized-images', 'uses-responsive-images', 'modern-image-formats'], 'Your pictures may be heavier than they need to be. This is a common cause of slow pages.'),
      auditProblem(audits, ['server-response-time'], 'Your website may be taking too long to start responding.'),
      auditProblem(audits, ['render-blocking-resources'], 'Some page files are making visitors wait before the page can appear.'),
      auditProblem(audits, ['unused-javascript'], 'Your page is loading code it may not need right away.'),
      auditProblem(audits, ['font-display'], 'Your page may be waiting on fonts before showing some text.')
    ].filter(Boolean).slice(0, 3);

    if (!findings.length) {
      findings.push('We did not find one obvious public problem dominating this test. The site may need a broader check, or the slowdown may be intermittent.');
    }

    let headline;
    if (score >= 90) headline = 'Your site looks fairly fast in this test.';
    else if (score >= 50) headline = 'Your site could be faster.';
    else headline = 'Your site looks slow enough to deserve attention.';

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({
        requestedUrl: url,
        finalUrl: lighthouse.finalDisplayedUrl || lighthouse.finalUrl || url,
        score,
        headline,
        findings,
        loadMoment: lcp && lcp.displayValue ? lcp.displayValue : null,
        pageWeight: pageWeight && pageWeight.displayValue ? pageWeight.displayValue : null,
        note: 'This is a public mobile performance check. Results can vary a little from one test to another.'
      })
    };
  } catch (error) {
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'We could not run the check right now. Please try again in a moment.' }) };
  }
};
