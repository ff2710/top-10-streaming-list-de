
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const JUSTWATCH_GRAPHQL = "https://apis.justwatch.com/graphql";
const COUNTRY           = "DE";
const TOP_N             = 10;
const OUTPUT_FILE       = path.join(__dirname, "manifest.json");

// ─── GraphQL Query ────────────────────────────────────────────────────────────

/**
 * JustWatch GraphQL query for the streaming charts.
 * objectType: "MOVIE" | "SHOW"
 * timeWindow: "DAY_7" = last 7 days
 */
function buildChartQuery(objectType) {
  return {
    operationName: "GetStreamingCharts",
    variables: {
      country:    COUNTRY,
      objectType: objectType,        // "MOVIE" or "SHOW"
      timeWindow: "DAY_7",
      first:      TOP_N,
    },
    query: `
      query GetStreamingCharts(
        $country: Country!,
        $objectType: ObjectType!,
        $timeWindow: StreamingChartsTimeWindow!,
        $first: Int!
      ) {
        streamingCharts(
          country: $country,
          objectType: $objectType,
          timeWindow: $timeWindow,
          first: $first
        ) {
          edges {
            node {
              id
              content(country: $country, language: "de") {
                title
                originalReleaseYear
                externalIds {
                  tmdbId
                }
                posterUrl
              }
              objectType
            }
          }
        }
      }
    `,
  };
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchCharts(objectType) {
  const label = objectType === "MOVIE" ? "Movies" : "Shows";
  console.log(`⏳  Fetching Top ${TOP_N} ${label} (DE, last 7 days)…`);

  const res = await fetch(JUSTWATCH_GRAPHQL, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept":        "application/json",
      // Mimic a browser to avoid bot-blocks
      "User-Agent":    "Mozilla/5.0 (compatible; StremioBot/1.0)",
      "Origin":        "https://www.justwatch.com",
      "Referer":       "https://www.justwatch.com/",
    },
    body: JSON.stringify(buildChartQuery(objectType)),
  });

  if (!res.ok) {
    throw new Error(`JustWatch API returned ${res.status} for ${objectType}`);
  }

  const json = await res.json();

  if (json.errors) {
    throw new Error(
      `GraphQL errors for ${objectType}: ${JSON.stringify(json.errors)}`
    );
  }

  const edges = json?.data?.streamingCharts?.edges ?? [];
  if (edges.length === 0) {
    console.warn(`  ⚠️  No results returned for ${objectType} – JustWatch may have changed their API.`);
  }
  return edges;
}

// ─── Transform to Stremio meta objects ───────────────────────────────────────

/**
 * Converts a JustWatch chart edge into a minimal Stremio meta object.
 * AIOMetadata will enrich these entries automatically via TMDB.
 */
function edgeToMeta(edge, stremioType) {
  const node    = edge.node;
  const content = node.content ?? {};
  const tmdbId  = content?.externalIds?.tmdbId;

  if (!tmdbId) {
    console.warn(`  ⚠️  No TMDB ID for "${content.title}" – skipping.`);
    return null;
  }

  // Stremio expects "tmdb:123456" as the canonical TMDB ID
  const id = `tmdb:${tmdbId}`;

  return {
    id,
    type:  stremioType,
    name:  content.title ?? "Unknown",
    year:  content.originalReleaseYear ?? null,
    // poster: JustWatch poster URL (optional, AIOMetadata will override anyway)
    poster: content.posterUrl
      ? `https://images.justwatch.com${content.posterUrl.replace("{profile}", "s592")}`
      : undefined,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🎬  JustWatch → Stremio Manifest Generator\n");

  // Fetch both charts in parallel
  const [movieEdges, showEdges] = await Promise.all([
    fetchCharts("MOVIE"),
    fetchCharts("SHOW"),
  ]);

  // Convert to Stremio meta objects, dropping any without a TMDB ID
  const movies = movieEdges
    .map((e) => edgeToMeta(e, "movie"))
    .filter(Boolean)
    .slice(0, TOP_N);

  const shows = showEdges
    .map((e) => edgeToMeta(e, "series"))
    .filter(Boolean)
    .slice(0, TOP_N);

  console.log(`\n✅  Movies collected: ${movies.length}`);
  movies.forEach((m, i) => console.log(`   ${i + 1}. ${m.name} (${m.year}) → ${m.id}`));

  console.log(`\n✅  Shows collected:  ${shows.length}`);
  shows.forEach((s, i) => console.log(`   ${i + 1}. ${s.name} (${s.year}) → ${s.id}`));

  // ── Build Stremio manifest ──────────────────────────────────────────────────

  const now       = new Date().toISOString();
  const manifest  = {
    id:          "de.justwatch.top10-7days",
    version:     "1.0.0",
    name:        "JustWatch Top 10 DE (7 Days)",
    description: `Auto-generated on ${now}. Top 10 Movies & Shows in Germany – last 7 days.`,
    logo:        "https://www.justwatch.com/appassets/img/logo/JustWatch-logo-large.webp",
    resources:   ["catalog"],
    types:       ["movie", "series"],
    idPrefixes:  ["tmdb:"],

    catalogs: [
      {
        type: "movie",
        id:   "top10-movies-de-7d",
        name: "Top 10 Movies DE 7 Days",
        extra: [],
        // Inline items – AIOMetadata "Load Manifest" reads these directly
        items: movies,
      },
      {
        type: "series",
        id:   "top10-shows-de-7d",
        name: "Top 10 Shows DE 7 Days",
        extra: [],
        items: shows,
      },
    ],

    // Stremio manifest metadata
    background:  "https://images.justwatch.com/originals/3e7be29a-8e6e-4b94-8f23-7d37e74e7e30/s1440/german-streaming-charts.jpg",
    behaviorHints: {
      configurable: false,
      adult:        false,
    },

    // For reference: raw TMDB IDs as flat arrays
    _meta: {
      generatedAt: now,
      source:      "https://www.justwatch.com/de/streaming-charts",
      country:     COUNTRY,
      timeWindow:  "DAY_7",
      tmdbMovies:  movies.map((m) => m.id),
      tmdbShows:   shows.map((s) => s.id),
    },
  };

  // ── Write manifest.json ─────────────────────────────────────────────────────

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`\n📄  manifest.json written to: ${OUTPUT_FILE}`);
  console.log("\n🚀  Done! Deploy manifest.json to GitHub Pages or Vercel,");
  console.log('    then use the URL as "Load Manifest" in AIOMetadata.\n');
}

main().catch((err) => {
  console.error("\n❌  Error:", err.message);
  process.exit(1);
});
