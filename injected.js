(function() {
    // Flag to prevent double patching if the script is injected multiple times
    if (window.QuickShipInterceptorActive) return;
    window.QuickShipInterceptorActive = true;

    try {
        patchFetch();
        patchXHR();
        console.log("[QuickShip] Network interceptors active.");
    } catch (err) {
        console.error("[QuickShip] Interceptor setup error:", err);
    }
})();

function patchFetch() {
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        const url = (args[0] instanceof Request) ? args[0].url : args[0];

        try {
            // Clone the response to read the body without consuming the original stream
            const clone = response.clone();
            clone.text().then(txt => safeProcessText(txt, url)).catch(err => {
                // Ignore errors related to body reading (e.g. stream locked)
            });
        } catch (err) {
            console.warn("[QuickShip] Fetch intercept warning:", err);
        }

        return response;
    };
}

function patchXHR() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url; // Store URL for debugging if needed
        return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener("load", () => {
            try {
                // Process text or JSON responses
                if (this.responseType === '' || this.responseType === 'text') {
                    safeProcessText(this.responseText, this._url);
                } else if (this.responseType === 'json' && this.response) {
                    try {
                        safeProcessText(JSON.stringify(this.response), this._url);
                    } catch (e) {
                        // Ignore stringify errors (circular structure etc)
                    }
                }
            } catch (err) {
                console.warn("[QuickShip] XHR intercept warning:", err);
            }
        });

        return origSend.apply(this, args);
    };
}

function safeProcessText(txt, url) {
    if (!txt || !url) return;

    // Filter by endpoint: Ensure the URL contains "ShipShipment" (case-insensitive)
    if (!url.match(/ShipShipment/i)) return;

    // Optimization: Only try parsing if it looks like a JSON object containing our target key
    // We check for "shipmentNumber" string existence first to avoid costly JSON.parse on irrelevant requests
    if (!txt.includes('"shipmentNumber"')) return;

    // Simple heuristic to check if it's JSON-like
    const trimmed = txt.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;

    try {
        const json = JSON.parse(txt);
        // Navigate to the specific field we need
        // Support both { result: { shipmentNumber: ... } } and { shipmentNumber: ... }
        let packID = json?.result?.shipmentNumber || json?.shipmentNumber;

        // Handle nested _body property (potential Angular/Wrapper response)
        if (!packID && json?._body && typeof json._body === 'string') {
            try {
                const inner = JSON.parse(json._body);
                packID = inner?.result?.shipmentNumber || inner?.shipmentNumber;
            } catch (e) {
                // Ignore parse error for inner body
            }
        }

        if (packID) {
            console.log("[QuickShip] PackID found:", packID);

            // Determine the App Base URL
            // If the URL is http://host/Instance/dist/#/..., we want http://host/Instance
            let appBase = window.location.origin;
            const path = window.location.pathname;
            if (path.toLowerCase().includes("/dist/")) {
                const parts = path.toLowerCase().split("/dist/");
                // Append the part before /dist/ to the origin. 
                // Ensure we use the original casing from pathname if possible, but split is case-insensitive?
                // Actually, let's just use string slicing to be safe with casing.
                const splitIndex = path.toLowerCase().indexOf("/dist/");
                appBase += path.substring(0, splitIndex);
            }

            window.dispatchEvent(new CustomEvent("label_packid_found", {
                detail: { 
                    packID,
                    baseUrl: appBase
                }
            }));
        }
    } catch (err) {
        // Not valid JSON or structure doesn't match, ignore
    }
}
``
