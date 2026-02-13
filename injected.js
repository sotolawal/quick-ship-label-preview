(function() {
    // We no longer return early if Active is set, to allow re-patching with new logic.
    // However, we rely on stored original functions to avoid stacking.
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
        const url = (args[0] instanceof Request) ? args[0].url : args[0];
        // console.log("Processing fetch response for URL:", url);

        try {
            // Clone the response to read the body without consuming the original stream     
            // console.log("Attemting to clone response...")    
        const clone = response.clone();
            /* console.debug("[Quick Ship] Fetch seen", {
                requestUrl: url,
                finalUrl: response.url,
                status: response.status,
                redirected: response.redirected,
                contentType: response.headers.get("content-type")
            }); */
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
                        safeProcessText(this.responseText, this._url, this._headers);
                    } else if (this.responseType === 'json' && this.response) {
                        try {
                            safeProcessText(JSON.stringify(this.response), this._url, this._headers);
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

function safeProcessText(txt, url, headers) {
    if (!txt || !url) {
        // console.log("[Quick Ship] Missing text or URL for processing");
        return;
    };
    // Filter by endpoint: Ensure the URL contains "ShipShipment" (case-insensitive)
    if (!url.match(/ShipShipment/i)) {
        // console.log("[Quick Ship] URL does not match ShipShipment pattern");
        return;
    }

    // Removed strict string check optimization to prevent false negatives with formatting/casing
    // if (!txt.includes('"shipmentNumber"')) return;

    // Simple heuristic to check if it's JSON-like
    const trimmed = txt.trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            /* console.debug("[Quick Ship] Non-JSON response", {
                url,
                startsWith: trimmed.slice(0, 30),
                length: trimmed.length
            }); */
            return;
        }

    try {
        const json = JSON.parse(txt);
        
        // Helper to find value case-insensitively in an object
        const findKey = (obj, key) => {
            if (!obj || typeof obj !== 'object') return undefined;
            // Direct check first
            if (obj[key]) return obj[key];
            // Case-insensitive check
            const foundKey = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
            return foundKey ? obj[foundKey] : undefined;
        };

        // Navigate to the specific field we need
        // Support both { result: { shipmentNumber: ... } } and { shipmentNumber: ... }
        // Also try PascalCase "ShipmentNumber" just in case
        let resultObj = json?.result || json;
        let packID = findKey(resultObj, "shipmentNumber");

        // Handle nested _body property (potential Angular/Wrapper response)
        if (!packID && json?._body && typeof json._body === 'string') {
            try {
                const inner = JSON.parse(json._body);
                resultObj = inner?.result || inner;
                packID = findKey(resultObj, "shipmentNumber");
            } catch (e) {
                // Ignore parse error for inner body
            }
        }

        if (packID) {
            console.log("[Quick Ship] PackID found:", packID);

            // Determine the App Base URL
            // If the URL is http://host/Instance/dist/#/..., we want http://host/Instance
            let appBase = window.location.origin;
            const path = window.location.pathname;
            if (path.toLowerCase().includes("/dist/")) {
                // Append the part before /dist/ to the origin. 
                const splitIndex = path.toLowerCase().indexOf("/dist/");
                appBase += path.substring(0, splitIndex);
            }

            const authHeaders = {};
            if (headers) {
                Object.keys(headers).forEach(k => {
                    if (k.toLowerCase() === 'authorization') authHeaders['Authorization'] = headers[k];
                    if (k.toLowerCase() === 'registrationcode') authHeaders['Registrationcode'] = headers[k];
                });
            }

            window.dispatchEvent(new CustomEvent("label_packid_found", {
                detail: { 
                    packID,
                    baseUrl: appBase,
                    authHeaders
                }
            }));
        } else {
             // Log if we expected something but didn't find it (helpful for debugging)
             // Only log if we are fairly sure it's a shipment response
             console.log("[Quick Ship] Parsed JSON but PackID not found. Keys in result:", resultObj ? Object.keys(resultObj) : "null");
        }
    } catch (err) {
        console.warn("[Quick Ship] JSON parse error in safeProcessText:", err);
    }
}
``
