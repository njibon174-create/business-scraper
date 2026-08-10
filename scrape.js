import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;
const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

// Google Places API key
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

const PLACES_API_BASE = 'https://places.googleapis.com/v1';
const HEADERS = {
  'Content-Type': 'application/json',
  'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
  'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.website,places.internationalPhoneNumber,places.primaryType',
};

function randomDelay(min = 1000, max = 3000) {
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
    const { name, phone, website, address, rating, facebook, place_id } = businessData;
    const { error } = await supabase
      .from('businesses')
      .upsert({
        name,
        phone: phone || null,
        website: website || null,
        address: address || null,
        rating: rating || null,
        facebook,
        source: 'api',
        place_id: place_id || null,
      }, {
        onConflict: 'place_id',
      });

    if (error) {
      // Fallback: upsert on name+address
      const { error: err2 } = await supabase
        .from('businesses')
        .upsert({
          name,
          phone: phone || null,
          website: website || null,
          address: address || null,
          rating: rating || null,
          facebook,
          source: 'api',
        }, {
          onConflict: 'name,address',
        });
      if (err2) {
        console.log(`    [SUPABASE] Upsert error: ${err2.message}`);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.log(`    [SUPABASE] Error: ${err.message}`);
    return false;
  }
}

// ─────────────────────────────────────────
// searchBusinesses - Google Places Text Search API
// ─────────────────────────────────────────
async function searchBusinesses(query) {
  if (!GOOGLE_PLACES_API_KEY) {
    throw new Error('GOOGLE_PLACES_API_KEY environment variable is required');
  }

  console.log(`\n🔍 Text Search for: "${query}"`);

  try {
    const response = await axios.post(
      `${PLACES_API_BASE}/places:searchText`,
      { textQuery: query },
      { headers: HEADERS, timeout: 10000 }
    );

    const places = response.data?.places || [];
    console.log(`    ✓ Found ${places.length} places`);

    return places.map(place => ({
      place_id: place.id,
      name: place.displayName?.text || null,
      address: place.formattedAddress || null,
      phone: place.internationalPhoneNumber || null,
      website: place.website || null,
      rating: place.rating ? `${place.rating} stars` : null,
      type: place.primaryType || null,
    }));
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.log(`    ✗ Text Search error: ${msg}`);
    throw error;
  }
}

// ─────────────────────────────────────────
// getPlaceDetails - Google Places Place Details API
// (included for completeness; Text Search already returns most fields)
// ─────────────────────────────────────────
async function getPlaceDetails(placeId) {
  if (!GOOGLE_PLACES_API_KEY) return null;

  try {
    const response = await axios.get(
      `${PLACES_API_BASE}/places/${placeId}`,
      {
        headers: {
          'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
          'X-Goog-FieldMask': 'id,displayName,formattedAddress,rating,website,internationalPhoneNumber',
        },
        timeout: 8000,
      }
    );
    return response.data;
  } catch (error) {
    console.log(`    ⚠ Place Details error for ${placeId}: ${error.message}`);
    return null;
  }
}

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node scrape.js "restaurants in Dhaka"');
    console.log('Required env: GOOGLE_PLACES_API_KEY');
    process.exit(1);
  }

  const query = args.join(' ');
  console.log(`\n🔍 Google Places API Scraper`);
  console.log(`   Query: "${query}"\n`);

  if (!GOOGLE_PLACES_API_KEY) {
    console.log('❌ Error: GOOGLE_PLACES_API_KEY not set');
    console.log('   Set it: export GOOGLE_PLACES_API_KEY=your_key');
    process.exit(1);
  }

  const businesses = await searchBusinesses(query);

  if (businesses.length === 0) {
    console.log('\n⚠ No results found.');
    process.exit(0);
  }

  console.log(`\n📊 Processing ${businesses.length} businesses...\n`);

  let facebookCount = 0;

  for (let i = 0; i < businesses.length; i++) {
    const biz = businesses[i];
    console.log(`[${i + 1}/${businesses.length}] ${biz.name}`);

    if (biz.website) {
      const fb = await findFacebookLink(biz.website);
      if (fb) {
        biz.facebook = fb;
        facebookCount++;
        console.log(`    ✓ Facebook: ${fb}`);
      }
    }

    await saveToSupabase(biz);
    console.log(`    ✓ Saved to Supabase`);

    await randomDelay(1500, 3000);
  }

  // Save locally
  const fs = await import('fs');
  const outputPath = '/tmp/scraped-businesses.json';
  fs.writeFileSync(outputPath, JSON.stringify(businesses, null, 2));

  console.log(`\n═══════════════════════════════════════`);
  console.log(`📊 SUMMARY:`);
  console.log(`   Total scraped: ${businesses.length}`);
  console.log(`   Facebook links found: ${facebookCount}`);
  console.log(`   Saved to: ${outputPath}`);
  console.log(`═══════════════════════════════════════\n`);
}

main().catch(console.error);
