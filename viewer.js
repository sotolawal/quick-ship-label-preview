(() => {
    const state = {
        objectUrls: [],
        clicks: {},
        timers: {},
        idleTimers: {}
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

            renderMetadata(preview);
            renderImages(preview.images);
        } catch (err) {
            console.error("[Quick Ship] Viewer failed:", err);
            showError(err.message || "Failed to load preview.");
        }
    }

    function wirePageButtons() {
        const printBtn = document.getElementById("print-all-btn");
        const closeBtn = document.getElementById("close-btn");

        if (printBtn) {
            printBtn.addEventListener("click", () => window.print());
        }

        if (closeBtn) {
            closeBtn.addEventListener("click", () => window.close());
        }

        window.addEventListener("beforeunload", cleanupObjectUrls);

        window.addEventListener("resize", () => {
            document.querySelectorAll('img[id^="media-"], iframe[id^="media-"]').forEach((el) => {
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
        const result = await chrome.storage.session.get(key);
        return result[key];
    }

    function renderMetadata(preview) {
        const subtitle = document.getElementById("viewer-subtitle");
        const pill = document.getElementById("metadata-pill");

        const metadata = preview.metadata || {};
        const imageCount = Array.isArray(preview.images) ? preview.images.length : 0;

        if (subtitle) {
            const parts = [];
            if (metadata.packID) parts.push(`Pack ID: ${metadata.packID}`);
            if (metadata.website) parts.push(`Website: ${metadata.website}`);
            if (metadata.source) parts.push(`Source: ${metadata.source}`);

            subtitle.textContent = parts.length
                ? parts.join(" • ")
                : `${imageCount} item${imageCount === 1 ? "" : "s"} ready`;
        }

        if (pill) {
            pill.hidden = false;
            pill.textContent = `${imageCount} item${imageCount === 1 ? "" : "s"}`;
        }

        document.title = imageCount > 1
            ? `Document Preview (${imageCount} items)`
            : "Document Preview";
    }

    function renderImages(images) {
        const status = document.getElementById("status");
        const viewer = document.getElementById("viewer");

        if (!viewer) throw new Error("Viewer container was not found.");
        if (status) status.remove();

        viewer.innerHTML = "";

        images.forEach((item, idx) => {
            const normalized = normalizePreviewItem(item);
            const card = createLabelCard(normalized, idx);
            viewer.appendChild(card);
        });

        requestAnimationFrame(() => {
            document.querySelectorAll('img[id^="media-"], iframe[id^="media-"]').forEach((el) => {
                if (el.tagName.toLowerCase() === "img" && !el.complete) {
                    el.addEventListener("load", () => captureMediaSize(el), { once: true });
                } else {
                    captureMediaSize(el);
                }
            });
        });
    }

    function normalizePreviewItem(item) {
        if (typeof item === "string") return normalizeStringItem(item);
        if (!item || typeof item !== "object") throw new Error("Invalid preview item encountered.");

        if (item.src) {
            return {
                src: item.src,
                type: item.type || inferTypeFromSrc(item.src)
            };
        }

        if (item.base64) {
            const type = item.type || inferTypeFromBase64(item.base64);
            return {
                src: createBlobUrlFromBase64(item.base64, type),
                type
            };
        }

        throw new Error("Preview item did not include src or base64 data.");
    }

    function normalizeStringItem(value) {
        const trimmed = value.trim();

        if (trimmed.startsWith("data:")) {
            return {
                src: trimmed,
                type: inferTypeFromSrc(trimmed)
            };
        }

        const type = inferTypeFromBase64(trimmed);
        return {
            src: createBlobUrlFromBase64(trimmed, type),
            type
        };
    }

    function inferTypeFromSrc(src) {
        const lower = String(src || "").toLowerCase();
        if (lower.startsWith("data:application/pdf")) return "application/pdf";
        if (lower.startsWith("data:image/png")) return "image/png";
        if (lower.startsWith("data:image/jpeg") || lower.startsWith("data:image/jpg")) return "image/jpeg";
        if (lower.startsWith("data:image/gif")) return "image/gif";
        return "image/png";
    }

    function inferTypeFromBase64(base64) {
        const prefix = String(base64 || "").trim().substring(0, 30);
        if (prefix.startsWith("JVBER")) return "application/pdf";
        if (prefix.startsWith("iVBORw0KGgo")) return "image/png";
        if (prefix.startsWith("/9j/")) return "image/jpeg";
        if (prefix.startsWith("R0lGOD")) return "image/gif";

        try {
            const decodedHeader = atob(prefix);
            if (decodedHeader.includes("%PDF")) return "application/pdf";
        } catch {
            // Ignore header decode failures.
        }

        return "image/png";
    }

    function createBlobUrlFromBase64(base64, type) {
        const cleanBase64 = String(base64 || "")
            .replace(/^data:[^;]+;base64,/i, "")
            .replace(/\s/g, "");

        const binary = atob(cleanBase64);
        const chunkSize = 1024 * 512;
        const chunks = [];

        for (let offset = 0; offset < binary.length; offset += chunkSize) {
            const slice = binary.slice(offset, offset + chunkSize);
            const bytes = new Uint8Array(slice.length);

            for (let i = 0; i < slice.length; i++) {
                bytes[i] = slice.charCodeAt(i);
            }

            chunks.push(bytes);
        }

        const blob = new Blob(chunks, { type });
        const url = URL.createObjectURL(blob);
        state.objectUrls.push(url);
        return url;
    }

    function createLabelCard(item, idx) {
        const card = document.createElement("article");
        card.className = "label-card";

        const header = document.createElement("div");
        header.className = "label-header";

        const pageNum = document.createElement("div");
        pageNum.className = "page-num";
        pageNum.textContent = `No. ${idx + 1}`;

        const actions = document.createElement("div");
        actions.className = "label-actions";

        const fan = createFanIcon(idx);

        const rotateBtn = document.createElement("button");
        rotateBtn.className = "btn";
        rotateBtn.type = "button";
        rotateBtn.textContent = "Rotate ⟳";
        rotateBtn.addEventListener("click", () => rotate(`media-${idx}`, `fan-${idx}`));

        actions.appendChild(fan);
        actions.appendChild(rotateBtn);
        header.appendChild(pageNum);
        header.appendChild(actions);

        const container = document.createElement("div");
        container.className = "img-container";

        if (item.type === "application/pdf") {
            const iframe = document.createElement("iframe");
            iframe.id = `media-${idx}`;
            iframe.src = item.src;
            iframe.title = `Document PDF ${idx + 1}`;
            iframe.setAttribute("data-rotation", "0");
            container.appendChild(iframe);
        } else {
            const img = document.createElement("img");
            img.id = `media-${idx}`;
            img.src = item.src;
            img.alt = `Document ${idx + 1}`;
            img.setAttribute("data-rotation", "0");
            container.appendChild(img);
        }
        
        const mediaShell = document.createElement("div");
        mediaShell.className = "media-shell";
        mediaShell.appendChild(container);

        const mediaCard = document.createElement("div");
        mediaCard.className = "media-card";
        mediaCard.appendChild(mediaShell);

        card.appendChild(header);
        card.appendChild(mediaCard);

        return card;
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
        svg.appendChild(path1);
        svg.appendChild(path2);
        return svg;
    }

    function getMediaContainer(el) {
        return el ? el.closest(".img-container") : null;
    }

    function captureMediaSize(el) {
        if (!el || el.dataset.baseWidth) return;
        const rect = el.getBoundingClientRect();
        const width = rect.width || el.offsetWidth;
        const height = rect.height || el.offsetHeight;
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
        if (!el) return;

        captureMediaSize(el);
        let current = parseInt(el.getAttribute("data-rotation") || "0", 10);
        current += 90;
        el.style.transform = `rotate(${current}deg)`;
        el.setAttribute("data-rotation", String(current));
        resizeMediaContainer(el);

        if (!state.clicks[mediaId]) state.clicks[mediaId] = 0;
        state.clicks[mediaId]++;
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

    function showError(message) {
        const status = document.getElementById("status");
        const subtitle = document.getElementById("viewer-subtitle");
        if (subtitle) subtitle.textContent = "Unable to load preview.";
        if (status) {
            status.className = "error-card";
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
    }
})();
