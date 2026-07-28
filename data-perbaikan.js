(function (global) {
    "use strict";

    const SURGEM_SERVER_PORT = "31726";

    function resolveApiBase() {
        if (global.SURGEM_API_BASE) {
            return String(global.SURGEM_API_BASE).replace(/\/$/, "");
        }

        const location = global.location;
        if (location && location.protocol !== "file:") {
            if (location.port === SURGEM_SERVER_PORT) return "/api";
            const hostname = location.hostname || "127.0.0.1";
            return "http://" + hostname + ":" + SURGEM_SERVER_PORT + "/api";
        }

        return "http://127.0.0.1:" + SURGEM_SERVER_PORT + "/api";
    }

    const API_BASE = resolveApiBase();
    const ADMIN_SESSION_KEY = "surgem_admin_server_session_v4";
    const SEGMENT_SIZE_METERS = 200;
    const MAX_DOCUMENTATION_BYTES = 1024 * 1024;
    const AUTO_SYNC_INTERVAL_MS = 30000;

    let recordsCache = [];
    let cacheVersion = "";
    let eventSource = null;
    let pollingTimer = null;

    function parseSTA(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === "number") {
            return Number.isFinite(value) && value >= 0 ? value : null;
        }

        const text = String(value).trim().replace(/\s+/g, "");
        if (!text) return null;

        const staMatch = text.match(/^(\d+)\+(\d{1,3})$/);
        if (staMatch) {
            const km = Number(staMatch[1]);
            const meter = Number(staMatch[2]);
            return meter < 1000 ? km * 1000 + meter : null;
        }

        const numeric = Number(text.replace(/,/g, "."));
        return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
    }

    function formatSTA(value) {
        const meter = parseSTA(value);
        if (meter === null) return "-";
        const rounded = Math.round(meter);
        return String(Math.floor(rounded / 1000)).padStart(2, "0") + "+" +
            String(rounded % 1000).padStart(3, "0");
    }

    function tokenPayload(token) {
        try {
            const part = String(token || "").split(".")[0];
            if (!part) return null;
            const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
            const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
            return JSON.parse(decodeURIComponent(escape(atob(padded))));
        } catch (error) {
            return null;
        }
    }

    function getAdminToken() {
        const token = sessionStorage.getItem(ADMIN_SESSION_KEY) || "";
        const payload = tokenPayload(token);
        if (!payload || !payload.exp || payload.exp * 1000 <= Date.now()) {
            sessionStorage.removeItem(ADMIN_SESSION_KEY);
            return "";
        }
        return token;
    }

    async function request(path, options) {
        const settings = { ...(options || {}) };
        settings.headers = { ...(settings.headers || {}) };

        if (settings.body && typeof settings.body !== "string") {
            settings.headers["Content-Type"] = "application/json";
            settings.body = JSON.stringify(settings.body);
        }

        if (settings.auth) {
            const token = getAdminToken();
            if (!token) throw new Error("Sesi admin sudah berakhir. Silakan masuk kembali.");
            settings.headers.Authorization = "Bearer " + token;
            delete settings.auth;
        }

        settings.mode = "cors";
        settings.cache = settings.cache || "no-store";

        let response;
        try {
            response = await fetch(API_BASE + path, settings);
        } catch (error) {
            throw new Error(
                "Server SurGem belum menyala. Tutup halaman ini, klik dua kali BUKA_SURGEM_WINDOWS.bat, lalu coba masuk kembali."
            );
        }
        let payload = null;
        try {
            payload = await response.json();
        } catch (error) {
            payload = null;
        }

        if (!response.ok) {
            if (response.status === 401) sessionStorage.removeItem(ADMIN_SESSION_KEY);

            const serverIdentity = response.headers.get("X-SurGem-Server") || "";
            if (response.status === 405 && serverIdentity !== "SurGem-Admin-v4") {
                throw new Error(
                    "Halaman masih terhubung ke server lama. Tutup semua tab SurGem, klik BUKA_SURGEM_WINDOWS.bat, lalu buka kembali halaman Admin."
                );
            }

            throw new Error(payload && payload.message
                ? payload.message
                : "Server SurGem menolak permintaan. Muat ulang halaman lalu coba kembali.");
        }

        return payload || {};
    }

    function computeVersion(records) {
        return JSON.stringify((records || []).map(function (record) {
            return [record.id, record.updatedAt, record.Tanggal_Pelaksanaan];
        }));
    }

    function setCache(records, options) {
        const normalized = Array.isArray(records) ? records : [];
        const nextVersion = options && options.version
            ? String(options.version)
            : computeVersion(normalized);
        const changed = nextVersion !== cacheVersion;

        recordsCache = normalized.map(function (record) { return { ...record }; });
        cacheVersion = nextVersion;

        if (changed && (!options || options.notify !== false)) {
            global.dispatchEvent(new CustomEvent("surgem:user-data-changed", {
                detail: { count: recordsCache.length, source: "server" }
            }));
        }

        return getRecords();
    }

    async function loadRecords(options) {
        const payload = await request("/perbaikan", { cache: "no-store" });
        return setCache(payload.records, {
            version: payload.version,
            notify: !options || options.notify !== false
        });
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
                Dokumentasi_DataURL: current.Dokumentasi_DataURL || record.Dokumentasi_DataURL || ""
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
        const payload = await request("/login", {
            method: "POST",
            body: { password: String(password || "") }
        });
        if (!payload.token) return false;
        sessionStorage.setItem(ADMIN_SESSION_KEY, payload.token);
        return true;
    }

    function logoutAdmin() {
        sessionStorage.removeItem(ADMIN_SESSION_KEY);
    }

    function isAdminLoggedIn() {
        return Boolean(getAdminToken());
    }

    function hasAdminPassword() {
        return true;
    }

    async function setupAdminPassword(password) {
        return loginAdmin(password);
    }

    async function addBatch(payload) {
        const response = await request("/perbaikan", {
            method: "POST",
            auth: true,
            body: payload
        });
        setCache(response.records, { version: response.version, notify: true });
        return Array.isArray(response.affectedRecords) ? response.affectedRecords : [];
    }

    async function updateBatch(batchId, payload) {
        if (!batchId) throw new Error("ID input tidak ditemukan.");
        const response = await request("/perbaikan/" + encodeURIComponent(batchId), {
            method: "PUT",
            auth: true,
            body: payload
        });
        setCache(response.records, { version: response.version, notify: true });
        return Array.isArray(response.affectedRecords) ? response.affectedRecords : [];
    }

    async function deleteBatch(batchId) {
        if (!batchId) throw new Error("ID input tidak ditemukan.");
        const response = await request("/perbaikan/" + encodeURIComponent(batchId), {
            method: "DELETE",
            auth: true
        });
        setCache(response.records, { version: response.version, notify: true });
        return Number(response.deletedCount || 0);
    }

    function startAutoSync() {
        if (eventSource || pollingTimer) return;

        if ("EventSource" in global) {
            eventSource = new EventSource(API_BASE + "/events");
            eventSource.addEventListener("data-changed", function () {
                loadRecords({ notify: true }).catch(function (error) {
                    console.warn("Sinkronisasi data SurGem gagal.", error);
                });
            });
            eventSource.onerror = function () {
                if (pollingTimer) return;
                pollingTimer = global.setInterval(function () {
                    loadRecords({ notify: true }).catch(function () {});
                }, AUTO_SYNC_INTERVAL_MS);
            };
            return;
        }

        pollingTimer = global.setInterval(function () {
            loadRecords({ notify: true }).catch(function () {});
        }, AUTO_SYNC_INTERVAL_MS);
    }

    function stopAutoSync() {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        if (pollingTimer) {
            global.clearInterval(pollingTimer);
            pollingTimer = null;
        }
    }

    global.SurGemData = Object.freeze({
        API_BASE,
        ADMIN_SESSION_KEY,
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
