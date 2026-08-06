(() => {
    const viewerUtils = globalThis.QuickShipViewerUtils || {};
    const PREVIEW_RETENTION_MS = 60 * 60 * 1000;
    const state = {
        objectUrls: [],
        clicks: {},
        timers: {},
        idleTimers: {},
        items: [],
        metadata: {}
    };

    document.addEventListener("DOMContentLoaded", init);

    async function init() {
        wirePageButtons();

        try {
            const previewId = getPreviewIdFromUrl();

            if (!previewId) {
                showError("Missing preview ID. The viewer URL did not include an id parameter.");
                return;
            }

            const preview = await loadPreview(previewId);

            if (!preview || !Array.isArray(preview.images) || preview.images.length === 0) {
                showError("Preview data was not found or has expired.");
                return;
            }

            state.metadata = preview.metadata || {};
            renderMetadata(preview);
            await renderImages(preview.images);
        } catch (err) {
            console.error("[Quick Ship] Viewer failed:", err);
            showError(err.message || "Failed to load preview.");
        }
    }

    function wirePageButtons() {
        const printBtn = document.getElementById("print-all-btn");
        const closeBtn = document.getElementById("close-btn");
        const downloadBtn = document.getElementById("download-btn");

        printBtn?.addEventListener("click", () => window.print());
        closeBtn?.addEventListener("click", () => window.close());
        downloadBtn?.addEventListener("click", downloadPreview);

        window.addEventListener("beforeunload", cleanupObjectUrls);
        window.addEventListener("resize", () => {
            document.querySelectorAll('img[id^="media-"]').forEach((el) => {
                delete el.dataset.baseWidth;
                delete el.dataset.baseHeight;
                captureMediaSize(el);
            });
        });
    }

    function getPreviewIdFromUrl() {
        const params = new URLSearchParams(window.location.search);
        return params.get("id");
    }

    async function loadPreview(previewId) {
        const key = `preview:${previewId}`;
        const storageAreas = [chrome.storage.session, chrome.storage.local];

        for (const storageArea of storageAreas) {
            if (!storageArea) continue;
            const result = await storageArea.get(key);
            if (!result[key]) continue;

            const preview = result[key];
            if (
                typeof preview.createdAt === "number"
                && Date.now() - preview.createdAt > PREVIEW_RETENTION_MS
            ) {
                await storageArea.remove(key);
                continue;
            }

            // Keep the payload available for refresh. Background cleanup removes
            // viewer previews after their one-hour retention window.
            return preview;
        }

        return null;
    }

    function renderMetadata(preview) {
        const subtitle = document.getElementById("viewer-subtitle");
        const pill = document.getElementById("metadata-pill");
        const metadata = preview.metadata || {};
        const itemCount = Array.isArray(preview.images) ? preview.images.length : 0;

        if (subtitle) {
            const parts = [];
            if (metadata.packID) parts.push(`Pack ID: ${metadata.packID}`);
            if (metadata.website) parts.push(`Website: ${metadata.website}`);
            if (metadata.source) parts.push(`Source: ${metadata.source}`);
            subtitle.textContent = parts.length
                ? parts.join(" • ")
                : `${itemCount} item${itemCount === 1 ? "" : "s"} ready`;
        }

        if (pill) {
            pill.hidden = false;
            pill.textContent = String(itemCount);
            pill.setAttribute("aria-label", `${itemCount} item${itemCount === 1 ? "" : "s"}`);
        }

        document.title = itemCount > 1
            ? `Document Preview (${itemCount} items)`
            : "Document Preview";
    }

    async function renderImages(images) {
        const status = document.getElementById("status");
        const viewer = document.getElementById("viewer");
        const printBtn = document.getElementById("print-all-btn");
        const downloadBtn = document.getElementById("download-btn");

        if (!viewer) throw new Error("Viewer container was not found.");

        const normalizedItems = await Promise.all(
            images.map((item, originalIndex) => normalizePreviewItem(item, originalIndex))
        );
        const labels = normalizedItems.filter((item) => !isPdfItem(item));
        const documents = normalizedItems.filter(isPdfItem);
        const orderedItems = [...labels, ...documents];

        state.items = orderedItems;
        viewer.replaceChildren();

        if (labels.length > 0) {
            viewer.appendChild(createViewerGroup("labels", "Labels", labels, orderedItems));
        }
        if (documents.length > 0) {
            viewer.appendChild(createViewerGroup("documents", "Documents", documents, orderedItems));
        }

        if (printBtn) {
            printBtn.hidden = labels.length === 0;
            printBtn.textContent = documents.length > 0 ? "Print Labels" : "Print";
        }

        if (downloadBtn) {
            downloadBtn.hidden = false;
            const downloadLabel = document.getElementById("download-btn-label");
            if (downloadLabel) {
                downloadLabel.textContent = orderedItems.length > 1 ? "Download ZIP" : "Download";
            }
        }

        status?.remove();

        requestAnimationFrame(() => {
            document.querySelectorAll('img[id^="media-"]').forEach((el) => {
                if (!el.complete) {
                    el.addEventListener("load", () => captureMediaSize(el), { once: true });
                } else {
                    captureMediaSize(el);
                }
            });
        });
    }

    function createViewerGroup(key, title, items, orderedItems) {
        const section = document.createElement("section");
        section.className = `viewer-group ${key}-group`;

        const headingId = `${key}-heading`;
        section.setAttribute("aria-labelledby", headingId);

        const summary = document.createElement("div");
        summary.className = "group-summary";

        const heading = document.createElement("h2");
        heading.id = headingId;
        heading.className = "group-title";
        heading.textContent = title;

        const count = document.createElement("span");
        count.className = "group-count";
        count.textContent = String(items.length);
        count.setAttribute("aria-label", `${items.length} ${title.toLowerCase()}`);

        summary.append(heading, count);

        const list = document.createElement("div");
        list.className = "viewer-group-items";
        list.setAttribute("role", "list");

        for (const item of items) {
            const renderedIndex = orderedItems.indexOf(item);
            list.appendChild(createLabelCard(item, renderedIndex, orderedItems.length));
        }

        section.append(summary, list);
        return section;
    }

    async function normalizePreviewItem(item, originalIndex) {
        if (typeof item === "string") {
            return normalizeStringItem(item, originalIndex);
        }
        if (!item || typeof item !== "object") {
            throw new Error("Invalid preview item encountered.");
        }

        const declaredType = normalizeMimeType(
            item.type || item.mimeType || inferTypeFromSrc(item.src) || inferTypeFromBase64(item.base64)
        );
        const shared = copyItemMetadata(item, originalIndex);

        if (item.src) {
            const source = String(item.src).trim();
            const type = normalizeMimeType(item.type || item.mimeType || inferTypeFromSrc(source));
            if (source.startsWith("data:")) {
                return createBlobBackedItem(source, type, shared);
            }
            return {
                ...shared,
                src: source,
                type: type || declaredType || "image/png",
                blob: null,
                isLabel: shared.isLabel ?? (type || declaredType || "image/png").startsWith("image/")
            };
        }

        if (item.base64) {
            const type = declaredType || "image/png";
            const blob = createBlobFromBase64(item.base64, type);
            return createObjectUrlItem(blob, type, shared);
        }

        throw new Error("Preview item did not include src or base64 data.");
    }

    function normalizeStringItem(value, originalIndex) {
        const trimmed = String(value || "").trim();
        const shared = { originalIndex };

        if (trimmed.startsWith("data:")) {
            return createBlobBackedItem(trimmed, inferTypeFromSrc(trimmed), shared);
        }

        const type = inferTypeFromBase64(trimmed);
        const blob = createBlobFromBase64(trimmed, type);
        return createObjectUrlItem(blob, type, shared);
    }

    function copyItemMetadata(item, originalIndex) {
        const keys = [
            "documentType",
            "logicalType",
            "contentType",
            "payloadFormat",
            "originalFormat",
            "docType",
            "format",
            "detectedFormat",
            "trackingNumber",
            "trackingNo",
            "tracking",
            "trackingId",
            "contentKey",
            "carrier",
            "filename",
            "fileName",
            "originalFilename",
            "carrierFilename",
            "carrierFileName",
            "copiesToPrint",
            "documentName",
            "title",
            "name",
            "category",
            "kind",
            "isLabel"
        ];
        const metadata = { originalIndex };
        const nestedMetadata = item.metadata && typeof item.metadata === "object"
            ? item.metadata
            : {};
        for (const key of keys) {
            const value = item[key] ?? nestedMetadata[key];
            if (value !== undefined && value !== null && value !== "") {
                metadata[key] = value;
            }
        }
        return metadata;
    }

    function createBlobBackedItem(dataUrl, fallbackType, shared) {
        const blob = dataUrlToBlob(dataUrl, fallbackType);
        return createObjectUrlItem(blob, normalizeMimeType(blob.type || fallbackType), shared);
    }

    function createObjectUrlItem(blob, type, shared) {
        const src = URL.createObjectURL(blob);
        state.objectUrls.push(src);
        const normalizedType = normalizeMimeType(type || blob.type) || "image/png";
        return {
            ...shared,
            src,
            type: normalizedType,
            isLabel: shared.isLabel ?? normalizedType.startsWith("image/"),
            blob
        };
    }

    function dataUrlToBlob(dataUrl, fallbackType = "application/octet-stream") {
        if (typeof viewerUtils.dataUrlToBlob === "function") {
            return viewerUtils.dataUrlToBlob(dataUrl, fallbackType);
        }

        const match = String(dataUrl || "").match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/i);
        if (!match) throw new Error("Invalid data URL encountered.");
        const type = normalizeMimeType(match[1]) || fallbackType;
        const binary = match[2] ? atob(match[3].replace(/\s/g, "")) : decodeURIComponent(match[3]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type });
    }

    function createBlobFromBase64(base64, type) {
        if (typeof viewerUtils.base64ToBlob === "function") {
            return viewerUtils.base64ToBlob(base64, type);
        }

        const cleanBase64 = String(base64 || "")
            .replace(/^data:[^;]+;base64,/i, "")
            .replace(/\s/g, "");
        const binary = atob(cleanBase64);
        const chunkSize = 1024 * 512;
        const chunks = [];

        for (let offset = 0; offset < binary.length; offset += chunkSize) {
            const slice = binary.slice(offset, offset + chunkSize);
            const bytes = new Uint8Array(slice.length);
            for (let i = 0; i < slice.length; i++) bytes[i] = slice.charCodeAt(i);
            chunks.push(bytes);
        }

        return new Blob(chunks, { type });
    }

    function normalizeMimeType(value) {
        const type = String(value || "").trim().toLowerCase().split(";", 1)[0];
        if (type === "application/pdf") return type;
        if (type === "image/jpg") return "image/jpeg";
        if (type.startsWith("image/")) return type;
        return type || "";
    }

    function inferTypeFromSrc(src) {
        const lower = String(src || "").toLowerCase();
        const dataType = lower.match(/^data:([^;,]+)/);
        if (dataType) return normalizeMimeType(dataType[1]);
        if (/\.pdf(?:[?#]|$)/.test(lower)) return "application/pdf";
        if (/\.jpe?g(?:[?#]|$)/.test(lower)) return "image/jpeg";
        if (/\.gif(?:[?#]|$)/.test(lower)) return "image/gif";
        if (/\.webp(?:[?#]|$)/.test(lower)) return "image/webp";
        if (/\.png(?:[?#]|$)/.test(lower)) return "image/png";
        return "";
    }

    function inferTypeFromBase64(base64) {
        const prefix = String(base64 || "").trim().replace(/^data:[^;]+;base64,/i, "").substring(0, 30);
        if (prefix.startsWith("JVBER")) return "application/pdf";
        if (prefix.startsWith("iVBORw0KGgo")) return "image/png";
        if (prefix.startsWith("/9j/")) return "image/jpeg";
        if (prefix.startsWith("R0lGOD")) return "image/gif";
        if (prefix.startsWith("UklGR")) return "image/webp";

        try {
            const decodedHeader = atob(prefix);
            if (decodedHeader.includes("%PDF")) return "application/pdf";
        } catch {
            // Ignore header decode failures.
        }

        return "image/png";
    }

    function isPdfItem(item) {
        return normalizeMimeType(item && item.type) === "application/pdf";
    }

    function createLabelCard(item, renderedIndex, totalItems) {
        const isPdf = isPdfItem(item);
        const card = document.createElement("article");
        card.className = `label-card ${isPdf ? "pdf-item" : "image-item"}`;
        card.setAttribute("role", "listitem");
        card.setAttribute(
            "aria-label",
            `${isPdf ? "Document" : "Label"} ${renderedIndex + 1} of ${totalItems}`
        );

        const mediaCard = document.createElement("div");
        mediaCard.className = "media-card";

        const mediaShell = document.createElement("div");
        mediaShell.className = "media-shell";

        const container = document.createElement("div");
        container.className = "img-container";

        const mediaId = `media-${item.originalIndex}`;
        if (isPdf) {
            container.classList.add("pdf-container");
            const iframe = document.createElement("iframe");
            iframe.id = mediaId;
            iframe.className = "pdf-frame";
            iframe.src = item.src;
            iframe.title = `${getItemDisplayName(item, true)} — item ${renderedIndex + 1} of ${totalItems}`;
            container.appendChild(iframe);
        } else {
            const img = document.createElement("img");
            img.id = mediaId;
            img.src = item.src;
            img.alt = `${getItemDisplayName(item, false)} — item ${renderedIndex + 1} of ${totalItems}`;
            img.setAttribute("data-rotation", "0");
            container.appendChild(img);

            const actions = document.createElement("div");
            actions.className = "label-actions";

            const fan = createFanIcon(item.originalIndex);
            const rotateBtn = document.createElement("button");
            rotateBtn.className = "rotate-btn";
            rotateBtn.type = "button";
            rotateBtn.title = "Rotate clockwise";
            rotateBtn.setAttribute("aria-label", `Rotate label ${renderedIndex + 1} clockwise`);
            rotateBtn.setAttribute("aria-controls", mediaId);
            rotateBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 11a8.1 8.1 0 1 0 2 5.3"/><path d="M20 4v7h-7"/></svg>';
            rotateBtn.addEventListener("click", () => rotate(mediaId, `fan-${item.originalIndex}`));

            actions.append(fan, rotateBtn);
            mediaCard.appendChild(actions);
        }

        mediaShell.appendChild(container);
        mediaCard.appendChild(mediaShell);

        const pageNum = document.createElement("div");
        pageNum.className = "page-num";

        const accessiblePageNum = document.createElement("span");
        accessiblePageNum.className = "visually-hidden";
        accessiblePageNum.textContent = `Item ${renderedIndex + 1} of ${totalItems}`;

        const currentPage = document.createElement("span");
        currentPage.setAttribute("aria-hidden", "true");
        currentPage.textContent = String(renderedIndex + 1);
        pageNum.append(accessiblePageNum, currentPage);

        const pageTotal = document.createElement("span");
        pageTotal.className = "page-total";
        pageTotal.setAttribute("aria-hidden", "true");
        pageTotal.textContent = `/ ${totalItems}`;
        pageNum.appendChild(pageTotal);

        card.append(mediaCard, pageNum);
        return card;
    }

    function getItemDisplayName(item, isPdf) {
        const rawType = item.documentType || item.contentType;
        if (rawType && typeof viewerUtils.humanizeDocumentType === "function") {
            return viewerUtils.humanizeDocumentType(rawType);
        }
        if (rawType) {
            return String(rawType)
                .trim()
                .replace(/[_-]+/g, " ")
                .replace(/\s+/g, " ")
                .toLowerCase()
                .replace(/\b\w/g, (character) => character.toUpperCase());
        }
        return isPdf ? "PDF document" : "Shipping label";
    }

    function createFanIcon(idx) {
        const svgNs = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNs, "svg");
        svg.setAttribute("id", `fan-${idx}`);
        svg.setAttribute("class", "fan-icon");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.setAttribute("aria-hidden", "true");

        const path1 = document.createElementNS(svgNs, "path");
        path1.setAttribute(
            "d",
            "M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z"
        );

        const path2 = document.createElementNS(svgNs, "path");
        path2.setAttribute("d", "M12 12v.01");
        svg.append(path1, path2);
        return svg;
    }

    function getMediaContainer(el) {
        return el ? el.closest(".img-container") : null;
    }

    function captureMediaSize(el) {
        if (!el || el.dataset.baseWidth) return;
        const rect = el.getBoundingClientRect();
        const width = el.offsetWidth || rect.width;
        const height = el.offsetHeight || rect.height;
        if (!width || !height) return;
        el.dataset.baseWidth = width;
        el.dataset.baseHeight = height;
        resizeMediaContainer(el);
    }

    function resizeMediaContainer(el) {
        const container = getMediaContainer(el);
        if (!container) return;
        const baseWidth = parseFloat(el.dataset.baseWidth) || el.offsetWidth;
        const baseHeight = parseFloat(el.dataset.baseHeight) || el.offsetHeight;
        const rotation = ((parseInt(el.getAttribute("data-rotation") || "0", 10) % 360) + 360) % 360;
        const isSideways = rotation === 90 || rotation === 270;
        container.style.width = `${isSideways ? baseHeight : baseWidth}px`;
        container.style.height = `${isSideways ? baseWidth : baseHeight}px`;
    }

    function rotate(mediaId, fanId) {
        const el = document.getElementById(mediaId);
        if (!el || el.tagName.toLowerCase() !== "img") return;

        captureMediaSize(el);
        let current = parseInt(el.getAttribute("data-rotation") || "0", 10);
        current = (current + 90) % 360;
        el.style.transform = `rotate(${current}deg)`;
        el.setAttribute("data-rotation", String(current));
        resizeMediaContainer(el);

        state.clicks[mediaId] = (state.clicks[mediaId] || 0) + 1;
        if (state.timers[mediaId]) clearTimeout(state.timers[mediaId]);
        state.timers[mediaId] = setTimeout(() => {
            state.clicks[mediaId] = 0;
        }, 500);

        const fan = document.getElementById(fanId);
        if (fan) {
            if (state.clicks[mediaId] >= 4) fan.style.opacity = "1";
            if (fan.style.opacity === "1") fan.style.transform = `rotate(${current}deg)`;
            if (state.idleTimers[mediaId]) clearTimeout(state.idleTimers[mediaId]);
            state.idleTimers[mediaId] = setTimeout(() => {
                fan.style.opacity = "0";
            }, 2000);
        }
    }

    async function downloadPreview() {
        const button = document.getElementById("download-btn");
        const label = document.getElementById("download-btn-label");
        if (!button || state.items.length === 0 || button.disabled) return;

        const originalLabel = label?.textContent || "Download";
        button.disabled = true;
        if (label) label.textContent = "Preparing…";

        try {
            const names = buildDownloadFilenames(state.items, state.metadata);
            if (state.items.length === 1) {
                const blob = await getItemBlob(state.items[0]);
                triggerBlobDownload(blob, names[0]);
                return;
            }

            const files = [];
            for (let index = 0; index < state.items.length; index++) {
                const blob = await getItemBlob(state.items[index]);
                files.push({
                    name: names[index],
                    blob
                });
            }

            const zipBlob = await createZipBlob(files);
            triggerBlobDownload(zipBlob, buildArchiveFilename(state.metadata));
        } catch (err) {
            console.error("[Quick Ship] Download failed:", err);
            showTransientError(err.message || "The download could not be prepared.");
        } finally {
            button.disabled = false;
            if (label) label.textContent = originalLabel;
        }
    }

    function buildDownloadFilenames(items, metadata) {
        if (typeof viewerUtils.assignDocumentFilenames === "function") {
            return viewerUtils.assignDocumentFilenames(items, metadata);
        }
        if (typeof viewerUtils.buildUniqueDocumentFilenames === "function") {
            return viewerUtils.buildUniqueDocumentFilenames(items, metadata);
        }
        if (typeof viewerUtils.assignUniqueFilenames === "function") {
            return viewerUtils.assignUniqueFilenames(items, metadata);
        }

        const seen = new Map();
        return items.map((item, index) => {
            const extension = getExtensionForType(item.type);
            const prefix = sanitizeFilenamePart(
                metadata.packID
                    || metadata.shipmentNumber
                    || getItemDisplayName(item, isPdfItem(item))
                    || "Document"
            );
            const typeName = sanitizeFilenamePart(item.documentType || item.contentType || "Document");
            const base = item.filename || item.carrierFilename || `${prefix}_${typeName || `Document-${index + 1}`}`;
            const safeBase = sanitizeFilenamePart(String(base).replace(/\.[A-Za-z0-9]{1,8}$/i, "")) || `Document-${index + 1}`;
            const key = `${safeBase.toLowerCase()}.${extension}`;
            const duplicateNumber = (seen.get(key) || 0) + 1;
            seen.set(key, duplicateNumber);
            return `${safeBase}${duplicateNumber > 1 ? `-${String(duplicateNumber).padStart(2, "0")}` : ""}.${extension}`;
        });
    }

    function buildArchiveFilename(metadata) {
        if (typeof viewerUtils.buildArchiveFilename === "function") {
            return viewerUtils.buildArchiveFilename(metadata, state.items);
        }
        const identifier = sanitizeFilenamePart(metadata.packID || metadata.shipmentNumber || "preview");
        return `QuickShip-${identifier || "preview"}-documents.zip`;
    }

    function sanitizeFilenamePart(value) {
        if (typeof viewerUtils.sanitizeFilenamePart === "function") {
            return viewerUtils.sanitizeFilenamePart(value);
        }
        return String(value || "")
            .trim()
            .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "-")
            .replace(/[\s_-]+/g, "-")
            .replace(/^[-. ]+|[-. ]+$/g, "")
            .slice(0, 120);
    }

    function getExtensionForType(type) {
        if (typeof viewerUtils.extensionForMimeType === "function") {
            return viewerUtils.extensionForMimeType(type, "bin");
        }
        if (typeof viewerUtils.getExtensionForMimeType === "function") {
            return viewerUtils.getExtensionForMimeType(type);
        }
        const normalized = normalizeMimeType(type);
        if (normalized === "application/pdf") return "pdf";
        if (normalized === "image/jpeg") return "jpg";
        if (normalized === "image/gif") return "gif";
        if (normalized === "image/webp") return "webp";
        return "png";
    }

    async function getItemBlob(item) {
        if (item.blob instanceof Blob) return item.blob;
        const response = await fetch(item.src);
        if (!response.ok) throw new Error(`Could not read document ${item.originalIndex + 1}.`);
        return response.blob();
    }

    async function createZipBlob(files) {
        if (typeof viewerUtils.buildZipBlob === "function") {
            return viewerUtils.buildZipBlob(files);
        }
        if (typeof viewerUtils.buildZip === "function") {
            const result = await viewerUtils.buildZip(files);
            return new Blob([result], { type: "application/zip" });
        }
        if (typeof viewerUtils.createZipBlob === "function") {
            return viewerUtils.createZipBlob(files);
        }
        if (typeof viewerUtils.createStoredZip === "function") {
            const result = viewerUtils.createStoredZip(files);
            return result instanceof Blob ? result : new Blob([result], { type: "application/zip" });
        }
        throw new Error("ZIP support did not load.");
    }

    function triggerBlobDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }

    function showTransientError(message) {
        const subtitle = document.getElementById("viewer-subtitle");
        if (!subtitle) return;
        const previous = subtitle.textContent;
        subtitle.textContent = message;
        subtitle.style.color = "var(--qs-error)";
        window.setTimeout(() => {
            subtitle.textContent = previous;
            subtitle.style.removeProperty("color");
        }, 5000);
    }

    function showError(message) {
        const status = document.getElementById("status");
        const subtitle = document.getElementById("viewer-subtitle");
        if (subtitle) subtitle.textContent = "Unable to load preview.";
        if (status) {
            status.className = "error-card";
            status.setAttribute("role", "alert");
            status.textContent = message;
        }
    }

    function cleanupObjectUrls() {
        for (const url of state.objectUrls) {
            try {
                URL.revokeObjectURL(url);
            } catch {
                // Ignore cleanup failures.
            }
        }
        state.objectUrls = [];

        for (const timer of Object.values(state.timers)) clearTimeout(timer);
        for (const timer of Object.values(state.idleTimers)) clearTimeout(timer);
    }
})();
