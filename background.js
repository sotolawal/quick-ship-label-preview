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
        await handlePackID(msg.packID, msg.baseUrl, sender.tab.id, msg.authHeaders);
        console.log("[Quick Ship] PackID message processed:", msg.packID);
    }
});

const activeRequests = new Map();

async function handlePackID(packID, baseUrl, tabId, authHeaders) {
    // Cancel any existing request for this tab
    if (activeRequests.has(tabId)) {
        console.log(`[Quick Ship] Aborting previous request for tab ${tabId}`);
        activeRequests.get(tabId).abort();
    }

    const controller = new AbortController();
    activeRequests.set(tabId, controller);
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
                    // Filter for files containing the packID
                    const matches = files.filter(f => f.fileName && f.fileName.includes(packID));
                    
                    if (matches.length > 0) {
                        // Prioritize file containing "Reply" if multiple matches exist
                        let match = matches.find(f => f.fileName.toLowerCase().includes("reply") || f.fileName.toLowerCase().includes("response"));
                        
                        // Fallback to the first match if no "Reply" file is found
                        if (!match) {
                            match = matches[0];
                        }

                        if (match) {
                            // Normalize backslashes to slashes and ensure proper joining
                            // Typically match.fileName is just the filename (e.g. "UPS_Reply_123.xml")
                            // But if it contains a path, we strip it to be safe or handle it.
                            // Assuming match.fileName is just the filename or partial path.
                            
                            let safeName = match.fileName.replace(/\\/g, "/");
                            
                            // If the API returns a full path starting with CarrierXmlFile, respect it, otherwise prepend it.
                            if (!safeName.toLowerCase().includes("carrierxmlfile")) {
                                safeName = `CarrierXmlFile/${safeName}`;
                            }
                            
                            const sep = safeName.startsWith("/") ? "" : "/";
                            targetUrl = `${cleanBase}${sep}${safeName}`;
                            console.log(`Resolved XML URL via API: ${targetUrl}`);
                        }
                    }
                }
            }
        } catch (e) {
            if (signal.aborted) throw e;
            console.warn("API resolution failed, falling back to pattern matching:", e);
        }

        // Strategy 2: Use expected URLs as a fallback
        const urlDouble = `${cleanBase}/CarrierXmlFile/UPS_APIShipReply__${packID}.xml`;
        const urlSingle = `${cleanBase}/CarrierXmlFile/UPS_APIShipReply_${packID}.xml`;
        
        // Good error handling, commenting out but saving for later
        //if (!targetUrl) {
        //    console.log(`API resolution skipped/failed. Will attempt pattern match: ${urlDouble} OR ${urlSingle}`);
        //}

        // Retry logic for XML fetch (up to 1 minute)
        let xmlResponse;
        let attempts = 0;
        const maxAttempts = 30;

        while (attempts < maxAttempts) {
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");

            if (targetUrl) {
                // Strategy 1: Fetch resolved URL
                try {
                    const resp = await fetch(targetUrl, { signal });
                    if (resp.ok) {
                        xmlResponse = resp;
                        break;
                    }
                } catch (e) { if (signal.aborted) throw e; }
            } else {
                // Strategy 2: Guess patterns
                try {
                    const resp1 = await fetch(urlDouble, { signal });
                    if (resp1.ok) {
                        xmlResponse = resp1;
                        console.log(`Found XML at: ${urlDouble}`);
                        break; 
                    }
                } catch (e) { if (signal.aborted) throw e; }

                // If not found, try single underscore
                try {
                    const resp2 = await fetch(urlSingle, { signal });
                    if (resp2.ok) {
                        xmlResponse = resp2;
                        console.log(`Found XML at: ${urlSingle}`);
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

        if (!xmlResponse || !xmlResponse.ok) {
            throw new Error(`Failed to fetch XML with status code ${xmlResponse ? xmlResponse.status : 'Network Error'}). \r\n Is GenerateXMLFiles set to true?`);
        }

        const xml = await xmlResponse.text();

        // Use helper from utils.js
        const extracted = extractLabelData(xml);
        if (!extracted) {
            throw new Error("No recognized label image tag found in the XML response.");
        }
        
        const { data: base64, format } = extracted;

        let zpl = "";
        try {
            zpl = atob(base64);
        } catch (err) {
            throw new Error("Failed to decode base64 label data.");
        }

        // Clean ZPL for Labelary
        zpl = zpl.replace(/\r\n/g, "\n")
                 .replace(/\r/g, "\n")
                 .replace(/\0/g, "")
                 .trim();

        if (!zpl) {
            throw new Error("Decoded ZPL data is empty.");
        }

        // Good error handling, commented out to reduce console noise
        // console.log(`Sending ZPL to Labelary (${zpl.length} bytes)...`);
        
        // Prepare headers
        const labelaryHeaders = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "image/png"
        };
        
        // Only apply rotation for UPS
        if (format === "UPS") {
            labelaryHeaders["X-Rotation"] = "180";
        }

        // Use the correct endpoint with index /0
        // Use application/x-www-form-urlencoded as per docs for raw body
        const labelaryResp = await fetch("https://api.labelary.com/v1/printers/8dpmm/labels/4x6/0", {
            method: "POST",
            headers: labelaryHeaders,
            body: zpl,
            signal
        });

        if (!labelaryResp.ok) {
            const errorText = await labelaryResp.text();
            console.error("Labelary API Response:", errorText);
            throw new Error(`Labelary API Error (${labelaryResp.status}): ${errorText || labelaryResp.statusText}`);
        }

        const pngBlob = await labelaryResp.blob();
        const b64png = await blobToBase64(pngBlob);

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
            png: b64png
        });

        if (!signal.aborted) {
            chrome.tabs.sendMessage(tabId, {
                type: "labelPreview",
                success: true,
                png: b64png
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
        if (activeRequests.get(tabId) === controller) {
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
