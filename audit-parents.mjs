#!/usr/bin/env node
/**
 * PHO-784: audit every combined listing parent in the store.
 *
 * Lists all PARENT products with their option count, variant titles, and
 * children, then flags:
 *   DUPLICATE_OPTIONS  more than one colour option (renders two picker rows)
 *   DUPLICATE_PARENT   another parent shares the same title
 *   NO_CHILDREN        parent with nothing attached
 *   ZERO_PRICE         price range tops out at 0, PDP shows Unavailable
 *   NO_MEDIA           parent has no image
 *
 *   node --env-file=.env audit-parents.mjs
 *   node --env-file=.env audit-parents.mjs --broken-only
 */

import process from "node:process";
import { createTokenProvider, resolveCredentials } from "./shopify-auth.mjs";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const n = () => argv[++i];
  switch (argv[i]) {
    case "--api-version": args.apiVersion = n(); break;
    case "--broken-only": args.brokenOnly = true; break;
    case "--title": args.title = n(); break;
    case "--handle": args.handle = n(); break;
    case "--id": args.id = n(); break;
    case "--group": args.group = n(); break;
    case "--flag": args.flag = n(); break;
    case "--mine": args.mine = true; break;
    case "--from-log": args.fromLog = n() ?? "run_log.csv"; break;
    case "--since": args.since = n(); break;
    case "--limit": args.limit = Number(n()); break;
    case "--quiet": args.quiet = true; break;
    case "--help": args.help = true; break;
  }
}

if (args.help) {
  console.log(`
audit-parents.mjs — list combined listing parents

  --broken-only        only parents with flags
  --flag NAME          only parents carrying NAME (e.g. DUPLICATE_OPTIONS)
  --mine               only parents that have a custom.style_group_id
  --from-log [FILE]    only parent ids recorded in a run log (default run_log.csv)
  --title TEXT         title contains TEXT (case-insensitive)
  --handle TEXT        handle contains TEXT
  --id ID              numeric id or full gid
  --group ID           exact style_group_id, e.g. MIM-T-blondie-mini-tote-bag
  --since YYYY-MM-DD   created on or after this date
  --limit N            cap the number printed
  --quiet              one line per parent instead of the full block
`);
  process.exit(0);
}
const apiVersion = args.apiVersion ?? "2025-10";
const creds = resolveCredentials(args);
const getToken = createTokenProvider(creds);
const endpoint = `https://${creds.shop}/admin/api/${apiVersion}/graphql.json`;

const Q = `
query parents($cursor: String) {
  products(first: 100, query: "combined_listing_role:parent", after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status createdAt
      metafield(namespace: "custom", key: "style_group_id") { value }
      featuredMedia { id }
      options { id name position optionValues { name } }
      variants(first: 20) { nodes { title } }
      priceRangeV2 { maxVariantPrice { amount } }
      combinedListing {
        combinedListingChildren(first: 50) { nodes { product { handle } } }
      }
    }
  }
}`;

async function gql(query, variables) {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": await getToken(),
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await resp.json();
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors, null, 2));
  return body.data;
}

const parents = [];
let cursor = null;
for (;;) {
  const d = await gql(Q, { cursor });
  parents.push(...d.products.nodes);
  if (!d.products.pageInfo.hasNextPage) break;
  cursor = d.products.pageInfo.endCursor;
}

const byTitle = new Map();
for (const p of parents) {
  const k = p.title.trim().toLowerCase();
  if (!byTitle.has(k)) byTitle.set(k, []);
  byTitle.get(k).push(p);
}

const total = parents.length;
let logIds = null;
if (args.fromLog) {
  const fs = await import("node:fs");
  if (!fs.existsSync(args.fromLog)) {
    console.error(`Log not found: ${args.fromLog}`);
    process.exit(1);
  }
  logIds = new Set(
    fs.readFileSync(args.fromLog, "utf8")
      .split("\n").slice(1).filter(Boolean)
      .map(l => l.split(",")[3])
      .filter(Boolean)
  );
}

const lc = v => String(v ?? "").toLowerCase();
const shown = parents.filter(p => {
  if (args.title && !lc(p.title).includes(lc(args.title))) return false;
  if (args.handle && !lc(p.handle).includes(lc(args.handle))) return false;
  if (args.id && !p.id.endsWith(String(args.id).split("/").pop())) return false;
  if (args.group && p.metafield?.value !== args.group) return false;
  if (args.mine && !p.metafield?.value) return false;
  if (logIds && !logIds.has(p.id)) return false;
  if (args.since && new Date(p.createdAt) < new Date(args.since)) return false;
  return true;
});

shown.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

const active = [];
if (args.title) active.push(`title~"${args.title}"`);
if (args.handle) active.push(`handle~"${args.handle}"`);
if (args.id) active.push(`id=${args.id}`);
if (args.group) active.push(`group=${args.group}`);
if (args.mine) active.push("mine");
if (logIds) active.push(`from-log ${args.fromLog}`);
if (args.since) active.push(`since ${args.since}`);
if (args.flag) active.push(`flag=${args.flag}`);
if (args.brokenOnly) active.push("broken-only");

let broken = 0;
console.log(`\n${total} parent(s) in store` +
  (active.length ? `, ${shown.length} match [${active.join(", ")}]` : "") + `\n`);

let printed = 0;
for (const p of shown) {
  const flags = [];
  const colourOpts = p.options.filter(o => /colou?r/i.test(o.name));
  if (colourOpts.length > 1) flags.push(`DUPLICATE_OPTIONS(${colourOpts.length})`);

  const dupes = byTitle.get(p.title.trim().toLowerCase()) ?? [];
  if (dupes.length > 1) flags.push(`DUPLICATE_PARENT(${dupes.length})`);

  const children = p.combinedListing?.combinedListingChildren?.nodes ?? [];
  if (!children.length) flags.push("NO_CHILDREN");
  if (Number(p.priceRangeV2.maxVariantPrice.amount) <= 0) flags.push("ZERO_PRICE");
  if (!p.featuredMedia) flags.push("NO_MEDIA");

  const isBroken = flags.length > 0;
  if (isBroken) broken++;
  if (args.brokenOnly && !isBroken) continue;
  if (args.flag && !flags.some(f => f.toUpperCase().startsWith(args.flag.toUpperCase()))) continue;
  if (args.limit && printed >= args.limit) continue;
  printed++;

  if (args.quiet) {
    console.log(
      `${isBroken ? "BROKEN" : "ok    "}  ${p.id.split("/").pop().padEnd(16)}` +
      `${("/" + p.handle).padEnd(46)} opts=${p.options.length} ` +
      `kids=${children.length}  ${flags.join(" ")}`
    );
    continue;
  }

  console.log(`${isBroken ? "BROKEN " : "ok     "} ${p.title}`);
  console.log(`         group   ${p.metafield?.value ?? "(no style_group_id)"}`);
  console.log(`         id      ${p.id}`);
  console.log(`         handle  /products/${p.handle}   [${p.status}]`);
  console.log(`         created ${p.createdAt}`);
  console.log(`         options ${p.options.map(o => `${o.position}:"${o.name}"(${o.optionValues.length})`).join("  ")}`);
  console.log(`         variants ${p.variants.nodes.map(v => v.title).join(" | ") || "(none)"}`);
  console.log(`         children ${children.map(c => c.product.handle).join(", ") || "(none)"}`);
  if (flags.length) console.log(`         FLAGS   ${flags.join("  ")}`);
  console.log("");
}

console.log(`${broken} of ${shown.length} shown parent(s) have problems (${total} in store).`);
if (broken) {
  console.log(`Delete the broken ones in the admin, or roll them back, then re-run the push.\n`);
} else {
  console.log(`All parents are structurally correct. If the storefront still shows two`);
  console.log(`picker rows, you are viewing a cached page or a different URL.\n`);
}
