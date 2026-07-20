(function() {
    window.QuickShipInterceptorActive = true;
    try {
        patchFetch();
        patchXHR();
        // console.log("[Quick Ship] Network interceptors active.");
    } catch (err) {
        // console.error("[Quick Ship] Interceptor setup error:", err);
    }
})();
// console.log("Made it past initial func");

function patchFetch() {
    //console.log("Patching fetch...");
    // Store original fetch ONCE to prevent stacking
    if (!window.__qsOrigFetch) {
        window.__qsOrigFetch = window.fetch;
    }
    const origFetch = window.__qsOrigFetch;
    //console.log("Original fetch stored-->", origFetch);
    window.fetch = async function(...args) {
        // console.log("Fetch called with args:", args);
        const response = await origFetch.apply(this, args);
        // console.log("Fetch response received");
        const url = getFetchUrl(args);
        const method = getFetchMethod(args);
        const requestHeaders = getFetchRequestHeaders(args);
        processFetchRequestBody(args, url, requestHeaders, method);
        // console.log("Processing fetch response for URL:", url);
        try {
            // Clone the response to read the body without consuming the original stream
            // console.log("Attemting to clone response...")
            const clone = response.clone();
            clone.text().then(bodyText => {
                const responseHeaders = {};
                response.headers.forEach((val, key) => { responseHeaders[key] = val; });
                safeProcessText(bodyText, url, mergeHeaders(responseHeaders, requestHeaders), method);
            }).catch(() => { /* ignore read errors */ });
        } catch (err) {
            console.warn("[Quick Ship] Fetch intercept warning:", err);
        }
        return response;
    };
}
// console.log("Made it past fetch patch");

function patchXHR() {
    // console.log("Patching XHR...");
    const XHR = XMLHttpRequest.prototype;
    // Store originals ONCE
    if (!XHR.__qsOrigOpen) XHR.__qsOrigOpen = XHR.open;
    if (!XHR.__qsOrigSend) XHR.__qsOrigSend = XHR.send;
    if (!XHR.__qsOrigSetHeader) XHR.__qsOrigSetHeader = XHR.setRequestHeader;
    const origOpen = XHR.__qsOrigOpen;
    const origSend = XHR.__qsOrigSend;
    const origSetRequestHeader = XHR.__qsOrigSetHeader;
    // console.log("Original XHR open stored-->", origOpen);
    // console.log("Original XHR send stored-->", origSend);
    XHR.setRequestHeader = function(header, value) {
        if (!this._headers) this._headers = {};
        this._headers[header] = value;
        return origSetRequestHeader.apply(this, arguments);
    };
    XHR.open = function(method, url) {
        this._url = url; // Store URL for debugging if needed
        this._method = method;
        // XMLHttpRequest instances can be reused. Never carry captured credentials
        // or other request headers from a previous open/send cycle.
        this._headers = {};
        // console.log("XHR open called with URL:", url);
        const result = origOpen.apply(this, arguments);
        // console.log("XHR open applied");
        return result;
    };
    XHR.send = function(...args) {
        safeProcessRequestText(args && args.length ? args[0] : null, this._url, this._headers, this._method);
        // Use readystatechange for more reliable status/response capture
        this.addEventListener("readystatechange", () => {
            // Log every state change for debugging
            // console.log(`[Quick Ship] XHR readyState: ${this.readyState} for URL: ${this._url}`);
            if (this.readyState === 4) { // DONE
            /*  console.log("[Quick Ship] XHR Finished (readyState 4)", {
                    url: this._url,
                    status: this.status,
                    statusText: this.statusText,
                    responseType: this.responseType
                }); */
                // Debug logging of the final result
                const ct = (() => { try { return this.getResponseHeader("content-type"); } catch { return null; }})();
            /*  console.debug("[Quick Ship] XHR Details", {
                    url: this._url,
                    finalUrl: this.responseURL,
                    status: this.status,
                    method: this._method,
                    response: this.response,
                    responseType: this.responseType,
                    ct: ct
                }); */
                try {
                    // Process text or JSON responses
                    if (this.responseType === '' || this.responseType === 'text') {
                        safeProcessText(this.responseText, this.responseURL || this._url, this._headers, this._method);
                    } else if (this.responseType === 'json' && this.response) {
                        try {
                            safeProcessText(JSON.stringify(this.response), this.responseURL || this._url, this._headers, this._method);
                        } catch (e) { /* ignore */ }
                    }
                } catch (err) {
                    console.warn("[Quick Ship] XHR processing error:", err);
                }
            }
        });
        // Keep error listeners just in case
        // this.addEventListener("error", () => console.warn("[Quick Ship] XHR error", { url: this._url, status: this.status }));
        // this.addEventListener("abort", () => console.warn("[Quick Ship] XHR abort", { url: this._url }));
        // this.addEventListener("timeout", () => console.warn("[Quick Ship] XHR timeout", { url: this._url }));
        return origSend.apply(this, args);
    };
}
// console.log("Made it past XHR patch");


function safeProcessRequestText(txt, url, headers, method = "GET") {
    if (!txt || !url) return;
    const urlText = String(url);
    const requestMethod = String(method || "GET").toUpperCase();
    if (!isKineticFreightCartonUrl(urlText, requestMethod)) return;

    const bodyText = typeof txt === "string" ? txt : String(txt || "");
    const trimmed = bodyText.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;

    try {
        const json = JSON.parse(trimmed);
        const context = getKineticLabelContextFromFreightCartonRequest(json, urlText);
        if (!context || !context.packID || !context.quickShipBaseUrl) return;

        window.dispatchEvent(new CustomEvent("qs_kinetic_label_context_found", {
            detail: {
                ...context,
                baseUrl: context.quickShipBaseUrl,
                kineticBaseUrl: getAppBaseUrl(),
                kineticAuthHeaders: getAuthHeaders(headers),
                sourceUrl: urlText,
                contextSource: "kinetic-freight-carton"
            }
        }));
        console.log("[Quick Ship] Kinetic label context found:", {
            packID: context.packID,
            quickShipBaseUrl: context.quickShipBaseUrl
        });
    } catch (err) {
        console.warn("[Quick Ship] Kinetic FreightCarton request parse error:", err);
    }
}

function isKineticFreightCartonUrl(url, method = "POST") {
    if (String(method || "POST").toUpperCase() !== "POST") return false;
    try {
        const parsed = new URL(String(url), window.location.href);
        return /\/Erp\.BO\.FreightServiceSvc\/FreightCarton\/?$/i.test(parsed.pathname);
    } catch {
        return /\/Erp\.BO\.FreightServiceSvc\/FreightCarton\/?(?:[?#].*)?$/i.test(String(url || ""));
    }
}

function getKineticLabelContextFromFreightCartonRequest(body, sourceUrl) {
    const freightURL = findCaseInsensitiveDeep(body, "freightURL");
    const quickShipBaseUrl = getQuickShipBaseFromFreightUrl(freightURL);
    const packID = getKineticPackIDFromFreightCartonBody(body);
    if (!freightURL || !quickShipBaseUrl || !packID) return null;
    return {
        sourceSystem: "Kinetic",
        documentType: "label",
        packID,
        kineticPackID: packID,
        freightURL,
        quickShipBaseUrl,
        sourceUrl
    };
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

function getKineticPackIDFromFreightCartonBody(body) {
    const rdt = body && body.rdt;
    const candidates = [
        rdt?.PackInfo?.[0]?.PackID,
        rdt?.OrderInfo?.[0]?.PackID,
        rdt?.OrderLine?.[0]?.PackID,
        rdt?.COO?.[0]?.PackID,
        rdt?.MasterPackInfo?.[0]?.PackID
    ];
    const found = candidates.find(value => {
        const text = String(value ?? "").trim();
        return text && text !== "0";
    });
    if (found != null) return String(found).trim();

    const deepPackId = findCaseInsensitiveDeep(body, "PackID", value => {
        const text = String(value ?? "").trim();
        return text && text !== "0";
    });
    return deepPackId != null ? String(deepPackId).trim() : null;
}

function findCaseInsensitiveDeep(obj, key, predicate = null) {
    let found;
    walkAny(obj, (node) => {
        if (found !== undefined || !node || typeof node !== "object") return;
        const direct = findKey(node, key);
        if (direct === undefined) return;
        if (predicate && !predicate(direct)) return;
        found = direct;
    });
    return found;
}

function walkAny(node, visit) {
    visit(node);
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
        node.forEach(child => walkAny(child, visit));
    } else {
        Object.values(node).forEach(child => walkAny(child, visit));
    }
}

function safeProcessText(txt, url, headers, method = "GET") {
    if (!txt || !url) {
        // console.log("[Quick Ship] Missing text or URL for processing");
        return;
    }

    const urlText = String(url);
    const requestMethod = String(method || "GET").toUpperCase();
    const isOriginalShipShipment = /ShipShipment/i.test(urlText);
    const isShipmentLookup = isDirectShipmentLookupUrl(urlText, requestMethod);
    const isKineticGetByID = isKineticCustShipGetByIDUrl(urlText, requestMethod);

    if (!isOriginalShipShipment && !isShipmentLookup && !isKineticGetByID) {
        return;
    }

    const trimmed = txt.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return;
    }

    try {
        const json = JSON.parse(txt);

        if (isKineticGetByID) {
            const context = getKineticShipmentNumberFromCustShipGetByID(json, urlText);
            if (context && context.shipmentNumber) {
                window.dispatchEvent(new CustomEvent("qs_kinetic_mftransnum_found", {
                    detail: {
                        ...context,
                        kineticBaseUrl: getAppBaseUrl(),
                        kineticAuthHeaders: getAuthHeaders(headers),
                        sourceUrl: urlText,
                        contextSource: "kinetic-custship-getbyid"
                    }
                }));
                console.log("[Quick Ship] Kinetic MFTransNum context found:", {
                    kineticPackID: context.kineticPackID,
                    shipmentNumber: context.shipmentNumber
                });
            }
            return;
        }

        if (isShipmentLookup && !isOriginalShipShipment) {
            const context = getShipmentContextFromShipmentApi(json, urlText);
            if (context && context.shipmentNumber) {
                window.dispatchEvent(new CustomEvent("qs_shipment_context_found", {
                    detail: {
                        ...context,
                        baseUrl: getAppBaseUrl(),
                        authHeaders: getAuthHeaders(headers),
                        sourceUrl: urlText,
                        contextSource: "api/shipments"
                    }
                }));
                console.log("[Quick Ship] Shipment context updated from direct api/shipments lookup:", context.shipmentNumber, {
                    erpSystem: context.erpSystem,
                    erpNumber: context.erpNumber
                });
            }
            return;
        }

        // Original ShipShipment workflow retained.
        const shipmentFailureInfo = getQuickShipFailureInfoFromResponse(json);
        const originalContext = getOriginalShipShipmentContext(json);
        if (shipmentFailureInfo) {
            console.warn("[Quick Ship] ShipShipment response indicated failure; background guard will block label preview.", {
                severityType: shipmentFailureInfo.severityType,
                message: shipmentFailureInfo.message,
                errors: shipmentFailureInfo.errors
            });
        }
        if (originalContext && originalContext.packID) {
            console.log("[Quick Ship] PackID found:", originalContext.packID);
            window.dispatchEvent(new CustomEvent("label_packid_found", {
                detail: {
                    packID: originalContext.packID,
                    shipmentNumber: originalContext.shipmentNumber,
                    erpSystem: originalContext.erpSystem,
                    erpNumber: originalContext.erpNumber,
                    baseUrl: getAppBaseUrl(),
                    authHeaders: getAuthHeaders(headers),
                    shipmentFailure: shipmentFailureInfo || null
                }
            }));
        } else {
             console.log("[Quick Ship] Parsed JSON but PackID not found.");
        }
    } catch (err) {
        console.warn("[Quick Ship] JSON parse error in safeProcessText:", err);
    }
}


function isKineticCustShipGetByIDUrl(url, method = "POST") {
    if (String(method || "POST").toUpperCase() !== "POST") return false;
    try {
        const parsed = new URL(String(url), window.location.href);
        return /\/Erp\.BO\.CustShipSvc\/GetByID\/?$/i.test(parsed.pathname);
    } catch {
        return /\/Erp\.BO\.CustShipSvc\/GetByID\/?(?:[?#].*)?$/i.test(String(url || ""));
    }
}

function getKineticShipmentNumberFromCustShipGetByID(payload, sourceUrl) {
    const resultObj = payload?.returnObj || payload?.ReturnObj || payload?.result?.returnObj || payload?.Result?.ReturnObj || payload;
    const shipHead = resultObj && (resultObj.ShipHead || resultObj.shipHead);
    const rows = Array.isArray(shipHead) ? shipHead : (shipHead ? [shipHead] : []);

    let selected = rows.find(row => {
        const mfTransNum = findKey(row, "MFTransNum");
        return mfTransNum != null && String(mfTransNum).trim() !== "" && String(mfTransNum).trim() !== "0";
    });

    if (!selected && rows.length > 0) selected = rows[0];

    let shipmentNumber = selected ? findKey(selected, "MFTransNum") : undefined;
    let kineticPackID = selected ? findKey(selected, "PackNum") : undefined;

    if (shipmentNumber == null || String(shipmentNumber).trim() === "" || String(shipmentNumber).trim() === "0") {
        shipmentNumber = findCaseInsensitiveDeep(payload, "MFTransNum", value => {
            const text = String(value ?? "").trim();
            return text && text !== "0";
        });
    }
    if (kineticPackID == null || String(kineticPackID).trim() === "" || String(kineticPackID).trim() === "0") {
        kineticPackID = findCaseInsensitiveDeep(payload, "PackNum", value => {
            const text = String(value ?? "").trim();
            return text && text !== "0";
        });
    }

    if (shipmentNumber == null || String(shipmentNumber).trim() === "" || String(shipmentNumber).trim() === "0") return null;

    const cleanShipmentNumber = String(shipmentNumber).trim();
    const cleanPackID = kineticPackID != null ? String(kineticPackID).trim() : null;

    return {
        sourceSystem: "Kinetic",
        documentType: "label",
        packID: cleanPackID,
        kineticPackID: cleanPackID,
        shipmentNumber: cleanShipmentNumber,
        mfTransNum: cleanShipmentNumber,
        sourceUrl
    };
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

function getQuickShipFailureInfoFromResponse(json) {
    if (!json || typeof json !== "object") return null;
    const resultObj = unwrapResult(json);
    const notification = resultObj && (findKey(resultObj, "notificationObject") || findKey(resultObj, "NotificationObject"));
    const severityType = String(notification && (findKey(notification, "severityType") || findKey(notification, "SeverityType")) || "").trim().toUpperCase();
    const notificationMessage = notification && (findKey(notification, "message") || findKey(notification, "Message"));
    const errors = Array.isArray(json.errors) ? json.errors : Array.isArray(json.Errors) ? json.Errors : [];
    const errorMessages = errors
        .map(error => error && (error.message || error.Message))
        .filter(Boolean);
    const isSuccess = Object.prototype.hasOwnProperty.call(json, "isSuccess")
        ? json.isSuccess
        : Object.prototype.hasOwnProperty.call(json, "IsSuccess")
            ? json.IsSuccess
            : undefined;

    const failureSeverityTypes = new Set(["ERROR", "ERR", "FATAL", "CRITICAL"]);
    const hasFailureSeverity = failureSeverityTypes.has(severityType);
    const hasExplicitFailure = isSuccess === false;
    const blockingMessages = getBlockingShipmentErrorMessages(errorMessages);
    const hasBlockingErrors = blockingMessages.length > 0;

    // Some successful ShipShipment responses include errors: [{ message: "Success" }].
    // Do not treat those as failures.
    if (!hasFailureSeverity && !hasExplicitFailure && !hasBlockingErrors) return null;

    return {
        severityType: severityType || (hasExplicitFailure || hasBlockingErrors ? "ERROR" : "UNKNOWN"),
        message: notificationMessage || blockingMessages.join("\n") || "Quick Ship returned a shipment failure.",
        errors: errorMessages
    };
}

function getOriginalShipShipmentContext(json) {
    let resultObj = json?.result || json;
    let shipmentNumber = findKey(resultObj, "shipmentNumber");
    let erpSystem = findKey(resultObj, "erpSystem");
    let erpNumber = findKey(resultObj, "erpNumber");
    let packID = shipmentNumber;

    // Handle nested _body property (potential Angular/Wrapper response)
    if (!packID && json?._body && typeof json._body === 'string') {
        try {
            const inner = JSON.parse(json._body);
            resultObj = inner?.result || inner;
            shipmentNumber = findKey(resultObj, "shipmentNumber");
            erpSystem = findKey(resultObj, "erpSystem");
            erpNumber = findKey(resultObj, "erpNumber");
            packID = shipmentNumber;
        } catch (e) {
            // Ignore parse error for inner body
        }
    }

    if (!packID) return null;
    return { packID, shipmentNumber, erpSystem, erpNumber };
}

function getShipmentContextFromShipmentApi(json, url) {
    const resultObj = unwrapResult(json);
    const shipmentFromUrl = getShipmentNumberFromUrl(url);

    const shipmentNumber =
        findKey(resultObj, "shipmentNumber") ||
        findKey(resultObj, "ShipmentNumber") ||
        findKey(resultObj, "shipmentNo") ||
        findKey(resultObj, "shipmentID") ||
        findKey(resultObj, "shipmentId") ||
        shipmentFromUrl;

    if (!shipmentNumber) return null;

    return {
        packID: String(shipmentNumber).trim(),
        shipmentNumber: String(shipmentNumber).trim(),
        erpSystem: findKey(resultObj, "erpSystem"),
        erpNumber: findKey(resultObj, "erpNumber")
    };
}

function unwrapResult(payload) {
    let resultObj = payload?.result || payload?.Result || payload;
    if (resultObj && resultObj._body && typeof resultObj._body === "string") {
        try {
            const inner = JSON.parse(resultObj._body);
            resultObj = inner?.result || inner?.Result || inner;
        } catch {
            // Ignore nested body parse errors.
        }
    }
    return resultObj;
}

function findKey(obj, key) {
    if (!obj || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    const foundKey = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
    return foundKey ? obj[foundKey] : undefined;
}

function getFetchUrl(args) {
    const input = args && args[0];
    if (input instanceof Request) return input.url;
    return input;
}

function getFetchMethod(args) {
    const input = args && args[0];
    const init = args && args[1];
    if (init && init.method) return init.method;
    if (input instanceof Request && input.method) return input.method;
    return "GET";
}

function processFetchRequestBody(args, url, headers, method) {
    const input = args && args[0];
    const init = args && args[1];
    if (init && typeof init.body === "string") {
        safeProcessRequestText(init.body, url, headers, method);
        return;
    }
    if (!(input instanceof Request)) return;
    try {
        // Read a clone so the page's original one-shot request stream is untouched.
        input.clone().text()
            .then(bodyText => safeProcessRequestText(bodyText, url, headers, method))
            .catch(() => { /* Ignore unreadable or non-text request bodies. */ });
    } catch {
        // Ignore clone failures and allow the page request to continue normally.
    }
}

function getFetchRequestHeaders(args) {
    const headers = {};
    const input = args && args[0];
    const init = args && args[1];

    if (input instanceof Request && input.headers) {
        copyHeaders(input.headers, headers);
    }
    if (init && init.headers) {
        copyHeaders(init.headers, headers);
    }
    return headers;
}

function copyHeaders(source, target) {
    if (!source || !target) return;
    try {
        if (source instanceof Headers) {
            source.forEach((value, key) => { target[key] = value; });
            return;
        }
        if (Array.isArray(source)) {
            for (const [key, value] of source) target[key] = value;
            return;
        }
        if (typeof source === "object") {
            Object.keys(source).forEach(key => { target[key] = source[key]; });
        }
    } catch {
        // Ignore unsupported header shapes.
    }
}

function mergeHeaders(...headerSets) {
    const merged = {};
    for (const set of headerSets) {
        if (!set || typeof set !== "object") continue;
        Object.keys(set).forEach(key => { merged[key] = set[key]; });
    }
    return merged;
}

function getAuthHeaders(headers) {
    const authHeaders = {};
    if (!headers) return authHeaders;
    Object.keys(headers).forEach(k => {
        if (k.toLowerCase() === 'authorization') authHeaders['Authorization'] = headers[k];
        if (k.toLowerCase() === 'registrationcode') authHeaders['Registrationcode'] = headers[k];
    });
    return authHeaders;
}

function getAppBaseUrl() {
    let appBase = window.location.origin;
    const path = window.location.pathname;
    if (path.toLowerCase().includes("/dist/")) {
        const splitIndex = path.toLowerCase().indexOf("/dist/");
        appBase += path.substring(0, splitIndex);
    }
    return appBase;
}

function isDirectShipmentLookupUrl(url, method = "GET") {
    if (String(method || "GET").toUpperCase() !== "GET") return false;
    try {
        const parsed = new URL(String(url), window.location.href);
        return /^\/api\/shipments\/\d+\/?$/i.test(parsed.pathname);
    } catch {
        const path = String(url || "").split(/[?#]/)[0];
        return /\/api\/shipments\/\d+\/?$/i.test(path);
    }
}

function getShipmentNumberFromUrl(url) {
    try {
        const parsed = new URL(String(url), window.location.href);
        const match = parsed.pathname.match(/^\/api\/shipments\/(\d+)\/?$/i);
        return match && match[1] ? decodeURIComponent(match[1]) : null;
    } catch {
        const path = String(url || "").split(/[?#]/)[0];
        const match = path.match(/\/api\/shipments\/(\d+)\/?$/i);
        return match && match[1] ? decodeURIComponent(match[1]) : null;
    }
}
