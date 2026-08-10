import { chromium } from 'playwright';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;
const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

// Random delay helper
function randomDelay(min = 2000, max = 4000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────
// findFacebookLink
// ─────────────────────────────────────────
async function findFacebookLink(websiteUrl) {
  if (!websiteUrl) return null;
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
    const links = $('a[href]');
    for (const link of links) {
      const href = $(link).attr('href') || '';
      if (href.toLowerCase().includes('facebook.com')) {
        return href;
      }
    }
  } catch (error) {
    // Silent fail
  }
  return null;
}

// ─────────────────────────────────────────
// saveToSupabase
// ─────────────────────────────────────────
async function saveToSupabase(businessData) {
  if (!supabase) {
    console.log('    [SUPABASE] Not configured, skipping');
    return false;
  }
  try {
    const { name, phone, website, address, rating, facebook } = businessData;
    const { error } = await supabase
      .from('businesses')
      .upsert({
        name,
        phone: phone || null,
        website: website || null,
        address: address || null,
        rating: rating || null,
        facebook_url: facebook,
        source: 'playwright',
      }, {
        onConflict: 'name,address',
      });

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

// ─────────────────────────────────────────
// MAIN: scrapeGoogleMaps
// Uses links that point to place pages to identify businesses
// ─────────────────────────────────────────
async function scrapeGoogleMaps(query) {
  const businesses = [];
  let browser;
  let screenshotCount = 0;

  console.log(`\n🗺️  Launching browser for: "${query}"`);

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

    const encodedQuery = encodeURIComponent(query);
    const url = `https://www.google.com/maps/search/${encodedQuery}`;

    console.log(`    URL: ${url}`);

    // Navigate
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    } catch (e) {
      console.log(`    ⚠ networkidle timeout, continuing...`);
    }
    await page.waitForTimeout(3000);

    // ─── STEP 1: Scroll to load all results ─────────────────────────
    console.log(`    📜 Scrolling to load results...`);

    // Wait for initial results to appear
    try {
      await page.waitForSelector('a[href*="/maps/place/"], [data-cid], div.Nv2PK', { timeout: 15000 });
      console.log(`    ✓ Initial results detected`);
    } catch (e) {
      screenshotCount++;
      const path = `/tmp/gmaps-no-results-${screenshotCount}-${Date.now()}.png`;
      await page.screenshot({ path, fullPage: true });
      console.log(`    ⚠ No results detected. Screenshot: ${path}`);
      return [];
    }

    // Scroll through the results to trigger lazy loading
    let lastCardCount = 0;
    let stuckCount = 0;
    for (let scrollRound = 0; scrollRound < 8; scrollRound++) {
      // Scroll down within the feed/list
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) {
          feed.scrollTop = feed.scrollHeight;
        } else {
          window.scrollBy(0, window.innerHeight);
        }
      });
      await randomDelay(2000, 3000);

      // Count cards after scroll
      const cardCount = await page.evaluate(() => {
        return document.querySelectorAll('a[href*="/maps/place/"]').length;
      });
      console.log(`    Scroll ${scrollRound + 1}/8: found ${cardCount} place links`);

      if (cardCount === lastCardCount) {
        stuckCount++;
        if (stuckCount >= 3) {
          console.log(`    ✓ No more results loading (stuck ${stuckCount} rounds)`);
          break;
        }
      } else {
        stuckCount = 0;
      }
      lastCardCount = cardCount;
    }

    // ─── STEP 2: Extract business data via DOM analysis ─────────────
    console.log(`    🔍 Extracting business data...`);

    const extracted = await page.evaluate(() => {
      const results = [];

      // Find all links that point to Google Maps place pages — these are actual businesses
      const placeLinks = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));

      // Deduplicate — sometimes the same business appears multiple times
      const seenUrls = new Set();

      for (const link of placeLinks) {
        const href = link.getAttribute('href') || '';
        if (seenUrls.has(href)) continue;
        seenUrls.add(href);

        // Get the parent card container — walk up the DOM
        let container = link;
        for (let up = 0; up < 5; up++) {
          container = container.parentElement;
          if (!container) break;
          // Check if this container has business data
          const cid = container.getAttribute('data-cid');
          if (cid) break;
        }

        // Business name: from the link text or nearby heading
        let name = link.textContent?.trim() || '';

        // Try to get from parent h3 or heading
        if (!name || name.length < 2) {
          const h3 = link.closest('[data-cid]')?.querySelector('h3') ||
                     link.closest('div')?.querySelector('h3') ||
                     link.closest('div')?.querySelector('[class*="title"]');
          name = h3?.textContent?.trim() || name;
        }

        // Clean name
        name = name.replace(/\s+/g, ' ').trim();

        // Skip if still no valid name
        if (!name || name.length < 2) continue;

        // Skip obvious non-business UI elements
        const lowerName = name.toLowerCase();
        if (lowerName.match(/^(price|hours?|rating|distance|sort|filter|open|closed|km|mi|reviews?|suggested|advertisement|popular|trending|search|available|related)/)) continue;
        if (lowerName.includes('show more')) continue;
        if (lowerName.includes('more options')) continue;

        // Address: look in the card for address text
        const cardEl = link.closest('[data-cid]') || link.closest('div');
        const addressEl = cardEl?.querySelector('[class*="address"], [class*="street"], [class*="Locality"], [class*="location"]');
        const address = addressEl?.textContent?.trim().replace(/\s+/g, ' ') || '';

        // Phone: look for tel: links
        const telLink = cardEl?.querySelector('a[href^="tel:"]');
        const phone = telLink?.textContent?.trim() || '';

        // Website: look for non-google http links
        const webLinks = Array.from(cardEl?.querySelectorAll('a[href^="http"]') || []);
        let website = '';
        for (const wl of webLinks) {
          const wh = wl.getAttribute('href') || '';
          if (!wh.includes('google.com') && !wh.includes('maps.google') && !wh.includes('goo.gl')) {
            website = wh;
            break;
          }
        }

        // Rating
        const ratingEl = cardEl?.querySelector('[aria-label*="star"]');
        const rating = ratingEl?.getAttribute('aria-label') || '';

        // Place ID from URL: /maps/place/PLACE_ID/
        const placeIdMatch = href.match(/\/maps\/place\/([^\/]+)\//);
        const place_id = placeIdMatch ? placeIdMatch[1] : '';

        // Lat/Lng from URL: @lat,lng,zoom
        const coordMatch = href.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
        const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
        const lng = coordMatch ? parseFloat(coordMatch[2]) : null;

        results.push({
          name,
          address,
          phone,
          website,
          rating,
          place_id,
          lat,
          lng,
        });
      }

      return results;
    });

    console.log(`    ✓ Extracted ${extracted.length} unique businesses`);

    if (extracted.length === 0) {
      screenshotCount++;
      const path = `/tmp/gmaps-no-biz-${screenshotCount}-${Date.now()}.png`;
      await page.screenshot({ path, fullPage: true });
      console.log(`    ⚠ No businesses extracted. Screenshot: ${path}`);
      return [];
    }

    // ─── STEP 3: Process each business ─────────────────────────────
    for (let i = 0; i < extracted.length; i++) {
      const raw = extracted[i];
      console.log(`\n  [${i + 1}/${extracted.length}] ${raw.name}`);

      const business = {
        name: raw.name,
        phone: raw.phone || null,
        website: raw.website || null,
        address: raw.address || null,
        rating: raw.rating || null,
        lat: raw.lat || null,
        lng: raw.lng || null,
        place_id: raw.place_id || null,
        facebook: null,
      };

      if (business.phone) console.log(`    Phone: ${business.phone}`);
      if (business.website) console.log(`    Website: ${business.website}`);
      if (business.address) console.log(`    Address: ${business.address}`);
      if (business.rating) console.log(`    Rating: ${business.rating}`);
      if (business.place_id) console.log(`    Place ID: ${business.place_id}`);

      businesses.push(business);

      await randomDelay(1000, 2000);
    }

  } catch (error) {
    console.log(`    ✗ Browser error: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return businesses;
}

// ─────────────────────────────────────────
// CLI MAIN FLOW
// ─────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node scrape-maps.js "restaurants in Dhaka"');
    console.log('Example: node scrape-maps.js "hotels in Bangladesh"');
    process.exit(1);
  }

  const query = args.join(' ');
  console.log(`\n🔍 Google Maps Scraper`);
  console.log(`   Query: "${query}"\n`);

  const businesses = await scrapeGoogleMaps(query);

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
      if (fb) {
        biz.facebook = fb;
        facebookCount++;
        console.log(`    ✓ Facebook: ${fb}`);
      }
    }

    await saveToSupabase(biz);

    await randomDelay(1500, 3000);
  }

  const fs = await import('fs');
  const outputPath = '/tmp/scraped-maps-businesses.json';
  fs.writeFileSync(outputPath, JSON.stringify(businesses, null, 2));

  console.log(`\n═══════════════════════════════════════`);
  console.log(`📊 SUMMARY:`);
  console.log(`   Total scraped: ${businesses.length}`);
  console.log(`   Facebook links found: ${facebookCount}`);
  console.log(`   Saved to: ${outputPath}`);
  console.log(`═══════════════════════════════════════\n`);
}

main().catch(console.error);
