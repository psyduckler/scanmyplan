/**
 * Cloudflare R2 storage helper using the Cloudflare REST API.
 * No extra dependencies — uses built-in fetch (Node 18+).
 */

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "9ce95ed3e1df4a7e1d2a401e116c3c6f";
const BUCKET = process.env.R2_BUCKET || "scanmyplan";
const API_TOKEN = process.env.R2_API_TOKEN || process.env.CF_API_TOKEN;

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;

function headers(contentType) {
  const h = { Authorization: `Bearer ${API_TOKEN}` };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

/** Upload a buffer or string to R2. */
async function putObject(key, body, contentType = "application/octet-stream") {
  const res = await fetch(`${BASE}/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: headers(contentType),
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 PUT ${key} failed (${res.status}): ${text}`);
  }
  return true;
}

/** Get an object from R2. Returns { body: Buffer, contentType } or null if not found. */
async function getObject(key) {
  const res = await fetch(`${BASE}/${encodeURIComponent(key)}`, {
    method: "GET",
    headers: headers(),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 GET ${key} failed (${res.status}): ${text}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return { body: buf, contentType };
}

/** Check if an object exists. */
async function headObject(key) {
  const res = await fetch(`${BASE}/${encodeURIComponent(key)}`, {
    method: "HEAD",
    headers: headers(),
  });
  return res.ok;
}

/** Delete an object. */
async function deleteObject(key) {
  const res = await fetch(`${BASE}/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: headers(),
  });
  return res.ok;
}

/** Put JSON object. */
async function putJSON(key, obj) {
  return putObject(key, JSON.stringify(obj, null, 2), "application/json");
}

/** Get and parse JSON object. Returns null if not found. */
async function getJSON(key) {
  const result = await getObject(key);
  if (!result) return null;
  return JSON.parse(result.body.toString("utf8"));
}

/** List objects with a prefix. Returns array of keys. */
async function listObjects(prefix = "") {
  const url = new URL(BASE);
  if (prefix) url.searchParams.set("prefix", prefix);
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 LIST failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  // Cloudflare R2 API returns objects in result
  return (data.result || []).map(obj => obj.key);
}

function isConfigured() {
  return !!API_TOKEN;
}

module.exports = { putObject, getObject, headObject, deleteObject, putJSON, getJSON, listObjects, isConfigured };
