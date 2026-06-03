import { createClient } from "npm:@supabase/supabase-js@2";

const KICK_PUBLIC_KEY_ENDPOINT = "https://api.kick.com/public/v1/public-key";
const DEFAULT_KICK_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

const PUBLIC_KEY_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const PUBLIC_KEY_FETCH_TIMEOUT_MS = 5000;

let cachedPublicKeyPem = "";
let cachedPublicKeyAtMs = 0;

function safeText(value: unknown, max = 2048): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Kick-Event-Message-Id, Kick-Event-Subscription-Id, Kick-Event-Signature, Kick-Event-Message-Timestamp, Kick-Event-Type, Kick-Event-Version",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

function decodeBase64ToUint8Array(input: string): Uint8Array {
  const normalized = safeText(input, 8192);
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function pemToSpkiBytes(pem: string): Uint8Array {
  const raw = String(pem || "")
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  return decodeBase64ToUint8Array(raw);
}

async function fetchKickPublicKeyPem(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), PUBLIC_KEY_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(KICK_PUBLIC_KEY_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return "";
    const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
    const data = (payload.data && typeof payload.data === "object") ? payload.data as Record<string, unknown> : {};
    return safeText(data.public_key, 8192);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveKickPublicKeyPem(): Promise<string> {
  const envPem = safeText(Deno.env.get("KICK_PUBLIC_KEY_PEM"), 8192);
  if (envPem) return envPem;

  const now = Date.now();
  if (cachedPublicKeyPem && (now - cachedPublicKeyAtMs) < PUBLIC_KEY_CACHE_TTL_MS) {
    return cachedPublicKeyPem;
  }

  const fetched = await fetchKickPublicKeyPem();
  if (fetched) {
    cachedPublicKeyPem = fetched;
    cachedPublicKeyAtMs = now;
    return fetched;
  }

  if (cachedPublicKeyPem) return cachedPublicKeyPem;
  return DEFAULT_KICK_PUBLIC_KEY_PEM;
}

async function verifyKickSignature(args: {
  messageId: string;
  messageTimestamp: string;
  signatureBase64: string;
  rawBody: string;
}): Promise<boolean> {
  const payloadToVerify = `${args.messageId}.${args.messageTimestamp}.${args.rawBody}`;
  const pem = await resolveKickPublicKeyPem();
  if (!pem) return false;

  try {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      pemToSpkiBytes(pem),
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["verify"],
    );

    const signature = decodeBase64ToUint8Array(args.signatureBase64);
    const encodedPayload = new TextEncoder().encode(payloadToVerify);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, encodedPayload);
  } catch {
    return false;
  }
}

function isDuplicateInsert(error: unknown): boolean {
  const code = safeText((error as { code?: unknown })?.code);
  if (code === "23505") return true;
  const msg = safeText((error as { message?: unknown })?.message).toLowerCase();
  return msg.includes("duplicate") || msg.includes("unique");
}

async function insertKickEventAudit(
  supabaseAdmin: ReturnType<typeof createClient>,
  row: Record<string, unknown>,
): Promise<void> {
  try {
    await supabaseAdmin.from("kick_events").insert(row);
  } catch {
    // Best effort audit write; never block webhook response path.
  }
}

Deno.serve(async (req) => {
  const startedAt = Date.now();

  if (req.method === "OPTIONS") {
    return json({ ok: true }, 204);
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const supabaseUrl = safeText(Deno.env.get("SUPABASE_URL"), 8192);
  const serviceRoleKey = safeText(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), 8192);
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const messageId = safeText(req.headers.get("Kick-Event-Message-Id"), 256);
  const subscriptionId = safeText(req.headers.get("Kick-Event-Subscription-Id"), 256);
  const signature = safeText(req.headers.get("Kick-Event-Signature"), 4096);
  const messageTimestamp = safeText(req.headers.get("Kick-Event-Message-Timestamp"), 128);
  const eventTypeHeader = safeText(req.headers.get("Kick-Event-Type"), 256);
  const eventVersion = safeText(req.headers.get("Kick-Event-Version"), 32);

  const rawBody = await req.text();
  const nowIso = new Date().toISOString();

  if (!messageId || !signature || !messageTimestamp) {
    await insertKickEventAudit(supabaseAdmin, {
      event_id: null,
      event_type: eventTypeHeader || "unknown",
      payload: { raw_body: rawBody },
      source: "kick_webhook_missing_headers",
      received_at: nowIso,
      signature,
      signature_valid: false,
      webhook_timestamp: messageTimestamp,
      processed_at: nowIso,
      processed_error: "missing required webhook headers",
    });
    return json({
      ok: false,
      error: "Missing required Kick webhook headers",
      missing: {
        messageId: !messageId,
        signature: !signature,
        messageTimestamp: !messageTimestamp,
      },
    }, 400);
  }

  const signatureValid = await verifyKickSignature({
    messageId,
    messageTimestamp,
    signatureBase64: signature,
    rawBody,
  });

  if (!signatureValid) {
    await insertKickEventAudit(supabaseAdmin, {
      event_id: null,
      event_type: eventTypeHeader || "unknown",
      payload: { raw_body: rawBody },
      source: "kick_webhook_invalid_signature",
      received_at: nowIso,
      signature,
      signature_valid: false,
      webhook_timestamp: messageTimestamp,
      processed_at: nowIso,
      processed_error: "invalid webhook signature",
    });
    return json({ ok: false, error: "Invalid webhook signature" }, 401);
  }

  let parsedPayload: unknown = {};
  try {
    parsedPayload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    parsedPayload = { raw_body: rawBody };
  }

  const payloadObj = (parsedPayload && typeof parsedPayload === "object")
    ? parsedPayload as Record<string, unknown>
    : { raw_body: rawBody };

  const eventTypePayload = safeText(payloadObj.event_type ?? payloadObj.event ?? payloadObj.type, 256);
  const eventType = eventTypeHeader || eventTypePayload || "unknown";

  const row = {
    event_id: messageId,
    event_type: eventType,
    payload: payloadObj,
    source: "kick_webhook",
    received_at: nowIso,
    signature,
    signature_valid: true,
    webhook_timestamp: messageTimestamp,
    processed_error: "",
  };

  const { error } = await supabaseAdmin
    .from("kick_events")
    .insert(row);

  if (error) {
    if (isDuplicateInsert(error)) {
      return json({
        ok: true,
        duplicate: true,
        eventId: messageId,
        eventType,
        durationMs: Date.now() - startedAt,
      }, 200);
    }

    return json({
      ok: false,
      error: safeText(error.message || error, 500),
      eventId: messageId,
      eventType,
    }, 500);
  }

  return json({
    ok: true,
    eventId: messageId,
    subscriptionId,
    eventType,
    eventVersion,
    durationMs: Date.now() - startedAt,
  }, 200);
});
