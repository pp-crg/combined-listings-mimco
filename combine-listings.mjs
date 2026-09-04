#!/usr/bin/env node
/**
 * PHO-784: Combined Listings backfill for Mimco.
 *
 * Creates a PARENT product per style group and attaches existing style_colour
 * products as children, so colourways surface as swatches on one PDP.
 * Nothing moves. Every child keeps its product ID, SKUs, inventory and images.
 *
 * Per group:
 *   1. productSet            create parent with combinedListingRole: PARENT
 *   2. combinedListingUpdate detach children from verified singleton parents
 *   3. productOptionsDelete  remove each child's redundant Colour option
 *   4. combinedListingUpdate attach children with their colour option
 *   5. metafieldsSet         stamp custom.style_group_id on parent + children
 *   6. productDelete         remove redundant singleton parents
 *
 * Node 18+. No dependencies.
 *
 *   node --env-file=.env combine-listings.mjs --input groups-bags-leather.csv --dry-run
 *   node --env-file=.env combine-listings.mjs --input groups-bags-leather.csv --limit 2 --status ACTIVE
 *   node --env-file=.env combine-listings.mjs --input groups-bags-leather.csv --resume
 *   node --env-file=.env combine-listings.mjs --rollback --log run_log.csv
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createTokenProvider, resolveCredentials, credentialSummary } from "./shopify-auth.mjs";

// ---------------------------------------------------------------------------
// Schema flags to verify on the first dry run against your API version.
// Shopify's docs show selectedParentOptionValues as both an object and a list
// in different examples. Flip this if the API rejects the list form.
// ---------------------------------------------------------------------------
const SELECTED_OPTION_AS_LIST = true;

const DEFAULT_API_VERSION = "2025-10";
const DEFAULT_OPTION_NAME = "Colour";
const METAFIELD_NAMESPACE = "custom";
const METAFIELD_KEY = "style_group_id";

const THROTTLE_FLOOR = 200;
const MAX_RETRIES = 5;

// ---------------------------------------------------------------------------
// Tiny CSV reader/writer (RFC4180-ish, handles quoted fields and embedded commas)
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(v => v.trim() !== ""));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map(h => h.trim());
  return nonEmpty.slice(1).map(r =>
    Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()]))
  );
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

const Q_SHOP = `query { shop { id name plan { displayName partnerDevelopment shopifyPlus } } }`;

const Q_PRODUCTS_BY_HANDLE = `
query productsByHandle($query: String!, $cursor: String) {
  products(first: 50, query: $query, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status productType vendor combinedListingRole
      combinedListing {
        parentProduct {
          id handle title status
          options { id name optionValues { name } }
          combinedListing {
            combinedListingChildren(first: 2) { nodes { product { id } } }
          }
        }
      }
      options { id name }
    }
  }
}`;

const M_CREATE_PARENT = `
mutation createParent($input: ProductSetInput!) {
  productSet(synchronous: true, input: $input) {
    product { id title handle status combinedListingRole options { id name } }
    userErrors { code field message }
  }
}`;

const M_ATTACH_CHILDREN = `
mutation attachChildren(
  $parentProductId: ID!,
  $productsAdded: [ChildProductRelationInput!],
  $optionsAndValues: [OptionAndValueInput!]
) {
  combinedListingUpdate(
    parentProductId: $parentProductId,
    productsAdded: $productsAdded,
    optionsAndValues: $optionsAndValues
  ) {
    product {
      id
      combinedListing {
        combinedListingChildren(first: 50) { nodes { product { id handle } } }
      }
    }
    userErrors { code field message }
  }
}`;

const M_REMOVE_CHILDREN = `
mutation removeChildren($parentProductId: ID!, $productsRemovedIds: [ID!]) {
  combinedListingUpdate(parentProductId: $parentProductId, productsRemovedIds: $productsRemovedIds) {
    product { id }
    userErrors { code field message }
  }
}`;

const M_DELETE_PRODUCT = `
mutation deleteProduct($input: ProductDeleteInput!) {
  productDelete(input: $input) { deletedProductId userErrors { field message } }
}`;

const Q_CHILD_OPTIONS = `
query childOptions($id: ID!) {
  product(id: $id) {
    id
    handle
    options { id name optionValues { name } }
  }
}`;

const M_DELETE_OPTIONS = `
mutation deleteOptions($productId: ID!, $options: [ID!]!) {
  productOptionsDelete(productId: $productId, options: $options, strategy: NON_DESTRUCTIVE) {
    deletedOptionsIds
    userErrors { code field message }
  }
}`;

const M_SET_METAFIELDS = `
mutation setMetafields($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id key namespace }
    userErrors { field message code }
  }
}`;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

class ShopifyClient {
  constructor({ shop, getToken, apiVersion, dryRun = false, verbose = false }) {
    this.endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
    this.getToken = getToken;
    this.dryRun = dryRun;
    this.verbose = verbose;
    this.callCount = 0;
  }

  async post(query, variables, { mutation = false, label = "" } = {}) {
    if (variables == null || typeof variables !== "object" || Array.isArray(variables)) {
      throw new Error(`${label || "post"}: variables must be a plain object, got ${
        variables === null ? "null" : Array.isArray(variables) ? "array" : typeof variables
      }`);
    }

    if (mutation && this.dryRun) {
      console.log(`\n--- DRY RUN [${label}] ---`);
      console.log(JSON.stringify({ variables }, null, 2));
      return { __dryRun: true };
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const resp = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": await this.getToken(),
        },
        body: JSON.stringify({ query, variables }),
      });

      if (resp.status === 401 && attempt === 0) {
        console.error("  401 received, forcing a token refresh");
        await this.getToken(true);
        continue;
      }

      if (resp.status === 429 || resp.status >= 500) {
        const wait = 2 ** attempt * 1000;
        console.error(`  ${resp.status} received, sleeping ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
      }

      const body = await resp.json();
      this.callCount++;

      const errors = body.errors ?? [];
      if (errors.some(e => e.extensions?.code === "THROTTLED")) {
        const wait = 2 ** attempt * 1000;
        console.error(`  THROTTLED, sleeping ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (errors.length) {
        throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
      }

      await this.#respectThrottle(body);
      return body.data;
    }
    throw new Error(`Exhausted ${MAX_RETRIES} retries on ${label}`);
  }

  async #respectThrottle(body) {
    const t = body.extensions?.cost?.throttleStatus;
    if (!t) return;
    const { currentlyAvailable, restoreRate = 50 } = t;
    if (currentlyAvailable != null && currentlyAvailable < THROTTLE_FLOOR) {
      const wait = ((THROTTLE_FLOOR - currentlyAvailable) / restoreRate) * 1000;
      if (this.verbose) console.log(`  bucket at ${currentlyAvailable}, sleeping ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
    }
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const REQUIRED_COLUMNS = [
  "style_group_id", "parent_title", "child_handle",
  "colour_name", "swatch_order", "approved",
];

function loadGroups(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (!rows.length) { console.error("Input CSV is empty"); process.exit(1); }
  const missing = REQUIRED_COLUMNS.filter(c => !(c in rows[0]));
  if (missing.length) {
    console.error(`Input CSV missing columns: ${missing.join(", ")}`);
    process.exit(1);
  }

  const groups = new Map();
  for (const row of rows) {
    if (!["Y", "YES", "TRUE", "1"].includes(row.approved.toUpperCase())) continue;
    const gid = row.style_group_id;
    if (!groups.has(gid)) {
      groups.set(gid, {
        styleGroupId: gid,
        parentTitle: row.parent_title,
        parentType: row.parent_type ?? "",
        parentVendor: row.parent_vendor ?? "",
        children: [],
      });
    }
    groups.get(gid).children.push({
      handle: row.child_handle,
      colourName: row.colour_name,
      swatchOrder: Number(row.swatch_order || 0),
      sourceParentId: row._source_parent_id || "",
      sourceParentHandle: row._source_parent_handle || "",
    });
  }
  for (const g of groups.values()) {
    g.children.sort((a, b) => a.swatchOrder - b.swatchOrder);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function resolveHandles(client, handles) {
  const resolved = new Map();
  const list = [...handles];
  for (let i = 0; i < list.length; i += 40) {
    const batch = list.slice(i, i + 40);
    const query = batch.map(h => `handle:${h}`).join(" OR ");
    let cursor = null;
    for (;;) {
      const data = await client.post(Q_PRODUCTS_BY_HANDLE, { query, cursor }, { label: "resolveHandles" });
      for (const node of data.products.nodes) resolved.set(node.handle, node);
      if (!data.products.pageInfo.hasNextPage) break;
      cursor = data.products.pageInfo.endCursor;
    }
  }
  return resolved;
}

function preflight(groups, resolved, { consolidateSingletons = false } = {}) {
  const problems = [];
  const ok = new Map();

  const seen = new Map();
  for (const [gid, g] of groups) {
    for (const c of g.children) {
      if (!seen.has(c.handle)) seen.set(c.handle, []);
      seen.get(c.handle).push(gid);
    }
  }
  const duplicated = new Set();
  for (const [handle, gids] of seen) {
    if (gids.length > 1) {
      duplicated.add(handle);
      problems.push(["GLOBAL", handle, `appears in groups ${gids.join(", ")}`]);
    }
  }

  for (const [gid, g] of groups) {
    const errs = [];
    if (g.children.length < 2) errs.push("group has fewer than 2 children");
    if (!g.parentTitle) errs.push("parent_title is empty");

    const colours = g.children.map(c => c.colourName);
    if (new Set(colours).size !== colours.length) {
      errs.push(`duplicate colour_name within group: ${colours.join(", ")}`);
    }

    for (const c of g.children) {
      const node = resolved.get(c.handle);
      if (!node) { errs.push(`handle not found in Shopify: ${c.handle}`); continue; }
      c.productId = node.id;
      c.status = node.status;
      if (node.status === "ARCHIVED") errs.push(`child is ARCHIVED: ${c.handle}`);
      if (node.combinedListingRole === "CHILD") {
        const p = node.combinedListing?.parentProduct;
        const children = p?.combinedListing?.combinedListingChildren?.nodes ?? [];
        const isVerifiedSingleton =
          consolidateSingletons &&
          c.sourceParentId &&
          p?.id === c.sourceParentId &&
          children.length === 1 &&
          children[0].product.id === node.id;

        if (!isVerifiedSingleton) {
          const hint = c.sourceParentId && !consolidateSingletons
            ? " (pass --consolidate-singletons to migrate verified singleton parents)"
            : "";
          errs.push(`child already attached to parent ${p?.title ?? "?"}: ${c.handle}${hint}`);
        } else {
          const colourOptions = (p.options ?? []).filter(o => /colou?r/i.test(o.name));
          const colourValues = colourOptions[0]?.optionValues ?? [];
          if (colourOptions.length !== 1 || colourValues.length !== 1) {
            errs.push(`source parent is not a one-colour singleton: ${p.handle}`);
          } else {
            c.sourceParent = {
              id: p.id,
              handle: p.handle,
              title: p.title,
              status: p.status,
              options: p.options,
              colourOptionId: colourOptions[0].id,
              colourOptionName: colourOptions[0].name,
            };
          }
        }
      } else if (c.sourceParentId) {
        errs.push(`CSV expects singleton parent ${c.sourceParentId}, but child is no longer attached: ${c.handle}`);
      }
      if (node.combinedListingRole === "PARENT") errs.push(`child is itself a PARENT: ${c.handle}`);
      if (duplicated.has(c.handle)) errs.push(`child claimed by multiple groups: ${c.handle}`);
      if (!c.colourName) errs.push(`empty colour_name for ${c.handle}`);
    }

    const first = resolved.get(g.children[0]?.handle);
    if (first) {
      g.parentType ||= first.productType ?? "";
      g.parentVendor ||= first.vendor ?? "";
    }

    const sourceParents = g.children.filter(c => c.sourceParent).map(c => c.sourceParent);
    if (sourceParents.length) {
      g.reuseParent = sourceParents.find(p => p.status === "ACTIVE") ?? sourceParents[0];
    }

    if (errs.length) for (const e of errs) problems.push([gid, g.parentTitle, e]);
    else ok.set(gid, g);
  }

  return { ok, problems };
}

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

const LOG_COLUMNS = [
  "timestamp", "style_group_id", "status", "parent_id",
  "parent_title", "child_ids", "child_handles", "message",
];

class RunLog {
  constructor(file) {
    this.file = file;
    if (!fs.existsSync(file)) fs.writeFileSync(file, LOG_COLUMNS.join(",") + "\n");
  }
  write(fields) {
    const row = { timestamp: new Date().toISOString(), ...fields };
    fs.appendFileSync(this.file, LOG_COLUMNS.map(c => csvEscape(row[c] ?? "")).join(",") + "\n");
  }
  static rows(file) {
    if (!fs.existsSync(file)) return [];
    return parseCsv(fs.readFileSync(file, "utf8"));
  }
  static completed(file) {
    return new Set(RunLog.rows(file).filter(r => r.status === "CREATED").map(r => r.style_group_id));
  }
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

async function createParent(client, g, status) {
  const input = { title: g.parentTitle, status, combinedListingRole: "PARENT" };
  if (g.parentType) input.productType = g.parentType;
  if (g.parentVendor) input.vendor = g.parentVendor;

  const data = await client.post(M_CREATE_PARENT, { input }, { mutation: true, label: `createParent ${g.styleGroupId}` });
  if (data.__dryRun) return { id: `gid://shopify/Product/DRYRUN-${g.styleGroupId}`, options: [] };

  const r = data.productSet;
  if (r.userErrors?.length) throw new Error(`productSet: ${JSON.stringify(r.userErrors)}`);
  return r.product;
}

async function detachSingletonChildren(client, g, retainedParentId) {
  for (const child of g.children.filter(c =>
    c.sourceParent && c.sourceParent.id !== retainedParentId
  )) {
    const data = await client.post(
      M_REMOVE_CHILDREN,
      { parentProductId: child.sourceParent.id, productsRemovedIds: [child.productId] },
      { mutation: true, label: `detachSingleton ${child.sourceParent.handle}` }
    );
    if (!data.__dryRun && data.combinedListingUpdate.userErrors?.length) {
      throw new Error(`detachSingleton ${child.handle}: ${JSON.stringify(data.combinedListingUpdate.userErrors)}`);
    }
  }
}

async function deleteSingletonParents(client, g, retainedParentId) {
  const parents = new Map(
    g.children
      .filter(c => c.sourceParent && c.sourceParent.id !== retainedParentId)
      .map(c => [c.sourceParent.id, c.sourceParent])
  );
  const errors = [];
  for (const parent of parents.values()) {
    try {
      const data = await client.post(
        M_DELETE_PRODUCT,
        { input: { id: parent.id } },
        { mutation: true, label: `deleteSingletonParent ${parent.handle}` }
      );
      if (!data.__dryRun && data.productDelete.userErrors?.length) {
        errors.push(`${parent.handle}: ${JSON.stringify(data.productDelete.userErrors)}`);
      }
    } catch (err) {
      errors.push(`${parent.handle}: ${err.message}`);
    }
  }
  return errors;
}

/** Remove a child's own single-value Colour option so the parent supplies it. */
async function stripChildColourOption(client, child) {
  const data = await client.post(
    Q_CHILD_OPTIONS,
    { id: child.productId },
    { label: `childOptions ${child.handle}` }
  );

  const target = (data.product?.options ?? []).find(
    option => /colou?r/i.test(option.name) && option.optionValues.length === 1
  );
  if (!target) return;

  const result = await client.post(
    M_DELETE_OPTIONS,
    { productId: child.productId, options: [target.id] },
    { mutation: true, label: `deleteChildOption ${child.handle}` }
  );
  if (result.__dryRun) return;

  const errors = result.productOptionsDelete.userErrors;
  if (errors?.length) {
    throw new Error(`productOptionsDelete ${child.handle}: ${JSON.stringify(errors)}`);
  }
}

async function attachChildren(client, parent, g, optionName) {
  const optionValues = colour => {
    const entry = { name: optionName, value: colour };
    return SELECTED_OPTION_AS_LIST ? [entry] : entry;
  };

  const childrenToAdd = g.children.filter(c => c.sourceParent?.id !== parent.id);
  const productsAdded = childrenToAdd.map(c => ({
    childProductId: c.productId,
    selectedParentOptionValues: optionValues(c.colourName),
  }));

  const optionsAndValues = [{ name: optionName, values: g.children.map(c => c.colourName) }];
  // A freshly created parent has no existing option, so optionId is omitted.
  const existing = Object.fromEntries((parent.options ?? []).map(o => [o.name, o.id]));
  if (existing[optionName]) optionsAndValues[0].optionId = existing[optionName];

  const data = await client.post(
    M_ATTACH_CHILDREN,
    { parentProductId: parent.id, productsAdded, optionsAndValues },
    { mutation: true, label: `attachChildren ${g.styleGroupId}` }
  );
  if (data.__dryRun) return g.children.map(c => c.productId);

  const r = data.combinedListingUpdate;
  if (r.userErrors?.length) throw new Error(`combinedListingUpdate: ${JSON.stringify(r.userErrors)}`);

  const attached = r.product.combinedListing.combinedListingChildren.nodes.map(n => n.product.id);
  const missing = g.children.map(c => c.productId).filter(id => !attached.includes(id));
  if (missing.length) {
    throw new Error(`attach verification failed, missing: ${missing.join(", ")}`);
  }
  return attached;
}

async function stampMetafields(client, g, parentId) {
  const targets = [parentId, ...g.children.map(c => c.productId)];
  const metafields = targets.map(ownerId => ({
    ownerId,
    namespace: METAFIELD_NAMESPACE,
    key: METAFIELD_KEY,
    type: "single_line_text_field",
    value: g.styleGroupId,
  }));
  const data = await client.post(M_SET_METAFIELDS, { metafields }, { mutation: true, label: `metafields ${g.styleGroupId}` });
  if (data.__dryRun) return;
  const errs = data.metafieldsSet.userErrors;
  if (errs?.length) throw new Error(`metafieldsSet: ${JSON.stringify(errs)}`);
}

async function processGroup(client, g, log, status, optionName) {
  let parent = null;
  try {
    parent = g.reuseParent ?? await createParent(client, g, status);
    if (g.reuseParent) {
      console.log(`  reusing existing parent ${parent.handle} (${parent.id})`);
    }
    await detachSingletonChildren(client, g, parent.id);
    for (const child of g.children) await stripChildColourOption(client, child);
    const childIds = await attachChildren(client, parent, g, optionName);
    await stampMetafields(client, g, parent.id);
    const cleanupErrors = await deleteSingletonParents(client, g, parent.id);
    const sourceParentIds = [...new Set(
      g.children.filter(c => c.sourceParent).map(c => c.sourceParent.id)
    )];
    const messages = [];
    if (sourceParentIds.length) messages.push(`CONSOLIDATED_SOURCE_PARENTS=${sourceParentIds.join("|")}`);
    if (g.reuseParent) messages.push(`REUSED_PARENT=${parent.id}`);
    if (cleanupErrors.length) messages.push(`SOURCE_PARENT_CLEANUP_FAILED=${cleanupErrors.join("; ")}`);
    log.write({
      style_group_id: g.styleGroupId, status: "CREATED", parent_id: parent.id,
      parent_title: g.parentTitle, child_ids: childIds.join("|"),
      child_handles: g.children.map(c => c.handle).join("|"),
      message: messages.join(" "),
    });
    if (cleanupErrors.length) {
      console.error(`  WARN ${g.styleGroupId}: new listing is valid, but source cleanup failed: ${cleanupErrors.join("; ")}`);
    }
    console.log(`  OK  ${g.styleGroupId} -> ${parent.id} (${childIds.length} children)`);
    return true;
  } catch (err) {
    log.write({
      style_group_id: g.styleGroupId, status: "FAILED", parent_id: parent?.id ?? "",
      parent_title: g.parentTitle,
      child_handles: g.children.map(c => c.handle).join("|"),
      message: String(err.message).slice(0, 500),
    });
    console.error(`  ERR ${g.styleGroupId}: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

async function rollback(client, logFile) {
  const created = RunLog.rows(logFile).filter(r => r.status === "CREATED");
  const consolidated = created.filter(r => r.message?.includes("CONSOLIDATED_SOURCE_PARENTS="));
  if (consolidated.length) {
    console.error(`Refusing to roll back ${consolidated.length} consolidated group(s): their source parents were deleted.`);
    for (const row of consolidated) console.error(`  ${row.style_group_id} (${row.parent_id})`);
  }
  const rows = created.filter(r => !r.message?.includes("CONSOLIDATED_SOURCE_PARENTS="));
  if (!rows.length) { console.log("Nothing to roll back."); return; }
  console.log(`Rolling back ${rows.length} groups from ${logFile}`);
  for (const row of rows) {
    try {
      const childIds = row.child_ids.split("|").filter(Boolean);
      if (childIds.length) {
        const d = await client.post(M_REMOVE_CHILDREN,
          { parentProductId: row.parent_id, productsRemovedIds: childIds },
          { mutation: true, label: `detach ${row.style_group_id}` });
        if (!d.__dryRun && d.combinedListingUpdate.userErrors?.length) {
          throw new Error(JSON.stringify(d.combinedListingUpdate.userErrors));
        }
      }
      const d2 = await client.post(M_DELETE_PRODUCT, { input: { id: row.parent_id } },
        { mutation: true, label: `deleteParent ${row.style_group_id}` });
      if (!d2.__dryRun && d2.productDelete.userErrors?.length) {
        throw new Error(JSON.stringify(d2.productDelete.userErrors));
      }
      console.log(`  rolled back ${row.style_group_id} (${row.parent_id})`);
    } catch (err) {
      console.error(`  ERR rollback ${row.style_group_id}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function defaultLogFile(input) {
  if (!input) return "run_log.csv";
  const parsed = path.parse(input);
  const match = parsed.name.match(/^groups-(.+)$/i);
  const filename = match ? `run_log-${match[1]}.csv` : "run_log.csv";
  return path.join(parsed.dir, filename);
}

function parseArgs(argv) {
  const args = { status: "DRAFT", apiVersion: DEFAULT_API_VERSION, optionName: DEFAULT_OPTION_NAME };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--input") args.input = next();
    else if (a === "--log") args.log = next();
    else if (a === "--shop") args.shop = next();
    else if (a === "--token") args.token = next();
    else if (a === "--client-id") args.clientId = next();
    else if (a === "--client-secret") args.clientSecret = next();
    else if (a === "--api-version") args.apiVersion = next();
    else if (a === "--option-name") args.optionName = next();
    else if (a === "--status") args.status = next();
    else if (a === "--limit") args.limit = Number(next());
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--resume") args.resume = true;
    else if (a === "--consolidate-singletons") args.consolidateSingletons = true;
    else if (a === "--rollback") args.rollbackMode = true;
    else if (a === "--verbose") args.verbose = true;
  }
  args.log ??= defaultLogFile(args.input);
  return args;
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
  if (!["DRAFT", "ACTIVE"].includes(args.status)) {
    console.error("--status must be DRAFT or ACTIVE");
    process.exit(1);
  }

  const client = new ShopifyClient({
    shop: creds.shop, getToken, apiVersion: args.apiVersion,
    dryRun: !!args.dryRun, verbose: !!args.verbose,
  });

  if (args.rollbackMode) return rollback(client, args.log);

  if (!args.input) { console.error("--input is required unless --rollback is set"); process.exit(1); }

  const shop = (await client.post(Q_SHOP, {}, { label: "probe" })).shop;
  console.log(`Connected to ${shop.name} (${creds.shop}), plan=${shop.plan?.displayName}`);
  if (!shop.plan?.shopifyPlus && !shop.plan?.partnerDevelopment) {
    console.error("WARNING: store does not report as Shopify Plus. Combined Listings will fail.");
  }

  const groups = loadGroups(args.input);
  const childCount = [...groups.values()].reduce((n, g) => n + g.children.length, 0);
  console.log(`Loaded ${groups.size} approved groups (${childCount} children)`);

  const handles = new Set([...groups.values()].flatMap(g => g.children.map(c => c.handle)));
  const resolved = await resolveHandles(client, handles);
  console.log(`Resolved ${resolved.size}/${handles.size} handles`);

  const { ok, problems } = preflight(groups, resolved, {
    consolidateSingletons: !!args.consolidateSingletons,
  });
  if (problems.length) {
    console.error(`\nPREFLIGHT PROBLEMS (${problems.length}):`);
    for (const [gid, title, msg] of problems) console.error(`  [${gid}] ${title}: ${msg}`);
    console.error("");
  }
  console.log(`${ok.size} groups passed preflight, ${groups.size - ok.size} skipped`);

  let todo = [...ok.values()];
  if (args.resume) {
    const done = RunLog.completed(args.log);
    const before = todo.length;
    todo = todo.filter(g => !done.has(g.styleGroupId));
    console.log(`Resume: skipping ${before - todo.length} already-created groups`);
  }
  if (args.limit) { todo = todo.slice(0, args.limit); console.log(`Limited to first ${todo.length} groups`); }
  if (!todo.length) { console.log("Nothing to do."); return; }

  if (args.dryRun) console.log("\n=== DRY RUN: no mutations will be sent ===");

  const log = new RunLog(args.log);
  const started = Date.now();
  let succeeded = 0;
  for (const [i, g] of todo.entries()) {
    console.log(`[${i + 1}/${todo.length}] ${g.styleGroupId} '${g.parentTitle}' (${g.children.length} children)`);
    if (await processGroup(client, g, log, args.status, args.optionName)) succeeded++;
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nDone. ${succeeded}/${todo.length} groups created in ${elapsed}s (${client.callCount} API calls). Log: ${args.log}`);
  if (succeeded < todo.length) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
