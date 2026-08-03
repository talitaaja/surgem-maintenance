(function (global) {
    "use strict";

    const CONFIG = global.SURGEM_SUPABASE || {};
    const SEGMENT_SIZE_METERS = 200;
    const MAX_DOCUMENTATION_BYTES = 1024 * 1024;
    const AUTO_SYNC_INTERVAL_MS = 60000;

    let client = null;
    let recordsCache = [];
    let batchRowsCache = new Map();
    let cacheVersion = "";
    let realtimeChannel = null;
    let pollingTimer = null;
    let adminSessionActive = false;

    function configurationError() {
        if (!CONFIG.url || !CONFIG.publishableKey || !CONFIG.adminEmail) {
            return "Konfigurasi Supabase belum lengkap. Pastikan file supabase-config.js ikut diunggah.";
        }
        if (!global.supabase || typeof global.supabase.createClient !== "function") {
            return "Library Supabase gagal dimuat. Periksa koneksi internet lalu muat ulang halaman.";
        }
        return "";
    }

    function getClient() {
        const configMessage = configurationError();
        if (configMessage) throw new Error(configMessage);
        if (!client) {
            client = global.supabase.createClient(
                CONFIG.url,
                CONFIG.publishableKey,
                {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true
                    }
                }
            );
        }
        return client;
    }

    const authReady = (async function () {
        try {
            const supabaseClient = getClient();
            const result = await supabaseClient.auth.getSession();
            adminSessionActive = Boolean(result.data && result.data.session);
            supabaseClient.auth.onAuthStateChange(function (_event, session) {
                const previous = adminSessionActive;
                adminSessionActive = Boolean(session);
                if (previous !== adminSessionActive) {
                    global.dispatchEvent(new CustomEvent("surgem:admin-session-changed", {
                        detail: { loggedIn: adminSessionActive }
                    }));
                }
            });
        } catch (error) {
            adminSessionActive = false;
        }
    })();

    function parseSTA(value) {
    if (value === null || value === undefined) return null;

    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0
            ? value
            : null;
    }

    const text = String(value)
        .trim()
        .replace(/\s+/g, "");

    if (!text) return null;

    // Format STA, contoh:
    // 15+200
    // 0+050
    const staMatch = text.match(/^(\d+)\+(\d{1,3})$/);

    if (staMatch) {
        const km = Number(staMatch[1]);
        const meter = Number(staMatch[2]);

        if (
            !Number.isFinite(km) ||
            !Number.isFinite(meter) ||
            meter >= 1000
        ) {
            return null;
        }

        return km * 1000 + meter;
    }

    // Format meter penuh, contoh:
    // 15200
    // 50
    if (/^\d+$/.test(text)) {
        const meter = Number(text);

        return Number.isSafeInteger(meter) && meter >= 0
            ? meter
            : null;
    }

    // Format seperti 15.2 atau 15,200 ditolak
    return null;
}

    function formatSTA(value) {
        const meter = parseSTA(value);
        if (meter === null) return "-";
        const rounded = Math.round(meter);
        return String(Math.floor(rounded / 1000)).padStart(2, "0") + "+" +
            String(rounded % 1000).padStart(3, "0");
    }

    function normalizeLane(value) {
        const match = String(value || "").toUpperCase().match(/[123]/);
        return match ? "L" + match[0] : null;
    }
    function isValidDateInput(value) {
        const text = String(value || "").trim();

        const match = text.match(
            /^(\d{4})-(\d{2})-(\d{2})$/
        );

        if (!match) {
            return false;
        }

        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);

        const date = new Date(
            Date.UTC(year, month - 1, day)
        );

        return (
            date.getUTCFullYear() === year &&
            date.getUTCMonth() === month - 1 &&
            date.getUTCDate() === day
        );
    }
    function normalizePayload(payload) {
        const startRaw = parseSTA(payload && payload.staDari);
        const endRaw = parseSTA(payload && payload.staSampai);
        const jalur = String(payload && payload.jalur || "").trim().toUpperCase();
        const lajur = normalizeLane(payload && payload.lajur);
        const tanggal = String(payload && payload.tanggal || "").trim();
        const keterangan = String(payload && payload.keterangan || "").trim();
        const documentationDataUrl = String(payload && payload.dokumentasiDataUrl || "").trim();

        if (startRaw === null || endRaw === null) {
            throw new Error("STA dari dan STA sampai wajib berformat seperti 15+200.");
        }
        if (!/^[AB]$/.test(jalur)) {
            throw new Error("Jalur wajib dipilih: A atau B.");
        }
        if (!lajur) {
            throw new Error("Lajur wajib dipilih: L1, L2, atau L3.");
        }
       if (!isValidDateInput(tanggal)) {
            throw new Error(
                "Tanggal pelaksanaan wajib diisi dengan tanggal yang valid."
            );
        }
        if (!keterangan) {
            throw new Error("Keterangan perbaikan wajib diisi.");
        }
        if (documentationDataUrl && !/^data:image\//i.test(documentationDataUrl)) {
            throw new Error("Dokumentasi unggahan harus berupa gambar.");
        }
        if (documentationDataUrl.length > MAX_DOCUMENTATION_BYTES * 1.5) {
            throw new Error("Foto dokumentasi melebihi batas 1 MB.");
        }

        if (endRaw <= startRaw) {
            throw new Error(
                "STA sampai harus lebih besar daripada STA dari."
            );
        }

        const start = startRaw;
        const end = endRaw;

        if (end - start > 50000) {
            throw new Error(
                "Rentang pekerjaan maksimum 50 km per input."
            );
        }

        return {
            start,
            end,
            jalur,
            lajur,
            tanggal,
            keterangan,
            petugas: String(payload && payload.petugas || "").trim().slice(0, 100),
            dokumentasiUrl: String(payload && payload.dokumentasiUrl || "").trim(),
            dokumentasiNama: String(payload && payload.dokumentasiNama || "").trim().slice(0, 255),
            dokumentasiDataUrl: documentationDataUrl
        };
    }

    function friendlyError(error, fallback) {
        const message = String(error && error.message || "").trim();
        if (/failed to fetch|networkerror|load failed/i.test(message)) {
            return new Error("Supabase tidak dapat dijangkau. Periksa koneksi internet lalu muat ulang halaman.");
        }
        if (/invalid login credentials/i.test(message)) {
            return new Error("Kata sandi admin salah.");
        }
        if (/row-level security|permission denied|not allowed/i.test(message)) {
            return new Error("Akses database ditolak. Pastikan SQL_SETUP_SUPABASE.sql sudah dijalankan dan sesi admin masih aktif.");
        }
        return new Error(message || fallback || "Operasi Supabase gagal.");
    }

    function rowVersion(rows) {
        return JSON.stringify((rows || []).map(function (row) {
            return [row.id, row.diubah_pada, row.tanggal_pelaksanaan];
        }));
    }
    function normalizeKeywordText(text) {
        return String(text ?? "")
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    const SFO_KEYWORDS = [
    "scraping filling",
    "scrapping filling",
    "sfo",
    "scraping",
    "scrapping",
    "filling",
    "overlay"
];

const OTHER_KEYWORDS = [
    // Patching
    "patching type 1",
    "patching type 2",
    "patching beton",
    "patching",

    // Sambungan dan sealant
    "expansion joint",
    "joint sealant",
    "sealant",
    "siar muai",

    // Rigid pavement
    "rigid pavement",
    "perkerasan kaku",
    "rekonstruksi rigid",
    "rekonstruksi",
    "dowel bar",
    "dowel",
    "tie bar",

    // Perbaikan beton lainnya
    "grouting",
    "slab",
    "diamond grinding",
    "partial depth",
    "full depth"
];

function keywordCategoryFromKeterangan(keterangan) {
    const text = normalizeKeywordText(keterangan);

    // Keterangan kosong/tidak dikenal tidak boleh otomatis menjadi SFO
    if (!text) {
        return "Lainnya";
    }

    // Periksa pekerjaan non-SFO terlebih dahulu
    const isOther = OTHER_KEYWORDS.some(function (keyword) {
        return text.includes(normalizeKeywordText(keyword));
    });

    if (isOther) {
        return "Lainnya";
    }

    // Baru periksa pekerjaan SFO
    const isSFO = SFO_KEYWORDS.some(function (keyword) {
        return text.includes(normalizeKeywordText(keyword));
    });

    if (isSFO) {
        return "SFO";
    }

    // Jenis pekerjaan yang belum dikenali masuk Lainnya,
    // bukan dipaksa menjadi SFO.
    return "Lainnya";
}
    function expandDatabaseRow(row) {
        const start = Number(row.sta_dari_m);
        const end = Number(row.sta_sampai_m);
        const firstSegment = Math.floor(start / SEGMENT_SIZE_METERS) * SEGMENT_SIZE_METERS;
        const records = [];
        let cursor = firstSegment;
        let index = 0;

        while (cursor < end) {
            records.push({
                id: String(row.id) + ":" + cursor,
                batchId: String(row.id),
                createdAt: row.dibuat_pada || "",
                updatedAt: row.diubah_pada || "",
                sortId: new Date(row.diubah_pada || row.dibuat_pada || 0).getTime() + index,
                rute: row.jalur === "B" ? "surgem_B" : "surgem_A",
                Jalur: row.jalur,
                Lajur: row.lajur,
                Dari: cursor,
                Sampai: cursor + SEGMENT_SIZE_METERS,
                KM_Asli_Dari: start,
                KM_Asli_Sampai: end,
                Tanggal_Pelaksanaan: row.tanggal_pelaksanaan,
                Tahun: Number(String(row.tanggal_pelaksanaan || "").slice(0, 4)) || null,
                Keterangan: row.keterangan || "",
                Petugas: row.petugas || "",
                Kategori_Pekerjaan: keywordCategoryFromKeterangan(row.keterangan),
                Sumber_Data: "Input Admin Supabase",
                Dokumentasi_URL: index === 0 ? (row.dokumentasi_url || "") : "",
                Dokumentasi_Nama: index === 0 ? (row.dokumentasi_nama || "") : "",
                Dokumentasi_DataURL: "",
                Dokumentasi_Path: index === 0 ? (row.dokumentasi_path || "") : ""
            });
            cursor += SEGMENT_SIZE_METERS;
            index += 1;
        }

        return records;
    }

    function setRows(rows, options) {
        const normalizedRows = Array.isArray(rows) ? rows : [];
        const nextVersion = rowVersion(normalizedRows);
        const changed = nextVersion !== cacheVersion;

        batchRowsCache = new Map();
        recordsCache = [];
        normalizedRows.forEach(function (row) {
            batchRowsCache.set(String(row.id), { ...row });
            recordsCache.push.apply(recordsCache, expandDatabaseRow(row));
        });
        cacheVersion = nextVersion;

        if (changed && (!options || options.notify !== false)) {
            global.dispatchEvent(new CustomEvent("surgem:user-data-changed", {
                detail: { count: recordsCache.length, source: "supabase" }
            }));
        }
        return getRecords();
    }

    async function loadRecords(options) {
        await authReady;
        const supabaseClient = getClient();
        const result = await supabaseClient
            .from(CONFIG.tableName || "sfo_perbaikan")
            .select("*")
            .order("tanggal_pelaksanaan", { ascending: false })
            .order("sta_dari_m", { ascending: true });

        if (result.error) throw friendlyError(result.error, "Data perbaikan tidak dapat dimuat.");
        return setRows(result.data, { notify: !options || options.notify !== false });
    }

    function getRecords() {
        return recordsCache.map(function (record) { return { ...record }; });
    }

    function getBatches() {
        const grouped = new Map();
        recordsCache.forEach(function (record) {
            if (!grouped.has(record.batchId)) grouped.set(record.batchId, []);
            grouped.get(record.batchId).push(record);
        });

        return Array.from(grouped.entries()).map(function (entry) {
            const rows = entry[1].slice().sort(function (a, b) {
                return Number(a.Dari) - Number(b.Dari);
            });
            const first = rows[0];
            return {
                batchId: entry[0],
                records: rows,
                segmentCount: rows.length,
                ...first,
                Dari: first.KM_Asli_Dari,
                Sampai: first.KM_Asli_Sampai
            };
        }).sort(function (a, b) {
            return String(b.Tanggal_Pelaksanaan).localeCompare(String(a.Tanggal_Pelaksanaan)) ||
                String(b.updatedAt).localeCompare(String(a.updatedAt));
        });
    }

    function toGeoJSON() {
        const batchDocumentation = new Map();
        recordsCache.forEach(function (record) {
            const current = batchDocumentation.get(record.batchId) || {};
            batchDocumentation.set(record.batchId, {
                Dokumentasi_URL: current.Dokumentasi_URL || record.Dokumentasi_URL || "",
                Dokumentasi_Nama: current.Dokumentasi_Nama || record.Dokumentasi_Nama || "",
                Dokumentasi_DataURL: ""
            });
        });

        return {
            type: "FeatureCollection",
            features: recordsCache.map(function (record, index) {
                const documentation = batchDocumentation.get(record.batchId) || {};
                return {
                    type: "Feature",
                    id: record.id,
                    properties: {
                        ...record,
                        ...documentation,
                        OBJECTID: record.sortId || (Date.now() + index),
                        __data_origin: "user",
                        __source_index: index,
                        Input_Batch_ID: record.batchId
                    },
                    geometry: null
                };
            })
        };
    }

    async function loginAdmin(password) {
        await authReady;
        const supabaseClient = getClient();
        const result = await supabaseClient.auth.signInWithPassword({
            email: CONFIG.adminEmail,
            password: String(password || "")
        });
        if (result.error) {
            if (/invalid login credentials/i.test(String(result.error.message || ""))) return false;
            throw friendlyError(result.error, "Login admin gagal.");
        }
        adminSessionActive = Boolean(result.data && result.data.session);
        return adminSessionActive;
    }

    function logoutAdmin() {
        adminSessionActive = false;
        try {
            getClient().auth.signOut({ scope: "local" }).catch(function () {});
        } catch (error) {}
    }

    function isAdminLoggedIn() {
        return adminSessionActive;
    }

    function hasAdminPassword() {
        return true;
    }

    async function setupAdminPassword(password) {
        return loginAdmin(password);
    }

    function makeUuid() {
        if (global.crypto && typeof global.crypto.randomUUID === "function") {
            return global.crypto.randomUUID();
        }
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (character) {
            const random = Math.random() * 16 | 0;
            const value = character === "x" ? random : (random & 0x3 | 0x8);
            return value.toString(16);
        });
    }

    function sanitizeFileName(value) {
        const safe = String(value || "dokumentasi.jpg")
            .normalize("NFKD")
            .replace(/[^a-zA-Z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 120);
        return safe || "dokumentasi.jpg";
    }

    function dataUrlToBlob(dataUrl) {
        const parts = String(dataUrl || "").split(",");
        const header = parts[0] || "";
        const encoded = parts[1] || "";
        const mimeMatch = header.match(/^data:([^;]+);base64$/i);
        if (!mimeMatch) throw new Error("Format foto dokumentasi tidak didukung.");
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        if (bytes.byteLength > MAX_DOCUMENTATION_BYTES) {
            throw new Error("Ukuran foto dokumentasi melebihi 1 MB.");
        }
        return new Blob([bytes], { type: mimeMatch[1] });
    }

    async function uploadDocumentation(batchId, normalized) {
        if (!normalized.dokumentasiDataUrl) return null;
        const supabaseClient = getClient();
        const blob = dataUrlToBlob(normalized.dokumentasiDataUrl);
        const filename = sanitizeFileName(normalized.dokumentasiNama || "dokumentasi.jpg");
        const path = batchId + "/" + Date.now() + "-" + filename;
        const bucket = CONFIG.storageBucket || "sfo-dokumentasi";
        const result = await supabaseClient.storage.from(bucket).upload(path, blob, {
            contentType: blob.type,
            upsert: false
        });
        if (result.error) throw friendlyError(result.error, "Foto dokumentasi gagal diunggah.");
        const publicResult = supabaseClient.storage.from(bucket).getPublicUrl(path);
        return {
            path,
            name: normalized.dokumentasiNama || filename,
            url: publicResult.data && publicResult.data.publicUrl || ""
        };
    }

    async function removeDocumentation(path) {
        if (!path) return;
        try {
            await getClient().storage
                .from(CONFIG.storageBucket || "sfo-dokumentasi")
                .remove([path]);
        } catch (error) {}
    }

    async function requireAdminSession() {
        await authReady;
        if (!adminSessionActive) {
            throw new Error("Sesi admin sudah berakhir. Silakan masuk kembali.");
        }
    }

    async function addBatch(payload) {
        await requireAdminSession();
        const normalized = normalizePayload(payload);
        const batchId = makeUuid();
        let upload = null;

        try {
            upload = await uploadDocumentation(batchId, normalized);
            const result = await getClient()
                .from(CONFIG.tableName || "sfo_perbaikan")
                .insert({
                    id: batchId,
                    tanggal_pelaksanaan: normalized.tanggal,
                    sta_dari_m: normalized.start,
                    sta_sampai_m: normalized.end,
                    jalur: normalized.jalur,
                    lajur: normalized.lajur,
                    keterangan: normalized.keterangan,
                    petugas: normalized.petugas || null,
                    dokumentasi_url: upload ? upload.url : (normalized.dokumentasiUrl || null),
                    dokumentasi_nama: upload ? upload.name : (normalized.dokumentasiNama || null),
                    dokumentasi_path: upload ? upload.path : null
                })
                .select()
                .single();

            if (result.error) throw friendlyError(result.error, "Data perbaikan gagal disimpan.");
            await loadRecords({ notify: true });
            return expandDatabaseRow(result.data);
        } catch (error) {
            if (upload && upload.path) await removeDocumentation(upload.path);
            throw error;
        }
    }

    async function updateBatch(batchId, payload) {
        await requireAdminSession();
        if (!batchId) throw new Error("ID input tidak ditemukan.");
        const normalized = normalizePayload(payload);
        const existing = batchRowsCache.get(String(batchId));
        if (!existing) throw new Error("Data yang akan diubah tidak ditemukan. Muat ulang halaman lalu coba kembali.");

        let upload = null;
        try {
            upload = await uploadDocumentation(batchId, normalized);
            const manualUrlChanged = normalized.dokumentasiUrl !== String(existing.dokumentasi_url || "");
            const nextUrl = upload
                ? upload.url
                : (manualUrlChanged ? (normalized.dokumentasiUrl || null) : existing.dokumentasi_url);
            const nextName = upload
                ? upload.name
                : (manualUrlChanged ? (normalized.dokumentasiNama || null) : existing.dokumentasi_nama);
            const nextPath = upload
                ? upload.path
                : (manualUrlChanged ? null : existing.dokumentasi_path);

            const result = await getClient()
                .from(CONFIG.tableName || "sfo_perbaikan")
                .update({
                    tanggal_pelaksanaan: normalized.tanggal,
                    sta_dari_m: normalized.start,
                    sta_sampai_m: normalized.end,
                    jalur: normalized.jalur,
                    lajur: normalized.lajur,
                    keterangan: normalized.keterangan,
                    petugas: normalized.petugas || null,
                    dokumentasi_url: nextUrl,
                    dokumentasi_nama: nextName,
                    dokumentasi_path: nextPath
                })
                .eq("id", batchId)
                .select()
                .single();

            if (result.error) throw friendlyError(result.error, "Data perbaikan gagal diperbarui.");
            if (existing.dokumentasi_path && existing.dokumentasi_path !== nextPath) {
                await removeDocumentation(existing.dokumentasi_path);
            }
            await loadRecords({ notify: true });
            return expandDatabaseRow(result.data);
        } catch (error) {
            if (upload && upload.path) await removeDocumentation(upload.path);
            throw error;
        }
    }

    async function deleteBatch(batchId) {
        await requireAdminSession();
        if (!batchId) throw new Error("ID input tidak ditemukan.");
        const existing = batchRowsCache.get(String(batchId));
        const segmentCount = existing ? expandDatabaseRow(existing).length : 0;
        const result = await getClient()
            .from(CONFIG.tableName || "sfo_perbaikan")
            .delete()
            .eq("id", batchId);

        if (result.error) throw friendlyError(result.error, "Data perbaikan gagal dihapus.");
        if (existing && existing.dokumentasi_path) {
            await removeDocumentation(existing.dokumentasi_path);
        }
        await loadRecords({ notify: true });
        return segmentCount;
    }

    function startAutoSync() {
        if (realtimeChannel || pollingTimer) return;
        try {
            const supabaseClient = getClient();
            realtimeChannel = supabaseClient
                .channel("surgem-sfo-perbaikan")
                .on(
                    "postgres_changes",
                    {
                        event: "*",
                        schema: "public",
                        table: CONFIG.tableName || "sfo_perbaikan"
                    },
                    function () {
                        loadRecords({ notify: true }).catch(function (error) {
                            console.warn("Sinkronisasi Supabase gagal.", error);
                        });
                    }
                )
                .subscribe();
        } catch (error) {
            realtimeChannel = null;
        }

        pollingTimer = global.setInterval(function () {
            loadRecords({ notify: true }).catch(function () {});
        }, AUTO_SYNC_INTERVAL_MS);
    }

    function stopAutoSync() {
        if (realtimeChannel) {
            try { getClient().removeChannel(realtimeChannel); } catch (error) {}
            realtimeChannel = null;
        }
        if (pollingTimer) {
            global.clearInterval(pollingTimer);
            pollingTimer = null;
        }
    }

    global.SurGemData = Object.freeze({
        API_BASE: CONFIG.url || "",
        ADMIN_SESSION_KEY: "supabase-auth-session",
        MAX_DOCUMENTATION_BYTES,
        SEGMENT_SIZE_METERS,
        loadRecords,
        getRecords,
        getBatches,
        addBatch,
        updateBatch,
        deleteBatch,
        toGeoJSON,
        parseSTA,
        formatSTA,
        hasAdminPassword,
        setupAdminPassword,
        loginAdmin,
        logoutAdmin,
        isAdminLoggedIn,
        startAutoSync,
        stopAutoSync
    });
})(window);
