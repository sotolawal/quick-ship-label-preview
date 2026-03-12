console.log("Background service worker loaded!");
importScripts("utils.js");

chrome.runtime.onStartup.addListener(() => {
    console.log("Service worker started (onStartup)");
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("Service worker installed (onInstalled)");
    
    chrome.contextMenus.create({
        id: "qs-preview-label",
        title: "Preview Label",
        contexts: ["selection"]
    });
});

// Keep the worker alive every 20 seconds
chrome.alarms.create("keepAlive", { periodInMinutes: 0.3 });

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepAlive") {
        console.log("KeepAlive ping");
    }
});

//Check if PackID message is sucessfully received
chrome.runtime.onMessage.addListener(async (msg, sender) => {
    if (msg.type === "packID") {
        // Check if paused
        const settings = await chrome.storage.local.get("isPaused");
        if (settings.isPaused) {
            console.log("[Quick Ship] Processing skipped (Paused):", msg.packID);
            return;
        }

        await handlePackID(msg.packID, msg.baseUrl, sender.tab.id, msg.authHeaders);
        console.log("[Quick Ship] PackID message processed:", msg.packID);
    } else if (msg.type === "analyzeText") {
        // Handle clipboard content
        let tabId = sender.tab ? sender.tab.id : null;
        let url = sender.tab ? sender.tab.url : "Popup";

        // If request came from Popup (no sender tab), try to target the active tab
        if (!tabId) {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs.length > 0) {
                // Check if we can inject into this tab by trying to send the loading signal
                const canInject = await sendToTabSafe(tabs[0].id, { type: "startLoading" });
                if (canInject) {
                    tabId = tabs[0].id;
                    url = tabs[0].url;
                }
            }
        }

        // Attempt to decode if it looks like URL-encoded content (common when copying from Network tab)
        let text = msg.text;
        try {
            if (text && text.includes("%")) {
                text = decodeURIComponent(text);
            }
        } catch (e) { /* ignore */ }

        await processLabelContent(text, tabId, "Clipboard", url);
    }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "qs-preview-label" && info.selectionText) {
        // Handle context menu selection
        const canRender = await sendToTabSafe(tab.id, { type: "startLoading" });
        
        // If the tab cannot render (e.g. XML file), pass null for tabId so processLabelContent
        // knows to fallback to opening a new tab.
        const targetTabId = canRender ? tab.id : null;
        
        await processLabelContent(info.selectionText, targetTabId, "Selection", tab.url);
    }
});

const activeRequests = new Map();

async function handlePackID(packID, baseUrl, tabId, authHeaders) {
    // Cancel any existing request for this tab
    if (activeRequests.has(tabId)) {
        const active = activeRequests.get(tabId);
        // If the same packID is already being processed, ignore this duplicate request
        if (active.packID === packID && !active.controller.signal.aborted) {
            console.log(`[Quick Ship] Request for packID ${packID} already in progress. Ignoring duplicate.`);
            return;
        }

        console.log(`[Quick Ship] Aborting previous request for tab ${tabId}`);
        active.controller.abort();
    }

    const controller = new AbortController();
    activeRequests.set(tabId, { controller, packID });
    const signal = controller.signal;

    const sendError = (errMsg) => {
        // Only send error if not aborted
        if (signal.aborted) return;
        chrome.tabs.sendMessage(tabId, {
            type: "labelPreview",
            success: false,
            error: errMsg
        });
    };

    try {
        // Cleanly construct URL using the dynamic base URL provided by the content script
        const cleanBase = baseUrl.replace(/\/$/, ""); 
        let targetUrl = null;

        // Strategy 1: Attempt to resolve exact URL via API
        try {
            console.log("Attempting to resolve XML via /api/downloads/getCarrierXMLs...");
            const fetchOptions = { headers: authHeaders || {}, signal };
            const listResponse = await fetch(`${cleanBase}/api/downloads/getCarrierXMLs`, fetchOptions);
            if (listResponse.ok) {
                const responseData = await listResponse.json();
                
                // Handle nested result array: { result: [...] }
                const files = (responseData && Array.isArray(responseData.result)) ? responseData.result : responseData;

                if (Array.isArray(files)) {
                    // Filter for files containing the packID to identify carrier
                    const packIdMatches = files.filter(f => f.fileName && f.fileName.includes(packID));

                    if (packIdMatches.length === 0) {
                        sendError("Failed to preview label. File not found.");
                        return;
                    }

                    // Check if any of the packID matches indicate Loomis
                    const isLoomis = packIdMatches.some(f => f.fileName.toLowerCase().includes("loomis"));
                    const isCanadaPost = packIdMatches.some(f => f.fileName.toLowerCase().includes("canadapost"));
                    const isAusPost = packIdMatches.some(f => f.fileName.toLowerCase().includes("auspost"));

                    if (isLoomis) {
                        // Loomis Way: Find the v2rs file
                        const loomisMatch = files.find(f => f.fileName && f.fileName.toLowerCase().includes("v2rs"));
                        if (loomisMatch) {
                            targetUrl = loomisMatch.url;
                            console.log(`Detected Loomis carrier via PackID. Resolved URL: ${targetUrl}`);
                        }
                    } else if (isCanadaPost) {
                        // Canada Post Way: Find artifact ID in the packID file, then find the artifact file
                        let match = packIdMatches.find(f => f.fileName.toLowerCase().includes("createshipmentresponse"));
                        if (!match) match = packIdMatches[0];

                        if (match) {
                            try {
                                const cpResp = await fetch(match.url, { signal });
                                if (cpResp.ok) {
                                    const cpText = await cpResp.text();
                                    const artifactMatch = cpText.match(/<artifact-id>(.*?)<\/artifact-id>/);
                                    if (artifactMatch && artifactMatch[1]) {
                                        const artifactID = artifactMatch[1];
                                        const fileWithLabel = files.find(f => f.fileName.includes("getArtifactResponse") && f.fileName.includes(artifactID));
                                        if (fileWithLabel) {
                                            targetUrl = fileWithLabel.url;
                                            console.log(`Detected Canada Post. Resolved URL via Artifact ID: ${targetUrl}`);
                                        }
                                    }
                                }
                            } catch (e) {
                                console.warn("Failed to fetch Canada Post artifact info", e);
                            }
                        }
                    } else if (isAusPost) {
                        // Australia Post Way: Look for "Label Image" in the packID file content
                        const ausMatch = packIdMatches.find(f => f.fileName && f.fileName.toLowerCase().includes("createlabelresponse"));
                        if (ausMatch) {
                            targetUrl = ausMatch.url;
                            console.log(`Detected Australia Post. Using packID file URL: ${targetUrl}`);
                        }
                    } else if (packIdMatches.length > 0) {
                        // Standard Check: Use the matches found
                        // Prioritize file containing "Reply" if multiple matches exist
                        let match = packIdMatches.find(f => f.fileName.toLowerCase().includes("reply") || f.fileName.toLowerCase().includes("response"));
                        
                        // Fallback to the first match if no "Reply" file is found
                        if (!match) {
                            match = packIdMatches[0];
                        }

                        if (match && match.url) {
                            targetUrl = match.url;
                            console.log(`Resolved XML URL via API: ${targetUrl}`);
                        }
                    }
                }
            }
        } catch (e) {
            if (signal.aborted) throw e;
            console.warn("API resolution failed", e);
        }

        // Good error handling, commenting out but saving for later
        //if (!targetUrl) {
        //    console.log(`API resolution failed.`);
        //}

        // Retry logic for XML fetch (up to 1 minute)
        let fileResponse;
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");

            if (targetUrl) {
                // Strategy 1: Fetch resolved URL
                try {
                    const resp = await fetch(targetUrl, { signal });
                    if (resp.ok) {
                        fileResponse = resp;
                        break;
                    }
                } catch (e) { if (signal.aborted) throw e; }
            } 
            
            attempts++;
            if (attempts < maxAttempts) {
                // Silent wait, abortable
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        signal.removeEventListener('abort', onAbort);
                        resolve();
                    }, 2000);
                    const onAbort = () => {
                        clearTimeout(timer);
                        signal.removeEventListener('abort', onAbort);
                        reject(new DOMException("Aborted", "AbortError"));
                    };
                    signal.addEventListener('abort', onAbort);
                });
            }
        }

        if (!fileResponse || !fileResponse.ok) {
            if (fileResponse && fileResponse.status === '') {
                throw new Error("No data found for this carrier.");
            }
            throw new Error(`Failed to preview label. ${fileResponse ? fileResponse.status : 'Error'}.`);
        }

        const fileContent = await fileResponse.text();

        // Delegate processing to shared function
        await processLabelContent(fileContent, tabId, packID, baseUrl, signal);

    } catch (err) {
        if (signal.aborted || err.name === 'AbortError') {
            console.log(`[Quick Ship] Request aborted for packID: ${packID}`);
        } else {
            console.error("Background processing error:", err);
            sendError(err.message || "Unknown error occurred during processing.");
        }
    } finally {
        // Cleanup: remove from activeRequests if it's still this controller
        const active = activeRequests.get(tabId);
        if (active && active.controller === controller) {
            activeRequests.delete(tabId);
        }
    }
}

/**
 * Shared logic to extract, convert, and display label data from raw text/xml/json.
 */
async function processLabelContent(fileContent, tabId, historyLabel, baseUrl, signal = null) {
    try {
        // Use helper from utils.js to find base64 data
        const extracted = extractLabelData(fileContent);
        if (!extracted) {
            if (historyLabel === "Clipboard" || historyLabel === "Selection") {
                throw new Error("No valid data found in the copied text. Please check your highlight and try again.");
            }
            throw new Error("No recognized label image tag found in the XML response.");
        }
        
        const { data: rawData, format } = extracted;
        const dataList = Array.isArray(rawData) ? rawData : [rawData];
        const processedImages = [];

        for (const base64 of dataList) {
            let isPdf = false;
            let isPng = false;
            let isJpg = false;
            let isGif = false;

            try {
                const b64Prefix = base64.trim().substring(0, 30);
                if (b64Prefix.startsWith("JVBER")) isPdf = true;
                else if (b64Prefix.startsWith("iVBORw0KGgo")) isPng = true;
                else if (b64Prefix.startsWith("/9j/")) isJpg = true;
                else if (b64Prefix.startsWith("R0lGODlh")) isGif = true;
                else {
                    const decodedHeader = atob(base64.substring(0, 50));
                    if (decodedHeader.includes("%PDF")) {
                        isPdf = true;
                    }
                }
            } catch (e) { /* ignore */ }

            if (isPdf) {
                processedImages.push({
                    src: `data:application/pdf;base64,${base64}`,
                    type: "application/pdf"
                });
            } else if (isPng) {
                processedImages.push({
                    src: `data:image/png;base64,${base64}`,
                    type: "image/png"
                });
            } else if (isJpg) {
                processedImages.push({
                    src: `data:image/jpeg;base64,${base64}`,
                    type: "image/jpeg"
                });
            } else if (isGif) {
                processedImages.push({
                    src: `data:image/gif;base64,${base64}`,
                    type: "image/gif"
                });
            } else {
                // Assume ZPL
                let zpl = "";
                try {
                    zpl = atob(base64);
                } catch (err) {
                    console.warn("Failed to decode base64 label data", err);
                    continue;
                }

                zpl = zpl.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\0/g, "").trim();
                if (!zpl) continue;
                
                // Verify if it's likely valid ZPL before hitting the Labelary API
                // Most ZPL labels start with ^XA, but allow for some flexibility
                if (!zpl.includes("^XA") && !zpl.includes("^xa")) {
                    console.warn("Skipping Labelary request: Decoded data does not appear to be valid ZPL (missing ^XA command).", zpl.substring(0, 100));
                    continue;
                }

                const labelaryHeaders = {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "image/png"
                };
                
                switch(format) {
                    case "UPS": labelaryHeaders["X-Rotation"] = "180"; break;
                    case "Loomis": labelaryHeaders["X-Rotation"] = "90"; break;
                    case "Canpar": labelaryHeaders["X-Rotation"] = "180"; break;
                }
            
                const labelaryResp = await fetch("https://api.labelary.com/v1/printers/8dpmm/labels/4x6/0", {
                    method: "POST",
                    headers: labelaryHeaders,
                    body: zpl,
                    signal: signal || undefined
                });

                if (labelaryResp.ok) {
                    const pngBlob = await labelaryResp.blob();
                    const b64png = await blobToBase64(pngBlob);
                    processedImages.push({
                        src: b64png,
                        type: "image/png"
                    });
                } else {
                    console.warn("Labelary failed for one label", await labelaryResp.text());
                }
            }
        }

        if (processedImages.length === 0) {
            // If we came from clipboard/selection and found "something" that turned out to be invalid,
            // treat it as "No Data" rather than a processing error.
             if (historyLabel === "Clipboard" || historyLabel === "Selection") {
                 throw new Error("No valid label data found in the copied text. Please check your highlight and try again.");
            }
            throw new Error("Failed to process any valid labels.");
        }

        // Extract hostname for history
        let website = "";
        try {
            website = new URL(baseUrl).hostname;
        } catch (e) {
            website = baseUrl;
        }

        // Save to History
        await saveToHistory({
            packID: historyLabel,
            website: website,
            timestamp: Date.now(),
            images: processedImages.map(img => img.src) // Store all images
        });

        if (!signal || !signal.aborted) {
            const payload = {
                type: "labelPreview",
                success: true,
                images: processedImages
            };

            if (baseUrl === "Popup") {
                // If request came from Popup, always send back to runtime to resolve popup UI state
                chrome.runtime.sendMessage(payload);
            }
            if (tabId) {
                chrome.tabs.sendMessage(tabId, payload);
            } else if (baseUrl !== "Popup") {
                // If no target tab and not from Popup (e.g. XML page context menu), 
                // open result in a new tab directly.
                await openViewerTab(processedImages);
            }
        }
    } catch (err) {
        // If signal exists and is aborted, suppress error
        if (signal && (signal.aborted || err.name === 'AbortError')) return;
        
        const isNoData = err.message === "No valid label data found in the copied text. Please check your highlight and try again." || err.message === "Error: No data found.";

        // Send error to tab
        const errorPayload = {
            type: "labelPreview",
            success: false,
            error: err.message || "Failed to process label data.",
            isNoData: isNoData
        };

        if (baseUrl === "Popup") {
            chrome.runtime.sendMessage(errorPayload);
        }
        if (tabId) {
            chrome.tabs.sendMessage(tabId, errorPayload);
        }
    }
}

async function openViewerTab(images) {
    // Construct HTML for the viewer
    const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Label Preview</title>
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap');
                body { font-family: "Inter", sans-serif; background: #eff3f6; margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 40px; }
                .label-card { background: white; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); border-radius: 8px; max-width: 95vw; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; }
                .header { width: 100%; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #eee; padding-bottom: 10px; }
                .page-num { color: #008aa9; font-size: 18px; font-weight: bold; }
                .btn { background: #0d6da0; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; transition: background 0.2s; }
                .btn:hover { background: #095c8a; }
                .img-container { overflow: hidden; display: flex; justify-content: center; align-items: center; padding: 10px; }
                img, iframe { max-width: 100%; transition: transform 0.3s ease; }
                iframe { width: 90vw; height: 90vh; border: none; }
            </style>
            <script>
                function rotate(id) {
                    const el = document.getElementById(id);
                    let current = parseInt(el.getAttribute('data-rotation') || '0');
                    current = (current + 90) % 360;
                    el.style.transform = 'rotate(' + current + 'deg)';
                    el.setAttribute('data-rotation', current);
                }
            </script>
        </head>
        <body>
            ${images.map((img, idx) => {
                const src = img.src || img; 
                const isPdf = src.includes("application/pdf");
                return `
                <div class="label-card">
                    <div class="header">
                        <div class="page-num">Label ${idx + 1}</div>
                        <button class="btn" onclick="rotate('media-${idx}')">Rotate &#x27F3;</buton>
                    </div>
                    <div class="img-container">
                        ${isPdf ? 
                            `<iframe id="media-${idx}" src="${src}"></iframe>` : 
                            `<img id="media-${idx}" src="${src}" />`
                        }
                    </div>
                </div>`;
            }).join('')}
        </body>
        </html>
    `;

    // Encode as data URL
    const dataUrl = `data:text/html;base64,${btoa(unescape(encodeURIComponent(htmlContent)))}`;
    
    await chrome.tabs.create({ url: dataUrl });
}

/**
 * Helper to safely send a message to a tab. Returns true if successful, false otherwise.
 * Used to determine if a tab has the content script active.
 */
async function sendToTabSafe(tabId, message) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        // Check if content script explicitly accepted the task
        return response && response.success;
    } catch (e) {
        return false;
    }
}

async function saveToHistory(item) {
    try {
        const result = await chrome.storage.local.get("labelHistory");
        let history = result.labelHistory || [];
        
        // Remove duplicates if any (based on packID)
        history = history.filter(h => h.packID !== item.packID);
        
        // Add new item to the top
        history.unshift(item);
        
        // Limit to last 20 items
        if (history.length > 20) {
            history = history.slice(0, 20);
        }
        
        await chrome.storage.local.set({ labelHistory: history });
    } catch (e) {
        console.error("Failed to save history:", e);
    }
}
