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
console.log(`   Keywords: ${keywords}`);
console.log(`   Collect: website=${COLLECT_WEBSITE} phone=${COLLECT_PHONE} facebook=${COLLECT_FACEBOOK} address=${COLLECT_ADDRESS}\n`);

// ─── Supabase ─────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// ─── Helpers ───────────────────────────────────────────────────
function randomDelay(min = 2000, max = 4000) {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
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
      rating:        rating || null,
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

    // ── Load page ─────────────────────────────────────────────
    console.log(`    ⏳ Loading Google Maps...`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.log(`    ⚠ page.goto error: ${e.message}`);
    }
    await page.waitForTimeout(5000);

    // Accept consent dialog
    try {
      const acceptBtn = await page.$('button[aria-label*="Accept"], button[id*="agree"], button:has-text("I agree")');
      if (acceptBtn) { await acceptBtn.click(); console.log(`    ✓ Accepted consent dialog`); await page.waitForTimeout(2000); }
    } catch (_) {}

    // Check for CAPTCHA
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 300));
    if (pageText.includes('unusual traffic') || pageText.includes('CAPTCHA') || pageText.includes('not a robot')) {
      console.log(`    ⚠ BLOCKED by Google: CAPTCHA or unusual traffic detected`);
      return [];
    }

    // ── Scroll to load all results ─────────────────────────────
    console.log(`    📜 Scrolling to load results...`);
    try {
      await page.waitForSelector('a[href*="/maps/place/"], [data-cid], div.Nv2PK', { timeout: 20000 });
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
        if (stuckCount >= 3) { console.log(`    ✓ No more results`); break; }
      } else stuckCount = 0;
      lastCardCount = cardCount;
    }

    // ── Step 1: Get all place URLs from list (quick, no clicking) ─
    console.log(`    🔍 Collecting place URLs from list...`);
    const placeData = await page.evaluate((kw) => {
      const seen = new Set();
      const results = [];
      for (const link of Array.from(document.querySelectorAll('a[href*="/maps/place/"]'))) {
        const href = link.getAttribute('href') || '';
        if (seen.has(href)) continue;
        seen.add(href);

        // Get name from link or nearby h3
        let name = link.textContent?.trim().replace(/\s+/g, ' ') || '';
        if (!name || name.length < 2) {
          const container = link.closest('[data-cid]') || link.parentElement?.closest('[data-cid]');
          const h3 = container?.querySelector('h3');
          name = h3?.textContent?.trim().replace(/\s+/g, ' ') || name;
        }
        if (!name || name.length < 2) continue;

        const lower = name.toLowerCase();
        if (/^(price|hours?|rating|distance|sort|filter|open|closed|km|mi|reviews?|suggested|advertisement|popular|trending|search|available|related)/.test(lower)) continue;
        if (lower.includes('show more') || lower.includes('more options')) continue;

        // Extract place_id and coords from href
        const placeIdMatch = href.match(/\/maps\/place\/([^\/]+)\//);
        const place_id = placeIdMatch ? placeIdMatch[1] : '';
        const coordMatch = href.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
        const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
        const lng = coordMatch ? parseFloat(coordMatch[2]) : null;

        results.push({ name, href, place_id, lat, lng });
      }
      return results;
    });

    console.log(`    ✓ Found ${placeData.length} places in list`);
    if (placeData.length === 0) return [];

    // ── Step 2: Click each listing to open detail panel ───────────
    for (let i = 0; i < placeData.length; i++) {
      const { name, href, place_id, lat, lng } = placeData[i];
      console.log(`\n  [${i + 1}/${placeData.length}] ${name}`);

      // Click the listing link to open the detail panel
      try {
        const link = await page.$(`a[href="${href}"]`);
        if (link) {
          await link.click();
        } else {
          // Fallback: navigate directly to the place URL
          await page.goto(`https://www.google.com${href}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        }
        await page.waitForTimeout(3000); // Wait for panel to slide in or page to load
      } catch (e) {
        console.log(`    ⚠ Could not open listing: ${e.message}`);
      }

      // ── Extract from detail panel / page ──────────────────────
      let phone = '', website = '', address = '', rating = null;

      try {
        // Wait for detail panel or page content to load
        await page.waitForTimeout(2000);

        const detailData = await page.evaluate(() => {
          let phone = '', website = '', address = '';

          // Phone: look for tel: links
          const telLink = document.querySelector('a[href^="tel:"]');
          phone = telLink?.textContent?.trim() || '';

          // Website: look for real website links (not google)
          const allLinks = Array.from(document.querySelectorAll('a[href^="http"]'));
          for (const l of allLinks) {
            const h = l.getAttribute('href') || '';
            if (!h.includes('google.com') && !h.includes('maps.google') && !h.includes('goo.gl') && !h.includes('webcache') && !h.includes('plus.url')) {
              website = h;
              break;
            }
          }

          // Address: look in the detail panel
          const panel = document.querySelector('[role="main"]') || document.body;
          const addressSelectors = [
            'button[data-item-id*="address"]',
            '[data-item-id*="address"]',
            'div[aria-label*="Address"]',
            'span:has-text("Address")',
            '.DqeaT', '.rogA2c', '[class*="address"]'
          ];
          for (const sel of addressSelectors) {
            try {
              const el = document.querySelector(sel);
              if (el) {
                const text = el.textContent?.trim() || '';
                // Make sure it looks like an address (contains numbers, Bangladesh-related keywords)
                if (text.length > 5 && (text.match(/\d/) || text.toLowerCase().includes('dhaka') || text.toLowerCase().includes('bangladesh'))) {
                  address = text;
                  break;
                }
              }
            } catch (_) {}
          }

          // Fallback: search for address-like text in the panel
          if (!address) {
            const paragraphs = Array.from(document.querySelectorAll('div[role="main"] p, div[role="main"] span, div[role="main"] div'));
            for (const p of paragraphs) {
              const text = p.textContent?.trim() || '';
              if (text.length > 8 && text.length < 200 && /\d{4,}/.test(text) || (text.toLowerCase().includes('dhaka') && text.match(/\d/))) {
                address = text;
                break;
              }
            }
          }

          // Rating
          let rating = null;
          const ratingEl = document.querySelector('[aria-label*="star"], [class*="rating"]');
          if (ratingEl) {
            const raw = ratingEl.getAttribute('aria-label') || ratingEl.textContent || '';
            const match = raw.match(/[\d.]+/);
            if (match) rating = parseFloat(match[0]);
          }

          return { phone, website, address, rating };
        });

        phone = detailData.phone || '';
        website = detailData.website || '';
        address = detailData.address || '';
        rating = detailData.rating;
      } catch (e) {
        console.log(`    ⚠ Detail extraction error: ${e.message}`);
      }

      // ── Go back to list view ──────────────────────────────────
      if (i < placeData.length - 1) {
        try {
          // Try to go back to the search results
          await page.goBack({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(2000);
          // Re-scroll to load more if needed
          await page.evaluate(() => {
            const feed = document.querySelector('div[role="feed"]');
            if (feed) feed.scrollTop = 0;
          });
          await page.waitForTimeout(1000);
        } catch (_) {}
      }

      const business = {
        name, phone: phone || null, website: website || null,
        address: address || null, rating, lat, lng,
        place_id, facebook: null,
      };

      if (phone)   console.log(`    ✓ Phone:   ${phone}`);
      else          console.log(`    ✗ Phone:   (not found)`);
      if (website) console.log(`    ✓ Website: ${website}`);
      else          console.log(`    ✗ Website: (not found)`);
      if (address) console.log(`    ✓ Address: ${address.substring(0, 80)}`);
      else          console.log(`    ✗ Address: (not found)`);
      if (rating)  console.log(`    ✓ Rating:  ${rating}`);

      businesses.push(business);
      await randomDelay(1500, 3000);
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

  console.log(`\n📊 Scraped ${businesses.length} businesses. Processing Facebook links...\n`);

  let facebookCount = 0;
  for (let i = 0; i < businesses.length; i++) {
    const biz = businesses[i];
    console.log(`[${i + 1}/${businesses.length}] ${biz.name}`);

    if (biz.website && COLLECT_FACEBOOK) {
      const fb = await findFacebookLink(biz.website);
      if (fb) { biz.facebook = fb; facebookCount++; console.log(`    ✓ Facebook: ${fb}`); }
    }

    await saveToSupabase(biz);
    await randomDelay(1500, 3000);
  }

  const fs = await import('fs');
  fs.writeFileSync('/tmp/scraped-maps-businesses.json', JSON.stringify(businesses, null, 2));

  // Count how many have at least one of phone/website/facebook/address
  const withContact = businesses.filter(b => b.phone || b.website || b.facebook || b.address);
  console.log(`\n═══════════════════════════════════════`);
  console.log(`📊 SUMMARY:`);
  console.log(`   Total scraped:   ${businesses.length}`);
  console.log(`   With contact info: ${withContact.length}`);
  console.log(`   Phone found:     ${businesses.filter(b => b.phone).length}`);
  console.log(`   Website found:   ${businesses.filter(b => b.website).length}`);
  console.log(`   Facebook found:  ${facebookCount}`);
  console.log(`   Address found:   ${businesses.filter(b => b.address).length}`);
  console.log(`   Saved to: /tmp/scraped-maps-businesses.json`);
  console.log(`═══════════════════════════════════════\n`);
}

main().catch(console.error);
