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
        // console.log("XHR open called with URL:", url);
        const result = origOpen.apply(this, arguments);
        // console.log("XHR open applied");
        return result;
    };
    XHR.send = function(...args) {
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

function safeProcessText(txt, url, headers, method = "GET") {
    if (!txt || !url) {
        // console.log("[Quick Ship] Missing text or URL for processing");
        return;
    }

    const urlText = String(url);
    const requestMethod = String(method || "GET").toUpperCase();
    const isOriginalShipShipment = /ShipShipment/i.test(urlText);
    const isShipmentLookup = isDirectShipmentLookupUrl(urlText, requestMethod);

    if (!isOriginalShipShipment && !isShipmentLookup) {
        return;
    }

    const trimmed = txt.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return;
    }

    try {
        const json = JSON.parse(txt);

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
        const originalContext = getOriginalShipShipmentContext(json);
        if (originalContext && originalContext.packID) {
            console.log("[Quick Ship] PackID found:", originalContext.packID);
            window.dispatchEvent(new CustomEvent("label_packid_found", {
                detail: {
                    packID: originalContext.packID,
                    shipmentNumber: originalContext.shipmentNumber,
                    erpSystem: originalContext.erpSystem,
                    erpNumber: originalContext.erpNumber,
                    baseUrl: getAppBaseUrl(),
                    authHeaders: getAuthHeaders(headers)
                }
            }));
        } else {
             console.log("[Quick Ship] Parsed JSON but PackID not found.");
        }
    } catch (err) {
        console.warn("[Quick Ship] JSON parse error in safeProcessText:", err);
    }
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
