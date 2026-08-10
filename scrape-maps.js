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
        facebook,
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
// Uses JS-based direct DOM extraction (no clicks needed)
// ─────────────────────────────────────────
async function scrapeGoogleMaps(query) {
  const businesses = [];
  let browser;

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

    // Block images/css for speed
    await page.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2}', route => route.abort());
    await page.route('**/fonts.googleapis.com/**', route => route.abort());
    await page.route('**/fonts.gstatic.com/**', route => route.abort());

    const encodedQuery = encodeURIComponent(query);
    const url = `https://www.google.com/maps/search/${encodedQuery}`;

    console.log(`    URL: ${url}`);

    // Navigate and wait for networkidle
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    } catch (e) {
      console.log(`    ⚠ networkidle timeout, continuing...`);
      await page.waitForTimeout(3000);
    }

    // Wait for results to appear
    await page.waitForTimeout(3000);

    // Debug: take initial screenshot
    const initScreenshot = `/tmp/gmaps-init-${Date.now()}.png`;
    await page.screenshot({ path: initScreenshot, fullPage: true });
    console.log(`    📸 Initial screenshot: ${initScreenshot}`);

    // Scroll to load more results
    console.log(`    📜 Scrolling to load more results...`);
    for (let scrollRound = 0; scrollRound < 5; scrollRound++) {
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) {
          feed.scrollBy(0, 2000);
        } else {
          window.scrollBy(0, 1500);
        }
      });
      await randomDelay(1500, 2000);
      console.log(`    Scroll round ${scrollRound + 1}/5 done`);
    }

    // Extract business data directly via JS — no clicks needed
    // This avoids "element not visible" issues with Playwright clicks
    console.log(`    🔍 Extracting business data via JS...`);

    const extracted = await page.evaluate(() => {
      const results = [];

      // Try multiple card selectors
      const selectors = [
        'div[role="feed"] > div > div[aria-label]',
        'div.Nv2PK',
        '.UaDxMd',
        'div[data-cid]',
        '[data-result-span]',
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 0) {
          console.log(`Found ${cards.length} cards with selector: ${sel}`);
          break;
        }
      }

      if (cards.length === 0) {
        // Last resort: look for any element with business-like structure
        cards = Array.from(document.querySelectorAll('[data-cid]'));
      }

      for (const card of cards) {
        // Get the business name — usually in aria-label or h3/h2 inside card
        const ariaLabel = card.getAttribute('aria-label') || '';
        const h3 = card.querySelector('h3');
        const h2 = card.querySelector('h2');
        const nameEl = h3 || h2 || card.querySelector('[class*="title"]') || card.querySelector('span');
        const name = nameEl?.textContent?.trim() || ariaLabel || '';

        if (!name || name.length < 2) continue;

        // Address — look for address-like text
        const addressEl = card.querySelector('[class*="address"], [class*="street"], [class*="location"]');
        const address = addressEl?.textContent?.trim() || '';

        // Rating — look for stars
        const ratingEl = card.querySelector('[aria-label*="star"], [class*="rating"]');
        const rating = ratingEl?.getAttribute('aria-label') || ratingEl?.textContent?.trim() || '';

        // Website/Phone — look for links
        const links = Array.from(card.querySelectorAll('a[href]'));
        let phone = '';
        let website = '';
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (href.startsWith('tel:')) {
            phone = link.textContent?.trim() || '';
          } else if (href.startsWith('http') && !href.includes('google.com') && !href.includes('maps.google')) {
            website = href;
          }
        }

        // Lat/Lng — extract from data attributes or URL
        const dataCid = card.getAttribute('data-cid') || '';
        const latMatch = card.outerHTML.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
        const lat = latMatch ? parseFloat(latMatch[1]) : null;
        const lng = latMatch ? parseFloat(latMatch[2]) : null;

        results.push({
          name,
          address,
          rating,
          phone,
          website,
          lat,
          lng,
          place_id: dataCid || null,
        });
      }

      return results;
    });

    console.log(`    ✓ Extracted ${extracted.length} businesses via JS`);

    if (extracted.length === 0) {
      const path = `/tmp/gmaps-no-results-${Date.now()}.png`;
      await page.screenshot({ path, fullPage: true });
      console.log(`    ⚠ No businesses extracted. Screenshot: ${path}`);
      return [];
    }

    // Process each business
    for (let i = 0; i < extracted.length; i++) {
      const raw = extracted[i];
      console.log(`\n  [${i + 1}/${extracted.length}] ${raw.name}`);

      // Build business object — use JS-extracted data directly
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
      if (business.lat && business.lng) console.log(`    Lat/Lng: ${business.lat}, ${business.lng}`);

      businesses.push(business);

      // Random delay to avoid rate limiting
      await randomDelay(1500, 3000);
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

  // Save locally
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
