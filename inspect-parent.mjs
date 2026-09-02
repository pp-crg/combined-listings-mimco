#!/usr/bin/env node
/**
 * PHO-784: inspect a combined listing parent.
 *
 * Dumps the parent's options, option values, and attached children so you can
 * see whether the parent has ONE Colour option with N values (correct) or
 * N Colour options (broken, renders as stacked swatch rows and Unavailable).
 *
 *   node --env-file=.env inspect-parent.mjs --handle blondie-mini-tote-bag
 *   node --env-file=.env inspect-parent.mjs --id gid://shopify/Product/123
 */

import process from "node:process";
import { createTokenProvider, resolveCredentials } from "./shopify-auth.mjs";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const n = () => argv[++i];
  switch (argv[i]) {
    case "--handle": args.handle = n(); break;
    case "--id": args.id = n(); break;
    case "--api-version": args.apiVersion = n(); break;
  }
}
const apiVersion = args.apiVersion ?? "2025-10";
const creds = resolveCredentials(args);
const getToken = createTokenProvider(creds);
const endpoint = `https://${creds.shop}/admin/api/${apiVersion}/graphql.json`;

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

const FRAGMENT = `
  id
  handle
  title
  status
  combinedListingRole
  
  options {
    id name position
    linkedMetafield { namespace key }
    optionValues {
      id name hasVariants
      linkedMetafieldValue
      swatch { color image { id } }
    }
  }
  variants(first: 50) {
    nodes {
      id title
      media(first: 1) { nodes { id } }
      selectedOptions { name value }
    }
  }
  combinedListing {
    combinedListingChildren(first: 50) {
      nodes {
        product { id handle title status }
      }
    }
  }
`;

let product;
if (args.id) {
  product = (await gql(`query($id: ID!) { product(id: $id) { ${FRAGMENT} } }`, { id: args.id })).product;
} else if (args.handle) {
  const d = await gql(
    `query($q: String!) { products(first: 5, query: $q) { nodes { ${FRAGMENT} } } }`,
    { q: `handle:${args.handle}` }
  );
  product = d.products.nodes[0];
} else {
  console.error("Pass --handle or --id");
  process.exit(1);
}

if (!product) { console.error("Not found"); process.exit(1); }

console.log(`\n${product.title}`);
console.log(`  id     : ${product.id}`);
console.log(`  handle : ${product.handle}`);
console.log(`  status : ${product.status}`);
console.log(`  role   : ${product.combinedListingRole}`);


console.log(`\nOptions (${product.options.length}):`);
for (const o of product.options) {
  const lm = o.linkedMetafield ? `${o.linkedMetafield.namespace}.${o.linkedMetafield.key}` : "(not linked)";
  console.log(`  [pos ${o.position}] "${o.name}"  linkedMetafield=${lm}`);
  for (const v of o.optionValues) {
    const sw = v.swatch
      ? `swatch(colour=${v.swatch.color ?? "-"} image=${v.swatch.image ? "yes" : "no"})`
      : "swatch=NONE";
    console.log(`      - ${v.name.padEnd(26)} hasVariants=${String(v.hasVariants).padEnd(5)} ${sw}  linkedValue=${v.linkedMetafieldValue ?? "-"}`);
  }
}

console.log(`\nParent variants (${product.variants.nodes.length}):`);
for (const v of product.variants.nodes) {
  const opts = v.selectedOptions.map(o => `${o.name}=${o.value}`).join(", ");
  console.log(`  ${v.title.padEnd(30)} media=${v.media.nodes.length ? "yes" : "NO"}   ${opts}`);
}

const children = product.combinedListing?.combinedListingChildren?.nodes ?? [];
console.log(`\nChildren (${children.length}):`);
for (const c of children) {
  console.log(`  ${c.product.handle.padEnd(34)} ${c.product.status.padEnd(9)} ${c.product.title}`);
}

const colourOptions = product.options.filter(o => /colou?r/i.test(o.name));
console.log("");
if (colourOptions.length === 1) {
  console.log(`VERDICT: correct. One "${colourOptions[0].name}" option with ${colourOptions[0].optionValues.length} values.`);
} else if (colourOptions.length > 1) {
  console.log(`VERDICT: BROKEN. ${colourOptions.length} separate colour options exist.`);
  console.log(`         The parent needs ONE option with all values. Roll this parent back.`);
} else {
  console.log(`VERDICT: no colour option found on the parent.`);
}
console.log("");
