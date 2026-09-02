#!/usr/bin/env node
/**
 * PHO-784 auth diagnostic.
 *
 * Validates the shape of your credentials, performs the client credentials
 * grant, and prints Shopify's exact error body so a 400 can be identified.
 *
 * Never prints the client secret.
 *
 *   node --env-file=.env check-auth.mjs
 */

import process from "node:process";

const shop = process.env.SHOPIFY_SHOP ?? "";
const clientId = process.env.SHOPIFY_CLIENT_ID ?? "";
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET ?? "";
const staticToken = process.env.SHOPIFY_TOKEN ?? "";

function report(label, value, { secret = false } = {}) {
  if (!value) { console.log(`  ${label.padEnd(22)} MISSING`); return; }
  const shown = secret ? `${value.slice(0, 4)}...${value.slice(-2)}` : JSON.stringify(value);
  const flags = [];
  if (/^\s|\s$/.test(value)) flags.push("LEADING/TRAILING WHITESPACE");
  if (/[\r\n\t]/.test(value)) flags.push("CONTAINS CR/LF/TAB");
  if (/^["']|["']$/.test(value)) flags.push("WRAPPED IN QUOTES");
  console.log(`  ${label.padEnd(22)} ${shown}  len=${value.length}  ${flags.join(" ") || "ok"}`);
}

console.log("\n1. Credential shape");
report("SHOPIFY_SHOP", shop);
report("SHOPIFY_CLIENT_ID", clientId);
report("SHOPIFY_CLIENT_SECRET", clientSecret, { secret: true });
if (staticToken) {
  report("SHOPIFY_TOKEN", staticToken, { secret: true });
  console.log("     ^ a static token is present and OVERRIDES the client credentials.");
  console.log("       Remove this line unless it is a valid shpat_ token.");
}

console.log("\n2. Shop domain");
const problems = [];
if (!shop) problems.push("SHOPIFY_SHOP is not set");
if (/^https?:\/\//i.test(shop)) problems.push("remove the https:// prefix");
if (shop.includes("/")) problems.push("remove any path, e.g. /admin");
if (shop.includes("admin.shopify.com")) problems.push("use the store's own .myshopify.com domain, not admin.shopify.com");
if (shop && !shop.endsWith(".myshopify.com")) problems.push("must end with .myshopify.com (a custom domain like mimco.com.au will not work)");
if (problems.length) { for (const p of problems) console.log(`  BAD: ${p}`); }
else console.log(`  ok: ${shop}`);

if (!shop || problems.length || !clientId || !clientSecret) {
  console.log("\nFix the above before retrying.\n");
  process.exit(1);
}

console.log("\n3. Token request");
const url = `https://${shop}/admin/oauth/access_token`;
console.log(`  POST ${url}`);

const resp = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  }),
});

const text = await resp.text();
console.log(`  HTTP ${resp.status} ${resp.statusText}`);
console.log(`  body: ${text.slice(0, 600)}`);

if (resp.ok) {
  const data = JSON.parse(text);
  console.log(`\n  SUCCESS`);
  console.log(`  scope      : ${data.scope}`);
  console.log(`  expires_in : ${data.expires_in}s`);
  if (!/write_products/.test(data.scope ?? "")) {
    console.log(`  WARNING: write_products is not in the granted scopes. The push`);
    console.log(`           script will fail with 403 on mutations. Add the scope`);
    console.log(`           in the Dev Dashboard and reinstall the app.`);
  }
  console.log("");
  process.exit(0);
}

const hints = {
  invalid_request: [
    "The request was malformed or the app is not installed on this store.",
    "Open the Dev Dashboard, check the app is installed on " + shop + ", then retry.",
  ],
  invalid_client: [
    "Client ID and secret do not match a known app for this store.",
    "Confirm both were copied from the SAME app's Settings page.",
    "If the secret was rotated, copy it again.",
  ],
  unsupported_grant_type: [
    "This app is not configured for the client credentials grant.",
    "Client credentials require the app and the store to be in the same Shopify organisation.",
  ],
  invalid_scope: [
    "A requested scope is not valid for this app. Review the Admin API scopes in the Dev Dashboard.",
  ],
};

let code = null;
try { code = JSON.parse(text).error; } catch { /* not JSON */ }

console.log("\n  FAILED");
if (code && hints[code]) {
  console.log(`  error: ${code}`);
  for (const h of hints[code]) console.log(`    - ${h}`);
} else {
  console.log("  Unrecognised error. Check in this order:");
  console.log("    - the app is installed on " + shop);
  console.log("    - the app and the store are in the same Shopify organisation");
  console.log("    - client_id and client_secret came from the same app");
  console.log("    - the app has Admin API scopes configured, not only Storefront");
}
console.log("");
process.exit(1);
