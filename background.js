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

        await handlePackID(msg.packID, msg.baseUrl, sender.tab.id, msg.authHeaders, msg.shipmentFailure || null);
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
    } else if (msg.type === "previewKineticLabel") {
        const tabId = sender.tab ? sender.tab.id : null;
        await handleKineticLabelPreview({
            packID: msg.packID,
            shipmentNumber: msg.shipmentNumber,
            mfTransNum: msg.mfTransNum,
            kineticPackID: msg.kineticPackID,
            baseUrl: msg.baseUrl,
            freightURL: msg.freightURL,
            authHeaders: msg.authHeaders || {},
            tabId
        });
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


function normalizeShipmentApiResult(data) {
    if (!data || typeof data !== "object") return { envelope: data || {}, shipment: null };
    return { envelope: data, shipment: data.result || data.Result || data };
}


function isBenignShipmentMessage(message) {
    const text = String(message || "").trim().toLowerCase();
    if (!text) return true;
    return /^(success|successful|ok|succeeded|completed)\b/.test(text);
}

function hasBlockingShipmentErrors(errorMessages = []) {
    return (errorMessages || [])
        .map(message => String(message || "").trim())
        .filter(Boolean)
        .some(message => !isBenignShipmentMessage(message));
}

function getBlockingShipmentErrorMessages(errorMessages = []) {
    return (errorMessages || [])
        .map(message => String(message || "").trim())
        .filter(Boolean)
        .filter(message => !isBenignShipmentMessage(message));
}

function getShipmentFailureInfo(data) {
    const { envelope, shipment } = normalizeShipmentApiResult(data);
    const notification = shipment && (shipment.notificationObject || shipment.NotificationObject);
    const severity = String(notification && (notification.severityType || notification.SeverityType) || "").trim().toUpperCase();
    const notificationMessage = notification && (notification.message || notification.Message);
    const errors = Array.isArray(envelope && envelope.errors)
        ? envelope.errors
        : Array.isArray(envelope && envelope.Errors)
            ? envelope.Errors
            : [];
    const errorMessages = errors
        .map(error => error && (error.message || error.Message))
        .filter(Boolean);
    const isSuccess = envelope && Object.prototype.hasOwnProperty.call(envelope, "isSuccess")
        ? envelope.isSuccess
        : envelope && Object.prototype.hasOwnProperty.call(envelope, "IsSuccess")
            ? envelope.IsSuccess
            : undefined;

    const failureSeverityTypes = new Set(["ERROR", "ERR", "FATAL", "CRITICAL"]);
    const hasFailureSeverity = failureSeverityTypes.has(severity);
    const hasExplicitFailure = isSuccess === false;
    const blockingMessages = getBlockingShipmentErrorMessages(errorMessages);
    const hasBlockingErrors = blockingMessages.length > 0;

    // Quick Ship can return errors: [{ message: "Success" }] on successful shipments.
    // Only block when the envelope says failure, notification severity is failure, or error messages are not benign.
    if (!hasFailureSeverity && !hasExplicitFailure && !hasBlockingErrors) return null;

    return {
        severityType: severity || (hasExplicitFailure || hasBlockingErrors ? "ERROR" : "UNKNOWN"),
        message: notificationMessage || blockingMessages.join("\n") || "Quick Ship returned a shipment failure.",
        errors: errorMessages,
        notification
    };
}

function normalizeImmediateShipmentFailure(failureInfo) {
    if (!failureInfo || typeof failureInfo !== "object") return null;
    const severityType = String(failureInfo.severityType || failureInfo.SeverityType || "").trim().toUpperCase();
    const message = String(failureInfo.message || failureInfo.Message || "").trim();
    const errors = Array.isArray(failureInfo.errors) ? failureInfo.errors : [];
    const failureSeverityTypes = new Set(["ERROR", "ERR", "FATAL", "CRITICAL"]);
    const hasFailureSeverity = failureSeverityTypes.has(severityType);
    const blockingMessages = getBlockingShipmentErrorMessages([message, ...errors]);
    const hasBlockingErrors = blockingMessages.length > 0;

    // Ignore benign immediate messages like "Success" so successful shipments can preview.
    if (!hasFailureSeverity && !hasBlockingErrors) return null;

    return {
        severityType: severityType || "ERROR",
        message: message && !isBenignShipmentMessage(message)
            ? message
            : blockingMessages.join("\n") || "Quick Ship returned a shipment failure.",
        errors,
        notification: failureInfo.notification || null
    };
}

async function getQuickShipShipmentFailureInfo(cleanBase, shipmentNumber, authHeaders = {}, signal = null) {
    const lookup = String(shipmentNumber || "").trim();
    if (!cleanBase || !lookup) return null;
    try {
        const resp = await fetch(`${cleanBase}/api/shipments/${encodeURIComponent(lookup)}`, { headers: authHeaders || {}, signal: signal || undefined });
        if (!resp.ok) return null;
        return getShipmentFailureInfo(await resp.json());
    } catch (err) {
        if (signal && (signal.aborted || err.name === "AbortError")) throw err;
        console.warn("[Quick Ship] Shipment status guard failed open:", err);
        return null;
    }
}

function buildShipmentFailurePreviewMessage(failureInfo, shipmentNumber) {
    const cleanedMessage = String(failureInfo && failureInfo.message || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    const prefix = shipmentNumber ? `Shipment ${shipmentNumber} failed in Quick Ship.` : "The shipment failed in Quick Ship.";
    return cleanedMessage ? `${prefix}\n\n${cleanedMessage}` : `${prefix}\n\nReview the Quick Ship shipment error and try again after it is resolved.`;
}

function sendShipmentFailurePreview(tabId, lookupNumber, failureInfo) {
    const failureMessage = buildShipmentFailurePreviewMessage(failureInfo, lookupNumber);
    console.warn("[Quick Ship] Label preview blocked because the shipment failed:", { lookupNumber, severityType: failureInfo && failureInfo.severityType, message: failureInfo && failureInfo.message });
    chrome.tabs.sendMessage(tabId, {
        type: "labelPreview",
        success: false,
        title: "Shipment Failed",
        error: failureMessage,
        category: "shipment_failed",
        severityType: failureInfo && failureInfo.severityType,
        isNoData: true
    });
}

async function handlePackID(packID, baseUrl, tabId, authHeaders, immediateShipmentFailure = null, previewOptions = {}) {
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
        const lookupNumber = String(packID || "").trim();

        console.log("Attempting to resolve label-bearing CarrierXML via /api/downloads/getCarrierXMLs...", {
            lookupNumber,
            baseUrl: cleanBase
        });

        const immediateFailureInfo = normalizeImmediateShipmentFailure(immediateShipmentFailure);
        if (immediateFailureInfo) {
            sendShipmentFailurePreview(tabId, lookupNumber, immediateFailureInfo);
            return;
        }

        const shipmentFailureInfo = await getQuickShipShipmentFailureInfo(cleanBase, lookupNumber, authHeaders || {}, signal);
        if (shipmentFailureInfo) {
            sendShipmentFailurePreview(tabId, lookupNumber, shipmentFailureInfo);
            return;
        }

        const liveMode = Boolean(previewOptions && previewOptions.liveMode);
        const liveStartedAt = Number(previewOptions && previewOptions.startedAt) || Date.now();
        const maxWaitMs = liveMode ? Number(previewOptions.maxWaitMs || 65000) : 0;
        const retryDelayMs = liveMode ? Number(previewOptions.retryDelayMs || 2500) : 0;
        const startedWaitingAt = Date.now();
        let resolved = null;
        let attempt = 0;
        do {
            attempt++;
            const files = await getCarrierXmlFiles(cleanBase, authHeaders || {});
            resolved = await resolveBestLabelFileForLookup(files, lookupNumber, signal, { ...previewOptions, liveMode, startedAt: liveStartedAt });
            if (resolved && resolved.text) break;
            if (!liveMode || Date.now() - startedWaitingAt >= maxWaitMs) break;
            console.log("[Quick Ship] Live label not ready yet; retrying CarrierXML resolution.", { lookupNumber, attempt, elapsedMs: Date.now() - startedWaitingAt, maxWaitMs });
            await sleep(retryDelayMs);
        } while (!signal.aborted);
        if (!resolved || !resolved.text) {
            sendError(liveMode ? `Label is not ready yet for ${lookupNumber}. Quick Ship may still be generating the carrier response. Try again in a moment.` : `Failed to preview label. No label-bearing CarrierXML file was found for ${lookupNumber}.`);
            return;
        }
        console.log("[Quick Ship] Label-bearing CarrierXML resolved:", {
            lookupNumber,
            fileName: resolved.file && resolved.file.fileName,
            reason: resolved.reason,
            clueCount: resolved.clues ? resolved.clues.length : 0
        });

        await processLabelContent(resolved.text, tabId, lookupNumber, baseUrl, signal);
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

function normalizeLookupValue(value) {
    const text = String(value ?? "").trim();
    if (!text || text === "0" || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") return null;
    return text;
}


function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function fileNameHasLookupToken(fileName, lookup) {
    const name = String(fileName || "");
    const token = String(lookup || "").trim();
    if (!name || !token) return false;
    return new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(token)}([^A-Za-z0-9]|$)`, "i").test(name);
}
function fileIsNewEnoughForLivePreview(file, startedAt, toleranceMs = 15000) {
    if (!startedAt) return true;
    const t = getFileTime(file);
    if (!t) return true;
    return t >= (startedAt - toleranceMs);
}
function isLiveResolverOptions(options = {}) {
    return Boolean(options && options.liveMode);
}
function getLiveResolverStartedAt(options = {}) {
    const startedAt = Number(options && options.startedAt);
    return Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0;
}
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function addLookupClue(clues, value) {
    const normalized = normalizeLookupValue(value);
    if (!normalized) return;
    // Avoid extremely short numeric clues because they create too many unrelated filename matches.
    if (/^\d+$/.test(normalized) && normalized.length < 3) return;
    clues.add(normalized);
}

function parsePossiblyNestedJson(text) {
    if (!text) return null;
    const trimmed = String(text).trim();
    if (!trimmed) return null;

    try {
        let parsed = JSON.parse(trimmed);
        // Some Quick Ship REST captures are JSON strings containing JSON objects.
        if (typeof parsed === "string") {
            const inner = parsed.trim();
            if (inner.startsWith("{") || inner.startsWith("[")) {
                parsed = JSON.parse(inner);
            }
        }
        return parsed;
    } catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(trimmed.slice(start, end + 1));
            } catch {
                return null;
            }
        }
        return null;
    }
}

function collectShipmentCluesFromText(text, initialLookup = null) {
    const clues = new Set();
    addLookupClue(clues, initialLookup);

    const json = parsePossiblyNestedJson(text);
    if (json) {
        walkJson(json, (node) => {
            if (!node || typeof node !== "object") return;
            [
                "ShipmentNumber",
                "shipmentNumber",
                "TransactionNumber",
                "transactionNumber",
                "TrackingNumber",
                "trackingNumber",
                "ContainerId",
                "containerId",
                "PackID",
                "packID",
                "PackId",
                "PackNum",
                "MFTransNum",
                "ArtifactId",
                "artifact-id"
            ].forEach(key => addLookupClue(clues, findCaseInsensitive(node, key)));
        });
    }

    [
        "ShipmentNumber",
        "TransactionNumber",
        "TrackingNumber",
        "ContainerId",
        "PackID",
        "PackId",
        "PackNum",
        "MFTransNum",
        "artifact-id",
        "ArtifactId"
    ].forEach(tag => {
        const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
        let match;
        while ((match = regex.exec(text || "")) !== null) {
            addLookupClue(clues, decodeXmlEntities(match[1]));
        }
    });

    // Canada Post artifact IDs sometimes appear in hyphenated XML tags and filenames.
    const artifactRegex = /artifact[-_]?id[^A-Za-z0-9]+([A-Za-z0-9_.-]{6,})/gi;
    let artifactMatch;
    while ((artifactMatch = artifactRegex.exec(text || "")) !== null) {
        addLookupClue(clues, artifactMatch[1]);
    }

    return clues;
}

async function fetchCarrierFileText(file, signal) {
    if (!file || !file.url) return null;
    try {
        const resp = await fetch(file.url, { signal });
        if (!resp.ok) {
            console.warn("[Quick Ship] Candidate CarrierXML fetch failed:", file.fileName, resp.status);
            return null;
        }
        return await resp.text();
    } catch (err) {
        if (signal && (signal.aborted || err.name === "AbortError")) throw err;
        console.warn("[Quick Ship] Candidate CarrierXML read failed:", file.fileName, err);
        return null;
    }
}

function textHasExtractableLabelData(text) {
    try {
        return Boolean(extractLabelData(text));
    } catch (err) {
        console.warn("[Quick Ship] Label data probe failed:", err);
        return false;
    }
}

function hasAnyClueInFileName(file, clues, options = {}) {
    const name = String(file && file.fileName || "").toLowerCase();
    if (!name) return false;
    const liveMode = isLiveResolverOptions(options);
    return [...clues].some(clue => {
        if (!clue) return false;
        const clueText = String(clue);
        return (liveMode || /^\d+$/.test(clueText))
            ? fileNameHasLookupToken(name, clueText)
            : name.includes(clueText.toLowerCase());
    });
}

function isNearAnySeedTime(file, seedTimes, windowMs = 5 * 60 * 1000) {
    const t = getFileTime(file);
    if (!t || !Array.isArray(seedTimes) || seedTimes.length === 0) return false;
    return seedTimes.some(seed => seed && Math.abs(t - seed) <= windowMs);
}

function scoreCarrierCandidate(file, clues, seedTimes, directMatchesSet, options = {}) {
    const name = String(file && file.fileName || "").toLowerCase();
    const liveMode = isLiveResolverOptions(options);
    const startedAt = getLiveResolverStartedAt(options);
    let score = 0;
    if (directMatchesSet && directMatchesSet.has(file)) score += 80;
    if (hasAnyClueInFileName(file, clues, options)) score += liveMode ? 120 : 70;
    if (!liveMode && isNearAnySeedTime(file, seedTimes)) score += 45;
    if (liveMode) {
        const t = getFileTime(file);
        if (startedAt && t && t < startedAt - 15000) score -= 250;
        if (startedAt && t && t >= startedAt - 15000) score += 80;
    }
    if (/(shipreply|shipmentresponse|createshipmentresponse|createlabelresponse|getartifactresponse|artifactresponse|labelresponse|ratequote|v2rs)/i.test(name)) score += 80;
    if (/(reply|response|label|graphic|outputimage|image)/i.test(name)) score += 45;
    if (/(fedex|ups|usps|endicia|dhl|loomis|canadapost|canpar|auspost|purolator|tforce|xpo|wtx)/i.test(name)) score += 30;
    if (/(request|_req_|transaction_req|freightcarton|epicorresponse)/i.test(name)) score -= 55;
    score += Math.min(25, Math.floor(getFileTime(file) / 100000000000));
    return score;
}

function uniqueFiles(files) {
    const seen = new Set();
    const output = [];
    for (const file of files || []) {
        const key = file && (file.url || file.fileName);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        output.push(file);
    }
    return output;
}

function sortCarrierCandidates(files, clues, seedTimes, directMatchesSet, options = {}) {
    return uniqueFiles(files)
        .map(file => ({ file, score: scoreCarrierCandidate(file, clues, seedTimes, directMatchesSet, options), time: getFileTime(file) }))
        .sort((a, b) => b.score !== a.score ? b.score - a.score : b.time - a.time)
        .map(item => item.file);
}

async function resolveBestLabelFileForLookup(files, lookupNumber, signal, options = {}) {
    const lookup = normalizeLookupValue(lookupNumber);
    if (!lookup || !Array.isArray(files) || files.length === 0) return null;
    const liveMode = isLiveResolverOptions(options);
    const startedAt = getLiveResolverStartedAt(options);
    const initialClues = new Set();
    addLookupClue(initialClues, lookup);
    const directMatches = files.filter(file => {
        if (!file || !file.fileName) return false;
        if (liveMode && !fileIsNewEnoughForLivePreview(file, startedAt)) return false;
        return liveMode ? fileNameHasLookupToken(file.fileName, lookup) : file.fileName.includes(lookup);
    });
    if (directMatches.length === 0) {
        console.warn(`[Quick Ship] No CarrierXML files directly matched lookup number ${lookup}.`, { liveMode, startedAt });
        return null;
    }
    const directMatchesSet = new Set(directMatches);
    const seedTimes = directMatches.map(getFileTime).filter(Boolean);
    const tested = new Set();
    const discoveredClues = new Set(initialClues);
    const probeCandidate = async (file, reason) => {
        if (!file || !file.url || tested.has(file.url)) return null;
        if (liveMode && !fileIsNewEnoughForLivePreview(file, startedAt)) return null;
        tested.add(file.url);
        const text = await fetchCarrierFileText(file, signal);
        if (!text) return null;
        const newClues = collectShipmentCluesFromText(text, lookup);
        newClues.forEach(clue => discoveredClues.add(clue));
        if (textHasExtractableLabelData(text)) return { file, text, reason, clues: [...discoveredClues] };
        console.log("[Quick Ship] Candidate did not contain label data:", { fileName: file.fileName, reason, liveMode, discoveredClues: [...discoveredClues] });
        return null;
    };
    for (const file of sortCarrierCandidates(directMatches, discoveredClues, seedTimes, directMatchesSet, options).slice(0, liveMode ? 20 : 12)) {
        const resolved = await probeCandidate(file, "direct-lookup-match");
        if (resolved) return resolved;
    }
    const expandedCandidates = files.filter(file => {
        if (!file || !file.fileName || tested.has(file.url)) return false;
        if (liveMode && !fileIsNewEnoughForLivePreview(file, startedAt)) return false;
        return liveMode ? hasAnyClueInFileName(file, discoveredClues, options) : hasAnyClueInFileName(file, discoveredClues, options) || isNearAnySeedTime(file, seedTimes);
    });
    for (const file of sortCarrierCandidates(expandedCandidates, discoveredClues, seedTimes, directMatchesSet, options).slice(0, liveMode ? 20 : 40)) {
        const resolved = await probeCandidate(file, liveMode ? "live-expanded-token-match" : "expanded-clue-or-time-match");
        if (resolved) return resolved;
    }
    console.warn("[Quick Ship] No label-bearing CarrierXML was found after probing candidates.", { lookup, liveMode, startedAt, directMatchCount: directMatches.length, expandedCandidateCount: expandedCandidates.length, clues: [...discoveredClues] });
    return null;
}


function isManualPreviewSource(historyLabel) {
    return historyLabel === "Clipboard" || historyLabel === "Selection";
}

function createManualPreviewError(fileContent, stage = "no_extractable_data") {
    const info = getFriendlyManualPreviewError(fileContent, stage);
    const err = new Error(info.message);
    err.isNoData = true;
    err.previewTitle = info.title;
    err.previewCategory = info.category;
    err.previewHint = info.hint;
    return err;
}

function getFriendlyManualPreviewError(fileContent, stage = "no_extractable_data") {
    const text = String(fileContent || "").trim();
    if (!text) {
        return {
            title: "Nothing to Preview",
            category: "empty_selection",
            message: "Nothing previewable was found. Highlight the full XML/JSON response or encoded label data, then try Preview again.",
            hint: "empty"
        };
    }

    const decoded = tryDecodeBase64Text(text);
    if (decoded && decoded.printableRatio > 0.85) {
        if (/manifest|pick[- ]?up|pickup|fedex ground|shipper #|driver signature/i.test(decoded.text)) {
            return {
                title: "Unsupported Text Document",
                category: "base64_text_document",
                message: "The selected data decoded successfully, but it appears to be a text manifest/document rather than a label, PDF, image, or ZPL payload.",
                hint: "base64-text-manifest"
            };
        }
        return {
            title: "Unsupported Text Data",
            category: "base64_plain_text",
            message: "The selected data decoded successfully, but it appears to be plain text instead of a supported label, PDF, image, or ZPL payload.",
            hint: "base64-text"
        };
    }

    if (looksLikeJsonOrXml(text)) {
        return {
            title: "No Label Data Found",
            category: "structured_without_label",
            message: "The selected XML/JSON did not contain a recognized label field. Try selecting the full carrier response that includes label image, PDF, or ZPL data.",
            hint: "structured-no-label-field"
        };
    }

    if (looksLikeBase64(text)) {
        return {
            title: "Unsupported Encoded Data",
            category: "unsupported_base64",
            message: "The selected text looks encoded, but it did not decode into a supported label, PDF, image, or ZPL payload.",
            hint: "unsupported-base64"
        };
    }

    return {
        title: "Nothing to Preview",
        category: "invalid_selection",
        message: "The selected text does not appear to contain supported preview data. Highlight the full carrier XML/JSON response, PDF/image base64, or ZPL data, then try Preview again.",
        hint: "generic-invalid-selection"
    };
}

function looksLikeJsonOrXml(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return false;
    if ((trimmed.startsWith("{") && trimmed.includes("}")) || (trimmed.startsWith("[") && trimmed.includes("]"))) return true;
    return /<\/?[A-Za-z][\s\S]*?>/.test(trimmed);
}

function looksLikeBase64(text) {
    const compact = String(text || "").trim().replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, "");
    if (compact.length < 40) return false;
    if (compact.length % 4 !== 0) return false;
    return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function tryDecodeBase64Text(text) {
    if (!looksLikeBase64(text)) return null;
    const compact = String(text || "").trim().replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, "");
    try {
        const decoded = atob(compact.slice(0, Math.min(compact.length, 12000)));
        if (!decoded) return null;
        let printable = 0;
        for (let i = 0; i < decoded.length; i++) {
            const code = decoded.charCodeAt(i);
            if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable++;
        }
        return {
            text: decoded,
            printableRatio: printable / decoded.length
        };
    } catch {
        return null;
    }
}

/* Shared logic to extract, convert, and display label data from raw text/xml/json. */
async function processLabelContent(fileContent, tabId, historyLabel, baseUrl, signal = null) {
    try {
        // Use helper from utils.js to find base64 data
        const extracted = extractLabelData(fileContent);
        if (!extracted) {
            if (isManualPreviewSource(historyLabel)) {
                throw createManualPreviewError(fileContent, "no_extractable_data");
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
            if (isManualPreviewSource(historyLabel)) {
                throw createManualPreviewError(fileContent, "no_valid_processed_labels");
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


async function handleKineticLabelPreview({ packID, shipmentNumber, mfTransNum, kineticPackID, baseUrl, freightURL, authHeaders = {}, tabId, livePreviewStartedAt = Date.now() }) {
    const sendKineticError = (message, details = {}) => {
        if (!tabId) return;
        chrome.tabs.sendMessage(tabId, {
            type: "labelPreview",
            success: false,
            error: message || "Failed to preview the Kinetic label.",
            isNoData: Boolean(details.isNoData)
        });
    };

    try {
        const cleanLookupNumber = String(shipmentNumber || mfTransNum || packID || "").trim();
        const cleanBase = String(baseUrl || getQuickShipBaseFromFreightUrl(freightURL) || "").replace(/\/$/, "");
        if (!cleanLookupNumber || cleanLookupNumber === "0") {
            throw new Error("Unable to determine the Quick Ship shipment number / MFTransNum for this Kinetic shipment.");
        }
        if (!cleanBase) {
            throw new Error("Unable to determine the connected Quick Ship URL from the Kinetic freightURL.");
        }

        console.log("[Quick Ship] Kinetic label lookup using Quick Ship shipment number:", {
            lookupNumber: cleanLookupNumber,
            kineticPackID: kineticPackID || packID || null,
            baseUrl: cleanBase
        });
        await handlePackID(cleanLookupNumber, cleanBase, tabId, authHeaders || {}, null, {
            liveMode: true,
            startedAt: livePreviewStartedAt || Date.now(),
            maxWaitMs: 65000,
            retryDelayMs: 2500
        });
    } catch (err) {
        console.error("[Quick Ship] Kinetic label preview failed:", err);
        sendKineticError(err.message || "Failed to preview the Kinetic label.");
    }
}

function getQuickShipBaseFromFreightUrl(freightURL) {
    if (!freightURL) return null;
    try {
        const parsed = new URL(String(freightURL));
        const marker = "/EpicorFreightService.svc";
        const markerIndex = parsed.pathname.toLowerCase().indexOf(marker.toLowerCase());
        if (markerIndex >= 0) {
            const basePath = parsed.pathname.slice(0, markerIndex).replace(/\/$/, "");
            return `${parsed.origin}${basePath}`.replace(/\/$/, "");
        }
        return parsed.origin.replace(/\/$/, "");
    } catch {
        const match = String(freightURL).match(/^(https?:\/\/.+?)\/EpicorFreightService\.svc/i);
        return match && match[1] ? match[1].replace(/\/$/, "") : null;
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
