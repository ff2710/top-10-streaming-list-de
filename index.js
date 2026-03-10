
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JUSTWATCH_GRAPHQL = "https://apis.justwatch.com/graphql";
const COUNTRY = "DE";
const LANGUAGE = "de";
const TOP_N = 10;
const OUTPUT_FILE = path.join(__dirname, "manifest.json");

// ─── GraphQL Query ─────────────────────────────────────────────────────────────
// Uses GetPopularTitles with POPULAR sort – this is what powers the JustWatch charts

const POPULAR_TITLES_QUERY = `
  query GetPopularTitles(
    $country: Country!,
    $language: Language!,
    $first: Int!,
    $popularTitlesSortBy: PopularTitlesSorting! = POPULAR,
    $popularAfterCursor: String,
    $popularTitlesFilter: TitleFilter,
    $platform: Platform! = WEB,
    $sortRandomSeed: Int! = 0
  ) {
    popularTitles(
      country: $country
      filter: $popularTitlesFilter
      after: $popularAfterCursor
      sortBy: $popularTitlesSortBy
      first: $first
      sortRandomSeed: $sortRandomSeed
    ) {
      edges {
        node {
          id
          objectId
          objectType
          content(country: $country, language: $language) {
            title
            originalReleaseYear
            externalIds {
              tmdbId
            }
            posterUrl(profile: S592)
          }
        }
      }
    }
  }
`;

function buildRequest(objectType) {
  return {
    operationName: "GetPopularTitles",
    variables: {
      country: COUNTRY,
      language: LANGUAGE,
      first: TOP_N,
      popularTitlesSortBy: "POPULAR",
      popularAfterCursor: "",
      platform: "WEB",
      sortRandomSeed: 0,
      popularTitlesFilter: {
        ageCertifications: [],
        excludeGenres: [],
        excludeProductionCountries: [],
        genres: [],
        objectTypes: [objectType],
        productionCountries: [],
        excludeIrrelevantTitles: false,
        presentationTypes: [],
        monetizationTypes: [],
      },
    },
    query: POPULAR_TITLES_QUERY,
  };
}

// ─── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchCharts(objectType) {
  const label = objectType === "MOVIE" ? "Movies" : "Shows";
  console.log(`Fetching Top ${TOP_N} ${label} (DE, most popular)...`);

  const res = await fetch(JUSTWATCH_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Origin": "https://www.justwatch.com",
      "Referer": "https://www.justwatch.com/de/streaming-charts",
    },
    body: JSON.stringify(buildRequest(objectType)),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JustWatch API ${res.status} for ${objectType}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();

  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json?.data?.popularTitles?.edges ?? [];
}

// ─── Transform ─────────────────────────────────────────────────────────────────

function edgeToMeta(edge, stremioType) {
  const node = edge.node;
  const content = node.content ?? {};
  const tmdbId = content?.externalIds?.tmdbId;

  if (!tmdbId) {
    console.warn(`  No TMDB ID for "${content.title}" (JW objectId: ${node.objectId}) - skipping.`);
    return null;
  }

  return {
    id: `tmdb:${tmdbId}`,
    type: stremioType,
    name: content.title ?? "Unknown",
    year: content.originalReleaseYear ?? null,
    poster: content.posterUrl ?? undefined,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("JustWatch -> Stremio Manifest Generator\n");

  const [movieEdges, showEdges] = await Promise.all([
    fetchCharts("MOVIE"),
    fetchCharts("SHOW"),
  ]);

  const movies = movieEdges.map((e) => edgeToMeta(e, "movie")).filter(Boolean).slice(0, TOP_N);
  const shows  = showEdges.map((e) => edgeToMeta(e, "series")).filter(Boolean).slice(0, TOP_N);

  console.log(`\nMovies collected: ${movies.length}`);
  movies.forEach((m, i) => console.log(`  ${i + 1}. ${m.name} (${m.year}) -> ${m.id}`));

  console.log(`\nShows collected: ${shows.length}`);
  shows.forEach((s, i) => console.log(`  ${i + 1}. ${s.name} (${s.year}) -> ${s.id}`));

  const now = new Date().toISOString();

  const manifest = {
    id: "de.justwatch.top10-7days",
    version: "1.0.0",
    name: "JustWatch Top 10 DE",
    description: `Auto-generated ${now}. Top 10 Movies & Shows in Germany by popularity.`,
    logo: "https://www.justwatch.com/appassets/img/logo/JustWatch-logo-large.webp",
    resources: ["catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tmdb:"],
    catalogs: [
      {
        type: "movie",
        id: "top10-movies-de-7d",
        name: "Top 10 Movies DE 7 Days",
        extra: [],
        items: movies,
      },
      {
        type: "series",
        id: "top10-shows-de-7d",
        name: "Top 10 Shows DE 7 Days",
        extra: [],
        items: shows,
      },
    ],
    behaviorHints: { configurable: false, adult: false },
    _meta: {
      generatedAt: now,
      source: "https://www.justwatch.com/de/streaming-charts",
      country: COUNTRY,
      tmdbMovies: movies.map((m) => m.id),
      tmdbShows: shows.map((s) => s.id),
    },
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`\nmanifest.json written -> ${OUTPUT_FILE}`);
  console.log("Done!\n");
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
