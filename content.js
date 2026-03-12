(function () {
    // Orphaned Script Detection
    // If the extension context is invalid (e.g., after extension reload), stop execution.
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
            // Prevent injection into non-HTML documents (XML, Text, etc.) to avoid corrupting the file view
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

    // Event Listeners

    // Listen for PackID detection from Injected Script
    window.addEventListener("label_packid_found", async (e) => {
        const { packID, baseUrl, authHeaders } = e.detail;
        
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