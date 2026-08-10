import { chromium } from 'playwright';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

// ─── Config from CLI args ───────────────────────────────────────
const [, , argQuery, argLocation, argKeywords = '', collectWebsite = 'true', collectPhone = 'true', collectFacebook = 'true', collectAddress = 'true'] = process.argv;

const COLLECT_WEBSITE  = collectWebsite  !== 'false';
const COLLECT_PHONE    = collectPhone    !== 'false';
const COLLECT_FACEBOOK = collectFacebook !== 'false';
const COLLECT_ADDRESS  = collectAddress  !== 'false';

const query = argQuery || (() => {
  console.error('❌ Usage: node scrape-maps.js "<business_type> in <location>" [keywords] [collectWebsite] [collectPhone] [collectFacebook] [collectAddress]');
  process.exit(1);
})();

const location = argLocation || 'Dhaka, Bangladesh';
const keywords = argKeywords ? argKeywords.split(',').map(k => k.trim().toLowerCase()) : [];

console.log(`\n🗺️  Google Maps Scraper`);
console.log(`   Business: ${query}`);
console.log(`   Location: ${location}`);
if (keywords.length) console.log(`   Keywords: ${keywords.join(', ')}`);
console.log(`   Collect: website=${COLLECT_WEBSITE} phone=${COLLECT_PHONE} facebook=${COLLECT_FACEBOOK} address=${COLLECT_ADDRESS}\n`);

// ─── Supabase ─────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// ─── Helpers ───────────────────────────────────────────────────
function randomDelay(min = 2000, max = 4000) {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
}

function matchesKeywords(text) {
  if (keywords.length === 0) return true;
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

// ─── Find Facebook from website ────────────────────────────────
async function findFacebookLink(websiteUrl) {
  if (!COLLECT_FACEBOOK || !websiteUrl) return null;
  try {
    const response = await axios.get(websiteUrl, {
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,*/*',
      },
      maxRedirects: 5,
    });
    const $ = cheerio.load(response.data);
    for (const link of $('a[href]')) {
      const href = $(link).attr('href') || '';
      if (href.toLowerCase().includes('facebook.com')) return href;
    }
  } catch (_) {}
  return null;
}

// ─── Save to Supabase ──────────────────────────────────────────
async function saveToSupabase(businessData) {
  if (!supabase) {
    console.log('    [SUPABASE] Not configured, skipping');
    return false;
  }
  try {
    const { name, phone, website, address, rating, facebook, lat, lng, place_id } = businessData;
    const { error } = await supabase.from('businesses').upsert({
      name,
      phone:         COLLECT_PHONE    ? (phone    || null) : null,
      website:       COLLECT_WEBSITE  ? (website  || null) : null,
      address:       COLLECT_ADDRESS  ? (address  || null) : null,
      rating:        rating  || null,
      facebook_url:  facebook || null,
      lat:           lat     || null,
      lng:           lng     || null,
      place_id:      place_id || null,
      source:        'playwright',
    }, { onConflict: 'place_id' });

    if (error) {
      console.log(`    [SUPABASE] Upsert error: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.log(`    [SUPABASE] Error: ${err.message}`);
    return false;
  }
}

// ─── MAIN SCRAPER ─────────────────────────────────────────────
async function scrapeGoogleMaps() {
  const businesses = [];
  let browser;

  const fullQuery = `${query} in ${location}`;
  console.log(`🗺️  Launching browser for: "${fullQuery}"`);

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Block unnecessary resources
    await page.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2}', route => route.abort());
    await page.route('**/fonts.googleapis.com/**', route => route.abort());
    await page.route('**/fonts.gstatic.com/**', route => route.abort());

    const encodedQuery = encodeURIComponent(fullQuery);
    const url = `https://www.google.com/maps/search/${encodedQuery}`;
    console.log(`    URL: ${url}`);

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    } catch (e) {
      console.log(`    ⚠ networkidle timeout, continuing...`);
    }
    await page.waitForTimeout(3000);

    // ── Scroll to load all results ─────────────────────────────
    console.log(`    📜 Scrolling to load results...`);
    try {
      await page.waitForSelector('a[href*="/maps/place/"], [data-cid], div.Nv2PK', { timeout: 15000 });
      console.log(`    ✓ Initial results detected`);
    } catch (e) {
      const path = `/tmp/gmaps-no-results-${Date.now()}.png`;
      await page.screenshot({ path, fullPage: true });
      console.log(`    ⚠ No results detected. Screenshot: ${path}`);
      return [];
    }

    let lastCardCount = 0;
    let stuckCount = 0;
    for (let round = 0; round < 8; round++) {
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollTop = feed.scrollHeight;
        else window.scrollBy(0, window.innerHeight);
      });
      await randomDelay(2000, 3000);

      const cardCount = await page.evaluate(() =>
        document.querySelectorAll('a[href*="/maps/place/"]').length
      );
      console.log(`    Scroll ${round + 1}/8: found ${cardCount} place links`);

      if (cardCount === lastCardCount) {
        stuckCount++;
        if (stuckCount >= 3) { console.log(`    ✓ No more results (stuck ${stuckCount} rounds)`); break; }
      } else stuckCount = 0;
      lastCardCount = cardCount;
    }

    // ── Extract business data ──────────────────────────────────
    console.log(`    🔍 Extracting business data...`);
    const extracted = await page.evaluate(() => {
      const results = [];
      const seenUrls = new Set();

      for (const link of Array.from(document.querySelectorAll('a[href*="/maps/place/"]'))) {
        const href = link.getAttribute('href') || '';
        if (seenUrls.has(href)) continue;
        seenUrls.add(href);

        let container = link;
        for (let up = 0; up < 5; up++) {
          container = container.parentElement;
          if (!container) break;
          if (container.getAttribute('data-cid')) break;
        }

        let name = link.textContent?.trim().replace(/\s+/g, ' ') || '';
        if (!name || name.length < 2) {
          const h3 = container?.querySelector('h3') || container?.querySelector('[class*="title"]');
          name = h3?.textContent?.trim().replace(/\s+/g, ' ') || name;
        }
        if (!name || name.length < 2) continue;

        // Skip non-business UI elements
        const lower = name.toLowerCase();
        if (/^(price|hours?|rating|distance|sort|filter|open|closed|km|mi|reviews?|suggested|advertisement|popular|trending|search|available|related)/.test(lower)) continue;
        if (lower.includes('show more') || lower.includes('more options')) continue;

        // Keyword filter
        if (![...document.querySelectorAll('[class*="address"], [class*="street"], [class*="Locality"]')].some(el => {
          const text = el?.textContent?.trim() || '';
          return keywords.some(k => text.toLowerCase().includes(k));
        }) && keywords.length > 0) continue;

        const cardEl = container || link;

        // Collect only enabled fields
        const address = COLLECT_ADDRESS ? (() => {
          const el = cardEl?.querySelector('[class*="address"], [class*="street"], [class*="Locality"], [class*="location"]');
          return el?.textContent?.trim().replace(/\s+/g, ' ') || '';
        })() : '';

        const phone = COLLECT_PHONE ? (() => {
          const tel = cardEl?.querySelector('a[href^="tel:"]');
          return tel?.textContent?.trim() || '';
        })() : '';

        const website = COLLECT_WEBSITE ? (() => {
          for (const wl of Array.from(cardEl?.querySelectorAll('a[href^="http"]') || [])) {
            const wh = wl.getAttribute('href') || '';
            if (!wh.includes('google.com') && !wh.includes('maps.google') && !wh.includes('goo.gl')) return wh;
          }
          return '';
        })() : '';

        const ratingEl = cardEl?.querySelector('[aria-label*="star"]');
        const rating = ratingEl?.getAttribute('aria-label') || '';

        const placeIdMatch = href.match(/\/maps\/place\/([^\/]+)\//);
        const place_id = placeIdMatch ? placeIdMatch[1] : '';
        const coordMatch = href.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
        const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
        const lng = coordMatch ? parseFloat(coordMatch[2]) : null;

        results.push({ name, address, phone, website, rating, place_id, lat, lng });
      }
      return results;
    });

    console.log(`    ✓ Extracted ${extracted.length} unique businesses`);

    if (extracted.length === 0) {
      const path = `/tmp/gmaps-no-biz-${Date.now()}.png`;
      await page.screenshot({ path, fullPage: true });
      console.log(`    ⚠ No businesses extracted. Screenshot: ${path}`);
      return [];
    }

    // ── Process each business ─────────────────────────────────
    for (let i = 0; i < extracted.length; i++) {
      const raw = extracted[i];
      console.log(`\n  [${i + 1}/${extracted.length}] ${raw.name}`);

      const business = {
        name:     raw.name,
        phone:    raw.phone    || null,
        website:  raw.website   || null,
        address:  raw.address   || null,
        rating:   raw.rating    || null,
        lat:      raw.lat       || null,
        lng:      raw.lng       || null,
        place_id: raw.place_id || null,
        facebook: null,
      };

      if (business.phone)   console.log(`    Phone:   ${business.phone}`);
      if (business.website) console.log(`    Website: ${business.website}`);
      if (business.address) console.log(`    Address: ${business.address}`);
      if (business.rating)  console.log(`    Rating:  ${business.rating}`);

      businesses.push(business);
      await randomDelay(1000, 2000);
    }

  } catch (error) {
    console.log(`    ✗ Browser error: ${error.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return businesses;
}

// ─── CLI MAIN ─────────────────────────────────────────────────
async function main() {
  const businesses = await scrapeGoogleMaps();

  if (businesses.length === 0) {
    console.log(`\n⚠ No businesses scraped. Check screenshots in /tmp/gmaps-*.png`);
    process.exit(0);
  }

  console.log(`\n📊 Scraped ${businesses.length} businesses. Processing...\n`);

  let facebookCount = 0;
  for (let i = 0; i < businesses.length; i++) {
    const biz = businesses[i];
    console.log(`[${i + 1}/${businesses.length}] Done: ${biz.name}`);

    if (biz.website) {
      const fb = await findFacebookLink(biz.website);
      if (fb) { biz.facebook = fb; facebookCount++; console.log(`    ✓ Facebook: ${fb}`); }
    }

    await saveToSupabase(biz);
    await randomDelay(1500, 3000);
  }

  const fs = await import('fs');
  fs.writeFileSync('/tmp/scraped-maps-businesses.json', JSON.stringify(businesses, null, 2));

  console.log(`\n═══════════════════════════════════════`);
  console.log(`📊 SUMMARY:`);
  console.log(`   Total scraped: ${businesses.length}`);
  console.log(`   Facebook links found: ${facebookCount}`);
  console.log(`   Saved to: /tmp/scraped-maps-businesses.json`);
  console.log(`═══════════════════════════════════════\n`);
}

main().catch(console.error);
