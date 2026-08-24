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
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed;
  } catch { return null; }
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
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
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
        method: options.method || 'GET', redirect: 'manual',
        headers: { 'user-agent': 'EMC2Digital-WebsiteCheck/1.0', 'accept': options.accept || '*/*' },
        signal: controller.signal
      });
    } finally { clearTimeout(timer); }
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
  try { const u = new URL(value, base); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null; }
  catch { return null; }
}

function extractAssets(html, baseUrl) {
  const images = [], scripts = [], styles = []; let m;
  const imgRe = /<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;
  while ((m = imgRe.exec(html)) !== null) { const u = absoluteUrl(m[1], baseUrl); if (u) images.push(u); }
  const scriptRe = /<script\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;
  while ((m = scriptRe.exec(html)) !== null) { const u = absoluteUrl(m[1], baseUrl); if (u) scripts.push(u); }
  const linkRe = /<link\b[^>]*?\brel=["'][^"']*stylesheet[^"']*["'][^>]*?\bhref=["']([^"']+)["'][^>]*>|<link\b[^>]*?\bhref=["']([^"']+)["'][^>]*?\brel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) { const u = absoluteUrl(m[1] || m[2], baseUrl); if (u) styles.push(u); }
  return { images: [...new Set(images)], scripts: [...new Set(scripts)], styles: [...new Set(styles)] };
}

async function headSize(urlString) {
  try {
    const { response } = await fetchWithSafeRedirects(new URL(urlString), { method: 'HEAD', timeout: 4500 });
    const len = Number(response.headers.get('content-length'));
    return { url: urlString, bytes: Number.isFinite(len) && len > 0 ? len : null };
  } catch { return { url: urlString, bytes: null }; }
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function rank(statuses) {
  if (statuses.includes('needs-attention')) return 'needs-attention';
  if (statuses.includes('could-be-better')) return 'could-be-better';
  return 'good';
}

exports.handler = async (event) => {
  const startUrl = normalizeUrl(event.queryStringParameters && event.queryStringParameters.url);
  if (!startUrl) return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Please enter a website address, such as example.com.' }) };

  try {
    const started = Date.now();
    const { response, url: finalUrl } = await fetchWithSafeRedirects(startUrl, { accept: 'text/html,application/xhtml+xml' });
    const responseMs = Date.now() - started;
    if (!response.ok) throw new Error('The website did not respond normally when we checked it.');
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) throw new Error('That address does not appear to be a normal web page.');

    const html = await response.text();
    const htmlBytes = Buffer.byteLength(html, 'utf8');
    if (htmlBytes > MAX_HTML_BYTES) throw new Error('That page is unusually large, so this check stopped before downloading more of it.');

    const assets = extractAssets(html, finalUrl);
    const imageInfo = await Promise.all(assets.images.slice(0, MAX_IMAGES_TO_CHECK).map(headSize));
    const sizedImages = imageInfo.filter(x => Number.isFinite(x.bytes));
    const knownImageBytes = sizedImages.reduce((sum, x) => sum + x.bytes, 0);
    const largeImages = sizedImages.filter(x => x.bytes >= 500_000).sort((a,b) => b.bytes - a.bytes);
    const veryLargeImages = sizedImages.filter(x => x.bytes >= 1_000_000);
    const totalFiles = assets.images.length + assets.scripts.length + assets.styles.length;

    let responseStatus = 'good';
    let responseText = 'Your website starts responding quickly. That is a good sign for visitors.';
    if (responseMs > 1800) { responseStatus = 'needs-attention'; responseText = 'Your website is slow to start responding. Visitors may be waiting before the page even begins to appear.'; }
    else if (responseMs > 900) { responseStatus = 'could-be-better'; responseText = 'Your website is a little slower than we would like at the start. There may be room to improve the server or hosting response.'; }

    let imageStatus = 'good';
    let imageText = assets.images.length ? 'Your homepage pictures are not unusually heavy based on the images we could measure.' : 'We did not find normal image files on this page to measure.';
    if (veryLargeImages.length || knownImageBytes > 8_000_000) { imageStatus = 'needs-attention'; imageText = 'Your pictures are heavy enough that they can noticeably slow visitors, especially on phones or weaker connections.'; }
    else if (largeImages.length || knownImageBytes > 4_000_000) { imageStatus = 'could-be-better'; imageText = 'Your pictures are reasonable, but we see room to make them lighter for mobile visitors without necessarily making them look worse.'; }

    let complexityStatus = 'good';
    let complexityText = 'Your homepage is not asking the browser to load an unusually large number of separate files.';
    if (totalFiles >= 45) { complexityStatus = 'needs-attention'; complexityText = 'Your homepage asks the browser to load a lot of separate files. That can add noticeable waiting time on slower devices and connections.'; }
    else if (totalFiles >= 28) { complexityStatus = 'could-be-better'; complexityText = 'Your homepage loads quite a few separate files. This may add some waiting time, particularly on phones.'; }

    const overall = rank([responseStatus, imageStatus, complexityStatus]);
    const overallLabel = overall === 'good' ? 'GOOD' : overall === 'could-be-better' ? 'COULD BE BETTER' : 'NEEDS ATTENTION';
    const headline = overall === 'good' ? 'Your website passed our basic speed check.' : overall === 'could-be-better' ? 'Your website is usable, but we found room to make it faster.' : 'We found speed issues worth fixing.';
    const summary = overall === 'good'
      ? 'We did not find an obvious speed problem in the areas we tested.'
      : overall === 'could-be-better'
        ? 'Nothing looks disastrous, but one or more areas could create extra waiting for some visitors.'
        : 'One or more areas can create noticeable delays, especially for mobile visitors or slower connections.';

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({
        requestedUrl: startUrl.toString(), finalUrl: finalUrl.toString(),
        overall, overallLabel, headline, summary,
        checks: [
          { label: 'Website response', status: responseStatus, text: responseText, detail: `${(responseMs / 1000).toFixed(1)} sec in this check` },
          { label: 'Pictures', status: imageStatus, text: imageText, detail: knownImageBytes ? `${humanBytes(knownImageBytes)} across the pictures we could measure` : 'No reliable picture-size total available' },
          { label: 'Page complexity', status: complexityStatus, text: complexityText, detail: `${totalFiles} picture, script, and style files found` }
        ],
        methodology: 'We check how quickly the public site answers, the weight of measurable homepage pictures, and how many separate page files the browser is asked to load.',
        localTip: 'If the site feels slow to you but passes here, try it on your phone with Wi-Fi turned off. If it becomes fast, your Wi-Fi, device, browser, or local connection may be the problem rather than the website itself.',
        note: 'This basic check is an outside view of the public website. It does not require your login and does not test every possible cause of slowness.'
      })
    };
  } catch (error) {
    const safeMessage = error && error.message && !/ENOTFOUND|EAI_AGAIN|ECONN|fetch failed|aborted/i.test(error.message) ? error.message : 'We could not reach that website right now. Check the address and try again.';
    return { statusCode: 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: safeMessage }) };
  }
};
