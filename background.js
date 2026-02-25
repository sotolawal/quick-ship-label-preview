console.log("Background service worker loaded!");
importScripts("utils.js");

chrome.runtime.onStartup.addListener(() => {
    console.log("Service worker started (onStartup)");
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("Service worker installed (onInstalled)");
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
                        else if (isAusPost) {
                                    // Australia Post Way: Look for "Label Image" in the packID file content
                                    const ausMatch = packIdMatches.find(f => f.fileName && f.fileName.toLowerCase().includes("createlabelresponse"));
                                    if (!ausMatch) match = packIdMatches[0];

                                    if (ausMatch) {
                                        targetUrl = ausMatch.url;
                                        console.log(`Detected Australia Post. Using packID file URL: ${targetUrl}`);
                                    }       
                        }
                            } catch (e) {
                                console.warn("Failed to fetch Canada Post artifact info", e);
                            }
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

        // Use helper from utils.js
        const extracted = extractLabelData(fileContent);
        if (!extracted) {
            throw new Error("No recognized label image tag found in the XML response.");
        }
        
        const { data: rawData, format } = extracted;
        const dataList = Array.isArray(rawData) ? rawData : [rawData];
        const processedImages = [];

        for (const base64 of dataList) {
            let isPdf = false;
            try {
                const decodedHeader = atob(base64.substring(0, 50));
                if (decodedHeader.startsWith("%PDF")) {
                    isPdf = true;
                }
            } catch (e) { /* ignore */ }

            if (isPdf) {
                processedImages.push({
                    src: `data:application/pdf;base64,${base64}`,
                    type: "application/pdf"
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
                    signal
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
            packID: packID,
            website: website,
            timestamp: Date.now(),
            images: processedImages.map(img => img.src) // Store all images
        });

        if (!signal.aborted) {
            chrome.tabs.sendMessage(tabId, {
                type: "labelPreview",
                success: true,
                images: processedImages
            });
        }

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
