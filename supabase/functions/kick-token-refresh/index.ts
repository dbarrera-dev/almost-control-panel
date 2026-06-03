import { createClient } from "npm:@supabase/supabase-js@2";

type KickTokenRow = {
  id: number;
  client_id: string | null;
  client_secret: string | null;
  refresh_token: string | null;
  access_token: string | null;
  refresh_fail_count: number | null;
};

type ModeConfig = {
  mode: "prod" | "dev";
  broadcasterRowId: number;
  botRowId: number;
};

type RefreshCallResult = {
  ok: boolean;
  status: number;
  accessToken: string;
  refreshToken: string;
  error: string;
};

const MODE_CONFIGS: ModeConfig[] = [
  { mode: "prod", broadcasterRowId: 1, botRowId: 2 },
  { mode: "dev", broadcasterRowId: 3, botRowId: 4 },
];

const KICK_TOKEN_ENDPOINT = "https://id.kick.com/oauth/token";
const HTTP_TIMEOUT_MS = 15000;

function nowIso(): string {
  return new Date().toISOString();
}

function safeText(value: unknown, max = 300): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function json(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function requestKickRefreshToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<RefreshCallResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), HTTP_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: params.clientId,
      client_secret: params.clientSecret,
      refresh_token: params.refreshToken,
    });

    const res = await fetch(KICK_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
    });

    let parsed: Record<string, unknown> = {};
    try {
      parsed = await res.json() as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    const accessToken = safeText(parsed?.access_token, 4096);
    const refreshToken = safeText(parsed?.refresh_token, 4096);
    if (res.ok && accessToken) {
      return {
        ok: true,
        status: res.status,
        accessToken,
        refreshToken,
        error: "",
      };
    }

    const msg = safeText(parsed?.error_description || parsed?.error || parsed?.message || `HTTP ${res.status}`);
    return {
      ok: false,
      status: res.status,
      accessToken: "",
      refreshToken: "",
      error: msg || `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      accessToken: "",
      refreshToken: "",
      error: safeText((e as Error)?.message || e || "Unknown error"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function writeRefreshLog(
  supabaseAdmin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
) {
  await supabaseAdmin.from("kick_token_refresh_logs").insert(payload).then(() => {}).catch(() => {});
}

async function updateKickTokenRow(
  supabaseAdmin: ReturnType<typeof createClient>,
  rowId: number,
  payload: Record<string, unknown>,
) {
  await supabaseAdmin.from("kick_tokens").update(payload).eq("id", rowId);
}

async function runRefreshForToken(
  supabaseAdmin: ReturnType<typeof createClient>,
  args: {
    runId: string;
    source: string;
    mode: "prod" | "dev";
    tokenKind: "broadcaster" | "bot";
    rowId: number;
    currentFailCount: number;
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  },
) {
  const result = await requestKickRefreshToken({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    refreshToken: args.refreshToken,
  });

  const now = nowIso();
  if (result.ok) {
    const updatePayload: Record<string, unknown> = {
      access_token: result.accessToken,
      updated_at: now,
      last_refresh_at: now,
      last_refresh_status: "ok",
      last_refresh_error: "",
      refresh_fail_count: 0,
    };
    if (result.refreshToken) {
      updatePayload.refresh_token = result.refreshToken;
    }
    await updateKickTokenRow(supabaseAdmin, args.rowId, updatePayload);
    await writeRefreshLog(supabaseAdmin, {
      run_id: args.runId,
      source: args.source,
      mode: args.mode,
      token_kind: args.tokenKind,
      row_id: args.rowId,
      success: true,
      status_code: result.status,
      error: "",
      details: {},
    });
    return { ok: true, status: result.status };
  }

  await updateKickTokenRow(supabaseAdmin, args.rowId, {
    last_refresh_at: now,
    last_refresh_status: "error",
    last_refresh_error: result.error,
    refresh_fail_count: Math.max(0, Number(args.currentFailCount || 0)) + 1,
  });
  await writeRefreshLog(supabaseAdmin, {
    run_id: args.runId,
    source: args.source,
    mode: args.mode,
    token_kind: args.tokenKind,
    row_id: args.rowId,
    success: false,
    status_code: result.status,
    error: result.error,
    details: {},
  });
  return { ok: false, status: result.status, error: result.error };
}

Deno.serve(async (req) => {
  const startAt = Date.now();
  const cronSecretHeader = safeText(req.headers.get("x-kick-cron-secret"));
  const envCronSecret = safeText(Deno.env.get("KICK_CRON_SECRET"));
  if (!cronSecretHeader || !envCronSecret || cronSecretHeader !== envCronSecret) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const supabaseUrl = safeText(Deno.env.get("SUPABASE_URL"));
  const serviceRoleKey = safeText(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!supabaseUrl || !serviceRoleKey) {
    return json({
      ok: false,
      error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Edge Function secrets.",
    }, 500);
  }

  let source = "edge-function";
  try {
    const body = await req.json().catch(() => ({}));
    const requestedSource = safeText((body as Record<string, unknown>)?.source);
    if (requestedSource) source = requestedSource;
  } catch {
    // no-op
  }

  const runId = crypto.randomUUID();
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const rowIds = MODE_CONFIGS.flatMap((m) => [m.broadcasterRowId, m.botRowId]);
  const { data: rows, error: rowsErr } = await supabaseAdmin
    .from("kick_tokens")
    .select("id, client_id, client_secret, refresh_token, access_token, refresh_fail_count")
    .in("id", rowIds);

  if (rowsErr) {
    await writeRefreshLog(supabaseAdmin, {
      run_id: runId,
      source,
      mode: "",
      token_kind: "",
      row_id: null,
      success: false,
      status_code: 0,
      error: `No se pudo leer kick_tokens: ${safeText(rowsErr.message)}`,
      details: {},
    });
    return json({ ok: false, error: `Kick refresh failed reading tokens: ${safeText(rowsErr.message)}` }, 500);
  }

  const byId = new Map<number, KickTokenRow>();
  for (const row of (rows ?? []) as KickTokenRow[]) {
    byId.set(Number(row.id), row);
  }

  let refreshed = 0;
  let failed = 0;
  let skipped = 0;
  const details: Array<Record<string, unknown>> = [];

  for (const modeConfig of MODE_CONFIGS) {
    const broadcaster = byId.get(modeConfig.broadcasterRowId);
    const bot = byId.get(modeConfig.botRowId);
    const clientId = safeText(broadcaster?.client_id);
    const clientSecret = safeText(broadcaster?.client_secret);

    const broadcasterRefresh = safeText(broadcaster?.refresh_token);
    if (!broadcasterRefresh || !clientId || !clientSecret) {
      skipped += 1;
      details.push({
        mode: modeConfig.mode,
        token: "broadcaster",
        status: "skipped",
        reason: "missing refresh_token/client credentials",
      });
    } else {
      const result = await runRefreshForToken(supabaseAdmin, {
        runId,
        source,
        mode: modeConfig.mode,
        tokenKind: "broadcaster",
        rowId: modeConfig.broadcasterRowId,
        currentFailCount: Number(broadcaster?.refresh_fail_count || 0),
        refreshToken: broadcasterRefresh,
        clientId,
        clientSecret,
      });
      if (result.ok) {
        refreshed += 1;
      } else {
        failed += 1;
      }
      details.push({
        mode: modeConfig.mode,
        token: "broadcaster",
        status: result.ok ? "ok" : "error",
        http: result.status,
      });
    }

    const botRefresh = safeText(bot?.refresh_token);
    if (!botRefresh || !clientId || !clientSecret) {
      skipped += 1;
      details.push({
        mode: modeConfig.mode,
        token: "bot",
        status: "skipped",
        reason: "missing bot refresh_token or broadcaster client credentials",
      });
      continue;
    }

    const botResult = await runRefreshForToken(supabaseAdmin, {
      runId,
      source,
      mode: modeConfig.mode,
      tokenKind: "bot",
      rowId: modeConfig.botRowId,
      currentFailCount: Number(bot?.refresh_fail_count || 0),
      refreshToken: botRefresh,
      clientId,
      clientSecret,
    });
    if (botResult.ok) {
      refreshed += 1;
    } else {
      failed += 1;
    }
    details.push({
      mode: modeConfig.mode,
      token: "bot",
      status: botResult.ok ? "ok" : "error",
      http: botResult.status,
    });
  }

  await writeRefreshLog(supabaseAdmin, {
    run_id: runId,
    source,
    mode: "",
    token_kind: "summary",
    row_id: null,
    success: failed === 0,
    status_code: failed === 0 ? 200 : 207,
    error: failed === 0 ? "" : `${failed} refresh operations failed`,
    details: {
      refreshed,
      failed,
      skipped,
      duration_ms: Date.now() - startAt,
      steps: details,
    },
  });

  return json({
    ok: failed === 0,
    runId,
    refreshed,
    failed,
    skipped,
    durationMs: Date.now() - startAt,
    details,
  }, failed === 0 ? 200 : 207);
});
