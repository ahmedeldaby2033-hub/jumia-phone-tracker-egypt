/**
 * Jumia Egypt Smartphone Price Tracker — Scraper
 * Direct fetch, no proxy and no API key: plain HTTP requests with browser
 * headers + cheerio. Runs on GitHub Actions (ubuntu-latest).
 *
 * NOTE: direct fetching was blocked by Jumia's Cloudflare check (HTTP 403)
 * from the author's own VM on 2026-11-19. Whether GitHub's runner IPs get
 * through is an open question — the daily run itself is the test. If a run
 * is blocked, it fails loudly (see BLOCKED handling below) instead of
 * writing empty data.
 */

const fs = require('fs');
const path = require('path');

const LISTING_URL = 'https://www.jumia.com.eg/smartphones/';
const DATA_DIR = path.join(__dirname, '..', 'data');
const MIN_PRICE = 8000;
const MAX_PRICE = 25000;
const DELAY_MS = 1800;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;
const MAX_PAGES = 30;
const FETCH_TIMEOUT_MS = 30000;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isBlockedPage(html, status) {
  if (status === 403 || status === 503) return true;
  return /just a moment|attention required|cf-chl|challenges\.cloudflare\.com|cf-turnstile|are you a robot|verify you are human/i.test(html);
}

async function fetchDirect(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal, redirect: 'follow' });
    const text = await res.text();
    if (isBlockedPage(text, res.status)) {
      throw new Error(`BLOCKED by Cloudflare (HTTP ${res.status}) — Jumia refused this request.`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return text;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timeout after ${FETCH_TIMEOUT_MS}ms for ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function retry(fn, label) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      if (i > 0) { const w = INITIAL_BACKOFF_MS * Math.pow(2, i - 1); console.log(`  Retry ${i + 1}/${MAX_RETRIES} (${label}) — ${w}ms…`); await sleep(w); }
      return await fn();
    } catch (err) { if (i === MAX_RETRIES - 1) throw err; console.warn(`  Attempt ${i + 1} failed (${label}): ${err.message}`); }
  }
}

function parsePrice(str) {
  if (!str) return NaN;
  const cleaned = str.replace(/(?:EGP|E£|£|₦|,|\s)/g, '');
  return parseInt(cleaned, 10);
}

/**
 * Parse a Jumia category listing page (server-rendered HTML) with cheerio.
 * Product cards are <article class="prd ..."> with:
 *   a.core[href]  — product link
 *   h3.name       — product name
 *   div.prc       — current price ("EGP 9,499")
 *   div.old       — old price (optional)
 *   div.rev       — rating, e.g. "4.3 (27)" (optional)
 *   img.img       — data-src (or src) image URL
 * Fallbacks cover minor markup changes (".c-prd", "[data-id]").
 */
function parseListingHTML(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const products = [];
  let cards = $('article.prd');
  if (cards.length === 0) cards = $('.c-prd');
  if (cards.length === 0) cards = $('[data-id].prd, a.core').filter((_, el) => $(el).find('.prc').length > 0);
  cards.each((_, el) => {
    const card = $(el);
    const link = card.is('a.core') ? card : card.find('a.core').first();
    const href = link.attr('href');
    const name = (card.find('h3.name').first().text() || link.attr('title') || '').replace(/\s+/g, ' ').trim();
    const priceText = card.find('.prc').first().text();
    const price = parsePrice(priceText);
    if (isNaN(price) || !href || !name) return;
    const oldText = card.find('.old').first().text();
    const oldPrice = parsePrice(oldText);
    const revText = (card.find('.rev').first().text() || '').trim();
    const revMatch = revText.match(/([\d.]+)\s*\((\d+)\)/);
    const img = card.find('img.img').first();
    const imageUrl = img.attr('data-src') || img.attr('src') || null;
    products.push({
      name,
      price,
      oldPrice: isNaN(oldPrice) ? null : oldPrice,
      rating: revMatch ? parseFloat(revMatch[1]) : null,
      ratingCount: revMatch ? parseInt(revMatch[2], 10) : null,
      productUrl: href.startsWith('http') ? href.split('?')[0] : `https://www.jumia.com.eg${href.split('?')[0]}`,
      imageUrl: imageUrl && imageUrl.startsWith('http') ? imageUrl : null,
    });
  });
  return products;
}

function extractSpecsFromHTML(html) {
  const $ = require('cheerio').load(html);
  const specs = {};
  $('table').each((i, t) => {
    $(t).find('tr').each((j, r) => {
      const cells = $(r).find('td, th');
      if (cells.length >= 2) {
        const k = $(cells[0]).text().trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]/g, '');
        const v = $(cells[1]).text().trim();
        if (k && v && k.length < 40) specs[k] = v;
      }
    });
  });
  if (Object.keys(specs).length === 0) {
    $('li, .spec-item, .-pvxs, .-pts').each((i, el) => {
      const t = $(el).text().trim();
      const m = t.match(/^(.+?)[:\s]{2,}(.+)$/);
      if (m) { const k = m[1].toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]/g, ''); specs[k] = m[2].trim(); }
    });
  }
  const km = {
    display: ['display', 'display_type', 'screen_size', 'screen', 'display_size', 'size'],
    ram: ['ram', 'memory', 'memory_ram', 'internal_memory', 'ram_size'],
    storage: ['storage', 'rom', 'internal_storage', 'internal', 'storage_capacity'],
    battery: ['battery', 'battery_capacity', 'battery_type'],
    camera_rear: ['camera_rear', 'rear_camera', 'main_camera', 'main_lens', 'back_camera', 'camera'],
    camera_front: ['camera_front', 'front_camera', 'selfie_camera', 'single_lens'],
    processor: ['processor', 'processor_chipset', 'cpu', 'chipset'],
    os: ['os', 'operating_system', 'operating_system_version', 'android_version'],
    network: ['network', 'connectivity', 'network_type'],
    sim: ['sim', 'sim_type'],
    resolution: ['resolution', 'screen_resolution'],
  };
  const result = {};
  for (const [tgt, keys] of Object.entries(km)) {
    let found = null;
    for (const k of keys) { if (specs[k]) { found = specs[k]; break; } }
    result[tgt] = found;
  }
  return result;
}

async function scrapeAll() {
  const st = new Date();
  console.log(`\n=== Jumia Phone Tracker (direct fetch, no API key) — ${st.toISOString()} ===\n`);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('-- Phase 1: Scanning listing pages (EGP 8k–25k) --\n');
  let all = [], seen = new Set(), blocked = false;

  for (let p = 1; p <= MAX_PAGES; p++) {
    console.log(`Page ${p}…`);
    let html;
    try { html = await retry(() => fetchDirect(`${LISTING_URL}?page=${p}&sort=lowest-price`), `listing page ${p}`); }
    catch (e) {
      console.error(`  Failed: ${e.message}`);
      if (/BLOCKED/.test(e.message)) blocked = true;
      break;
    }
    if (html.length < 500 || !/(?:EGP|E£)/.test(html)) {
      console.warn(`  Suspicious content (${html.length} chars, no EGP).`);
      if (p === 1) { blocked = true; console.error('  Page 1 invalid — likely blocked.'); }
      break;
    }
    const prods = parseListingHTML(html);
    console.log(`  ${prods.length} products`);
    let nc = 0, lo = Infinity, hi = -Infinity;
    for (const pr of prods) {
      lo = Math.min(lo, pr.price); hi = Math.max(hi, pr.price);
      if (pr.price >= MIN_PRICE && pr.price <= MAX_PRICE) {
        const uk = pr.productUrl;
        if (!seen.has(uk)) { seen.add(uk); all.push(pr); nc++; }
      }
    }
    console.log(`    EGP ${lo.toLocaleString()} – EGP ${hi.toLocaleString()} | +${nc} | total=${all.length}`);
    if (prods.length === 0) { console.log('  No products on this page — stopping.'); break; }
    if (lo > MAX_PRICE) { console.log(`  Lowest > EGP 25k — stopping.`); break; }
    await sleep(DELAY_MS);
  }

  console.log(`\n-- Phase 1 done: ${all.length} candidates --\n`);

  if (all.length === 0) {
    const status = blocked ? 'BLOCKED' : 'WARNING';
    const message = blocked
      ? 'Jumia blocked direct requests (Cloudflare). No data written — previous data kept.'
      : 'No products parsed — check selectors.';
    writeJSON('last-run-log.json', { timestamp: new Date().toISOString(), status, message, candidatesFound: 0, specsSucceeded: 0, specsFailed: 0 });
    console.log(`${status}: ${message}`);
    if (blocked) process.exit(2);
    return;
  }

  console.log(`-- Phase 2: Extracting specs for ${all.length} candidates --\n`);
  let ok = 0, fail = 0;
  const results = [];

  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    console.log(`[${i + 1}/${all.length}] ${c.name.slice(0, 50)}`);
    let specs;
    try {
      const html = await retry(() => fetchDirect(c.productUrl), `product: ${c.name.slice(0, 40)}`);
      specs = extractSpecsFromHTML(html);
      if (!c.imageUrl) {
        const imgM = html.match(/<img[^>]*data-src="([^"]+)"/i) || html.match(/<img[^>]*src="(https?:\/\/[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
        if (imgM) c.imageUrl = imgM[1];
      }
      ok++;
      console.log(`  Specs OK (${Object.values(specs).filter(v => v !== null).length} fields)`);
    } catch (e) {
      fail++;
      console.warn(`  Failed: ${e.message}`);
      specs = { display: null, resolution: null, ram: null, storage: null, battery: null, camera_rear: null, camera_front: null, processor: null, os: null, network: null, sim: null, _error: e.message };
    }
    results.push({ name: c.name, price: c.price, oldPrice: c.oldPrice, rating: c.rating, ratingCount: c.ratingCount, productUrl: c.productUrl, imageUrl: c.imageUrl, specs, scrapedAt: new Date().toISOString() });
    if (i < all.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\n-- Phase 2 done: ${ok} OK, ${fail} failed --\n`);
  console.log('-- Phase 3: Writing output --\n');

  writeJSON('phones.json', { generatedAt: new Date().toISOString(), priceRange: { min: MIN_PRICE, max: MAX_PRICE, currency: 'EGP' }, totalPhones: results.length, phones: results });
  console.log(`  data/phones.json — ${results.length} phones`);

  const history = updateHistory(results);
  writeJSON('history.json', history);
  console.log(`  data/history.json — ${Object.keys(history.phones).length} tracked`);

  const elapsed = Math.round((new Date() - st) / 1000);
  writeJSON('last-run-log.json', { timestamp: new Date().toISOString(), status: 'SUCCESS', elapsedSeconds: elapsed, candidatesFound: all.length, specsSucceeded: ok, specsFailed: fail, totalWritten: results.length });
  console.log(`  data/last-run-log.json`);
  console.log(`\n=== Complete in ${elapsed}s ===\n`);
}

function loadExistingJSON(fn) {
  const fp = path.join(DATA_DIR, fn);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
}

function writeJSON(fn, d) { fs.writeFileSync(path.join(DATA_DIR, fn), JSON.stringify(d, null, 2), 'utf-8'); }

function updateHistory(phones) {
  let h = loadExistingJSON('history.json');
  if (!h || !h.phones) h = { description: 'Price history for tracked phones.', lastUpdated: new Date().toISOString(), phones: {} };
  const today = new Date().toISOString().split('T')[0];
  for (const p of phones) {
    const k = p.name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').replace(/(\d+)gb\s*ram/i, '$1gb').replace(/(\d+)gb\s*rom/i, '$1gb').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    if (!h.phones[k]) h.phones[k] = { name: p.name, productUrl: p.productUrl, imageUrl: p.imageUrl, priceHistory: [] };
    const hi = h.phones[k];
    if (p.imageUrl) hi.imageUrl = p.imageUrl;
    const last = hi.priceHistory[hi.priceHistory.length - 1];
    if (!last || last.price !== p.price || last.date !== today) hi.priceHistory.push({ date: today, price: p.price, scrapedAt: p.scrapedAt });
  }
  h.lastUpdated = new Date().toISOString();
  return h;
}

scrapeAll().catch(err => {
  console.error('\n=== FATAL ==='); console.error(err);
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); writeJSON('last-run-log.json', { timestamp: new Date().toISOString(), status: 'FATAL', error: err.message }); } catch (_) { }
  process.exit(1);
});
