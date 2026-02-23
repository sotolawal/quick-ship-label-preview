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
        await handlePackID(msg.packID, msg.baseUrl, sender.tab.id, msg.authHeaders, msg.cloudTokens, msg.storageAccount);
        console.log("[Quick Ship] PackID message processed:", msg.packID, "Storage Account Detected:", !!msg.storageAccount);
    }
});

const activeRequests = new Map();

const CLOUD_REQUIRED_KEYS = [
     "sv", "se", "sr", "sp", "sig"
];

function buildCloudQueryString(rawQuery) {
    if (!rawQuery) return ""; // On-Premise or no tokens found

    if (CLOUD_REQUIRED_KEYS.length === 0) {
        console.warn("[Quick Ship] Cloud tokens detected but CLOUD_REQUIRED_KEYS is empty. Cloud fetch may fail.");
        return "";
    }
    
    const sourceParams = new URLSearchParams(rawQuery);
    const targetParams = new URLSearchParams();
    
    CLOUD_REQUIRED_KEYS.forEach(key => {
        if (sourceParams.has(key)) {
            targetParams.append(key, sourceParams.get(key));
        }
    });
    
    return targetParams.toString();
}

function appendQueryToUrl(urlStr, queryString) {
    if (!queryString) return urlStr;
    const url = new URL(urlStr);
    const params = new URLSearchParams(queryString);
    params.forEach((val, key) => url.searchParams.append(key, val));
    return url.toString();
}

async function handlePackID(packID, baseUrl, tabId, authHeaders, cloudTokens, storageAccount) {
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

        // Generate the reordered query string for Cloud
        const cloudQuery = buildCloudQueryString(cloudTokens);

        // Determine URLs based on Environment (Cloud vs On-Prem)
        if (storageAccount && cloudQuery) {
            // --- CLOUD STRATEGY ---
            console.log("[Quick Ship] Detected Cloud Environment. Constructing Azure Blob URLs...");
            
            // Extract Registration Code from headers (case-insensitive check)
            const regCodeKey = Object.keys(authHeaders).find(k => k.toLowerCase() === 'registrationcode');
            const regCode = regCodeKey ? authHeaders[regCodeKey] : null;

            if (!regCode) {
                throw new Error("Cloud environment detected, but RegistrationCode is missing from headers.");
            }

            // Construct Base Blob URL: https://{storageAccount}.blob.core.windows.net/demo-artifacts/{registrationCode}_CarrierXML/
            const blobBase = `https://${storageAccount}.blob.core.windows.net/demo-artifacts/${regCode}_CarrierXML`;
            
            // Cloud Fallbacks
            targetUrl = null; // No API resolution for direct blob storage usually
            // Note: We append the cloudQuery (SAS token) to the end
            urlDouble = `${blobBase}/UPS_APIShipReply__${packID}.xml?${cloudQuery}`;
            urlSingle = `${blobBase}/UPS_APIShipReply_${packID}.xml?${cloudQuery}`;

        } else {
            // --- ON-PREMISE STRATEGY ---
            
            // Strategy 1: Attempt to resolve exact URL via API
            try {
                console.log("Attempting to resolve XML via /api/downloads/getCarrierXMLs...");
                const fetchOptions = { headers: authHeaders || {}, signal };
                const listApiUrl = appendQueryToUrl(`${cleanBase}/api/downloads/getCarrierXMLs`, cloudQuery);
                const listResponse = await fetch(listApiUrl, fetchOptions);
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
                                let safeName = match.fileName.replace(/\\/g, "/");
                                
                                // If the API returns a full path starting with CarrierXmlFile, respect it, otherwise prepend it.
                                if (!safeName.toLowerCase().includes("carrierxmlfile")) {
                                    safeName = `CarrierXmlFile/${safeName}`;
                                }
                                
                                const sep = safeName.startsWith("/") ? "" : "/";
                                targetUrl = appendQueryToUrl(`${cleanBase}${sep}${safeName}`, cloudQuery);
                                console.log(`Resolved XML URL via API: ${targetUrl}`);
                            }
                        }
                    }
                }
            } catch (e) {
                if (signal.aborted) throw e;
                console.warn("API resolution failed, falling back to pattern matching:", e);
            }

            // Strategy 2: Use expected URLs as a fallback (On-Prem)
            urlDouble = appendQueryToUrl(`${cleanBase}/CarrierXmlFile/UPS_APIShipReply__${packID}.xml`, cloudQuery);
            urlSingle = appendQueryToUrl(`${cleanBase}/CarrierXmlFile/UPS_APIShipReply_${packID}.xml`, cloudQuery);
        }
        
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
