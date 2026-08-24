const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_HTML_BYTES = 2_000_000;
const MAX_IMAGES_TO_CHECK = 24;
const FETCH_TIMEOUT_MS = 8000;

function normalizeUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isPrivateIp(address) {
  if (!address) return true;
  if (address === '::1' || address === '::' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return true;
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (net.isIPv4(address)) {
    const p = address.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] >= 224);
  }
  return false;
}

async function assertPublicHost(url) {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('That address cannot be checked.');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('That address cannot be checked.');
    return;
  }
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(x => isPrivateIp(x.address))) throw new Error('That address cannot be checked.');
}

async function fetchWithSafeRedirects(startUrl, options = {}) {
  let current = new URL(startUrl.toString());
  for (let i = 0; i < 5; i++) {
    await assertPublicHost(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current.toString(), {
        method: options.method || 'GET',
        redirect: 'manual',
        headers: { 'user-agent': 'EMC2Digital-WebsiteCheck/1.0', 'accept': options.accept || '*/*' },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return { response, url: current };
      current = new URL(location, current);
      if (!['http:', 'https:'].includes(current.protocol)) throw new Error('That website redirects somewhere we cannot check.');
      continue;
    }
    return { response, url: current };
  }
  throw new Error('That website redirects too many times.');
}

function absoluteUrl(value, base) {
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) return null;
  try {
    const u = new URL(value, base);
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null;
  } catch { return null; }
}

function extractAssets(html, baseUrl) {
  const images = [];
  const scripts = [];
  const styles = [];
  let m;
  const imgRe = /<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;
  while ((m = imgRe.exec(html)) !== null) {
    const u = absoluteUrl(m[1], baseUrl);
    if (u) images.push(u);
  }
  const scriptRe = /<script\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;
  while ((m = scriptRe.exec(html)) !== null) {
    const u = absoluteUrl(m[1], baseUrl);
    if (u) scripts.push(u);
  }
  const linkRe = /<link\b[^>]*?\brel=["'][^"']*stylesheet[^"']*["'][^>]*?\bhref=["']([^"']+)["'][^>]*>|<link\b[^>]*?\bhref=["']([^"']+)["'][^>]*?\brel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const u = absoluteUrl(m[1] || m[2], baseUrl);
    if (u) styles.push(u);
  }
  return { images: [...new Set(images)], scripts: [...new Set(scripts)], styles: [...new Set(styles)] };
}

async function headSize(urlString) {
  try {
    const u = new URL(urlString);
    const { response } = await fetchWithSafeRedirects(u, { method: 'HEAD', timeout: 4500 });
    const len = Number(response.headers.get('content-length'));
    const type = response.headers.get('content-type') || '';
    return { url: urlString, bytes: Number.isFinite(len) && len > 0 ? len : null, type };
  } catch {
    return { url: urlString, bytes: null, type: '' };
  }
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

exports.handler = async (event) => {
  const startUrl = normalizeUrl(event.queryStringParameters && event.queryStringParameters.url);
  if (!startUrl) {
    return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Please enter a website address, such as example.com.' }) };
  }

  try {
    const started = Date.now();
    const { response, url: finalUrl } = await fetchWithSafeRedirects(startUrl, { accept: 'text/html,application/xhtml+xml' });
    const responseMs = Date.now() - started;

    if (!response.ok) throw new Error('The website did not respond normally when we checked it.');
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) throw new Error('That address does not appear to be a normal web page.');

    const html = await response.text();
    const htmlBytes = Buffer.byteLength(html, 'utf8');
    if (htmlBytes > MAX_HTML_BYTES) throw new Error('That page is unusually large, so this quick check stopped before downloading more of it.');

    const assets = extractAssets(html, finalUrl);
    const imageInfo = await Promise.all(assets.images.slice(0, MAX_IMAGES_TO_CHECK).map(headSize));
    const sizedImages = imageInfo.filter(x => Number.isFinite(x.bytes));
    const knownImageBytes = sizedImages.reduce((sum, x) => sum + x.bytes, 0);
    const largeImages = sizedImages.filter(x => x.bytes >= 500_000).sort((a,b) => b.bytes - a.bytes);
    const veryLargeImages = sizedImages.filter(x => x.bytes >= 1_000_000);
    const totalFiles = assets.images.length + assets.scripts.length + assets.styles.length;

    const findings = [];
    if (veryLargeImages.length) {
      findings.push(`We found ${veryLargeImages.length} picture${veryLargeImages.length === 1 ? '' : 's'} over 1 MB. Large pictures are one of the most common reasons a page feels slow.`);
    } else if (largeImages.length) {
      findings.push(`We found ${largeImages.length} fairly large picture${largeImages.length === 1 ? '' : 's'}. They may be slowing the page more than necessary.`);
    } else if (assets.images.length && sizedImages.length) {
      findings.push('The pictures we could measure do not look unusually large.');
    }

    if (responseMs > 1800) findings.push('The website took a while to answer our request. The slowdown may begin before the page files even start loading.');
    else if (responseMs > 900) findings.push('The website response was a little slow in this check.');

    if (totalFiles >= 45) findings.push(`This page calls for a lot of separate files (${totalFiles} pictures, scripts, and stylesheets). That can add waiting time, especially on phones.`);
    else if (totalFiles >= 28) findings.push(`This page loads quite a few separate files (${totalFiles}). That may contribute to slower loading.`);

    if (!findings.length) findings.push('We did not find one obvious public problem in this quick check. A deeper browser-based test may be needed to find the slowdown.');

    let score = 100;
    score -= Math.min(35, veryLargeImages.length * 12 + Math.max(0, largeImages.length - veryLargeImages.length) * 6);
    if (responseMs > 1800) score -= 25; else if (responseMs > 900) score -= 12;
    if (totalFiles >= 45) score -= 18; else if (totalFiles >= 28) score -= 8;
    if (knownImageBytes > 8_000_000) score -= 15; else if (knownImageBytes > 4_000_000) score -= 8;
    score = Math.max(20, Math.min(100, score));

    let headline = 'Nothing obvious jumped out in this first look.';
    if (score < 55) headline = 'We found signs that could explain a slow website.';
    else if (score < 80) headline = 'We found a few things worth improving.';

    const biggest = largeImages[0];
    if (biggest) {
      findings.unshift(`Biggest picture we measured: ${humanBytes(biggest.bytes)}.`);
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({
        requestedUrl: startUrl.toString(),
        finalUrl: finalUrl.toString(),
        score,
        headline,
        findings: findings.slice(0, 4),
        loadMoment: `${(responseMs / 1000).toFixed(1)} sec to receive the page`,
        pageWeight: knownImageBytes ? `${humanBytes(knownImageBytes)} in measured pictures` : `${humanBytes(htmlBytes)} page text/code`,
        fileCount: totalFiles,
        note: 'This is a quick public first look, not a full browser speed test.'
      })
    };
  } catch (error) {
    const safeMessage = error && error.message && !/ENOTFOUND|EAI_AGAIN|ECONN|fetch failed|aborted/i.test(error.message)
      ? error.message
      : 'We could not reach that website right now. Check the address and try again.';
    return { statusCode: 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: safeMessage }) };
  }
};
