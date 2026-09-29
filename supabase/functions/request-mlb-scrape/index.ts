const ALLOWED_ORIGIN = "https://lutetiumcalciumlee.github.io";
const GITHUB_OWNER = "LutetiumCalciumLee";
const GITHUB_REPOSITORY = "Web_scraping_MLB_Project";
const GITHUB_WORKFLOW = "scrape.yml";
const GITHUB_REF = "main";

function corsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin),
  });
}

function configuredPublishableKeys(): string[] {
  const keys: string[] = [];
  const encodedKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (encodedKeys) {
    try {
      const parsed = JSON.parse(encodedKeys) as Record<string, string>;
      keys.push(...Object.values(parsed));
    } catch {
      // The legacy key below remains a safe fallback while projects migrate.
    }
  }

  const legacyKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (legacyKey) keys.push(legacyKey);
  return keys;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, origin);
  }
  if (origin && origin !== ALLOWED_ORIGIN) {
    return jsonResponse({ error: "origin_not_allowed" }, 403, origin);
  }

  const apiKey = request.headers.get("apikey") ?? "";
  if (!apiKey || !configuredPublishableKeys().includes(apiKey)) {
    return jsonResponse({ error: "invalid_publishable_key" }, 401, origin);
  }

  let selectedDate = "";
  try {
    const body = await request.json() as { p_selected_date?: unknown };
    selectedDate = String(body.p_selected_date ?? "");
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400, origin);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
    return jsonResponse({ error: "invalid_selected_date" }, 400, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) {
    return jsonResponse({ error: "supabase_url_not_configured" }, 500, origin);
  }

  const queueResponse = await fetch(
    `${supabaseUrl}/rest/v1/rpc/request_mlb_scrape`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": apiKey,
      },
      body: JSON.stringify({ p_selected_date: selectedDate }),
    },
  );
  if (!queueResponse.ok) {
    const detail = await queueResponse.text();
    console.error("queue request failed", queueResponse.status, detail);
    return jsonResponse(
      { error: "queue_request_failed", status: queueResponse.status },
      queueResponse.status,
      origin,
    );
  }

  const queued = await queueResponse.json() as Record<string, unknown>;
  if (queued.shouldDispatch !== true) {
    return jsonResponse({ ...queued, dispatchStatus: "not_needed" }, 200, origin);
  }

  const githubToken = Deno.env.get("GITHUB_WORKFLOW_TOKEN");
  if (!githubToken) {
    console.error("GITHUB_WORKFLOW_TOKEN is not configured");
    return jsonResponse({ ...queued, dispatchStatus: "fallback" }, 202, origin);
  }

  const dispatchResponse = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${githubToken}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: GITHUB_REF,
        inputs: {
          selected_date: "",
          process_queue: "true",
        },
      }),
    },
  );

  if (!dispatchResponse.ok) {
    const detail = await dispatchResponse.text();
    console.error("GitHub workflow dispatch failed", dispatchResponse.status, detail);
    // The request remains pending and the five-minute scheduled worker is the
    // recovery path, so the browser still receives an accepted response.
    return jsonResponse({ ...queued, dispatchStatus: "fallback" }, 202, origin);
  }

  return jsonResponse({ ...queued, dispatchStatus: "started" }, 200, origin);
});
