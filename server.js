const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { imageSize } = require("image-size");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { execSync } = require("child_process");
const r2 = require("./r2");

let apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  try {
    apiKey = execSync('security find-generic-password -s "google-api-key" -w', { encoding: "utf8" }).trim();
    console.log("Loaded API key from macOS Keychain");
  } catch { console.error("No GEMINI_API_KEY found"); process.exit(1); }
}

// Local temp dir for OCR processing only
const TMP_DIR = process.env.TMP_DIR || "/tmp/scanmyplan";
try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch {}

const genAI = new GoogleGenerativeAI(apiKey);
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const ITEM_VOCABULARY = [
  "Styling Chair", "Mirror", "Rolling Cart", "Shampoo Shuttle",
  "Shampoo Chair", "Shampoo Cabinet", "Hallway Bench",
  "47in Cabinet - LEFT ", "47in Cabinet - RIGHT", "47in Cabinet - No Si",
  "63in Cabinet - LEFT ", "63in Cabinet - RIGHT",
  "LEFT Hand Sliding Do", "RIGHT Hand Sliding D", "Back to Back Station"
];

const TRAINING_DIR = path.join(__dirname, "training-data");

// Load legend images
let legendCabinetsB64 = null, legendItemsB64 = null;
try {
  const lc = path.join(TRAINING_DIR, "legend-cabinets.png");
  const li = path.join(TRAINING_DIR, "legend-items.png");
  if (fs.existsSync(lc)) { const b = fs.readFileSync(lc); legendCabinetsB64 = b.toString("base64"); console.log("Loaded cabinet legend (" + (b.length/1024).toFixed(0) + "KB)"); }
  if (fs.existsSync(li)) { const b = fs.readFileSync(li); legendItemsB64 = b.toString("base64"); console.log("Loaded items legend (" + (b.length/1024).toFixed(0) + "KB)"); }
} catch (e) { console.error("Failed to load legends:", e.message); }

// Load Q1002 as one-shot example
let fewShotExample = null;
try {
  const imgPath = path.join(TRAINING_DIR, "quote-1002-small.png");
  const jsonPath = path.join(TRAINING_DIR, "quote-1002-cropped.json");
  if (fs.existsSync(imgPath) && fs.existsSync(jsonPath)) {
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const imgBuf = fs.readFileSync(imgPath);
    const dims = imageSize(imgBuf);
    const origW = 18120, origH = 21356;
    fewShotExample = {
      imgBase64: imgBuf.toString("base64"),
      imgDims: dims,
      json: jsonData.map(item => {
        const c = JSON.parse(item.Coordinates);
        const ymin = Math.round(c.y / origH * 1000);
        const xmin = Math.round(c.x / origW * 1000);
        const ymax = Math.round((c.y + c.height) / origH * 1000);
        const xmax = Math.round((c.x + c.width) / origW * 1000);
        return { RoomNo: item.RoomNo, RoomName: item.RoomName, ItemName: item.ItemName,
          box_2d: [ymin, xmin, ymax, xmax], Accuracy: item.Accuracy };
      })
    };
    console.log(`Loaded one-shot: Q1002 (${dims.width}x${dims.height}, ${fewShotExample.json.length} items, ${(imgBuf.length/1024).toFixed(0)}KB)`);
  }
} catch (e) { console.error("Failed to load Q1002:", e.message); }

function generateId() {
  return crypto.randomBytes(3).toString("hex");
}

// R2 key helpers
function planMetaKey(planId) { return `plans/${planId}/meta.json`; }
function planImageKey(planId, filename) { return `plans/${planId}/${filename}`; }
function leadsKey() { return `leads.csv`; }

// Mime type from filename
function mimeFromFilename(f) {
  if (f.endsWith(".png")) return "image/png";
  if (f.endsWith(".jpg") || f.endsWith(".jpeg")) return "image/jpeg";
  return "image/png";
}

// Use case pages
const usePages = ['furniture-fixture-detection','auto-quoting-estimation','compliance-code-checking','space-optimization','insurance-claims','real-estate-property'];
usePages.forEach(p => app.get('/' + p, (req, res) => res.sendFile(path.join(__dirname, 'public', p + '.html'))));

// Resources
app.get('/resources', (req, res) => res.sendFile(path.join(__dirname, 'public', 'resources', 'index.html')));
app.get('/resources/:slug', (req, res) => {
  const file = path.join(__dirname, 'public', 'resources', req.params.slug + '.html');
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).send('Not found');
});

app.use(express.static(path.join(__dirname, "public")));

// Plan permalink page
app.get("/plan/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "plan.html"));
});

// Upload-only endpoint: saves image + metadata to R2, returns planId
app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });
    const { documentNo, customer, email } = req.body;
    const filename = req.file.originalname;
    const dims = imageSize(req.file.buffer);
    const planId = generateId();

    // Save image to R2
    await r2.putObject(planImageKey(planId, filename), req.file.buffer, req.file.mimetype || mimeFromFilename(filename));

    // Save meta to R2
    const meta = {
      id: planId, imageFile: filename, documentNo: documentNo || "", customer: customer || "", email: email || "",
      imageDims: { width: dims.width, height: dims.height }, rooms: [], items: [], status: "pending",
      createdAt: new Date().toISOString()
    };
    await r2.putJSON(planMetaKey(planId), meta);

    // Append email to leads log
    if (email) {
      try {
        let csv = "";
        const existing = await r2.getObject(leadsKey());
        if (existing) csv = existing.body.toString("utf8");
        else csv = "timestamp,email,planId,filename\n";
        csv += `${new Date().toISOString()},${email},${planId},${filename}\n`;
        await r2.putObject(leadsKey(), csv, "text/csv");
      } catch (e) { console.warn("Failed to update leads:", e.message); }
    }

    console.log(`Uploaded ${filename} → /plan/${planId} (R2)`);
    res.json({ planId });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// SSE detection for an already-uploaded plan
app.get("/api/detect/:planId", async (req, res) => {
  const planId = req.params.planId;
  const meta = await r2.getJSON(planMetaKey(planId));
  if (!meta) { return res.status(404).json({ error: "Plan not found" }); }

  // If already processed, return cached results
  if (meta.status === "done") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    res.write(`event: result\ndata: ${JSON.stringify({ items: meta.items, rooms: meta.rooms })}\n\n`);
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  const keepalive = setInterval(() => { res.write("event: keepalive\ndata: {}\n\n"); }, 15000);

  try {
    // Fetch image from R2
    const imgObj = await r2.getObject(planImageKey(planId, meta.imageFile));
    if (!imgObj) throw new Error("Image not found in storage");
    const imgBuf = imgObj.body;
    const dims = meta.imageDims;
    const filename = meta.imageFile;

    res.write(`event: status\ndata: ${JSON.stringify({status:"Analyzing image..."})}\n\n`);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

    const prompt = buildPrompt(dims);
    const contentParts = buildContentParts(prompt, imgBuf, dims, filename);

    res.write(`event: status\ndata: ${JSON.stringify({status:"Waiting for Gemini response..."})}\n\n`);
    const result = await model.generateContent(contentParts);
    const text = result.response.text().trim();
    const parsed = extractJsonArray(text);
    const items = parseItems(parsed, dims, filename, meta.documentNo, meta.customer);

    let rooms = [];
    try {
      res.write('event: status\ndata: ' + JSON.stringify({status:'Detecting room boundaries via OCR...'}) + '\n\n');
      rooms = await detectRoomsOCR(imgBuf);
    } catch (e) { console.warn('OCR room detection skipped:', e.message); }

    // Update meta with results on R2
    meta.items = items;
    meta.rooms = rooms;
    meta.status = "done";
    await r2.putJSON(planMetaKey(planId), meta);

    console.log(`Detected ${items.length} items for plan ${planId} (R2)`);
    clearInterval(keepalive);
    res.write(`event: result\ndata: ${JSON.stringify({ items, rooms })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Detection error:", err);
    clearInterval(keepalive);
    res.write(`event: error\ndata: ${JSON.stringify({error: err.message || "Detection failed"})}\n\n`);
    res.end();
  }
});

// Serve saved results (legacy + new)
app.get("/results/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

app.get("/api/results/:id", async (req, res) => {
  const meta = await r2.getJSON(planMetaKey(req.params.id));
  if (!meta) return res.status(404).json({ error: "Not found" });
  res.json(meta);
});

app.get("/api/results/:id/image", async (req, res) => {
  const meta = await r2.getJSON(planMetaKey(req.params.id));
  if (!meta) return res.status(404).json({ error: "Not found" });
  const imgObj = await r2.getObject(planImageKey(req.params.id, meta.imageFile));
  if (!imgObj) return res.status(404).json({ error: "Image not found" });
  res.set("Content-Type", imgObj.contentType);
  res.set("Cache-Control", "public, max-age=86400");
  res.send(imgObj.body);
});

// List all saved results
app.get("/api/results", async (req, res) => {
  try {
    const keys = await r2.listObjects("plans/");
    // Extract unique plan IDs from keys like "plans/{id}/meta.json"
    const planIds = [...new Set(keys.filter(k => k.endsWith("/meta.json")).map(k => k.split("/")[1]))];
    const results = [];
    for (const id of planIds) {
      try {
        const meta = await r2.getJSON(planMetaKey(id));
        if (meta) {
          results.push({ id, imageFile: meta.imageFile, documentNo: meta.documentNo, customer: meta.customer, itemCount: (meta.items || []).length, createdAt: meta.createdAt });
        }
      } catch {}
    }
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(results);
  } catch (e) {
    console.error("List error:", e);
    res.json([]);
  }
});

// Direct upload + detect (legacy flow)
app.post("/api/detect", upload.single("image"), async (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  const keepalive = setInterval(() => { res.write("event: keepalive\ndata: {}\n\n"); }, 15000);

  try {
    if (!req.file) { clearInterval(keepalive); res.write('event: error\ndata: {"error":"No image uploaded"}\n\n'); res.end(); return; }
    const { documentNo, customer, email } = req.body;

    if (email) {
      try {
        let csv = "";
        const existing = await r2.getObject(leadsKey());
        if (existing) csv = existing.body.toString("utf8");
        else csv = "timestamp,email,planId,filename\n";
        csv += `${new Date().toISOString()},${email},,${req.file.originalname}\n`;
        await r2.putObject(leadsKey(), csv, "text/csv");
      } catch (e) { console.warn("Failed to update leads:", e.message); }
    }

    const filename = req.file.originalname;
    const dims = imageSize(req.file.buffer);
    console.log(`Processing ${filename}: ${dims.width}x${dims.height}`);
    res.write(`event: status\ndata: ${JSON.stringify({status:"Analyzing image..."})}\n\n`);

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    const prompt = buildPrompt(dims);
    const contentParts = buildContentParts(prompt, req.file.buffer, dims, filename);

    res.write(`event: status\ndata: ${JSON.stringify({status:"Waiting for Gemini response..."})}\n\n`);
    const result = await model.generateContent(contentParts);
    const text = result.response.text().trim();
    const parsed = extractJsonArray(text);
    const items = parseItems(parsed, dims, filename, documentNo, customer);

    let rooms = [];
    try {
      res.write('event: status\ndata: ' + JSON.stringify({status:'Detecting room boundaries via OCR...'}) + '\n\n');
      rooms = await detectRoomsOCR(req.file.buffer);
    } catch (e) { console.warn('OCR room detection skipped:', e.message); }

    // Save result to R2 for permalink
    const resultId = generateId();
    await r2.putObject(planImageKey(resultId, filename), req.file.buffer, req.file.mimetype || mimeFromFilename(filename));
    await r2.putJSON(planMetaKey(resultId), {
      id: resultId, imageFile: filename, documentNo: documentNo || "", customer: customer || "",
      imageDims: { width: dims.width, height: dims.height }, rooms, items, status: "done",
      createdAt: new Date().toISOString()
    });

    console.log(`Detected ${items.length} items in ${filename} → /results/${resultId} (R2)`);
    clearInterval(keepalive);
    res.write(`event: result\ndata: ${JSON.stringify({items, rooms, resultUrl: "/results/" + resultId})}\n\n`);
    res.end();
  } catch (err) {
    console.error("Detection error:", err);
    clearInterval(keepalive);
    res.write(`event: error\ndata: ${JSON.stringify({error: err.message || "Detection failed"})}\n\n`);
    res.end();
  }
});

// Leads endpoint
app.get("/api/leads", async (req, res) => {
  try {
    const obj = await r2.getObject(leadsKey());
    if (!obj) return res.json({ leads: [], count: 0 });
    const csv = obj.body.toString("utf8");
    const lines = csv.trim().split("\n").slice(1);
    const leads = lines.map(l => {
      const [timestamp, email, planId, filename] = l.split(",");
      return { timestamp, email, planId, filename };
    });
    res.json({ leads, count: leads.length });
  } catch { res.json({ leads: [], count: 0 }); }
});

// ─── Shared helpers ───

function buildPrompt(dims) {
  return `You are analyzing a salon floor plan architectural drawing.
Detect all furniture items and return their bounding boxes.

ITEM VOCABULARY (use ONLY these exact strings):
${ITEM_VOCABULARY.map((v, i) => `${i + 1}. "${v}"`).join("\n")}

I am providing LEGEND IMAGES showing exactly what each item looks like in the floor plan drawings. Use these to identify:
- "47in Cabinet - LEFT " = 47in cabinet with sink on the LEFT side
- "47in Cabinet - RIGHT" = 47in cabinet with sink on the RIGHT side  
- "47in Cabinet - No Si" = 47in cabinet with NO sink
- "63in Cabinet - LEFT " = 63in cabinet with sink on the LEFT side
- "63in Cabinet - RIGHT" = 63in cabinet with sink on the RIGHT side

INSTRUCTIONS:
1. Find ALL room numbers/labels visible in the floor plan. Every item MUST have a RoomNo.
2. Return bounding boxes using NORMALIZED coordinates on a 0-1000 scale (where 0,0 is top-left and 1000,1000 is bottom-right of the image).
3. Only output items from the vocabulary. Do NOT hallucinate items.
4. Be precise with bounding boxes — they should tightly wrap each item.
5. Use the legend images to correctly distinguish cabinet types.
6. Sliding doors appear as arc/swing lines at doorways.
7. A "Back to Back Station" is two styling stations sharing a central divider.
8. Count carefully — each physical object = exactly one entry.

Return ONLY a JSON array where each element is:
{"RoomNo":"<string>","RoomName":"","ItemName":"<exact vocabulary string>","box_2d":[ymin,xmin,ymax,xmax],"Accuracy":<0-100>}

The box_2d values MUST be integers from 0 to 1000 representing normalized coordinates.`;
}

function buildContentParts(prompt, imgBuf, dims, filename) {
  const contentParts = [{ text: prompt }];
  if (legendCabinetsB64) {
    contentParts.push({ text: "\nLEGEND 1 - Cabinet types (47in and 63in with LEFT/RIGHT/No Sink variations):" });
    contentParts.push({ inlineData: { data: legendCabinetsB64, mimeType: "image/png" } });
  }
  if (legendItemsB64) {
    contentParts.push({ text: "\nLEGEND 2 - Other items (Styling Chair, Back to Back Station, Shampoo Shuttle, Mirror, Rolling Cart):" });
    contentParts.push({ inlineData: { data: legendItemsB64, mimeType: "image/png" } });
  }
  if (fewShotExample) {
    const w = fewShotExample.imgDims.width, h = fewShotExample.imgDims.height;
    contentParts.push({ text: `\nEXAMPLE: Here is a floor plan (${w}x${h} pixels) with its correct output:` });
    contentParts.push({ inlineData: { data: fewShotExample.imgBase64, mimeType: "image/png" } });
    contentParts.push({ text: `CORRECT OUTPUT (${fewShotExample.json.length} items):\n${JSON.stringify(fewShotExample.json, null, 2)}` });
  }
  contentParts.push({ text: `\nNow analyze this NEW floor plan (${dims.width}x${dims.height} pixels):` });
  contentParts.push({ inlineData: { data: imgBuf.toString("base64"), mimeType: mimeFromFilename(filename) } });
  return contentParts;
}

function parseItems(parsed, dims, filename, documentNo, customer) {
  return parsed.map((item, idx) => {
    const box = item.box_2d;
    const x = Math.round(box[1] / 1000 * dims.width);
    const y = Math.round(box[0] / 1000 * dims.height);
    const w = Math.round((box[3] - box[1]) / 1000 * dims.width);
    const h = Math.round((box[2] - box[0]) / 1000 * dims.height);
    return {
      DocumentNo: documentNo || "", Customer: customer || "", DrawingFile: filename,
      ID: idx + 1, RoomNo: String(item.RoomNo || ""), RoomName: String(item.RoomName || ""),
      ItemName: item.ItemName,
      Coordinates: JSON.stringify({ x, y, width: w, height: h }),
      Accuracy: item.Accuracy ?? 0
    };
  });
}

async function detectRoomsOCR(imgBuf) {
  const tmpImg = path.join(TMP_DIR, '_ocr_' + Date.now() + '.png');
  fs.writeFileSync(tmpImg, imgBuf);
  try {
    const roomJson = execSync('python3 detect_rooms.py "' + tmpImg + '"', {
      encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, cwd: __dirname, timeout: 60000
    });
    return JSON.parse(roomJson.trim());
  } finally {
    try { fs.unlinkSync(tmpImg); } catch {}
  }
}

function extractJsonArray(text) {
  const clean = text.replace(/```json?\n?/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('[');
  if (start === -1) throw new Error('No JSON array found');
  let depth = 0;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === '[') depth++;
    else if (clean[i] === ']') { depth--; if (depth === 0) return JSON.parse(clean.slice(start, i + 1)); }
  }
  throw new Error('Unbalanced JSON array');
}

// ─── Startup ───

if (!r2.isConfigured()) {
  console.warn("⚠️  R2 not configured (set R2_API_TOKEN or CF_API_TOKEN). Storage will fail at runtime.");
}

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`ScanMyPlan running on http://localhost:${PORT} (R2 storage: ${r2.isConfigured() ? '✅' : '❌'})`));
