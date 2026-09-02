# PHO-784 — Combined Listings backfill: handover

Mimco / Shopify Plus. Session handover as of 2 Sep 2026.

---

## 1. The ticket

Colourways of the same style sit on separate PDPs because Mimco's style codes
aren't consistent across colours. Two products that are the same bag in
different colours end up as two product pages instead of one page with two
colour swatches.

**Solution chosen:** Shopify **Combined Listings**. A parent product presents the
existing colourway products as swatches on one PDP. Nothing is moved. Every
child keeps its own product record, SKUs, inventory, images, size variants and
URL. `productMoveVariants` was rejected because it would destroy those records.

Combined Listings requires Shopify Plus.

---

## 2. Current status

| Area | State |
|---|---|
| Auth (client credentials) | Working |
| Candidate group generation | Working |
| Parent creation + attach | Working |
| Rollback | Working, verified non-destructive to children |
| Audit / inspection tooling | Working |
| Duplicate-parent guard | Written, needs applying |
| Duplicate-option guard | Written, needs applying |
| Publishing to Online Store | Gap identified, fix written, **not yet applied** |
| Child colour-option stripping | **In progress — this is where the session stopped** |
| Colour metaobject swatches | Deferred, PDP does not need them, collection cards do |
| 301 redirects, review remap, feed URLs | Deferred |
| BAU / recurring fix | Not started |

---

## 3. THE ROOT CAUSE (read this first)

After a long diagnosis, the actual defect was found by comparing a working
combined listing (`facet-bezel-stud-ear-24429581`) against ours
(`blondie-mini-tote-bag`).

**Parents are identical in every queryable field.** One Colour option, correct
values, `hasVariants=true`, children attached, `swatch=NONE` on both,
`media=NO` on both. The parent is not the problem and the script builds it
correctly.

**The difference is on the CHILDREN.**

- Working listing: children have **no** Colour option of their own.
- Ours: each child has its **own single-value Colour option** (e.g. `Colour: Navy`),
  which arrives from the RMS feed.

On a child PDP the theme renders the child's own Colour option **plus** the
combined listing's Colour option. That is the two picker rows in the screenshots,
and the reason the PDP shows `$0.00` / `Unavailable`.

A single-value Colour option carries no information — the child *is* that colour —
so it should be removed when the child joins a combined listing.

### Dead ends already ruled out (do not revisit)

1. Duplicate options on the parent — was real early on, now fixed and guarded.
2. Stale cache / preview URL — checked, not the cause.
3. Colour metaobjects (`shopify.color-pattern`) — the working listing has
   `swatch=NONE` too, so these are not required for the PDP.
4. Parent variant media — `media=NO` on the working listing too.
5. Children being corrupted by the script — verified clean before and after
   rollback; role goes `CHILD` → `null`, options untouched.

---

## 4. Immediate next step

Strip the child's single-value Colour option before attaching.

### 4a. The 400 error you hit

`HTTP 400 invalid variables parameter` is Shopify rejecting the request body,
not a schema error (a schema error returns 200 with `userErrors`). It happens
when `variables` isn't a plain object — usually arguments passed positionally.

Add this guard at the top of `ShopifyClient.post` in `combine-listings.mjs`:

```js
  async post(query, variables, { mutation = false, label = "" } = {}) {
    if (variables == null || typeof variables !== "object" || Array.isArray(variables)) {
      throw new Error(`${label || "post"}: variables must be a plain object, got ${typeof variables}`);
    }
```

### 4b. The working implementation

Add near the other mutations in `combine-listings.mjs`:

```js
const Q_CHILD_OPTIONS = `
query childOptions($id: ID!) {
  product(id: $id) { id handle options { id name optionValues { name } } }
}`;

const M_DELETE_OPTIONS = `
mutation deleteOptions($productId: ID!, $options: [ID!]!) {
  productOptionsDelete(productId: $productId, options: $options, strategy: NON_DESTRUCTIVE) {
    deletedOptionsIds
    userErrors { code field message }
  }
}`;

/** Remove a child's own single-value Colour option so the parent supplies it. */
async function stripChildColourOption(client, child) {
  const d = await client.post(
    Q_CHILD_OPTIONS,
    { id: child.productId },
    { label: `childOptions ${child.handle}` }
  );
  if (d.__dryRun) return;

  const target = (d.product?.options ?? []).find(
    o => /colou?r/i.test(o.name) && o.optionValues.length === 1
  );
  if (!target) return;

  const res = await client.post(
    M_DELETE_OPTIONS,
    { productId: child.productId, options: [target.id] },
    { mutation: true, label: `deleteChildOption ${child.handle}` }
  );
  if (res.__dryRun) return;

  const errs = res.productOptionsDelete.userErrors;
  if (errs?.length) {
    throw new Error(`productOptionsDelete ${child.handle}: ${JSON.stringify(errs)}`);
  }
}
```

Two things cause the 400 here: `options` must be an **array** even for one ID,
and `variables` must be the **second positional argument**.

Call it in `processGroup`, before the attach:

```js
    parent = await createParent(client, g, status);
    for (const c of g.children) await stripChildColourOption(client, c);
    const childIds = await attachChildren(client, parent, g, optionName);
```

### 4c. Test it

```powershell
node --env-file=.env combine-listings.mjs --input groups.csv --limit 1 --dry-run
node --env-file=.env combine-listings.mjs --input groups.csv --limit 1 --status ACTIVE
node --env-file=.env inspect-parent.mjs --handle blondie-mini-tote-bag-60318052
```

Expect **zero** Colour options on the child. Then check the PDP renders one
picker row.

If `NON_DESTRUCTIVE` refuses because a variant depends on the option, read the
`userErrors` message before changing anything. Do **not** switch to `POSITION`
blind — it can drop variants.

### 4d. Check before rolling this out widely

The child's Colour option may be load-bearing elsewhere: feed exports to
Google/Meta, storefront filters, or the RMS sync writing back to it. Ask whoever
owns the RMS integration before deleting it across the catalogue.

If RMS adds a single-value Colour option to every product, that's the upstream
root cause and it will keep recurring.

---

## 5. Files

All in the working folder. Node 22 LTS, zero dependencies, no `package.json`.

| File | Purpose |
|---|---|
| `shopify-auth.mjs` | Client credentials grant, token caching, refresh. Imported by the others. |
| `check-auth.mjs` | Auth diagnostic. Validates credential shape, prints the exact OAuth error. |
| `build-groups.mjs` | Reads the catalogue, emits `groups.csv` (candidates), `near-misses.csv`, `unmatched-handles.csv`. Writes nothing to Shopify. |
| `combine-listings.mjs` | The push. Creates parents, attaches children, stamps metafields. Dry-run, resume, rollback. |
| `inspect-parent.mjs` | Dumps one product's options, values, children. Primary debugging tool. |
| `audit-parents.mjs` | Lists every combined listing parent store-wide with filters and flags. |
| `groups.sample.csv` | Input format reference. |

`shopify-auth.mjs` must sit alongside the others — they import it.

---

## 6. Setup

### Credentials

**Shopify changed this on 1 Jan 2026.** New custom apps can no longer be created
from Shopify admin under Settings > Apps > Develop apps. They must be created in
the **Dev Dashboard** (`https://dev.shopify.com/dashboard`), which issues a
**Client ID and Client Secret** rather than a static `shpat_` token. Tokens are
obtained via the client credentials grant and **expire after 24 hours**. The
scripts handle this automatically.

The client credentials grant only works when the app and the store are in the
**same Shopify organisation**.

`.env` in the working folder:

```
SHOPIFY_SHOP=mimco-staging.myshopify.com
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
```

Scopes needed: `read_products`, `write_products`. Scope changes require a reinstall.

Legacy `shpat_` tokens still work via `SHOPIFY_TOKEN` for pre-2026 apps (e.g. if
production has one). If both are present, the static token wins.

Verify:

```powershell
node --env-file=.env check-auth.mjs
```

### Metafield definition

Create before running: Settings → Custom data → Products → Add definition.
Namespace and key `custom.style_group_id`, type Single line text.

---

## 7. Grouping logic

**Key: exact normalised title + `productType`.** Nothing else.

Mimco titles do not contain the colour, so three colourways of one style share an
identical title. An extra word means a different product:

- `Blondie Mini Tote Bag` → style A
- `Blondie Mini Tote Crossbody Bag` → style B, **never** merged with A

Normalisation levels case, accents, punctuation, `&` vs `and`, and whitespace.
**No words are removed.** Fuzzy matching was tried and rejected: containment
scoring merges `Tote Bag` into `Tote Crossbody Bag`, which is exactly wrong.

Vendor was removed as a gate (constant across the catalogue). Size scale and
price are **flags only**, never gates — colourways legitimately run different
size scales.

### Style codes

Handle parsing is **optional** and only feeds: the `style_group_id` (lowest code
in the group), the `WIDE_CODE_SPREAD` flag, and a last-resort colour code.
Products whose handles don't parse are still grouped normally.

Note: Mimco's real handle format is `title-stylecode`
(`blondie-mini-tote-bag-60318052`), not `stylecode-colourcode` as the ticket
examples suggested. So `splitHandle` currently never matches and every group gets
`NONSTANDARD_HANDLE` with a `MIM-T-<title-slug>` id. Harmless, but
`WIDE_CODE_SPREAD` never fires. **Worth updating `splitHandle` to the real format**
so the reused-style-name warning actually works.

### Flags in `groups.csv`

| Flag | Meaning |
|---|---|
| `WIDE_CODE_SPREAD` | Codes far apart — likely a style name reused in a later season |
| `DUPLICATE_COLOUR` | Two children with the same colour name — must fix before approval |
| `MISSING_COLOUR` | No resolvable colour name — must fill in before approval |
| `NONSTANDARD_HANDLE` | A member's handle didn't parse (informational) |
| `SIZE_SCALE_DIFF` | Different size scales (expected, informational) |
| `PRICE_VARIANCE` | Parent will show a price range |
| `OVERSIZED` | More colourways than `--max-group`, inspect |

Flagged groups sort to the top. `approved` is **blank by design** — the push
script only reads rows marked `Y`.

---

## 8. Run order

```powershell
# 1. verify auth
node --env-file=.env check-auth.mjs

# 2. generate candidates for one category
node --env-file=.env build-groups.mjs --type "Bags" --out groups.csv

# 3. review in GOOGLE SHEETS (not Excel — it eats leading zeros in colour codes)
#    add =IMAGE() on product images, merchandising sets approved=Y, export back to CSV

# 4. dry run: real reads, zero writes, prints payloads
node --env-file=.env combine-listings.mjs --input groups.csv --dry-run

# 5. one group live
node --env-file=.env combine-listings.mjs --input groups.csv --limit 1 --status ACTIVE

# 6. verify
node --env-file=.env inspect-parent.mjs --handle <parent-handle>
node --env-file=.env audit-parents.mjs --mine --quiet

# 7. rollback and re-run to prove idempotency
node --env-file=.env combine-listings.mjs --rollback --log run_log.csv
node --env-file=.env combine-listings.mjs --input groups.csv --limit 1 --status ACTIVE

# 8. full approved set
node --env-file=.env combine-listings.mjs --input groups.csv --status ACTIVE
```

`--status` defaults to `DRAFT` (safe). Use `ACTIVE` to see the PDP.
`--resume` skips groups already logged as `CREATED`.

---

## 9. Patches written but NOT yet applied

### 9a. Duplicate-parent guard (important)

Nothing currently stops a re-run creating a **second** parent for a group that
already has one. This happened three times in the session and was the cause of a
long false trail — the DOM being inspected was a different product from the one
being fixed.

Add above `preflight` in `combine-listings.mjs`:

```js
const Q_EXISTING_PARENTS = `
query existingParents($cursor: String) {
  products(first: 100, query: "combined_listing_role:parent", after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title
      metafield(namespace: "custom", key: "style_group_id") { value }
    }
  }
}`;

async function loadExistingParents(client) {
  const map = new Map();
  let cursor = null;
  for (;;) {
    const d = await client.post(Q_EXISTING_PARENTS, { cursor }, { label: "existingParents" });
    for (const n of d.products.nodes) {
      if (n.metafield?.value) map.set(n.metafield.value, n);
    }
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  return map;
}
```

Change `preflight(groups, resolved)` → `preflight(groups, resolved, existingParents)`
and add inside the per-group loop:

```js
    const already = existingParents.get(gid);
    if (already) {
      errs.push(`parent already exists for this style_group_id: ${already.id} (${already.title}). Roll it back first.`);
    }
```

In `main`, before the preflight call:

```js
  const existingParents = await loadExistingParents(client);
  console.log(`Found ${existingParents.size} existing parent(s) with a style_group_id`);
  const { ok, problems } = preflight(groups, resolved, existingParents);
```

### 9b. Publish parents to Online Store

`productSet` creates the product but does **not** publish it to any sales
channel. `status: ACTIVE` and "published to Online Store" are separate.

```js
const Q_PUBLICATIONS = `query { publications(first: 20) { nodes { id name } } }`;

const M_PUBLISH = `
mutation publish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) { userErrors { field message } }
}`;

let onlineStoreId = null;
async function getOnlineStorePublicationId(client) {
  if (onlineStoreId) return onlineStoreId;
  const d = await client.post(Q_PUBLICATIONS, {}, { label: "publications" });
  if (d.__dryRun) return null;
  const os = d.publications.nodes.find(p => /online store/i.test(p.name));
  if (!os) throw new Error("Online Store publication not found");
  onlineStoreId = os.id;
  return onlineStoreId;
}
```

In `processGroup`, after `attachChildren`:

```js
    const pubId = await getOnlineStorePublicationId(client);
    if (pubId) {
      const d = await client.post(M_PUBLISH,
        { id: parent.id, input: [{ publicationId: pubId }] },
        { mutation: true, label: `publish ${g.styleGroupId}` });
      if (!d.__dryRun && d.publishablePublish.userErrors?.length) {
        throw new Error(`publish: ${JSON.stringify(d.publishablePublish.userErrors)}`);
      }
    }
```

### 9c. Live option re-read (prevents duplicate options)

In `attachChildren`, replace:

```js
  const existing = Object.fromEntries((parent.options ?? []).map(o => [o.name, o.id]));
  if (existing[optionName]) optionsAndValues[0].optionId = existing[optionName];
```

with:

```js
  const live = await client.post(
    `query($id: ID!) { product(id: $id) { options { id name optionValues { name } } } }`,
    { id: parent.id }, { label: `readOptions ${g.styleGroupId}` }
  );
  const liveOptions = live.__dryRun ? [] : (live.product?.options ?? []);
  const match = liveOptions.find(o => o.name.toLowerCase() === optionName.toLowerCase());
  if (match) {
    optionsAndValues[0].optionId = match.id;
    const seen = new Set(match.optionValues.map(v => v.name));
    optionsAndValues[0].values = [
      ...match.optionValues.map(v => v.name),
      ...g.children.map(c => c.colourName).filter(v => !seen.has(v)),
    ];
  }

  const dupes = liveOptions.filter(o => /colou?r/i.test(o.name));
  if (dupes.length > 1) {
    throw new Error(`parent already has ${dupes.length} colour options. Roll this group back before retrying.`);
  }
```

Trusting the `productSet` response means a re-run omits `optionId` and
`combinedListingUpdate` creates a **second** option of the same name.

### 9d. `verifyParent` (fail loudly instead of shipping broken)

```js
const Q_VERIFY_PARENT = `
query verifyParent($id: ID!) {
  product(id: $id) {
    id status
    options { id name optionValues { name hasVariants } }
    variants(first: 100) { nodes { title price selectedOptions { name value } } }
    priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
    combinedListing { combinedListingChildren(first: 50) { nodes { product { id } } } }
  }
}`;

async function verifyParent(client, parent, g, optionName) {
  const data = await client.post(Q_VERIFY_PARENT, { id: parent.id }, { label: `verify ${g.styleGroupId}` });
  if (data.__dryRun) return;
  const p = data.product;
  const errs = [];

  const colourOpts = p.options.filter(o => /colou?r/i.test(o.name));
  if (colourOpts.length !== 1) errs.push(`${colourOpts.length} colour options, expected 1`);

  const values = colourOpts[0]?.optionValues ?? [];
  if (values.length !== g.children.length) {
    errs.push(`${values.length} option values for ${g.children.length} children`);
  }
  const noVariant = values.filter(v => !v.hasVariants).map(v => v.name);
  if (noVariant.length) errs.push(`option values with no variant: ${noVariant.join(", ")}`);

  const stray = p.variants.nodes.filter(v =>
    v.title === "Default Title" || v.selectedOptions.some(o => o.value === "Default Title")
  );
  if (stray.length) errs.push(`${stray.length} stray Default Title variant(s)`);

  if (Number(p.priceRangeV2.maxVariantPrice.amount) <= 0) {
    errs.push("parent price range is 0, PDP will show $0.00 and Unavailable");
  }

  const attached = new Set(p.combinedListing.combinedListingChildren.nodes.map(n => n.product.id));
  const missing = g.children.filter(c => !attached.has(c.productId)).map(c => c.handle);
  if (missing.length) errs.push(`children not attached: ${missing.join(", ")}`);

  if (errs.length) throw new Error(`parent verification failed: ${errs.join("; ")}`);
}
```

Call in `processGroup` between attach and metafields.

### 9e. Extra inspector fields (useful, low risk)

Add to `FRAGMENT` in `inspect-parent.mjs`:

```js
  publishedAt
  resourcePublications(first: 10) { nodes { isPublished publication { name } } }
  variants(first: 50) {
    nodes { id title price media(first: 1) { nodes { id } } selectedOptions { name value } }
  }
```

A variant titled `X / X` is proof of duplicate options and needs no interpretation.

---

## 10. Theme findings (Horizon)

- `snippets/variant-main-picker.liquid` is the **PDP** picker. Renders one
  `<fieldset>` per option in `product_resource.options_with_values`.
  `data-input-id` is `{position}-{index}` — `1-0`, `1-1` is one option;
  `2-0`, `2-1` means two.
- `snippets/variant-swatches.liquid` is the **product card** renderer
  (collection/search), not the PDP.
- Card snippet line ~100: `swatch_count == 0` → `{% continue %}`. Colour
  metaobjects **are** required for collection card swatches. The PDP does not
  need them (it qualifies via `connected_product_count` and uses child images).
- Swatch image resolution: `product_option_value.variant.featured_media`, falling
  back to the child product's media **only when `product_url` is set**. Shopify
  doesn't set `product_url` on the value for the product you're currently
  viewing, so a blank selected swatch means that child's variant has no media.

---

## 11. Deferred / follow-up tickets

1. **Colour metaobjects** (`shopify.color-pattern`) — required for collection
   card swatches only. Needs a colour code → colour name mapping, which is a
   merchandising input. Colour codes like `448` and `8934` map to nothing today.
2. **301 redirects** from child handles to parent handles.
3. **Review platform remapping** (reviews tie to product IDs).
4. **Google Shopping / Meta feed** canonical URLs.
5. **BAU: ERP/PIM style grouping code.** *Longest lead time — raise now.* Without
   a stable grouping code in the product feed, new products recreate this problem
   every season. Interim: a nightly reconciler querying products with a
   `style_group_id` but no `combinedListingRole`, auto-attaching exact matches
   and queueing anything else for merchandising. Use a scheduled sweep, not a
   `products/create` webhook — the webhook fires before images and metafields are
   written.
6. **`splitHandle` regex** — update to Mimco's real `title-stylecode` format.
7. **Rollback should also restore child options** once 4b lands, so a rolled-back
   child gets its Colour option back if that turns out to matter.

---

## 12. Windows gotchas

| Symptom | Cause |
|---|---|
| `node is not recognized` | PowerShell opened before Node installed |
| `Cannot find module ...\.env` | Notepad saved it as `.env.txt` — save as `".env"` with quotes |
| `Unexpected token` on a command | Curly quotes from pasting via Word/Slack/Confluence |
| Colour codes lost leading zeros | Excel opened the CSV — use Google Sheets |
| `HTTP 401` on the API | Token expired or wrong type (`shpss_` is Storefront, not Admin) |
| `HTTP 400 invalid variables parameter` | `variables` isn't a plain object — check positional args |

Node 22's `--env-file` handles CRLF, quotes and trailing spaces correctly, so
line endings are not a concern.

---

## 13. Status line for Product

> The backfill tooling is built and verified. Grouping, parent creation,
> rollback and audit all work, and a script-created parent is equivalent to an
> existing working combined listing in every queryable field.
>
> One defect remains: children arriving from RMS carry their own single-value
> Colour option, which renders alongside the combined listing's option and
> produces two colour pickers on the PDP. The fix is to remove that redundant
> option when a child joins a listing. Working listings in the catalogue have no
> such option on their children, which confirms the approach.
>
> Before rolling it out we need confirmation from whoever owns the RMS
> integration that the child Colour option isn't used by feeds, filters or the
> sync itself. If RMS keeps adding it, that's the upstream fix.
>
> Also worth starting now, because it has the longest lead time: the ERP/PIM
> needs to assign a stable style grouping code that the product feed carries into
> Shopify. Without it, new products recreate this problem every season.
