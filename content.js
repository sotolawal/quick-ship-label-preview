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
            this.ensureHost();
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
            const { content, status } = this.renderBase();
            status.textContent = "Generating";
            content.innerHTML = `
                <div class="qs-loading">
                    <div class="qs-spinner"></div>
                    <span>Fetching label data...</span>
                </div>
            `;
        }

        showImage(base64Png) {
            const content = this.shadowRoot.getElementById("qs-content");
            const status = this.shadowRoot.getElementById("qs-status");
            
            if (!content) return; // UI was closed

            status.textContent = "Ready";
            status.style.backgroundColor = "#e8f5e9";
            status.style.color = "#2e7d32";

            const src = base64Png.startsWith("data:") ? base64Png : `data:image/png;base64,${base64Png}`;
            content.innerHTML = `<img src="${src}" class="qs-image" alt="Shipping Label" />`;
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
    window.addEventListener("label_packid_found", (e) => {
        const { packID, baseUrl, authHeaders, cloudTokens, storageAccount } = e.detail;
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
                authHeaders: authHeaders,
                cloudTokens: cloudTokens,
                storageAccount: storageAccount
            });
            console.log("[Quick Ship] Message sent to background script");
        } catch (err) {
            console.error("[Quick Ship] Message failed:", err);
            ui.showError("Connection lost. Please refresh the page.");
        }
    });

    // Listen for responses from Background Script
    try {
        chrome.runtime.onMessage.addListener((msg) => {
            if (msg.type === "labelPreview") {
                if (msg.success) {
                    ui.showImage(msg.png);
                } else {
                    console.error("[Quick Ship] Label Generation Error:", msg.error);
                    ui.showError(msg.error || "Failed to generate label.");
                }
            }
        });
    } catch (err) {
        console.warn("[Quick Ship] Could not attach listener (context invalidated).");
    }

})();