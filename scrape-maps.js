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
// findFacebookLink - from existing scrape.js
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
// saveToSupabase - from existing scrape.js
// NOTE: source='playwright' to distinguish from API version
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

    // Block unnecessary resources for speed
    await page.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2}', route => route.abort());

    const encodedQuery = encodeURIComponent(query);
    const url = `https://www.google.com/maps/search/${encodedQuery}`;

    console.log(`    URL: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Wait for result panel to load
    // Selector: the business listings container in Google Maps
    try {
      await page.waitForSelector('div[role="feed"], div[data-result-span], .Nv2PK', { timeout: 10000 });
    } catch (e) {
      console.log(`    ⚠ Could not find result feed selector: ${e.message}`);
      // Try alternative selector
      try {
        await page.waitForSelector('#search', { timeout: 5000 });
      } catch {
        console.log(`    ⚠ Page may not have loaded correctly`);
      }
    }

    // Scroll to load more results
    console.log(`    📜 Scrolling to load more results...`);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) {
          feed.scrollBy(0, 2000);
        } else {
          window.scrollBy(0, 1500);
        }
      });
      await randomDelay(1500, 2000);
    }

    // Collect business card references
    // Google Maps uses various selectors - try multiple
    const cardSelectors = [
      'div[role="feed"] > div > div[aria-label]',
      'div.Nv2PK',
      '.UaDxMd',
      '[data-result-span]',
      'div[data-cid]',
    ];

    let cards = [];
    for (const sel of cardSelectors) {
      cards = await page.$$(sel);
      if (cards.length > 0) {
        console.log(`    ✓ Found ${cards.length} cards using selector: ${sel}`);
        break;
      }
    }

    if (cards.length === 0) {
      console.log(`    ⚠ No business cards found. Taking screenshot...`);
      await page.screenshot({ path: '/tmp/gmaps-debug.png' });
      console.log(`    Screenshot saved to /tmp/gmaps-debug.png`);
      return [];
    }

    console.log(`    🔄 Processing ${cards.length} businesses...`);

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const cardHtml = await card.innerHTML().catch(() => '');
      const cardName = await card.getAttribute('aria-label').catch(async () =>
        await card.$eval('h3', el => el ? el.textContent : null).catch(() => `Business ${i + 1}`)
      );

      console.log(`\n  [${i + 1}/${cards.length}] ${cardName}`);

      try {
        // Click to open details panel
        await card.click({ timeout: 3000 });
        await randomDelay(2000, 3500);

        // Wait for details panel
        const detailsSelectors = [
          '[data-section-id="info"]',
          '.section-layout .section-info',
          '[aria-label*="Business"]',
        ];

        let detailsLoaded = false;
        for (const sel of detailsSelectors) {
          try {
            await page.waitForSelector(sel, { timeout: 4000 });
            detailsLoaded = true;
            break;
          } catch {
            // Try next selector
          }
        }

        if (!detailsLoaded) {
          console.log(`    ⚠ Details panel not found, skipping`);
          continue;
        }

        // Extract data from details panel
        const data = await page.evaluate(() => {
          const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
          const getAttr = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || null;

          // Name
          const nameEl = document.querySelector('h1[data-item-id], h1.section-title, .section-header-title h1');
          const name = nameEl?.textContent?.trim() || null;

          // Phone
          const phoneEl = document.querySelector('a[href^="tel:"]');
          const phone = phoneEl?.textContent?.trim() || null;

          // Website
          const websiteEl = document.querySelector('a[href^="http"]:not([href*="google.com"]):not([href*="maps"])');
          const website = websiteEl?.href || null;

          // Address
          const addrEl = document.querySelector('[data-item-id="address"], .section-info span');
          const address = addrEl?.textContent?.trim() || null;

          // Rating
          const ratingEl = document.querySelector('.section-star-display, [aria-label*="star"]');
          const rating = ratingEl?.getAttribute('aria-label') || null;

          return { name, phone, website, address, rating };
        });

        if (!data.name) {
          console.log(`    ⚠ Could not extract name, skipping`);
          continue;
        }

        const business = {
          name: data.name,
          phone: data.phone,
          website: data.website,
          address: data.address,
          rating: data.rating,
          facebook: null,
        };

        console.log(`    ✓ Name: ${business.name}`);
        if (business.phone) console.log(`      Phone: ${business.phone}`);
        if (business.website) console.log(`      Website: ${business.website}`);
        if (business.address) console.log(`      Address: ${business.address}`);
        if (business.rating) console.log(`      Rating: ${business.rating}`);

        businesses.push(business);

      } catch (err) {
        console.log(`    ⚠ Error extracting: ${err.message}`);
        // Continue to next card
      }

      // Random delay for rate limiting / anti-detection
      await randomDelay(2000, 4000);
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
    console.log(`\n⚠ No businesses scraped. Check selectors - Google Maps HTML may have changed.`);
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
