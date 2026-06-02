console.log("Background service worker loaded!");
importScripts("utils.js");

chrome.runtime.onStartup.addListener(() => {
    console.log("Service worker started (onStartup)");
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("Service worker installed (onInstalled)");

    chrome.contextMenus.create({
        id: "qs-preview-label",
        title: "Preview",
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
    } else if (msg.type === "openViewer") {
        await openViewerTab(msg.images || [], msg.metadata || {});
    } else if (msg.type === "previewP21PackingList") {
        const tabId = sender.tab ? sender.tab.id : null;
        await handleP21PackingListPreview({
            shipmentLookupNumber: msg.shipmentNumber || msg.quickShipShipmentNumber || msg.erpNumber,
            baseUrl: msg.baseUrl,
            authHeaders: msg.authHeaders || {},
            tabId
        });
    }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "qs-preview-label" && info.selectionText) {
        // Handle context menu selection
        const canRender = await sendToTabSafe(tab.id, { type: "startLoading" });
        const targetTabId = canRender ? tab.id : null;

        await processLabelContent(info.selectionText, targetTabId, "Selection", tab.url);
    }
});

const activeRequests = new Map();

function getFileTime(file) {
    const parsed = file && file.fileDate
        ? new Date(file.fileDate).getTime()
        : NaN;

    return Number.isFinite(parsed) ? parsed : 0;
}

function getMostRecent(files) {
    if (!Array.isArray(files) || files.length === 0) {
        return null;
    }

    return [...files].sort((a, b) => getFileTime(b) - getFileTime(a))[0];
}

async function handlePackID(packID, baseUrl, tabId, authHeaders) {
    if (activeRequests.has(tabId)) {
        const active = activeRequests.get(tabId);
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
        if (signal.aborted) return;
        chrome.tabs.sendMessage(tabId, {
            type: "labelPreview",
            success: false,
            error: errMsg
        });
    };

    try {
        const cleanBase = baseUrl.replace(/\/$/, "");
        let targetUrl = null;

        // Resolve exact URL via API
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

                    // Determine carrier from the most recent file for this packID.
                    // Do not use .some(...) across all historical packID matches, because
                    // the same packID can have older files from a previous carrier/method.
                    const latestPackIdMatch = getMostRecent(packIdMatches);
                    const latestPackIdFileName = latestPackIdMatch && latestPackIdMatch.fileName
                        ? latestPackIdMatch.fileName.toLowerCase()
                        : "";

                    const isLoomis = latestPackIdFileName.includes("loomis");
                    const isCanadaPost = latestPackIdFileName.includes("canadapost");
                    const isAusPost = latestPackIdFileName.includes("auspost");

                    console.log(`[Quick Ship] Most recent file for PackID ${packID}: ${latestPackIdMatch ? latestPackIdMatch.fileName : "none"}`);

                    if (isLoomis) {
                        // Loomis Way: Find the most recent v2rs file
                        const loomisMatches = files.filter(f =>
                            f.fileName &&
                            f.fileName.toLowerCase().includes("v2rs")
                        );
                        const loomisMatch = getMostRecent(loomisMatches);
                        if (loomisMatch) {
                            targetUrl = loomisMatch.url;
                            console.log(`Detected Loomis carrier via PackID. Resolved URL using most recent fileDate: ${targetUrl}`);
                        }
                    } else if (isCanadaPost) {
                        // Canada Post Way: Find artifact ID in the packID file, then find the artifact file
                        const createShipmentMatches = packIdMatches.filter(f =>
                            f.fileName &&
                            f.fileName.toLowerCase().includes("createshipmentresponse")
                        );

                        let match = createShipmentMatches.length > 0
                            ? getMostRecent(createShipmentMatches)
                            : getMostRecent(packIdMatches);

                        if (match) {
                            try {
                                const cpResp = await fetch(match.url, { signal });
                                if (cpResp.ok) {
                                    const cpText = await cpResp.text();
                                    const artifactMatch = cpText.match(/<artifact-id>(.*?)<\/artifact-id>/);
                                    if (artifactMatch && artifactMatch[1]) {
                                        const artifactID = artifactMatch[1];
                                        const artifactMatches = files.filter(f =>
                                            f.fileName &&
                                            f.fileName.includes("getArtifactResponse") &&
                                            f.fileName.includes(artifactID)
                                        );
                                        const fileWithLabel = getMostRecent(artifactMatches);
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
                        const ausMatches = packIdMatches.filter(f =>
                            f.fileName &&
                            f.fileName.toLowerCase().includes("createlabelresponse")
                        );
                        const ausMatch = getMostRecent(ausMatches);
                        if (ausMatch) {
                            targetUrl = ausMatch.url;
                            console.log(`Detected Australia Post. Using packID file URL: ${targetUrl}`);
                        }
                    } else if (packIdMatches.length > 0) {
                        // Standard Check: Use the most recent matching file.
                        // Prioritize files containing "Reply" or "Response" if multiple matches exist.
                        const responseMatches = packIdMatches.filter(f =>
                            f.fileName &&
                            (
                                f.fileName.toLowerCase().includes("reply") ||
                                f.fileName.toLowerCase().includes("response")
                            )
                        );

                        const match = responseMatches.length > 0
                            ? getMostRecent(responseMatches)
                            : getMostRecent(packIdMatches);

                        if (match && match.url) {
                            targetUrl = match.url;
                            console.log(`Resolved XML URL via API using most recent fileDate: ${targetUrl}`);
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
            throw new Error(`Failed to preview. ${fileResponse ? fileResponse.status : 'Error'}.`);
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

/* Shared logic to extract, convert, and display label data from raw text/xml/json. */
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

                switch (format) {
                    case "UPS": labelaryHeaders["X-Rotation"] = "180"; break;
                    case "Loomis": labelaryHeaders["X-Rotation"] = "90"; break;
                    case "Canpar": labelaryHeaders["X-Rotation"] = "180"; break;
                    default:
                        if (base64.trim().startsWith("Cl5YQQ")) {
                            labelaryHeaders["X-Rotation"] = "180";
                        }
                        break;
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
                await openViewerTab(processedImages, {
                    packID: historyLabel,
                    website,
                    source: baseUrl
                });
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

async function openViewerTab(images, metadata = {}) {
    if (!Array.isArray(images) || images.length === 0) {
        console.warn("[Quick Ship] Viewer open skipped: no images were provided.");
        return;
    }

    const previewId = createPreviewId();
    const storageKey = `preview:${previewId}`;

    const previewPayload = {
        createdAt: Date.now(),
        metadata,
        images
    };

    await chrome.storage.session.set({
        [storageKey]: previewPayload
    });
    cleanupOldViewerPreviews().catch((err) => {
        console.warn("[Quick Ship] Viewer preview cleanup failed:", err);
    });

    const viewerUrl = chrome.runtime.getURL(`viewer.html?id=${encodeURIComponent(previewId)}`);
    await chrome.tabs.create({ url: viewerUrl });
}

function createPreviewId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function cleanupOldViewerPreviews(maxAgeMs = 60 * 60 * 1000) {
    if (!chrome.storage || !chrome.storage.session) return;

    const allSessionItems = await chrome.storage.session.get(null);
    const now = Date.now();
    const keysToRemove = [];

    for (const [key, value] of Object.entries(allSessionItems)) {
        if (!key.startsWith("preview:")) continue;

        const createdAt = value && typeof value.createdAt === "number"
            ? value.createdAt
            : 0;

        if (!createdAt || now - createdAt > maxAgeMs) {
            keysToRemove.push(key);
        }
    }

    if (keysToRemove.length > 0) {
        await chrome.storage.session.remove(keysToRemove);
    }
}


async function handleP21PackingListPreview({ shipmentLookupNumber, baseUrl, authHeaders = {}, tabId }) {
    const sendP21Error = (message, details = {}) => {
        if (!tabId) return;
        chrome.tabs.sendMessage(tabId, {
            type: "p21PreviewResult",
            success: false,
            title: details.title || "Error",
            category: details.category || "error",
            error: message || "Failed to preview the P21 packing list."
        });
    };

    try {
        if (!shipmentLookupNumber) {
            throw new Error("Unable to determine a Quick Ship shipment number from this page.");
        }
        if (!baseUrl) {
            throw new Error("Unable to determine the Quick Ship base URL for this shipment page.");
        }

        const cleanBase = baseUrl.replace(/\/$/, "");
        const shipmentInfo = await getShipmentInfoForP21(cleanBase, shipmentLookupNumber, authHeaders);

        if (!shipmentInfo || !shipmentInfo.isP21) {
            throw new Error("This shipment does not appear to be a P21 shipment, so no P21 packing list preview is available.");
        }

        const resolvedErpNumber = shipmentInfo.erpNumber;
        const files = await getCarrierXmlFiles(cleanBase, authHeaders);
        const resolved = await resolveP21PackingListFromCarrierXml(files, resolvedErpNumber);

        if (!resolved.success) {
            const error = new Error(resolved.error || "No document was available for preview.");
            error.p21Category = resolved.category || "error";
            error.p21Title = resolved.title || "P21 Packing List Error";
            throw error;
        }

        await saveToHistory({
            packID: `P21 Packing List ${shipmentLookupNumber}`,
            website: cleanBase,
            timestamp: Date.now(),
            images: [
                `data:${resolved.contentType || "application/pdf"};base64,${resolved.documentData}`
            ],
            metadata: {
                source: "P21 Packing List",
                erpNumber: resolvedErpNumber,
                shipmentLookupNumber,
                reqFile: resolved.reqFile ? resolved.reqFile.fileName : undefined,
                resFile: resolved.resFile ? resolved.resFile.fileName : undefined
            }
        });

        await openViewerTab([
            {
                base64: resolved.documentData,
                type: resolved.contentType || "application/pdf"
            }
        ], {
            source: "P21 Packing List",
            erpNumber: resolvedErpNumber,
            shipmentLookupNumber,
            reqFile: resolved.reqFile ? resolved.reqFile.fileName : undefined,
            resFile: resolved.resFile ? resolved.resFile.fileName : undefined
        });

        if (tabId) {
            chrome.tabs.sendMessage(tabId, {
                type: "p21PreviewResult",
                success: true
            });
        }
    } catch (err) {
        console.error("[Quick Ship] P21 packing list preview failed:", err);
        sendP21Error(err.message || "Failed to preview the P21 packing list.", {
            title: err.p21Title,
            category: err.p21Category
        });
    }
}

async function getShipmentInfoForP21(cleanBase, shipmentLookupNumber, authHeaders = {}) {
    const cleanShipmentLookupNumber = String(shipmentLookupNumber || "").trim();
    const resp = await fetch(`${cleanBase}/api/shipments/${cleanShipmentLookupNumber}`, {
        headers: authHeaders || {}
    });

    if (!resp.ok) {
        throw new Error(`Unable to retrieve shipment details. Response Status: ${resp.status}.`);
    }

    const data = await resp.json();
    const result = data && (data.result || data.Result || data);
    const erpSystem = findCaseInsensitive(result, "erpSystem");
    const resolvedErpNumber = findCaseInsensitive(result, "erpNumber");

    if (!resolvedErpNumber) {
        throw new Error(`No shipment found to originate from Prophet 21.`);
    }

    return {
        isP21: String(erpSystem || "").toUpperCase() === "P21",
        erpNumber: String(resolvedErpNumber || "").trim(),
        shipmentLookupNumber: cleanShipmentLookupNumber,
        raw: result
    };
}

async function getCarrierXmlFiles(cleanBase, authHeaders = {}) {
    const listResponse = await fetch(`${cleanBase}/api/downloads/getCarrierXMLs`, {
        headers: authHeaders || {}
    });

    if (!listResponse.ok) {
        throw new Error(`Unable to retrieve CarrierXML files. ${listResponse.status}.`);
    }

    const responseData = await listResponse.json();
    const files = responseData && Array.isArray(responseData.result)
        ? responseData.result
        : responseData;

    if (!Array.isArray(files)) {
        throw new Error("CarrierXMLs were not returned in the expected format.");
    }

    return files;
}

async function resolveP21PackingListFromCarrierXml(files, erpNumber) {
    const reqFiles = files
        .filter(file => getTransactionInfo(file && file.fileName)?.type === "REQ")
        .sort((a, b) => getFileTime(b) - getFileTime(a));

    for (const reqFile of reqFiles) {
        let reqText = "";
        try {
            const reqResp = await fetch(reqFile.url);
            if (!reqResp.ok) continue;
            reqText = await reqResp.text();
        } catch (err) {
            console.warn("[Quick Ship] Failed to read P21 transaction request:", reqFile.fileName, err);
            continue;
        }

        if (!requestContainsP21PickTicket(reqText, erpNumber)) {
            continue;
        }

        const resFile = findBestMatchingTransactionResFile(reqFile, files);
        if (!resFile) {
            return {
                success: false,
                category: "not_ready",
                title: "Error",
                error: `Found a packing list request for pick ticket ${erpNumber}, but no matching response was found. If the shipment just processed, wait a moment and try again.`,
                reqFile
            };
        }

        const resResp = await fetch(resFile.url);
        if (!resResp.ok) {
            return {
                success: false,
                category: "technical",
                title: "Error",
                error: `Found matching response file, but it could not be opened. ${resResp.status}.`,
                reqFile,
                resFile
            };
        }

        const resText = await resResp.text();
        const extracted = extractP21DocumentData(resText, erpNumber);

        if (extracted.documentData) {
            return {
                success: true,
                documentData: extracted.documentData,
                contentType: extracted.contentType || "application/pdf",
                reqFile,
                resFile
            };
        }

        return {
            success: false,
            category: extracted.category || "p21_exception",
            title: extracted.title || "Prophet 21 Error",
            error: extracted.message || `A response was found for pick ticket ${erpNumber}, but no packing list document data was available.`,
            reqFile,
            resFile
        };
    }

    return {
        success: false,
        category: "not_ready",
        title: "Error",
        error: `No transaction was found for pick ticket ${erpNumber}. This usually means the shipment has not been processed yet. Ship the order first, then try again.`
    };
}
function requestContainsP21PickTicket(text, erpNumber) {
    const target = String(erpNumber || "").trim();
    if (!text || !target) return false;

    try {
        const json = JSON.parse(text);
        let matched = false;
        walkJson(json, (node) => {
            if (matched || !node || typeof node !== "object") return;
            const name = findCaseInsensitive(node, "Name");
            const value = findCaseInsensitive(node, "Value");
            if (String(name || "").toLowerCase() === "pick_ticket_no" && String(value || "").trim() === target) {
                matched = true;
            }
        });
        if (matched) return true;
    } catch {
        // Not JSON; continue to raw matching.
    }

    const compact = text.replace(/\s+/g, "");
    return compact.includes("pick_ticket_no") && (
        compact.includes(`\"Value\":\"${escapeForJsonLikeSearch(target)}\"`) ||
        compact.includes(`\"Value\":${escapeForJsonLikeSearch(target)}`) ||
        compact.includes(`<Name>pick_ticket_no</Name><Value>${escapeForXmlLikeSearch(target)}</Value>`)
    );
}

function getTransactionInfo(fileName) {
    const match = String(fileName || "").match(/transaction_(REQ|RES)_([0-9]+)/i);
    if (!match) return null;
    return {
        type: match[1].toUpperCase(),
        suffix: match[2]
    };
}

function commonPrefixLength(a, b) {
    const max = Math.min(String(a || "").length, String(b || "").length);
    let i = 0;
    while (i < max && a[i] === b[i]) i++;
    return i;
}

function findBestMatchingTransactionResFile(reqFile, files) {
    const MIN_TRANSACTION_PAIR_PREFIX = 9;
    const reqInfo = getTransactionInfo(reqFile && reqFile.fileName);
    if (!reqInfo || reqInfo.type !== "REQ") return null;

    const candidates = files
        .map(file => {
            const info = getTransactionInfo(file && file.fileName);
            if (!info || info.type !== "RES") return null;
            return {
                file,
                prefixLength: commonPrefixLength(reqInfo.suffix, info.suffix),
                timeDelta: getFileTime(file) - getFileTime(reqFile)
            };
        })
        .filter(Boolean)
        .filter(candidate => candidate.prefixLength >= MIN_TRANSACTION_PAIR_PREFIX)
        .sort((a, b) => {
            if (b.prefixLength !== a.prefixLength) return b.prefixLength - a.prefixLength;
            const aAfter = a.timeDelta >= 0;
            const bAfter = b.timeDelta >= 0;
            if (aAfter !== bAfter) return aAfter ? -1 : 1;
            return Math.abs(a.timeDelta) - Math.abs(b.timeDelta);
        });

    return candidates.length > 0 ? candidates[0].file : null;
}

function extractP21DocumentData(text, erpNumber = null) {
    if (!text) return { documentData: null, contentType: null, message: null, title: null, category: null };

    const json = parseJsonOrEmbeddedJson(text);
    if (json) {
        const docs = [];
        const messageInfo = extractP21JsonMessageInfo(json, erpNumber);

        walkJson(json, (node) => {
            if (!node || typeof node !== "object") return;
            const data = findCaseInsensitive(node, "DocumentData");
            if (!data) return;
            docs.push({
                documentData: String(data).trim(),
                contentType: findCaseInsensitive(node, "DocumentContentType") || "application/pdf"
            });
        });

        const doc = docs.find(d => d.documentData);
        if (doc) return { ...doc, message: messageInfo.detailMessage, title: messageInfo.title, category: messageInfo.category };
        return {
            documentData: null,
            contentType: null,
            message: messageInfo.detailMessage,
            title: messageInfo.title,
            category: messageInfo.category
        };
    }

    const documentData = firstXmlValue(text, "DocumentData");
    const contentType = firstXmlValue(text, "DocumentContentType") || "application/pdf";
    const xmlMessages = [
        firstXmlValue(text, "Message"),
        ...extractAllXmlValues(text, "Messages")
    ].filter(Boolean);
    const messageInfo = buildP21MessageInfo(xmlMessages, erpNumber);

    return {
        documentData: documentData ? documentData.trim() : null,
        contentType,
        message: messageInfo.detailMessage,
        title: messageInfo.title,
        category: messageInfo.category
    };
}
function parseJsonOrEmbeddedJson(text) {
    if (!text) return null;
    const trimmed = String(text).trim();
    try {
        return JSON.parse(trimmed);
    } catch {
        // Continue to embedded JSON extraction.
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
        return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
        return null;
    }
}

function extractP21JsonMessageInfo(json, erpNumber = null) {
    const messages = [];
    walkJson(json, (node) => {
        if (!node || typeof node !== "object") return;
        const directMessages = findCaseInsensitive(node, "Messages");
        if (Array.isArray(directMessages)) {
            for (const item of directMessages) {
                if (typeof item === "string" && item.trim()) messages.push(item.trim());
            }
        }
        const directMessage = findCaseInsensitive(node, "Message");
        if (typeof directMessage === "string" && directMessage.trim()) messages.push(directMessage.trim());
    });
    return buildP21MessageInfo(messages, erpNumber);
}

function buildP21MessageInfo(messages, erpNumber = null) {
    const uniqueMessages = [...new Set((messages || []).map(m => String(m || "").trim()).filter(Boolean))];
    if (uniqueMessages.length === 0) {
        return {
            title: "Error",
            category: "p21_exception",
            detailMessage: erpNumber
                ? `Data for ${erpNumber} was found, but no packing list was available for preview.`
                : "Data was found, but no packing list was found to be previewed."
        };
    }

    const friendly = getFriendlyP21Message(uniqueMessages[0]);
    const pickTicketLine = erpNumber ? `\n\nPick Ticket: ${erpNumber}` : "";
    const detailBlock = uniqueMessages.length > 1
        ? `\n\nDetails:\n${uniqueMessages.join("\n")}`
        : "";
    return {
        title: "P21 Returned an Exception",
        category: "p21_exception",
        detailMessage: `${friendly}${pickTicketLine}${detailBlock}`
    };
}

function getFriendlyP21Message(message) {
    const raw = String(message || "").trim();
    if (!raw) return "P21 did not return a packing list document.";

    const exceptionMatch = raw.match(/General Exception:\s*(.*?)(?:\s*DataElement:|$)/i);
    if (exceptionMatch && exceptionMatch[1]) return exceptionMatch[1].trim();

    const rowMessageMatch = raw.match(/row\s+\d+:\s*(.*?)(?:\s*DataElement:|$)/i);
    if (rowMessageMatch && rowMessageMatch[1]) return rowMessageMatch[1].trim();

    const dataElementIndex = raw.search(/\sDataElement:/i);
    return dataElementIndex > 0 ? raw.slice(0, dataElementIndex).trim() : raw;
}
function walkJson(node, visit) {
    visit(node);
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
        node.forEach(child => walkJson(child, visit));
    } else {
        Object.values(node).forEach(child => walkJson(child, visit));
    }
}

function findCaseInsensitive(obj, key) {
    if (!obj || typeof obj !== "object") return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    const found = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
    return found ? obj[found] : undefined;
}

function firstXmlValue(text, tagName) {
    const values = extractAllXmlValues(text, tagName);
    return values.length > 0 ? values[0] : null;
}

function extractAllXmlValues(text, tagName) {
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
    const values = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        values.push(decodeXmlEntities(match[1].trim()));
    }
    return values;
}

function decodeXmlEntities(value) {
    return String(value || "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

function escapeForJsonLikeSearch(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeForXmlLikeSearch(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/* Helper to safely send a message to a tab. Used to determine if a tab has the content script active */
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

        // Remove duplicates
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
