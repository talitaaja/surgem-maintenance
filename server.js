"use strict";

const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const childProcess = require("child_process");

const ROOT_DIR = path.resolve(__dirname);
const DATA_DIR = path.join(ROOT_DIR, "data");
const DATA_FILE = path.join(DATA_DIR, "user-repairs.json");
const PORT = Number(process.env.PORT || 31726);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "JTTforSFO26";
const SESSION_SECRET = process.env.SESSION_SECRET ||
    crypto.createHash("sha256").update("SurGem:" + ADMIN_PASSWORD).digest("hex");
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 12 * 60 * 60);
const SEGMENT_SIZE_METERS = 200;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_DOCUMENTATION_TEXT_BYTES = 1.5 * 1024 * 1024;

const sseClients = new Set();
let writeQueue = Promise.resolve();

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".geojson": "application/geo+json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

function jsonResponse(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "X-SurGem-Server": "SurGem-Admin-v4",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin"
    });
    res.end(body);
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function base64url(value) {
    return Buffer.from(value).toString("base64url");
}

function signToken() {
    const payload = {
        role: "admin",
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
    };
    const encoded = base64url(JSON.stringify(payload));
    const signature = crypto.createHmac("sha256", SESSION_SECRET)
        .update(encoded)
        .digest("base64url");
    return encoded + "." + signature;
}

function verifyToken(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 2) return false;
    const expected = crypto.createHmac("sha256", SESSION_SECRET)
        .update(parts[0])
        .digest("base64url");
    if (!safeEqual(parts[1], expected)) return false;

    try {
        const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        return payload.role === "admin" && Number(payload.exp) > Math.floor(Date.now() / 1000);
    } catch (error) {
        return false;
    }
}

function requireAdmin(req, res) {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!verifyToken(token)) {
        jsonResponse(res, 401, { message: "Sesi admin tidak valid atau sudah berakhir." });
        return false;
    }
    return true;
}

async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            const error = new Error("Ukuran data terlalu besar.");
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
        const invalid = new Error("Format JSON tidak valid.");
        invalid.statusCode = 400;
        throw invalid;
    }
}

async function ensureDataFile() {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    try {
        await fsp.access(DATA_FILE);
    } catch (error) {
        await fsp.writeFile(DATA_FILE, "[]\n", "utf8");
    }
}

async function readRecords() {
    await ensureDataFile();
    try {
        const parsed = JSON.parse(await fsp.readFile(DATA_FILE, "utf8"));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        throw new Error("Basis data perbaikan tidak dapat dibaca.");
    }
}

async function writeRecords(records) {
    await ensureDataFile();
    const temporary = DATA_FILE + ".tmp";
    await fsp.writeFile(temporary, JSON.stringify(records, null, 2) + "\n", "utf8");
    await fsp.rename(temporary, DATA_FILE);
}

function versionOf(records) {
    return crypto.createHash("sha1")
        .update(JSON.stringify(records.map((record) => [record.id, record.updatedAt])))
        .digest("hex");
}

function parseSTA(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
    const text = String(value).trim().replace(/\s+/g, "");
    const match = text.match(/^(\d+)\+(\d{1,3})$/);
    if (match) {
        const meter = Number(match[2]);
        return meter < 1000 ? Number(match[1]) * 1000 + meter : null;
    }
    const numeric = Number(text.replace(/,/g, "."));
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function normalizeLane(value) {
    const match = String(value || "").toUpperCase().match(/[123]/);
    return match ? "L" + match[0] : null;
}

function normalizePayload(payload) {
    const startRaw = parseSTA(payload.staDari);
    const endRaw = parseSTA(payload.staSampai);
    const jalur = String(payload.jalur || "").trim().toUpperCase();
    const lajur = normalizeLane(payload.lajur);
    const tanggal = String(payload.tanggal || "").trim();
    const keterangan = String(payload.keterangan || "").trim();
    const dokumentasiDataUrl = String(payload.dokumentasiDataUrl || "").trim();

    if (startRaw === null || endRaw === null) {
        throw Object.assign(new Error("STA dari dan STA sampai wajib berformat seperti 15+200."), { statusCode: 400 });
    }
    if (!/^[AB]$/.test(jalur)) {
        throw Object.assign(new Error("Jalur wajib dipilih: A atau B."), { statusCode: 400 });
    }
    if (!lajur) {
        throw Object.assign(new Error("Lajur wajib dipilih: L1, L2, atau L3."), { statusCode: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal) || Number.isNaN(new Date(tanggal + "T00:00:00Z").getTime())) {
        throw Object.assign(new Error("Tanggal pelaksanaan wajib diisi dengan benar."), { statusCode: 400 });
    }
    if (!keterangan) {
        throw Object.assign(new Error("Keterangan perbaikan wajib diisi."), { statusCode: 400 });
    }
    if (Buffer.byteLength(dokumentasiDataUrl, "utf8") > MAX_DOCUMENTATION_TEXT_BYTES) {
        throw Object.assign(new Error("Foto dokumentasi melebihi batas 1 MB."), { statusCode: 413 });
    }
    if (dokumentasiDataUrl && !/^data:image\//i.test(dokumentasiDataUrl)) {
        throw Object.assign(new Error("Dokumentasi unggahan harus berupa gambar."), { statusCode: 400 });
    }

    const start = Math.min(startRaw, endRaw);
    const end = Math.max(startRaw, endRaw);
    if (end - start > 50000) {
        throw Object.assign(new Error("Rentang pekerjaan maksimum 50 km per input."), { statusCode: 400 });
    }

    return {
        start,
        end,
        jalur,
        lajur,
        tanggal,
        keterangan,
        petugas: String(payload.petugas || "").trim().slice(0, 100),
        dokumentasiUrl: String(payload.dokumentasiUrl || "").trim(),
        dokumentasiNama: String(payload.dokumentasiNama || "").trim().slice(0, 255),
        dokumentasiDataUrl
    };
}

function makeId(prefix) {
    return prefix + "-" + crypto.randomUUID();
}

function expandPayload(payload, batchId, createdAt) {
    const data = normalizePayload(payload);
    const id = batchId || makeId("batch");
    const now = new Date().toISOString();
    const firstSegment = Math.floor(data.start / SEGMENT_SIZE_METERS) * SEGMENT_SIZE_METERS;
    const effectiveEnd = data.end === data.start ? data.start + 1 : data.end;
    const records = [];
    let cursor = firstSegment;
    let index = 0;

    while (cursor < effectiveEnd) {
        records.push({
            id: makeId("repair"),
            batchId: id,
            createdAt: createdAt || now,
            updatedAt: now,
            sortId: Date.now() + index,
            rute: data.jalur === "B" ? "surgem_B" : "surgem_A",
            Jalur: data.jalur,
            Lajur: data.lajur,
            Dari: cursor,
            Sampai: cursor + SEGMENT_SIZE_METERS,
            KM_Asli_Dari: data.start,
            KM_Asli_Sampai: data.end,
            Tanggal_Pelaksanaan: data.tanggal,
            Tahun: Number(data.tanggal.slice(0, 4)),
            Keterangan: data.keterangan,
            Petugas: data.petugas,
            Kategori_Pekerjaan: "SFO",
            Sumber_Data: "Input Admin Terpusat",
            Dokumentasi_URL: index === 0 ? data.dokumentasiUrl : "",
            Dokumentasi_Nama: index === 0 ? data.dokumentasiNama : "",
            Dokumentasi_DataURL: index === 0 ? data.dokumentasiDataUrl : ""
        });
        cursor += SEGMENT_SIZE_METERS;
        index += 1;
    }

    return records;
}

function broadcastChange(records) {
    const event = "event: data-changed\ndata: " + JSON.stringify({
        count: records.length,
        version: versionOf(records),
        updatedAt: new Date().toISOString()
    }) + "\n\n";

    for (const client of sseClients) {
        try {
            client.write(event);
        } catch (error) {
            sseClients.delete(client);
        }
    }
}

async function mutateRecords(mutator) {
    const task = writeQueue.then(async () => {
        const current = await readRecords();
        const result = await mutator(current);
        await writeRecords(result.records);
        broadcastChange(result.records);
        return result;
    });
    writeQueue = task.catch(() => {});
    return task;
}

async function handleApi(req, res, pathname) {
    if (req.method === "POST" && pathname === "/api/login") {
        const body = await readBody(req);
        if (!safeEqual(body.password || "", ADMIN_PASSWORD)) {
            jsonResponse(res, 401, { message: "Kata sandi admin salah." });
            return true;
        }
        jsonResponse(res, 200, {
            token: signToken(),
            expiresInSeconds: SESSION_TTL_SECONDS
        });
        return true;
    }

    if (req.method === "GET" && pathname === "/api/events") {
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "X-SurGem-Server": "SurGem-Admin-v4",
            "X-Accel-Buffering": "no"
        });
        res.write("retry: 5000\n\n");
        sseClients.add(res);
        const heartbeat = setInterval(() => {
            try { res.write(": heartbeat\n\n"); } catch (error) {}
        }, 25000);
        req.on("close", () => {
            clearInterval(heartbeat);
            sseClients.delete(res);
        });
        return true;
    }

    if (req.method === "GET" && pathname === "/api/perbaikan") {
        const records = await readRecords();
        jsonResponse(res, 200, {
            records,
            count: records.length,
            version: versionOf(records)
        });
        return true;
    }

    if (req.method === "POST" && pathname === "/api/perbaikan") {
        if (!requireAdmin(req, res)) return true;
        const body = await readBody(req);
        const result = await mutateRecords(async (records) => {
            const affectedRecords = expandPayload(body);
            return { records: records.concat(affectedRecords), affectedRecords };
        });
        jsonResponse(res, 201, {
            records: result.records,
            affectedRecords: result.affectedRecords,
            version: versionOf(result.records)
        });
        return true;
    }

    const batchMatch = pathname.match(/^\/api\/perbaikan\/([^/]+)$/);
    if (batchMatch && req.method === "PUT") {
        if (!requireAdmin(req, res)) return true;
        const body = await readBody(req);
        const batchId = decodeURIComponent(batchMatch[1]);
        const result = await mutateRecords(async (records) => {
            const old = records.filter((record) => record.batchId === batchId);
            if (!old.length) {
                throw Object.assign(new Error("Data yang akan diubah tidak ditemukan."), { statusCode: 404 });
            }
            const affectedRecords = expandPayload(body, batchId, old[0].createdAt);
            return {
                records: records.filter((record) => record.batchId !== batchId).concat(affectedRecords),
                affectedRecords
            };
        });
        jsonResponse(res, 200, {
            records: result.records,
            affectedRecords: result.affectedRecords,
            version: versionOf(result.records)
        });
        return true;
    }

    if (batchMatch && req.method === "DELETE") {
        if (!requireAdmin(req, res)) return true;
        const batchId = decodeURIComponent(batchMatch[1]);
        const result = await mutateRecords(async (records) => {
            const filtered = records.filter((record) => record.batchId !== batchId);
            const deletedCount = records.length - filtered.length;
            if (!deletedCount) {
                throw Object.assign(new Error("Data yang akan dihapus tidak ditemukan."), { statusCode: 404 });
            }
            return { records: filtered, deletedCount };
        });
        jsonResponse(res, 200, {
            records: result.records,
            deletedCount: result.deletedCount,
            version: versionOf(result.records)
        });
        return true;
    }

    if (pathname.startsWith("/api/")) {
        jsonResponse(res, 405, {
            message: "Permintaan API tidak didukung oleh server SurGem. Muat ulang halaman lalu coba kembali."
        });
        return true;
    }

    return false;
}

async function serveStatic(req, res, pathname) {
    const requested = pathname === "/" ? "/index.html" : pathname;
    let decoded;
    try {
        decoded = decodeURIComponent(requested);
    } catch (error) {
        jsonResponse(res, 400, { message: "URL tidak valid." });
        return;
    }

    const filePath = path.resolve(ROOT_DIR, "." + decoded);
    if (filePath !== ROOT_DIR && !filePath.startsWith(ROOT_DIR + path.sep)) {
        jsonResponse(res, 403, { message: "Akses ditolak." });
        return;
    }

    try {
        const stats = await fsp.stat(filePath);
        if (!stats.isFile()) throw new Error("not-file");
        const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": stats.size,
            "Cache-Control": /\.(html|js)$/i.test(filePath) ? "no-store" : "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
            "X-SurGem-Server": "SurGem-Admin-v4",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "same-origin"
        });
        fs.createReadStream(filePath).pipe(res);
    } catch (error) {
        jsonResponse(res, 404, { message: "File tidak ditemukan." });
    }
}


function getLocalNetworkUrls() {
    const urls = [];
    const interfaces = os.networkInterfaces();
    Object.values(interfaces).forEach((items) => {
        (items || []).forEach((item) => {
            if (item && item.family === "IPv4" && !item.internal) {
                urls.push("http://" + item.address + ":" + PORT);
            }
        });
    });
    return urls;
}

function openBrowser(url) {
    if (process.env.SURGEM_AUTO_OPEN !== "1") return;
    try {
        if (process.platform === "win32") {
            childProcess.spawn("cmd", ["/c", "start", "", url], {
                detached: true,
                stdio: "ignore"
            }).unref();
        } else if (process.platform === "darwin") {
            childProcess.spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
        } else {
            childProcess.spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
        }
    } catch (error) {
        console.warn("Browser tidak dapat dibuka otomatis. Buka " + url);
    }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
        if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Max-Age": "86400",
                "X-SurGem-Server": "SurGem-Admin-v4"
            });
            res.end();
            return;
        }

        const handled = await handleApi(req, res, url.pathname);
        if (!handled) await serveStatic(req, res, url.pathname);
    } catch (error) {
        console.error(error);
        jsonResponse(res, error.statusCode || 500, {
            message: error.message || "Kesalahan server internal."
        });
    }
});

server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
        console.error("");
        console.error("SurGem tidak dapat dibuka karena alamat lokal sedang dipakai aplikasi lain.");
        console.error("Tutup jendela SurGem lama, lalu klik kembali BUKA_SURGEM_WINDOWS.bat.");
        process.exit(1);
    }
    console.error("Server SurGem gagal:", error);
    process.exit(1);
});

ensureDataFile().then(() => {
    server.listen(PORT, "0.0.0.0", () => {
        const localUrl = "http://localhost:" + PORT;
        console.log("");
        console.log("===============================================");
        console.log("  SURGEM MAINTENANCE SUDAH BERJALAN");
        console.log("===============================================");
        console.log("Buka website : " + localUrl);
        console.log("Buka admin   : " + localUrl + "/admin.html");
        const networkUrls = getLocalNetworkUrls();
        if (networkUrls.length) {
            console.log("");
            console.log("Alamat untuk perangkat lain dalam Wi-Fi/LAN yang sama:");
            networkUrls.forEach((url) => console.log("- " + url));
        }
        console.log("");
        console.log("Jangan tutup jendela ini selama website dipakai.");
        console.log("===============================================");
        openBrowser(localUrl + "/admin.html");
    });
}).catch((error) => {
    console.error("Server gagal dimulai:", error);
    process.exit(1);
});
