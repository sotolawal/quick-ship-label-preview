(function attachQuickShipViewerUtils(root, factory) {
    "use strict";

    const api = factory();

    if (typeof module === "object" && module && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.QuickShipViewerUtils = api;
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function createQuickShipViewerUtils() {
    "use strict";

    const DOCUMENT_TYPE_NAMES = Object.freeze({
        LABEL: "Shipping-Label",
        LABEL_IMAGE: "Shipping-Label",
        SHIPPING_LABEL: "Shipping-Label",
        SHIPPINGLABEL: "Shipping-Label",
        THERMAL_LABEL: "Shipping-Label",
        RETURN_LABEL: "Return-Label",
        COMMERCIAL_INVOICE: "Commercial-Invoice",
        PRO_FORMA_INVOICE: "Pro-Forma-Invoice",
        PROFORMA_INVOICE: "Pro-Forma-Invoice",
        CERTIFICATE_OF_ORIGIN: "Certificate-of-Origin",
        USMCA_COMMERCIAL_INVOICE_CERTIFICATION_OF_ORIGIN: "USMCA-Certification-of-Origin",
        USMCA_CERTIFICATION_OF_ORIGIN: "USMCA-Certification-of-Origin",
        AIR_WAYBILL: "Air-Waybill",
        AIRWAY_BILL: "Air-Waybill",
        AWB: "Air-Waybill",
        PACKING_LIST: "Packing-List",
        BILL_OF_LADING: "Bill-of-Lading",
        BOL: "Bill-of-Lading",
        CUSTOMS_DECLARATION: "Customs-Declaration",
        DANGEROUS_GOODS_DECLARATION: "Dangerous-Goods-Declaration",
        MANIFEST: "Manifest",
        RECEIPT: "Receipt"
    });

    const MIME_EXTENSIONS = Object.freeze({
        "application/pdf": "pdf",
        "application/json": "json",
        "application/octet-stream": "bin",
        "application/zip": "zip",
        "application/zpl": "zpl",
        "application/x-zpl": "zpl",
        "image/bmp": "bmp",
        "image/gif": "gif",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/svg+xml": "svg",
        "image/tiff": "tif",
        "image/webp": "webp",
        "text/csv": "csv",
        "text/plain": "txt",
        "text/zpl": "zpl"
    });

    const FORMAT_EXTENSIONS = Object.freeze({
        PDF: "pdf",
        PNG: "png",
        JPEG: "jpg",
        JPG: "jpg",
        GIF: "gif",
        WEBP: "webp",
        TIFF: "tif",
        TIF: "tif",
        BMP: "bmp",
        SVG: "svg",
        ZPL: "zpl",
        ZPLII: "zpl",
        EPL: "epl",
        EPL2: "epl",
        CSV: "csv",
        JSON: "json",
        TXT: "txt",
        TEXT: "txt"
    });

    const RESERVED_WINDOWS_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    const MAX_UINT32 = 0xffffffff;
    const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
    let crcTable = null;

    function encodeUtf8(value) {
        const text = String(value == null ? "" : value);
        if (textEncoder) return textEncoder.encode(text);
        if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(text, "utf8"));
        throw new Error("This environment does not provide UTF-8 encoding support.");
    }

    function sanitizeFilenamePart(value, fallback) {
        const fallbackValue = fallback == null ? "Document" : String(fallback);
        let result = String(value == null ? "" : value);

        if (typeof result.normalize === "function") result = result.normalize("NFC");

        result = result
            .replace(/[<>:\"/\\|?*\u0000-\u001f\u007f]+/g, "-")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^[.\-\s]+|[.\-\s]+$/g, "");

        if (!result) {
            result = fallbackValue
                .replace(/[<>:\"/\\|?*\u0000-\u001f\u007f]+/g, "-")
                .replace(/\s+/g, "-")
                .replace(/-+/g, "-")
                .replace(/^[.\-\s]+|[.\-\s]+$/g, "") || "Document";
        }

        if (RESERVED_WINDOWS_NAMES.test(result)) result = `_${result}`;
        return result;
    }

    function splitFilename(filename) {
        const value = String(filename || "");
        const dot = value.lastIndexOf(".");
        if (dot <= 0 || dot === value.length - 1) return { stem: value, extension: "" };
        return {
            stem: value.slice(0, dot),
            extension: value.slice(dot + 1)
        };
    }

    function sanitizeFilename(value, fallback, maxLength) {
        const safeFallback = fallback == null ? "Document" : fallback;
        const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : 180;
        const raw = String(value == null ? "" : value);
        const split = splitFilename(raw);
        let stem = sanitizeFilenamePart(split.stem || raw, safeFallback);
        let extension = split.extension
            ? sanitizeFilenamePart(split.extension, "").replace(/[^A-Za-z0-9]+/g, "").toLowerCase()
            : "";

        if (extension.length > 16) extension = extension.slice(0, 16);
        if (RESERVED_WINDOWS_NAMES.test(stem)) stem = `_${stem}`;

        const suffix = extension ? `.${extension}` : "";
        const available = Math.max(1, limit - suffix.length);
        if (stem.length > available) {
            stem = stem.slice(0, available).replace(/[.\-\s]+$/g, "") || "Document";
        }

        return `${stem}${suffix}`;
    }

    function humanizeDocumentType(value) {
        const raw = String(value == null ? "" : value).trim();
        if (!raw) return "Document";

        const key = raw
            .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
            .replace(/[^A-Za-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .toUpperCase();

        if (DOCUMENT_TYPE_NAMES[key]) return DOCUMENT_TYPE_NAMES[key];

        const acronyms = new Set(["AWB", "BOL", "DHL", "PDF", "UPS", "USMCA", "ZPL"]);
        const words = key.split("_").filter(Boolean).map((word) => {
            if (acronyms.has(word)) return word;
            return word.charAt(0) + word.slice(1).toLowerCase();
        });

        return words.length ? words.join("-") : "Document";
    }

    function normalizeMimeType(mimeType) {
        const raw = String(mimeType == null ? "" : mimeType).trim().toLowerCase();
        if (!raw) return "";
        if (raw.startsWith("data:")) {
            const match = /^data:([^;,]+)/i.exec(raw);
            return match ? match[1].toLowerCase() : "";
        }
        return raw.split(";", 1)[0].trim();
    }

    function extensionForMimeType(mimeType, fallback) {
        const normalized = normalizeMimeType(mimeType);
        if (MIME_EXTENSIONS[normalized]) return MIME_EXTENSIONS[normalized];
        if (normalized.endsWith("+json")) return "json";
        if (normalized.endsWith("+xml")) return "xml";
        return sanitizeFilenamePart(fallback == null ? "bin" : fallback, "bin")
            .replace(/[^A-Za-z0-9]+/g, "")
            .toLowerCase() || "bin";
    }

    function firstValue(objects, keys) {
        for (const object of objects) {
            if (!object || typeof object !== "object") continue;
            for (const key of keys) {
                const value = object[key];
                if (value != null && String(value).trim()) return value;
            }
        }
        return null;
    }

    function inferDocumentExtension(document, fallback) {
        const item = document && typeof document === "object" ? document : {};
        const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
        const mime = firstValue([item, metadata], ["mimeType", "type"]);
        const contentType = firstValue([item, metadata], ["contentType"]);
        const src = firstValue([item], ["src"]);

        if (mime && String(mime).includes("/")) return extensionForMimeType(mime, fallback);
        if (contentType && String(contentType).includes("/")) return extensionForMimeType(contentType, fallback);
        if (src && String(src).toLowerCase().startsWith("data:")) return extensionForMimeType(src, fallback);

        const format = firstValue(
            [item, metadata],
            ["payloadFormat", "originalFormat", "docType", "format", "detectedFormat", "type"]
        );
        const formatKey = String(format == null ? "" : format).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
        return FORMAT_EXTENSIONS[formatKey] || extensionForMimeType("", fallback);
    }

    function usefulDocumentType(document) {
        const item = document && typeof document === "object" ? document : {};
        const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
        const candidates = [
            firstValue([item, metadata], ["documentType", "logicalType"]),
            firstValue([item, metadata], ["contentType"]),
            firstValue([item, metadata], ["documentName", "title", "name"])
        ];

        for (const candidate of candidates) {
            if (candidate == null) continue;
            const value = String(candidate).trim();
            if (!value || value.includes("/")) continue;
            const formatKey = value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
            if (FORMAT_EXTENSIONS[formatKey]) continue;
            const humanized = humanizeDocumentType(value);
            if (humanized !== "Document") return humanized;
        }

        const category = firstValue([item, metadata], ["category", "kind"]);
        if (item.isLabel === true || /^(?:label|shipping[_ -]?label)$/i.test(String(category || ""))) {
            return DOCUMENT_TYPE_NAMES.LABEL;
        }
        return "";
    }

    function ensureExtension(filename, extension, replaceExisting) {
        const safe = sanitizeFilename(filename, "Document");
        const split = splitFilename(safe);
        if (split.extension && !replaceExisting) return safe;
        const safeExtension = String(extension || "bin").replace(/[^A-Za-z0-9]+/g, "").toLowerCase() || "bin";
        const stem = split.extension ? split.stem : safe;
        return sanitizeFilename(`${stem}.${safeExtension}`, `Document.${safeExtension}`);
    }

    // `index` is zero-based. The visible/generic sequence is therefore index + 1.
    function buildDocumentFilename(document, index, context) {
        const item = document && typeof document === "object" ? document : {};
        const itemMetadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
        const scope = context && typeof context === "object" ? context : {};
        const scopeMetadata = scope.metadata && typeof scope.metadata === "object" ? scope.metadata : {};
        const sequence = Math.max(0, Number.isFinite(index) ? Math.floor(index) : 0) + 1;
        const sequenceText = String(sequence).padStart(2, "0");
        const extension = inferDocumentExtension(item, "bin");
        const explicit = firstValue(
            [item, itemMetadata],
            ["filename", "fileName", "originalFilename", "carrierFilename"]
        );
        const packId = firstValue(
            [scope, scopeMetadata, item, itemMetadata],
            ["packID", "packId"]
        );
        const typeName = usefulDocumentType(item);

        // Pack ID is the business identifier used by Quick Ship. When it is
        // available, it intentionally overrides carrier filenames and tracking.
        if (packId) {
            const identifier = sanitizeFilenamePart(packId, "Pack");
            const stem = typeName
                ? `${identifier}_${typeName}`
                : `${identifier}_Document-${sequenceText}`;
            return sanitizeFilename(`${stem}.${extension}`, `Document-${sequenceText}.${extension}`);
        }

        if (explicit) {
            const renderedMime = normalizeMimeType(firstValue([item, itemMetadata], ["mimeType", "type"]));
            const hasRenderedExtension = Boolean(
                renderedMime
                && renderedMime !== "application/octet-stream"
                && (
                    MIME_EXTENSIONS[renderedMime]
                    || renderedMime.endsWith("+json")
                    || renderedMime.endsWith("+xml")
                )
            );
            return ensureExtension(explicit, extension, hasRenderedExtension);
        }

        const shipment = firstValue(
            [item, itemMetadata, scope, scopeMetadata],
            ["shipmentNumber", "shipmentLookupNumber", "shipmentId", "erpNumber"]
        );
        const identifier = shipment ? sanitizeFilenamePart(shipment, "Document") : "";
        let stem;

        if (identifier && typeName) stem = `${identifier}_${typeName}`;
        else if (identifier) stem = `${identifier}_Document-${sequenceText}`;
        else if (typeName) stem = `${typeName}-${sequenceText}`;
        else stem = `Document-${sequenceText}`;

        return sanitizeFilename(`${stem}.${extension}`, `Document-${sequenceText}.${extension}`);
    }

    function dedupeFilenames(filenames) {
        const used = new Set();
        return (Array.isArray(filenames) ? filenames : []).map((filename, index) => {
            const maxLength = 180;
            const safe = sanitizeFilename(filename, `Document-${String(index + 1).padStart(2, "0")}`);
            const split = splitFilename(safe);
            const extension = split.extension ? `.${split.extension}` : "";
            const baseStem = split.stem || `Document-${String(index + 1).padStart(2, "0")}`;
            let candidate = safe;
            let duplicateNumber = 2;

            while (used.has(candidate.toLocaleLowerCase("en-US"))) {
                const suffix = `-${String(duplicateNumber).padStart(2, "0")}`;
                const availableStemLength = Math.max(1, maxLength - suffix.length - extension.length);
                const suffixedStem = baseStem
                    .slice(0, availableStemLength)
                    .replace(/[.\-\s]+$/g, "") || "Document";
                candidate = sanitizeFilename(
                    `${suffixedStem}${suffix}${extension}`,
                    `Document-${index + 1}${extension}`,
                    maxLength
                );
                duplicateNumber += 1;
            }

            used.add(candidate.toLocaleLowerCase("en-US"));
            return candidate;
        });
    }

    function assignDocumentFilenames(documents, context) {
        const list = Array.isArray(documents) ? documents : [];
        return dedupeFilenames(list.map((document, index) => buildDocumentFilename(document, index, context)));
    }

    function formatDateStamp(value) {
        const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
        const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
        const year = safeDate.getUTCFullYear();
        const month = String(safeDate.getUTCMonth() + 1).padStart(2, "0");
        const day = String(safeDate.getUTCDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    function forceZipExtension(value) {
        const safe = sanitizeFilename(value, "QuickShip-Documents.zip");
        const split = splitFilename(safe);
        return sanitizeFilename(`${split.stem || "QuickShip-Documents"}.zip`, "QuickShip-Documents.zip");
    }

    function buildArchiveFilename(metadata, documents, options) {
        const details = metadata && typeof metadata === "object" ? metadata : {};
        const settings = options && typeof options === "object" ? options : {};
        const packId = firstValue([details], ["packID", "packId"]);
        if (packId) {
            return forceZipExtension(`QuickShip-${sanitizeFilenamePart(packId, "Pack")}-Documents`);
        }

        const explicit = firstValue([details], ["archiveFilename", "zipFilename"]);
        if (explicit) return forceZipExtension(explicit);

        const source = String(firstValue([details], ["source"]) || "");
        const p21Identifier = firstValue(
            [details],
            ["shipmentLookupNumber", "erpNumber", "shipmentNumber", "packID", "packId"]
        );
        if (p21Identifier && /(?:p21|packing\s*list)/i.test(source)) {
            return forceZipExtension(`P21-${sanitizeFilenamePart(p21Identifier, "Shipment")}-Packing-List`);
        }

        const shipment = firstValue([details], ["shipmentNumber", "shipmentLookupNumber", "shipmentId", "erpNumber"]);
        if (shipment) {
            return forceZipExtension(`QuickShip-${sanitizeFilenamePart(shipment, "Shipment")}-Documents`);
        }

        const timestamp = firstValue([settings, details], ["date", "timestamp"]);
        return forceZipExtension(`QuickShip-Preview-${formatDateStamp(timestamp)}`);
    }

    function normalizeBase64(value) {
        let raw = String(value == null ? "" : value).trim();
        if (/^data:/i.test(raw)) {
            const comma = raw.indexOf(",");
            const header = comma >= 0 ? raw.slice(0, comma) : raw;
            if (comma < 0 || !/;base64(?:;|$)/i.test(header)) {
                throw new Error("The data URL is not base64 encoded.");
            }
            raw = raw.slice(comma + 1);
        }

        raw = raw.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
        if (!raw) return "";
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1) {
            throw new Error("Invalid base64 data.");
        }
        raw = raw.replace(/=+$/, "");
        while (raw.length % 4) raw += "=";
        return raw;
    }

    function base64ToBytes(value) {
        const normalized = normalizeBase64(value);
        if (!normalized) return new Uint8Array(0);

        if (typeof atob === "function") {
            let binary;
            try {
                binary = atob(normalized);
            } catch (error) {
                throw new Error(`Invalid base64 data: ${error.message || error}`);
            }
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
                bytes[index] = binary.charCodeAt(index);
            }
            return bytes;
        }

        if (typeof Buffer !== "undefined") {
            return Uint8Array.from(Buffer.from(normalized, "base64"));
        }
        throw new Error("This environment does not provide base64 decoding support.");
    }

    function dataUrlToBytes(value) {
        const dataUrl = String(value == null ? "" : value);
        if (!/^data:/i.test(dataUrl)) throw new Error("Expected a data URL.");
        const comma = dataUrl.indexOf(",");
        if (comma < 0) throw new Error("Malformed data URL: missing comma separator.");

        const header = dataUrl.slice(5, comma);
        const payload = dataUrl.slice(comma + 1);
        const segments = header.split(";");
        const mimeType = normalizeMimeType(segments[0] || "text/plain") || "text/plain";
        const isBase64 = segments.slice(1).some((segment) => segment.toLowerCase() === "base64");
        let bytes;

        if (isBase64) {
            bytes = base64ToBytes(payload);
        } else {
            let decoded;
            try {
                decoded = decodeURIComponent(payload);
            } catch (error) {
                throw new Error(`Malformed data URL payload: ${error.message || error}`);
            }
            bytes = encodeUtf8(decoded);
        }

        return { bytes, mimeType };
    }

    function copyView(view) {
        return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    }

    async function toBytes(value, options) {
        const settings = options && typeof options === "object" ? options : {};
        if (value instanceof Uint8Array) return new Uint8Array(value);
        if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
        if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value)) return copyView(value);
        if (Array.isArray(value)) return Uint8Array.from(value);
        if (typeof Blob !== "undefined" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());

        if (typeof value === "string") {
            if (/^data:/i.test(value)) return dataUrlToBytes(value).bytes;
            if (settings.encoding === "base64") return base64ToBytes(value);
            return encodeUtf8(value);
        }

        throw new TypeError("Binary data must be a data URL, string, Blob, ArrayBuffer, typed array, or byte array.");
    }

    function bytesToBlob(value, mimeType) {
        if (typeof Blob === "undefined") throw new Error("This environment does not provide Blob support.");
        let bytes;
        if (value instanceof Uint8Array) bytes = value;
        else if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) bytes = new Uint8Array(value);
        else if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value)) bytes = copyView(value);
        else if (Array.isArray(value)) bytes = Uint8Array.from(value);
        else throw new TypeError("Blob data must be an ArrayBuffer, typed array, or byte array.");
        return new Blob([bytes], { type: normalizeMimeType(mimeType) || "application/octet-stream" });
    }

    function dataUrlToBlob(value, fallbackType) {
        const decoded = dataUrlToBytes(value);
        return bytesToBlob(decoded.bytes, decoded.mimeType || fallbackType || "application/octet-stream");
    }

    function base64ToBlob(value, mimeType) {
        if (/^data:/i.test(String(value == null ? "" : value))) {
            const decoded = dataUrlToBytes(value);
            return bytesToBlob(decoded.bytes, mimeType || decoded.mimeType);
        }
        return bytesToBlob(base64ToBytes(value), mimeType || "application/octet-stream");
    }

    function getCrcTable() {
        if (crcTable) return crcTable;
        crcTable = new Uint32Array(256);
        for (let number = 0; number < 256; number += 1) {
            let value = number;
            for (let bit = 0; bit < 8; bit += 1) {
                value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
            }
            crcTable[number] = value >>> 0;
        }
        return crcTable;
    }

    function crc32(value) {
        let bytes;
        if (value instanceof Uint8Array) bytes = value;
        else if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) bytes = new Uint8Array(value);
        else if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value)) bytes = copyView(value);
        else if (Array.isArray(value)) bytes = Uint8Array.from(value);
        else if (typeof value === "string") bytes = encodeUtf8(value);
        else throw new TypeError("CRC32 input must be a string, ArrayBuffer, typed array, or byte array.");

        return (updateCrc32(MAX_UINT32, bytes) ^ MAX_UINT32) >>> 0;
    }

    function updateCrc32(crc, bytes) {
        const table = getCrcTable();
        let next = crc >>> 0;
        for (let index = 0; index < bytes.length; index += 1) {
            next = table[(next ^ bytes[index]) & 0xff] ^ (next >>> 8);
        }
        return next >>> 0;
    }

    async function crc32Blob(blob, chunkSize) {
        const size = Number.isFinite(chunkSize) && chunkSize > 0
            ? Math.floor(chunkSize)
            : 4 * 1024 * 1024;
        let crc = MAX_UINT32;

        for (let offset = 0; offset < blob.size; offset += size) {
            const chunk = blob.slice(offset, Math.min(blob.size, offset + size));
            const bytes = new Uint8Array(await chunk.arrayBuffer());
            crc = updateCrc32(crc, bytes);

            // Yield between chunks so large archives do not monopolize the
            // viewer's main thread while checksums are being calculated.
            if (offset + size < blob.size && typeof setTimeout === "function") {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }

        return (crc ^ MAX_UINT32) >>> 0;
    }

    function zipDateTime(value) {
        const candidate = value instanceof Date ? new Date(value.getTime()) : new Date(value == null ? Date.now() : value);
        const date = Number.isNaN(candidate.getTime()) ? new Date() : candidate;
        const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
        const month = Math.min(12, Math.max(1, date.getUTCMonth() + 1));
        const day = Math.min(31, Math.max(1, date.getUTCDate()));
        const hours = Math.min(23, Math.max(0, date.getUTCHours()));
        const minutes = Math.min(59, Math.max(0, date.getUTCMinutes()));
        const seconds = Math.min(59, Math.max(0, date.getUTCSeconds()));
        return {
            time: ((hours << 11) | (minutes << 5) | Math.floor(seconds / 2)) & 0xffff,
            date: (((year - 1980) << 9) | (month << 5) | day) & 0xffff
        };
    }

    function setUint16(view, offset, value) {
        view.setUint16(offset, value & 0xffff, true);
    }

    function setUint32(view, offset, value) {
        view.setUint32(offset, value >>> 0, true);
    }

    async function buildZip(entries, options) {
        const list = Array.isArray(entries) ? entries : [];
        const settings = options && typeof options === "object" ? options : {};
        if (list.length > 0xffff) throw new RangeError("ZIP archives are limited to 65,535 entries.");

        const requestedNames = list.map((entry, index) => {
            const fallback = `Document-${String(index + 1).padStart(2, "0")}.bin`;
            return sanitizeFilename(entry && entry.name, fallback);
        });
        const names = dedupeFilenames(requestedNames);
        const prepared = [];
        let localSize = 0;
        let centralSize = 0;

        for (let index = 0; index < list.length; index += 1) {
            const entry = list[index] && typeof list[index] === "object" ? list[index] : { data: list[index] };
            let source;
            let encoding = entry.encoding;
            if (Object.prototype.hasOwnProperty.call(entry, "data")) source = entry.data;
            else if (Object.prototype.hasOwnProperty.call(entry, "bytes")) source = entry.bytes;
            else if (Object.prototype.hasOwnProperty.call(entry, "blob")) source = entry.blob;
            else if (Object.prototype.hasOwnProperty.call(entry, "base64")) {
                source = entry.base64;
                encoding = "base64";
            } else {
                throw new TypeError(`ZIP entry ${index + 1} did not include data, bytes, blob, or base64.`);
            }

            const bytes = await toBytes(source, { encoding });
            const nameBytes = encodeUtf8(names[index]);
            if (bytes.length > MAX_UINT32) throw new RangeError(`ZIP entry ${index + 1} exceeds the 4 GiB ZIP32 limit.`);
            if (nameBytes.length > 0xffff) throw new RangeError(`ZIP entry ${index + 1} has a filename longer than 65,535 bytes.`);

            const dateTime = zipDateTime(entry.date == null ? settings.date : entry.date);
            prepared.push({
                name: names[index],
                nameBytes,
                bytes,
                crc: crc32(bytes),
                time: dateTime.time,
                date: dateTime.date,
                offset: localSize
            });
            localSize += 30 + nameBytes.length + bytes.length;
            centralSize += 46 + nameBytes.length;
            if (localSize > MAX_UINT32 || centralSize > MAX_UINT32) {
                throw new RangeError("Archive exceeds the ZIP32 size limit.");
            }
        }

        const totalSize = localSize + centralSize + 22;
        if (!Number.isSafeInteger(totalSize) || totalSize > MAX_UINT32) {
            throw new RangeError("Archive exceeds the ZIP32 size limit.");
        }

        const output = new Uint8Array(totalSize);
        const view = new DataView(output.buffer);
        let offset = 0;
        const utf8Flag = 0x0800;

        for (const entry of prepared) {
            setUint32(view, offset, 0x04034b50);
            setUint16(view, offset + 4, 20);
            setUint16(view, offset + 6, utf8Flag);
            setUint16(view, offset + 8, 0);
            setUint16(view, offset + 10, entry.time);
            setUint16(view, offset + 12, entry.date);
            setUint32(view, offset + 14, entry.crc);
            setUint32(view, offset + 18, entry.bytes.length);
            setUint32(view, offset + 22, entry.bytes.length);
            setUint16(view, offset + 26, entry.nameBytes.length);
            setUint16(view, offset + 28, 0);
            offset += 30;
            output.set(entry.nameBytes, offset);
            offset += entry.nameBytes.length;
            output.set(entry.bytes, offset);
            offset += entry.bytes.length;
        }

        const centralOffset = offset;
        for (const entry of prepared) {
            setUint32(view, offset, 0x02014b50);
            setUint16(view, offset + 4, 20);
            setUint16(view, offset + 6, 20);
            setUint16(view, offset + 8, utf8Flag);
            setUint16(view, offset + 10, 0);
            setUint16(view, offset + 12, entry.time);
            setUint16(view, offset + 14, entry.date);
            setUint32(view, offset + 16, entry.crc);
            setUint32(view, offset + 20, entry.bytes.length);
            setUint32(view, offset + 24, entry.bytes.length);
            setUint16(view, offset + 28, entry.nameBytes.length);
            setUint16(view, offset + 30, 0);
            setUint16(view, offset + 32, 0);
            setUint16(view, offset + 34, 0);
            setUint16(view, offset + 36, 0);
            setUint32(view, offset + 38, 0);
            setUint32(view, offset + 42, entry.offset);
            offset += 46;
            output.set(entry.nameBytes, offset);
            offset += entry.nameBytes.length;
        }

        setUint32(view, offset, 0x06054b50);
        setUint16(view, offset + 4, 0);
        setUint16(view, offset + 6, 0);
        setUint16(view, offset + 8, prepared.length);
        setUint16(view, offset + 10, prepared.length);
        setUint32(view, offset + 12, centralSize);
        setUint32(view, offset + 16, centralOffset);
        setUint16(view, offset + 20, 0);

        return output;
    }

    async function zipEntryToBlob(entry, index) {
        const item = entry && typeof entry === "object" ? entry : { data: entry };
        if (typeof Blob !== "undefined" && item.blob instanceof Blob) return item.blob;

        let source;
        let encoding = item.encoding;
        if (Object.prototype.hasOwnProperty.call(item, "data")) source = item.data;
        else if (Object.prototype.hasOwnProperty.call(item, "bytes")) source = item.bytes;
        else if (Object.prototype.hasOwnProperty.call(item, "base64")) {
            source = item.base64;
            encoding = "base64";
        } else {
            throw new TypeError(`ZIP entry ${index + 1} did not include data, bytes, blob, or base64.`);
        }

        if (typeof Blob !== "undefined" && source instanceof Blob) return source;
        if (typeof source === "string" && /^data:/i.test(source)) return dataUrlToBlob(source);
        if (encoding === "base64") return base64ToBlob(source);
        return bytesToBlob(await toBytes(source), "application/octet-stream");
    }

    function createLocalZipHeader(entry) {
        const output = new Uint8Array(30 + entry.nameBytes.length);
        const view = new DataView(output.buffer);
        setUint32(view, 0, 0x04034b50);
        setUint16(view, 4, 20);
        setUint16(view, 6, 0x0800);
        setUint16(view, 8, 0);
        setUint16(view, 10, entry.time);
        setUint16(view, 12, entry.date);
        setUint32(view, 14, entry.crc);
        setUint32(view, 18, entry.size);
        setUint32(view, 22, entry.size);
        setUint16(view, 26, entry.nameBytes.length);
        setUint16(view, 28, 0);
        output.set(entry.nameBytes, 30);
        return output;
    }

    function createCentralZipHeader(entry) {
        const output = new Uint8Array(46 + entry.nameBytes.length);
        const view = new DataView(output.buffer);
        setUint32(view, 0, 0x02014b50);
        setUint16(view, 4, 20);
        setUint16(view, 6, 20);
        setUint16(view, 8, 0x0800);
        setUint16(view, 10, 0);
        setUint16(view, 12, entry.time);
        setUint16(view, 14, entry.date);
        setUint32(view, 16, entry.crc);
        setUint32(view, 20, entry.size);
        setUint32(view, 24, entry.size);
        setUint16(view, 28, entry.nameBytes.length);
        setUint16(view, 30, 0);
        setUint16(view, 32, 0);
        setUint16(view, 34, 0);
        setUint16(view, 36, 0);
        setUint32(view, 38, 0);
        setUint32(view, 42, entry.offset);
        output.set(entry.nameBytes, 46);
        return output;
    }

    function createZipEndRecord(entryCount, centralSize, centralOffset) {
        const output = new Uint8Array(22);
        const view = new DataView(output.buffer);
        setUint32(view, 0, 0x06054b50);
        setUint16(view, 4, 0);
        setUint16(view, 6, 0);
        setUint16(view, 8, entryCount);
        setUint16(view, 10, entryCount);
        setUint32(view, 12, centralSize);
        setUint32(view, 16, centralOffset);
        setUint16(view, 20, 0);
        return output;
    }

    async function buildZipBlob(entries, options) {
        if (typeof Blob === "undefined") throw new Error("This environment does not provide Blob support.");
        const list = Array.isArray(entries) ? entries : [];
        const settings = options && typeof options === "object" ? options : {};
        if (list.length > 0xffff) throw new RangeError("ZIP archives are limited to 65,535 entries.");

        const names = dedupeFilenames(list.map((entry, index) => {
            const fallback = `Document-${String(index + 1).padStart(2, "0")}.bin`;
            return sanitizeFilename(entry && entry.name, fallback);
        }));
        const prepared = [];
        let localSize = 0;
        let centralSize = 0;

        for (let index = 0; index < list.length; index += 1) {
            const item = list[index] && typeof list[index] === "object" ? list[index] : { data: list[index] };
            const blob = await zipEntryToBlob(item, index);
            const nameBytes = encodeUtf8(names[index]);
            if (blob.size > MAX_UINT32) throw new RangeError(`ZIP entry ${index + 1} exceeds the 4 GiB ZIP32 limit.`);
            if (nameBytes.length > 0xffff) throw new RangeError(`ZIP entry ${index + 1} has a filename longer than 65,535 bytes.`);

            const dateTime = zipDateTime(item.date == null ? settings.date : item.date);
            prepared.push({
                blob,
                nameBytes,
                size: blob.size,
                crc: await crc32Blob(blob, settings.chunkSize),
                time: dateTime.time,
                date: dateTime.date,
                offset: localSize
            });
            localSize += 30 + nameBytes.length + blob.size;
            centralSize += 46 + nameBytes.length;
            if (localSize > MAX_UINT32 || centralSize > MAX_UINT32) {
                throw new RangeError("Archive exceeds the ZIP32 size limit.");
            }
        }

        const totalSize = localSize + centralSize + 22;
        if (!Number.isSafeInteger(totalSize) || totalSize > MAX_UINT32) {
            throw new RangeError("Archive exceeds the ZIP32 size limit.");
        }

        const parts = [];
        for (const entry of prepared) parts.push(createLocalZipHeader(entry), entry.blob);
        for (const entry of prepared) parts.push(createCentralZipHeader(entry));
        parts.push(createZipEndRecord(prepared.length, centralSize, localSize));
        return new Blob(parts, { type: "application/zip" });
    }

    return Object.freeze({
        DOCUMENT_TYPE_NAMES,
        MIME_EXTENSIONS,
        sanitizeFilenamePart,
        sanitizeFilename,
        humanizeDocumentType,
        normalizeMimeType,
        extensionForMimeType,
        getExtensionForMimeType: extensionForMimeType,
        inferDocumentExtension,
        buildDocumentFilename,
        dedupeFilenames,
        assignDocumentFilenames,
        buildUniqueDocumentFilenames: assignDocumentFilenames,
        buildArchiveFilename,
        base64ToBytes,
        dataUrlToBytes,
        toBytes,
        bytesToBlob,
        dataUrlToBlob,
        base64ToBlob,
        crc32,
        buildZip,
        buildZipBlob,
        createZipBlob: buildZipBlob
    });
}));
