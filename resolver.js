(function exposeResolverUtils(root) {
    function normalizeLookupValue(value) {
        const text = String(value ?? "").trim();
        if (!text || text === "0" || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") {
            return null;
        }
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

    function resolveQuickShipResourceUrl(value, effectiveBase, configuredBase = effectiveBase) {
        try {
            const effective = new URL(String(effectiveBase || ""));
            let resolved = new URL(String(value || ""), `${effective.href.replace(/\/$/, "")}/`);
            if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return "";

            const configured = new URL(String(configuredBase || effectiveBase || ""));
            if (resolved.origin.toLowerCase() === configured.origin.toLowerCase()
                && resolved.origin.toLowerCase() !== effective.origin.toLowerCase()) {
                resolved = new URL(`${resolved.pathname}${resolved.search}${resolved.hash}`, effective.origin);
            }
            return resolved.href;
        } catch {
            return "";
        }
    }

    const api = {
        normalizeLookupValue,
        escapeRegex,
        fileNameHasLookupToken,
        resolveQuickShipResourceUrl
    };

    root.QuickShipResolverUtils = api;

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof self !== "undefined" ? self : globalThis);
