/**
 * Shopify auth for PHO-784.
 *
 * Supports both credential models:
 *
 *   Dev Dashboard app (created on or after 1 Jan 2026)
 *     SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *     Exchanged for a 24-hour access token via the client credentials grant.
 *     Requires the app and the store to be in the same Shopify organisation.
 *
 *   Legacy admin-created custom app (created before 1 Jan 2026)
 *     SHOPIFY_TOKEN, a static shpat_ token that does not expire.
 *
 * If both are present the static token wins.
 *
 * createTokenProvider() returns an async function. Call it before every
 * request. It caches the token and refreshes 5 minutes before expiry, so
 * calling it per request costs nothing.
 */

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function createTokenProvider({ shop, clientId, clientSecret, staticToken }) {
  if (staticToken) {
    const t = staticToken.trim();
    if (!t.startsWith("shpat_")) {
      console.error(
        `WARNING: SHOPIFY_TOKEN starts with '${t.slice(0, 6)}', not 'shpat_'. ` +
        `shpss_ is a Storefront API token and will not work against the Admin API.`
      );
    }
    return async () => t;
  }

  if (!clientId || !clientSecret) {
    throw new Error(
      "No credentials. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET " +
      "(Dev Dashboard app), or SHOPIFY_TOKEN (legacy custom app)."
    );
  }

  let cached = null;      // { token, expiresAt }
  let inFlight = null;

  async function fetchToken() {
    const url = `https://${shop}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(
        `Token request failed (HTTP ${resp.status}): ${text.slice(0, 300)}\n` +
        `  401/403 here usually means the app is not installed on ${shop}, ` +
        `or the app and store are in different Shopify organisations.`
      );
    }

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`Token endpoint returned non-JSON: ${text.slice(0, 200)}`); }

    if (!data.access_token) {
      throw new Error(`Token endpoint returned no access_token: ${text.slice(0, 300)}`);
    }

    const ttlMs = (Number(data.expires_in) || 86399) * 1000;
    cached = { token: data.access_token, expiresAt: Date.now() + ttlMs, scope: data.scope };
    return cached;
  }

  return async function getToken(force = false) {
    if (!force && cached && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) {
      return cached.token;
    }
    if (!inFlight) {
      inFlight = fetchToken().finally(() => { inFlight = null; });
    }
    const { token } = await inFlight;
    return token;
  };
}

/** Read credentials from argv overrides falling back to environment. */
export function resolveCredentials(args) {
  return {
    shop: args.shop ?? process.env.SHOPIFY_SHOP,
    clientId: args.clientId ?? process.env.SHOPIFY_CLIENT_ID,
    clientSecret: args.clientSecret ?? process.env.SHOPIFY_CLIENT_SECRET,
    staticToken: args.token ?? process.env.SHOPIFY_TOKEN,
  };
}

/** One-line summary for startup output. Never prints the secret. */
export function credentialSummary(c) {
  if (c.staticToken) return "static shpat_ token (legacy custom app)";
  return `client credentials grant (client_id ${String(c.clientId).slice(0, 8)}...)`;
}
