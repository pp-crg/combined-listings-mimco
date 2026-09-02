#!/usr/bin/env node
/**
 * PHO-784: candidate group generator.
 *
 * GROUPING KEY: exact normalised title + productType.
 *
 * Mimco titles do not carry the colour, so three colourways of one style share
 * an identical title. An extra word means a different product:
 *   'Blondie Mini Tote Bag'            -> style A, however many colourways
 *   'Blondie Mini Tote Crossbody Bag'  -> style B, never merged with A
 *
 * Normalisation is deliberately conservative. Case, punctuation, '&' vs 'and',
 * and whitespace are levelled. No words are ever removed, because every word
 * carries product meaning.
 *
 * FLAGS (recorded for review, never used to reject a group):
 *   WIDE_CODE_SPREAD  style codes in the group are far apart. Usually means a
 *                     style name was reused in a later season. Check these.
 *   DUPLICATE_COLOUR  two children resolve to the same colour name.
 *   SIZE_SCALE_DIFF   colourways run different size scales. Expected and fine.
 *   PRICE_VARIANCE    price spread exceeds --price-ratio. Parent shows a range.
 *   OVERSIZED         more colourways than --max-group.
 *   SINGLETON_PARENT  child is currently the only child of its own parent and
 *                     can be consolidated into a same-title group.
 *
 * NEAR-MISS REPORT: exact matching cannot recover a group whose titles differ
 * by a typo, a plural or a stray hyphen. Those pairs are written to a separate
 * file for upstream correction rather than merged automatically.
 *
 * Emits groups.csv with `approved` left BLANK. A human fills it in.
 * Nothing here writes to Shopify.
 *
 * style_group_id is minted here, not read from Shopify. It is the lowest style
 * code in the group, so re-running on the same catalogue is deterministic.
 *
 * Node 18+. No dependencies.
 *
 *   node --env-file=.env build-groups.mjs --type "Bags" --out groups.csv
 *   node --env-file=.env build-groups.mjs --warn-gap 50 --near-out near-misses.csv
 */

import fs from "node:fs";
import process from "node:process";
import { createTokenProvider, resolveCredentials, credentialSummary } from "./shopify-auth.mjs";

const DEFAULT_API_VERSION = "2025-10";
const DEFAULT_WARN_GAP = 100;        // code spread before WIDE_CODE_SPREAD fires
const DEFAULT_SPLIT_GAP = 0;         // 0 = never split a title group on code gap
const DEFAULT_MAX_GROUP = 12;
const DEFAULT_PRICE_RATIO = 1.5;
const DEFAULT_NEAR_THRESHOLD = 0.90; // string similarity for the near-miss report
const NEAR_WINDOW = 40;              // how many neighbouring codes to compare

const Q_PRODUCTS = `
query catalogue($query: String!, $cursor: String) {
  products(first: 100, query: $query, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status productType combinedListingRole
      combinedListing {
        parentProduct {
          id handle title status
          options { id name values }
          combinedListing {
            combinedListingChildren(first: 2) { nodes { product { id } } }
          }
        }
      }
      options { name values }
      priceRangeV2 { minVariantPrice { amount currencyCode } }
      variants(first: 100) { nodes { sku selectedOptions { name value } } }
    }
  }
}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(endpoint, getToken, query, variables) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": await getToken(),
      },
      body: JSON.stringify({ query, variables }),
    });
    if (resp.status === 401 && attempt === 0) {
      console.error("  401 received, forcing a token refresh");
      await getToken(true);
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) { await sleep(2 ** attempt * 1000); continue; }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const body = await resp.json();
    if (body.errors?.some(e => e.extensions?.code === "THROTTLED")) { await sleep(2 ** attempt * 1000); continue; }
    if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
    const t = body.extensions?.cost?.throttleStatus;
    if (t && t.currentlyAvailable < 200) {
      await sleep(((200 - t.currentlyAvailable) / (t.restoreRate || 50)) * 1000);
    }
    return body.data;
  }
  throw new Error("Exhausted retries");
}

// ---------------------------------------------------------------------------
// Title normalisation: levels formatting only. No words are removed.
// ---------------------------------------------------------------------------

function normTitle(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")  // strip accents
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")                        // punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable fallback id when no member of a group has a parseable style code. */
function titleSlug(norm) {
  return norm.replace(/\s+/g, "-").slice(0, 48);
}

function normType(node) {
  return (node.productType || "").toLowerCase().trim();
}

/** 0..1 string similarity, used only for the near-miss report. */
function stringSimilarity(a, b) {
  if (a === b) return 1;
  const [s, t] = a.length >= b.length ? [a, b] : [b, a];
  if (!s.length) return 1;
  if (s.length - t.length > s.length * 0.25) return 0;   // cheap early exit
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return 1 - prev[t.length] / s.length;
}

// ---------------------------------------------------------------------------
// Product helpers
// ---------------------------------------------------------------------------

/** 60318168-448 -> { style: 60318168, colour: "448" } */
function splitHandle(handle) {
  const m = handle.match(/^(\d{4,})-(\w+)$/);
  return m ? { style: Number(m[1]), colour: m[2] } : null;
}

/** Sorted size option values. Recorded for flagging, never gated on. */
function sizeScale(node) {
  const opt = node.options?.find(o => /size/i.test(o.name));
  return opt ? [...opt.values].sort().join(",") : "";
}

/** Best available colour name, else the raw colour code. */
function colourName(node, colourCode) {
  const opt = node.options?.find(o => /colou?r/i.test(o.name));
  if (opt?.values?.length === 1) return opt.values[0];
  const sel = node.variants?.nodes?.[0]?.selectedOptions?.find(o => /colou?r/i.test(o.name));
  if (sel?.value) return sel.value;
  return colourCode ?? "";
}

/** Return the live parent only when this child is its sole attached child. */
function singletonParent(node) {
  if (node.combinedListingRole !== "CHILD") return null;
  const parent = node.combinedListing?.parentProduct;
  const children = parent?.combinedListing?.combinedListingChildren?.nodes ?? [];
  return children.length === 1 && children[0].product.id === node.id ? parent : null;
}

/** Ascending style code, unparseable handles last. */
const byCode = (a, b) => (a.style ?? Infinity) - (b.style ?? Infinity);

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, columns, rows) {
  const body = [columns.join(","), ...rows.map(r => columns.map(c => csvEscape(r[c])).join(","))];
  fs.writeFileSync(file, body.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Optional split of a title group on a large code gap
// ---------------------------------------------------------------------------

function splitOnGap(items, gap) {
  if (!gap) return [items];
  const out = [];
  let current = [];
  for (const item of items) {
    const prev = current[current.length - 1];
    const noCode = !current.length || item.style == null || prev.style == null;
    if (noCode || item.style - prev.style <= gap) current.push(item);
    else { out.push(current); current = [item]; }
  }
  if (current.length) out.push(current);
  return out;
}

// ---------------------------------------------------------------------------
// Near-miss detection, for upstream title correction
// ---------------------------------------------------------------------------

function findNearMisses(items, threshold) {
  // items are already sorted by style code within one productType
  const seen = new Set();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < Math.min(items.length, i + NEAR_WINDOW); j++) {
      const a = items[i], b = items[j];
      if (a.normTitle === b.normTitle) continue;
      const gapVal = (a.style != null && b.style != null) ? Math.abs(a.style - b.style) : "";
      const pair = a.normTitle < b.normTitle
        ? `${a.normTitle}||${b.normTitle}` : `${b.normTitle}||${a.normTitle}`;
      if (seen.has(pair)) continue;
      const sim = stringSimilarity(a.normTitle, b.normTitle);
      if (sim < threshold) continue;
      seen.add(pair);
      out.push({
        product_type: a.node.productType ?? "",
        similarity: sim.toFixed(3),
        title_a: a.node.title,
        handle_a: a.node.handle,
        title_b: b.node.title,
        handle_b: b.node.handle,
        code_gap: gapVal,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    out: "groups.csv",
    nearOut: "near-misses.csv",
    unmatchedOut: "unmatched-handles.csv",
    warnGap: DEFAULT_WARN_GAP,
    splitGap: DEFAULT_SPLIT_GAP,
    maxGroup: DEFAULT_MAX_GROUP,
    priceRatio: DEFAULT_PRICE_RATIO,
    nearThreshold: DEFAULT_NEAR_THRESHOLD,
    apiVersion: DEFAULT_API_VERSION,
    // Draft children still belong in a Combined Listing; only archived products
    // are excluded from the default candidate catalogue.
    query: "(status:active OR status:draft)",
  };
  for (let i = 0; i < argv.length; i++) {
    const n = () => argv[++i];
    switch (argv[i]) {
      case "--out": a.out = n(); break;
      case "--near-out": a.nearOut = n(); break;
      case "--unmatched-out": a.unmatchedOut = n(); break;
      case "--warn-gap": a.warnGap = Number(n()); break;
      case "--split-gap": a.splitGap = Number(n()); break;
      case "--max-group": a.maxGroup = Number(n()); break;
      case "--price-ratio": a.priceRatio = Number(n()); break;
      case "--near-threshold": a.nearThreshold = Number(n()); break;
      case "--type": a.type = n(); break;
      case "--query": a.query = n(); break;
      case "--shop": a.shop = n(); break;
      case "--token": a.token = n(); break;
      case "--client-id": a.clientId = n(); break;
      case "--client-secret": a.clientSecret = n(); break;
      case "--api-version": a.apiVersion = n(); break;
      case "--limit": a.limit = Number(n()); break;
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const creds = resolveCredentials(args);
  if (!creds.shop) {
    console.error("Set SHOPIFY_SHOP (e.g. mimco-staging.myshopify.com)");
    process.exit(1);
  }
  let getToken;
  try {
    getToken = createTokenProvider(creds);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`Auth: ${credentialSummary(creds)}`);
  const endpoint = `https://${creds.shop}/admin/api/${args.apiVersion}/graphql.json`;
  let query = args.query;
  if (args.type) query += ` AND product_type:'${args.type}'`;

  console.log(`Fetching catalogue with query: ${query}`);
  const nodes = [];
  let cursor = null;
  for (;;) {
    const data = await gql(endpoint, getToken, Q_PRODUCTS, { query, cursor });
    nodes.push(...data.products.nodes);
    process.stdout.write(`\r  fetched ${nodes.length}`);
    if (!data.products.pageInfo.hasNextPage) break;
    if (args.limit && nodes.length >= args.limit) break;
    cursor = data.products.pageInfo.endCursor;
  }
  console.log(`\nFetched ${nodes.length} products`);

  const eligible = nodes
    .map(node => ({ node, sourceParent: singletonParent(node) }))
    .filter(({ node, sourceParent }) =>
      !node.combinedListingRole || node.combinedListingRole === "NONE" || sourceParent
    );
  const singletonChildren = eligible.filter(e => e.sourceParent).length;
  console.log(`${eligible.length} eligible (${singletonChildren} from singleton combined listings)`);

  const items = [];
  const unparsed = [];
  for (const { node, sourceParent } of eligible) {
    const parts = splitHandle(node.handle);
    if (!parts) unparsed.push(node);
    items.push({
      node,
      sourceParent,
      style: parts?.style ?? null,
      colourCode: parts?.colour ?? null,
      colour: colourName(node, parts?.colour ?? null) || colourName(sourceParent, null),
      normTitle: normTitle(node.title),
      type: normType(node),
      sizeScale: sizeScale(node),
      price: Number(node.priceRangeV2?.minVariantPrice?.amount ?? 0),
    });
  }
  if (unparsed.length) {
    console.log(`\n${unparsed.length} handles are non-standard (still grouped by title, but they`);
    console.log(`contribute no style code, so the group id and spread come from the others):`);
    for (const n of unparsed.slice(0, 20)) {
      console.log(`    ${n.handle.padEnd(44)} ${n.title}`);
    }
    if (unparsed.length > 20) console.log(`    ... and ${unparsed.length - 20} more`);
    writeCsv(args.unmatchedOut, ["handle", "title", "product_type", "status"],
      unparsed.map(n => ({
        handle: n.handle, title: n.title,
        product_type: n.productType ?? "", status: n.status ?? "",
      })));
    console.log(`  full list written to ${args.unmatchedOut}\n`);
  }

  // ---- Grouping: exact normalised title + productType -----------------------
  const buckets = new Map();
  for (const it of items) {
    const key = `${it.type}::${it.normTitle}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }

  const rows = [];
  const stats = {
    groups: 0, singletons: 0, oversized: 0, wideSpread: 0,
    dupColour: 0, sizeDiff: 0, priceVariance: 0, splits: 0,
    nonStandard: 0, missingColour: 0,
  };

  for (const bucket of buckets.values()) {
      bucket.sort(byCode);
    const pieces = splitOnGap(bucket, args.splitGap);
    if (pieces.length > 1) stats.splits += pieces.length - 1;

    for (const group of pieces) {
      if (group.length < 2) { stats.singletons++; continue; }

      const flags = [];
      const codes = group.map(g => g.style).filter(c => c != null);
      const spread = codes.length > 1 ? Math.max(...codes) - Math.min(...codes) : null;

      if (group.length > args.maxGroup) { stats.oversized++; flags.push("OVERSIZED"); }
      if (group.some(g => g.sourceParent)) flags.push("SINGLETON_PARENT");
      if (spread != null && spread > args.warnGap) { stats.wideSpread++; flags.push("WIDE_CODE_SPREAD"); }
      if (codes.length < group.length) { stats.nonStandard++; flags.push("NONSTANDARD_HANDLE"); }
      if (group.some(g => !g.colour)) { stats.missingColour++; flags.push("MISSING_COLOUR"); }

      const colours = group.map(g => g.colour);
      if (new Set(colours).size !== colours.length) { stats.dupColour++; flags.push("DUPLICATE_COLOUR"); }

      if (new Set(group.map(g => g.sizeScale)).size > 1) { stats.sizeDiff++; flags.push("SIZE_SCALE_DIFF"); }

      const prices = group.map(g => g.price).filter(p => p > 0);
      if (prices.length && Math.max(...prices) / Math.min(...prices) > args.priceRatio) {
        stats.priceVariance++; flags.push("PRICE_VARIANCE");
      }

      const styleGroupId = codes.length
        ? `MIM-${Math.min(...codes)}`
        : `MIM-T-${titleSlug(group[0].normTitle)}`;
      const parentTitle = group[0].node.title.trim();   // identical across children
      stats.groups++;

      group.forEach((g, i) => {
        rows.push({
          style_group_id: styleGroupId,
          parent_title: parentTitle,
          parent_type: g.node.productType ?? "",
          child_handle: g.node.handle,
          colour_name: g.colour,
          swatch_order: i + 1,
          approved: "",                            // human fills this in
          _child_title: g.node.title,
          _style_code: g.style ?? "",
          _colour_code: g.colourCode ?? "",
          _price: g.price || "",
          _size_scale: g.sizeScale,
          _code_spread: spread ?? "",
          _source_parent_id: g.sourceParent?.id ?? "",
          _source_parent_handle: g.sourceParent?.handle ?? "",
          _flags: flags.join("|"),
        });
      });
    }
  }

  // Flagged groups first so review effort lands where it matters.
  rows.sort((a, b) =>
    (b._flags ? 1 : 0) - (a._flags ? 1 : 0) ||
    a.style_group_id.localeCompare(b.style_group_id) ||
    a.swatch_order - b.swatch_order
  );

  writeCsv(args.out, [
    "style_group_id", "parent_title", "parent_type",
    "child_handle", "colour_name", "swatch_order", "approved",
    "_child_title", "_style_code", "_colour_code", "_price",
    "_size_scale", "_code_spread", "_source_parent_id",
    "_source_parent_handle", "_flags",
  ], rows);

  // ---- Near-miss report -----------------------------------------------------
  const byType = new Map();
  for (const it of items) {
    if (!byType.has(it.type)) byType.set(it.type, []);
    byType.get(it.type).push(it);
  }
  const nearMisses = [];
  for (const list of byType.values()) {
    list.sort(byCode);
    nearMisses.push(...findNearMisses(list, args.nearThreshold));
  }
  nearMisses.sort((a, b) => Number(b.similarity) - Number(a.similarity));
  writeCsv(args.nearOut, [
    "product_type", "similarity", "code_gap",
    "title_a", "handle_a", "title_b", "handle_b",
  ], nearMisses);

  console.log(`
Wrote ${args.out}
  candidate groups  : ${stats.groups}
  rows              : ${rows.length}
  singletons        : ${stats.singletons}  (left as standalone PDPs)
  OVERSIZED         : ${stats.oversized}
  WIDE_CODE_SPREAD  : ${stats.wideSpread}  (likely a reused style name, check these)
  DUPLICATE_COLOUR  : ${stats.dupColour}  (must be fixed before approval)
  NONSTANDARD_HANDLE: ${stats.nonStandard}  (grouped fine, no style code contributed)
  MISSING_COLOUR    : ${stats.missingColour}  (fill colour_name in before approving)
  SIZE_SCALE_DIFF   : ${stats.sizeDiff}  (expected, informational)
  PRICE_VARIANCE    : ${stats.priceVariance}  (parent shows a price range)
  split on code gap : ${stats.splits}  (--split-gap ${args.splitGap})

Wrote ${args.nearOut}
  near-miss pairs   : ${nearMisses.length}  (titles that differ only by a typo,
                      plural or hyphen. Fix the source titles, then re-run.
                      These are NOT merged automatically.)

Flagged groups sort to the top of ${args.out}. Open in Sheets, add =IMAGE() on
the product image, review, set 'approved' to Y, then run combine-listings.mjs.
Columns prefixed with _ are review aids and are ignored by the push script.
`);
}

main().catch(err => { console.error(err); process.exit(1); });
