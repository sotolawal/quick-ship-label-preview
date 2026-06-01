(function () {
    // Orphaned Script Detection
    try {
        if (!chrome.runtime || !chrome.runtime.id) {
            return;
        }
    } catch (e) {
        return;
    }

    // Prevent duplicate injection
    if (window.QuickShipLabelPreviewActive) return;
    window.QuickShipLabelPreviewActive = true;

    // Inject the Interceptor Script
    function injectInterceptor() {
        try {
            if (!chrome.runtime?.id) return; // Double check before access
            const script = document.createElement("script");
            script.src = chrome.runtime.getURL("injected.js");
            script.onload = () => script.remove();
            (document.head || document.documentElement).appendChild(script);
        } catch (err) {
            // Suppress context invalidation errors here
            if (!err.message.includes("Extension context invalidated")) {
                console.error("[Quick Ship] Injection error:", err);
            }
        }
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        injectInterceptor();
    } else {
        window.addEventListener("DOMContentLoaded", injectInterceptor);
    }

    // Class for UI Rendering
    class LabelPreviewUI {
        constructor() {
            this.hostId = "quick-ship-preview-host";
            this.shadowRoot = null;
        }

        ensureHost() {
            // Prevent injection into non-HTML documents
            if (document.contentType && !["text/html", "application/xhtml+xml"].includes(document.contentType)) {
                // console.warn("[Quick Ship] Overlay disabled on non-HTML document.");
                return null;
            }

            let host = document.getElementById(this.hostId);
            if (host) host.remove(); // Reset for fresh state

            host = document.createElement("div");
            host.id = this.hostId;
            document.body.appendChild(host);
            this.shadowRoot = host.attachShadow({ mode: "open" });
            this.injectStyles();
            return this.shadowRoot;
        }

        makeP21FabDraggable(fab) {
            if (!fab || fab.dataset.dragBound === "true") return;
            fab.dataset.dragBound = "true";

            const DRAG_THRESHOLD_PX = 8;
            const storageKey = "qsP21FabPosition";
            let isPointerDown = false;
            let isDragging = false;
            let startX = 0;
            let startY = 0;
            let startLeft = 0;
            let startTop = 0;

            try {
                chrome.storage.local.get(storageKey).then((result) => {
                    const saved = result && result[storageKey];
                    if (!saved || typeof saved.left !== "number" || typeof saved.top !== "number") return;
                    const restored = clampPosition(saved.left, saved.top);
                    fab.style.left = `${restored.left}px`;
                    fab.style.top = `${restored.top}px`;
                    fab.style.right = "auto";
                    fab.style.bottom = "auto";
                });
            } catch {
                // Ignore storage restore failures.
            }

            function clampPosition(left, top) {
                const rect = fab.getBoundingClientRect();
                const margin = 8;
                const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
                const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
                return {
                    left: Math.min(Math.max(left, margin), maxLeft),
                    top: Math.min(Math.max(top, margin), maxTop)
                };
            }

            const savePosition = () => {
                const rect = fab.getBoundingClientRect();
                const position = {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top)
                };
                try {
                    chrome.storage.local.set({ [storageKey]: position });
                } catch {
                    // Ignore storage save failures.
                }
            };

            const onPointerDown = (event) => {
                // Only primary mouse/touch/pen input.
                if (event.button !== undefined && event.button !== 0) return;
                const rect = fab.getBoundingClientRect();
                isPointerDown = true;
                isDragging = false;
                startX = event.clientX;
                startY = event.clientY;
                startLeft = rect.left;
                startTop = rect.top;
                fab.setPointerCapture?.(event.pointerId);
            };

            const onPointerMove = (event) => {
                if (!isPointerDown) return;
                const dx = event.clientX - startX;
                const dy = event.clientY - startY;
                const movedFarEnough = Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX;

                if (!isDragging && !movedFarEnough) return;

                if (!isDragging) {
                    isDragging = true;
                    fab.style.transition = "none";
                }

                const next = clampPosition(startLeft + dx, startTop + dy);
                fab.style.left = `${next.left}px`;
                fab.style.top = `${next.top}px`;
                fab.style.right = "auto";
                fab.style.bottom = "auto";
            };

            const onPointerUp = (event) => {
                if (!isPointerDown) return;
                const wasDragging = isDragging;
                isPointerDown = false;
                isDragging = false;
                fab.releasePointerCapture?.(event.pointerId);
                fab.style.transition = "";

                if (wasDragging) {
                    savePosition();
                    fab.dataset.suppressNextClick = "true";
                    setTimeout(() => {
                        delete fab.dataset.suppressNextClick;
                    }, 250);
                }
            };

            fab.addEventListener("pointerdown", onPointerDown);
            fab.addEventListener("pointermove", onPointerMove);
            fab.addEventListener("pointerup", onPointerUp);
            fab.addEventListener("pointercancel", onPointerUp);
            fab.addEventListener("lostpointercapture", onPointerUp);
            fab.addEventListener("click", (event) => {
                if (fab.dataset.suppressNextClick === "true") {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    delete fab.dataset.suppressNextClick;
                }
            }, true);
        }
        injectStyles() {
            const style = document.createElement("style");
            style.textContent = `
                @import url('https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap');
                :host {
                    all: initial;
                    font-family: "Inter", sans-serif;
                }
                .qs-overlay {
                    position: fixed;
                    bottom: 24px;
                    right: 24px;
                    z-index: 2147483647;
                    filter: drop-shadow(0 8px 30px rgba(0,0,0,0.15));
                    animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
                }
                .qs-card {
                    background: white;
                    width: 380px;
                    border-radius: 16px;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    border: 1px solid rgba(0,0,0,0.08);
                    box-shadow: 0 4px 6px rgba(0,0,0,0.05);
                }
                .qs-header {
                    background-color: #0d6da0;
                    padding: 15px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    color: white;
                }
                .qs-title {
                    font-weight: 600;
                    font-size: 16px;
                    color: white;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .qs-status-badge {
                    font-size: 11px;
                    padding: 2px 8px;
                    border-radius: 12px;
                    background: white;
                    color: #0d6da0;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                .qs-close-btn {
                    background: rgba(255, 255, 255, 0.2);
                    border: none;
                    color: white;
                    cursor: pointer;
                    width: 28px;
                    height: 28px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 18px;
                    transition: all 0.2s;
                }
                .qs-close-btn:hover {
                    background: rgba(255, 255, 255, 0.3);
                    color: white;
                }
                .qs-body {
                    background: #fafafa;
                    min-height: 200px;
                    max-height: 600px;
                    overflow-y: auto;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    position: relative;
                    padding: 0;
                }
                .qs-image {
                    width: 100%;
                    height: auto;
                    display: block;
                    animation: fadeIn 0.3s ease;
                }
                
                /* Loading State */
                .qs-loading {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 12px;
                    color: #666;
                    padding: 40px;
                }
                .qs-spinner {
                    width: 24px;
                    height: 24px;
                    border: 3px solid #e0e0e0;
                    border-top-color: #0d6da0;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                }
                
                /* Error State */
                .qs-error {
                    padding: 30px;
                    text-align: center;
                    color: #d32f2f;
                }
                .qs-error-icon {
                    font-size: 32px;
                    margin-bottom: 8px;
                    display: block;
                }
                
                /* Info State */
                .qs-info {
                    padding: 30px;
                    text-align: center;
                    color: #0277bd;
                }
                .qs-info-icon {
                    font-size: 32px;
                    margin-bottom: 8px;
                    display: block;
                }
                
                /* Controls */
                .qs-controls {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    gap: 16px;
                    padding: 12px 16px;
                    background: #fff;
                    border-top: 1px solid #eee;
                    width: 100%;
                    box-sizing: border-box;
                }
                .qs-nav-btn {
                    background: rgb(13, 109, 160);
                    border: none;
                    border-radius: 50%;
                    width: 28px;
                    height: 28px;
                    padding: 0;
                    display: flex;
                    align-items: safe center;
                    justify-content: safe center;
                    cursor: pointer;
                    font-size: 20px;
                    font-weight: bold;
                    color: white;
                    transition: all 0.2s;
                    line-height: 1;
                }
                .qs-nav-btn:hover:not(:disabled) {
                    background: rgba(13, 109, 160, 0.8);
                }
                .qs-nav-btn:active:not(:disabled) {
                    background:  rgba(13, 109, 160, 0.15);
                }
                .qs-nav-btn:disabled {
                    opacity: 0.4;
                    cursor: default;
                }
                .qs-page-indicator {
                    font-size: 13px;
                    color: #555;
                    font-weight: 600;
                }

                @keyframes slideUp {
                    from { opacity: 0; transform: translateY(20px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
            `;
            this.shadowRoot.appendChild(style);
        }

        renderBase(title = "Label Preview") {
            const shadow = this.ensureHost();
            if (!shadow) return null;

            const wrapper = document.createElement("div");
            wrapper.className = "qs-overlay";
            wrapper.innerHTML = `
                <div class="qs-card">
                    <div class="qs-header">
                        <div class="qs-title">
                            <span>${title}</span>
                            <span class="qs-status-badge" id="qs-status">Processing</span>
                        </div>
                         <button id="qs-close" class="qs-close-btn" aria-label="Close">&times;</button>
                    </div>
                    <div class="qs-body" id="qs-content">
                        <!-- Content goes here -->
                    </div>
                </div>
            `;
            this.shadowRoot.appendChild(wrapper);

            this.shadowRoot.getElementById("qs-close").addEventListener("click", () => {
                document.getElementById(this.hostId).remove();
            });

            return {
                content: this.shadowRoot.getElementById("qs-content"),
                status: this.shadowRoot.getElementById("qs-status")
            };
        }

        ensureP21FabHost() {
            const fabHostId = "quick-ship-p21-fab-host";

            if (document.contentType && !["text/html", "application/xhtml+xml"].includes(document.contentType)) {
                return null;
            }

            let host = document.getElementById(fabHostId);
            if (host && host.shadowRoot) return host.shadowRoot;

            host = document.createElement("div");
            host.id = fabHostId;
            document.body.appendChild(host);

            const shadow = host.attachShadow({ mode: "open" });
            const style = document.createElement("style");
            style.textContent = `
                :host { all: initial; font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
                .qs-p21-fab {
                    position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
                    display: flex; align-items: center; gap: 8px; min-width: 172px;
                    padding: 12px 16px; border: none; border-radius: 8px;
                    background: #0d6da0; color: #fff; font-family: inherit; font-size: 13px; font-weight: 700;
                    cursor: pointer; box-shadow: 0 10px 28px rgba(0,0,0,.24);
                    transition: transform .18s ease, background .18s ease, opacity .18s ease;
                    touch-action: none;
                    user-select: none;
                }
                .qs-p21-fab:hover:not(:disabled) { background: #095c8a; transform: translateY(-1px); }
                .qs-p21-fab:disabled { cursor: wait; opacity: .72; }
                .qs-p21-fab-icon {
                    width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center;
                    background: rgba(255,255,255,.18); border-radius: 3px; font-size: 12px;
                }
                .qs-p21-fab-error { background: #c62828 !important; }
                .qs-p21-fab-ready { background: #2e7d32 !important; }
                .qs-p21-fab-retry { background: #0d6da0 !important; cursor: pointer; opacity: 1; }
                .qs-p21-toast {
                    position: fixed; right: 24px; bottom: 82px; z-index: 2147483647;
                    width: min(420px, calc(100vw - 48px)); background: #fff; color: #1f2933;
                    border: 1px solid rgba(198,40,40,.22); border-left: 5px solid #c62828;
                    border-radius: 0px; box-shadow: 0 14px 38px rgba(0,0,0,.24);
                    padding: 14px 14px 12px; font-family: inherit;
                    transform: translateY(8px); opacity: 0; pointer-events: none;
                    transition: opacity .18s ease, transform .18s ease;
                }
                .qs-p21-toast-visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
                .qs-p21-toast-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
                .qs-p21-toast-title { font-size: 18px; font-weight: 800; color: #c62828; }
                .qs-p21-toast-close { border: none; background: transparent; color: #64748b; cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 4px; }
                .qs-p21-toast-message { font-size: 14px; line-height: 1.45; color: #334155; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow-y: auto; padding-bottom: 16px; }
                .qs-p21-toast-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
                .qs-p21-toast-btn { border: 1px solid #bad7e8; background: #fff; color: #0d6da0; border-radius: 6px; padding: 6px 10px; font-size: 12px; font-weight: 700; cursor: pointer; }
                .qs-p21-toast-btn:hover { background: #eef8fd; }
            `;
            shadow.appendChild(style);
            return shadow;
        }

        ensureP21Fab() {
            const shadow = this.ensureP21FabHost();
            if (!shadow) return null;

            let fab = shadow.getElementById("qs-p21-fab");
            if (fab) {
                this.makeP21FabDraggable(fab);
                return fab;
            }

            fab = document.createElement("button");
            fab.id = "qs-p21-fab";
            fab.className = "qs-p21-fab";
            fab.type = "button";
            fab.innerHTML = `<span class="qs-p21-fab-icon">P21</span><span id="qs-p21-fab-text">Check Packing List</span>`;
            shadow.appendChild(fab);
            this.makeP21FabDraggable(fab);
            return fab;

        }

        setP21FabState(state, text) {
            const fab = this.ensureP21Fab();
            if (!fab) return null;

            const label = fab.querySelector("#qs-p21-fab-text");
            if (label) label.textContent = text || "Check Packing List";

            fab.disabled = state === "loading";
            fab.classList.remove("qs-p21-fab-error", "qs-p21-fab-ready", "qs-p21-fab-retry");
            fab.classList.toggle("qs-p21-fab-error", state === "error" || state === "notReady");
            fab.classList.toggle("qs-p21-fab-ready", state === "ready");
            fab.classList.toggle("qs-p21-fab-retry", state === "retry" || state === "idle");
            return fab;
        }

        showP21Toast(title, message, options = {}) {
            const shadow = this.ensureP21FabHost();
            if (!shadow) return;

            let toast = shadow.getElementById("qs-p21-toast");
            if (!toast) {
                toast = document.createElement("div");
                toast.id = "qs-p21-toast";
                toast.className = "qs-p21-toast";
                toast.innerHTML = `
                    <div class="qs-p21-toast-header">
                        <div class="qs-p21-toast-title" id="qs-p21-toast-title"></div>
                        <button class="qs-p21-toast-close" id="qs-p21-toast-close" type="button" aria-label="Dismiss">&times;</button>
                    </div>
                    <div class="qs-p21-toast-message" id="qs-p21-toast-message"></div>
                `;
                shadow.appendChild(toast);
                toast.querySelector("#qs-p21-toast-close").addEventListener("click", () => this.hideP21Toast());
            }

            toast.querySelector("#qs-p21-toast-title").textContent = title || "P21 Packing List Error";
            toast.querySelector("#qs-p21-toast-message").textContent = message || "An unknown error occurred.";
            toast.classList.add("qs-p21-toast-visible");

            if (this.p21ToastTimer) clearTimeout(this.p21ToastTimer);
            this.p21ToastTimer = setTimeout(() => this.hideP21Toast(), options.durationMs || 12000);
        }

        hideP21Toast() {
            const host = document.getElementById("quick-ship-p21-fab-host");
            const toast = host && host.shadowRoot ? host.shadowRoot.getElementById("qs-p21-toast") : null;
            if (toast) toast.classList.remove("qs-p21-toast-visible");
        }

        showLoading() {
            const root = this.renderBase();
            if (!root) return;
            const { content, status } = root;
            status.textContent = "Generating";
            content.innerHTML = `
                <div class="qs-loading">
                    <div class="qs-spinner"></div>
                    <span>Fetching label data...</span>
                </div>
            `;
        }

        showImage(images) {
            const content = this.shadowRoot.getElementById("qs-content");
            const status = this.shadowRoot.getElementById("qs-status");

            if (!content) return; // UI was closed

            status.textContent = "Ready";
            status.style.backgroundColor = "#e8f5e9";
            status.style.color = "#2e7d32";

            content.innerHTML = ""; // Clear previous

            if (!images || images.length === 0) return;

            // Container for the view
            const wrapper = document.createElement("div");
            wrapper.style.display = "flex";
            wrapper.style.flexDirection = "column";
            wrapper.style.width = "100%";

            // Image Area
            const imgView = document.createElement("div");
            imgView.style.width = "100%";
            imgView.style.display = "flex";
            imgView.style.justifyContent = "center";
            wrapper.appendChild(imgView);

            let currentIndex = 0;

            const renderCurrent = () => {
                const img = images[currentIndex];
                if (img.type === "application/pdf") {
                    imgView.innerHTML = `<iframe src="${img.src}" style="width:100%; height:400px; border:none;" title="Shipping Label PDF"></iframe>`;
                } else {
                    imgView.innerHTML = `<img src="${img.src}" class="qs-image" alt="Shipping Label ${currentIndex + 1}" />`;
                }
            };

            // Controls (only if multiple images)
            if (images.length > 1) {
                const controls = document.createElement("div");
                controls.className = "qs-controls";
                controls.innerHTML = `
                    <button class="qs-nav-btn" id="qs-prev" disabled>&#x1F808;</button>
                    <span class="qs-page-indicator" id="qs-indicator">1 / ${images.length}</span>
                    <button class="qs-nav-btn" id="qs-next">&#x1F80A;</button>
                `;
                wrapper.appendChild(controls);

                const prevBtn = controls.querySelector("#qs-prev");
                const nextBtn = controls.querySelector("#qs-next");
                const indicator = controls.querySelector("#qs-indicator");

                const updateControls = () => {
                    indicator.textContent = `${currentIndex + 1} / ${images.length}`;
                    prevBtn.disabled = currentIndex === 0;
                    nextBtn.disabled = currentIndex === images.length - 1;
                };

                prevBtn.onclick = () => { if (currentIndex > 0) { currentIndex--; renderCurrent(); updateControls(); } };
                nextBtn.onclick = () => { if (currentIndex < images.length - 1) { currentIndex++; renderCurrent(); updateControls(); } };
            }

            renderCurrent();
            content.appendChild(wrapper);
        }

        showInfo(msg) {
            const content = this.shadowRoot.getElementById("qs-content");
            const status = this.shadowRoot.getElementById("qs-status");

            if (!content) return;

            status.textContent = "Info";
            status.style.backgroundColor = "#e1f5fe";
            status.style.color = "#0277bd";

            content.innerHTML = `
                <div class="qs-info">
                    <div>${msg}</div>
                </div>
            `;
        }

        showError(msg) {
            const content = this.shadowRoot.getElementById("qs-content");
            const status = this.shadowRoot.getElementById("qs-status");

            if (!content) return;

            status.textContent = "Error";
            status.style.backgroundColor = "#ffebee";
            status.style.color = "#c62828";

            content.innerHTML = `
                <div class="qs-error">
                    <span class="qs-error-icon">⚠️</span>
                    <div>${msg}</div>
                </div>
            `;
        }
    }

    const ui = new LabelPreviewUI();
    let latestShipmentContext = null;
    let p21FabResetTimer = null;

    function resetP21FabAfterDelay(delayMs = 3500) {
        if (p21FabResetTimer) {
            clearTimeout(p21FabResetTimer);
        }

        p21FabResetTimer = setTimeout(() => {
            ui.setP21FabState("idle", "Check Packing List");
            p21FabResetTimer = null;
        }, delayMs);
    }

    function getLikelyErpNumberFromUrl() {
        const matches = String(window.location.href || "").match(/\d+/g);
        return matches && matches.length > 0 ? matches[matches.length - 1] : null;
    }

    function getLikelyBaseUrlFromLocation() {
        let appBase = window.location.origin;
        const path = window.location.pathname;
        if (path.toLowerCase().includes("/dist/")) {
            const splitIndex = path.toLowerCase().indexOf("/dist/");
            appBase += path.substring(0, splitIndex);
        }
        return appBase;
    }

    async function requestP21PackingListPreview() {
        ui.hideP21Toast();

        const settings = await chrome.storage.local.get("isPaused");
        if (settings.isPaused) {
            ui.setP21FabState("retry", "Try Again");
            ui.showP21Toast("Extension Paused", "Resume label generation to preview the P21 packing list.", { onRetry: requestP21PackingListPreview });
            return;
        }

        const context = latestShipmentContext || {};
        const shipmentNumber = context.shipmentNumber || context.packID || getLikelyErpNumberFromUrl();
        const baseUrl = context.baseUrl || getLikelyBaseUrlFromLocation();

        if (!shipmentNumber) {
            ui.setP21FabState("retry", "Try Again");
            ui.showP21Toast("Missing Shipment Number", "Unable to determine a Quick Ship shipment number from this page. Try refreshing the page, then click Try Again.", { onRetry: requestP21PackingListPreview });
            return;
        }

        ui.setP21FabState("loading", "Checking...");

        chrome.runtime.sendMessage({
            type: "previewP21PackingList",
            shipmentNumber,
            erpNumber: context.erpNumber,
            baseUrl,
            authHeaders: context.authHeaders || {}
        }, () => {
            if (chrome.runtime.lastError) {
                const message = chrome.runtime.lastError.message || "Failed to request P21 packing list preview.";
                console.error("[Quick Ship] P21 FAB message failed:", message);
                ui.setP21FabState("retry", "Try Again");
                ui.showP21Toast("P21 Preview Request Failed", message, { onRetry: requestP21PackingListPreview });
            }
        });
    }

    function attachP21FabHandler() {
        const fab = ui.setP21FabState("idle", "Check Packing List");
        if (!fab || fab.dataset.bound === "true") return;
        fab.dataset.bound = "true";
        fab.addEventListener("click", requestP21PackingListPreview);
    }
    attachP21FabHandler();

    // Event Listeners

    // Listen for shipment number for P21 Context
    window.addEventListener("qs_shipment_context_found", (e) => {
        const { packID, shipmentNumber, baseUrl, authHeaders, erpSystem, erpNumber } = e.detail || {};
        latestShipmentContext = {
            packID,
            shipmentNumber: shipmentNumber || packID,
            baseUrl,
            authHeaders,
            erpSystem,
            erpNumber: erpNumber || null
        };
        attachP21FabHandler();
        console.log("[Quick Ship] Shipment context updated without preview workflow:", latestShipmentContext);
    });


    // Listen for PackID detection from Injected Script
    window.addEventListener("label_packid_found", async (e) => {
        const { packID, shipmentNumber, baseUrl, authHeaders, erpSystem, erpNumber } = e.detail;

        latestShipmentContext = {
            packID,
            shipmentNumber: shipmentNumber || packID,
            baseUrl,
            authHeaders,
            erpSystem,
            erpNumber: erpNumber || null
        };
        attachP21FabHandler();

        // Check if extension is paused
        const settings = await chrome.storage.local.get("isPaused");
        if (settings.isPaused) {
            console.log("[Quick Ship] Extension is paused. Ignoring PackID:", packID);
            return;
        }

        console.log("[Quick Ship] PackID detected:", packID, "on base URL:", baseUrl);

        // Show loading state immediately
        ui.showLoading();

        // Inform background script to start fetching
        try {
            console.log("[Quick Ship] Sending message to background script", packID, baseUrl);
            chrome.runtime.sendMessage({
                type: "packID",
                packID: packID,
                baseUrl: baseUrl,
                authHeaders: authHeaders
            });
            console.log("[Quick Ship] Message sent to background script");
        } catch (err) {
            console.error("[Quick Ship] Message failed:", err);
            ui.showError("Connection lost. Please refresh the page.");
        }
    });

    // Listen for responses from Background Script
    try {
        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            if (msg.type === "startLoading") {
                // Check if we can render UI
                if (document.contentType && !["text/html", "application/xhtml+xml"].includes(document.contentType)) {
                    // Cannot render on XML/Text
                    sendResponse({ success: false, reason: "invalid_content_type" });
                    return;
                }
                ui.showLoading();
                sendResponse({ success: true });
                return;
            } else if (msg.type === "p21PreviewResult") {
                if (msg.success) {
                    ui.hideP21Toast();
                    ui.setP21FabState("ready", "Opened");
                    setTimeout(() => ui.setP21FabState("idle", "Check Packing List"), 1800);
                } else {
                    const message = msg.error || "Failed to preview the P21 packing list.";
                    const title = msg.title || "P21 Packing List Error";
                    const state = msg.category === "not_ready" ? "notReady" : "retry";
                    const buttonText = msg.category === "not_ready" ? "Error" : "Try Again";
                    ui.setP21FabState(state, buttonText);
                    resetP21FabAfterDelay(7500);
                    ui.showP21Toast(title, message, { onRetry: requestP21PackingListPreview });
                }
            } else if (msg.type === "labelPreview") {
                try {
                    if (msg.success) {
                        ui.showImage(msg.images);
                    } else if (msg.isNoData) {
                        // Show informative message for empty clipboard/selection
                        ui.showInfo(msg.error);
                    } else {
                        console.error("[Quick Ship] Label Generation Error:", msg.error);
                        ui.showError(msg.error || "Failed to generate label.");
                    }
                } catch (e) {
                    console.error("[Quick Ship] UI Error:", e);
                    ui.showError("An error occurred while displaying the result.");
                }
            }
        });
    } catch (err) {
        console.warn("[Quick Ship] Could not attach listener (context invalidated).");
    }

})();