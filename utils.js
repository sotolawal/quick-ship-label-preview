/* Helper to validate if a string looks like base64 image/document data. It prevents returning nested XML tags or empty strings. */
function isValidBase64(str) {
    if (!str || str.trim().length < 20) return false;
    if (/[<>]/.test(str)) return false;
    if (str.includes(" ") && !str.includes("\n") && !str.includes("\r")) {
        const spaceCount = (str.match(/ /g) || []).length;
        if (spaceCount > 2) return false;
    }
    return /^[A-Za-z0-9+/=\s]+$/.test(str);
}

function normalizeBase64Candidate(value) {
    return String(value || "")
        .trim()
        .replace(/^data:[^;]+;base64,/i, "")
        .replace(/\s/g, "");
}

function extractLabelData(content) {
    const results = [];
    let detectedFormat = null;

    const jsonStrategies = [
        { key: "LabelImage", format: "DHL" },
        { key: "GraphicImage", format: "UPS" },
        { key: "InternationalSignatureGraphicImage", format: "UPS" },
        { key: "labelData", format: "EVRi" },
        { key: "bolBase64", format: "TForce" },
        { key: "Base64LabelImage", format: "Endicia" },
        { key: "Image", format: "FedExEndicia" },
        { key: "label", format: "Loomis" },
        { key: "labels", format: "RoyalMail" },
        { key: "label", format: "GenericLabel" },
        { key: "OutputImage", format: "DHL" },
        { key: "Bytes", format: "DHL" },
        { key: "Data", format: "Purolator" },
        { key: "data", format: "TForce" }
    ];

    const addCandidate = (value, format) => {
        if (typeof value !== "string") return;
        const clean = normalizeBase64Candidate(value);
        if (isValidBase64(clean)) {
            results.push(clean);
            if (!detectedFormat) detectedFormat = format;
        }
    };

    // JSON Strategy
    if (content && (content.trim().startsWith("{") || content.trim().startsWith("["))) {
        try {
            const json = JSON.parse(content);
            const findInJson = (node) => {
                if (!node || typeof node !== "object") return;
                for (const { key, format } of jsonStrategies) {
                    if (Object.prototype.hasOwnProperty.call(node, key)) {
                        const val = node[key];
                        addCandidate(val, format);
                        if (Array.isArray(val)) {
                            for (const item of val) addCandidate(item, format);
                        }
                    }
                }
                if (Array.isArray(node)) {
                    node.forEach(child => findInJson(child));
                } else {
                    Object.values(node).forEach(child => findInJson(child));
                }
            };
            findInJson(json);
        } catch (e) {
            console.warn("JSON parse failed, falling back to XML/Regex", e);
        }
    }

    // Example: {"GraphicImage":"..."}{"GraphicImage":"..."} or several pretty-printed objects pasted together.
    for (const { key, format } of jsonStrategies) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const jsonStringPattern = new RegExp(`"${escapedKey}"\\s*:\\s*"([A-Za-z0-9+/=\\r\\n\\t ]{20,})"`, "gi");
        let jsonMatch;
        while ((jsonMatch = jsonStringPattern.exec(content || "")) !== null) {
            addCandidate(jsonMatch[1], format);
        }
    }

    // DOMParser Strategy
    if (typeof DOMParser !== "undefined") {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(content, "application/xml");
            const parserError = doc.querySelector("parsererror");
            if (!parserError) {
                const domStrategies = [
                    { selector: "LabelImage Bytes", format: "DHL" },
                    { selector: "Label Image", format: "TNT" },
                    { selector: "labels label", format: "AusPost" },
                    { type: "ns", ns: "http://ws.dto.canshipws.canpar.com/xsd", selector: "labels", format: "Canpar" },
                    { selector: "Data", format: "Purolator" },
                    { selector: "GraphicImage", format: "UPS" },
                    { selector: "InternationalSignatureGraphicImage", format: "UPS" },
                    { selector: "labelData", format: "EVRi" },
                    { selector: "bolBase64", format: "TForce" },
                    { selector: "Base64LabelImage", format: "Endicia" },
                    { selector: "Image", format: "FedExEndicia" },
                    { selector: "label", format: "Loomis" },
                    { selector: "label", format: "GenericLabel" },
                    { selector: "OutputImage", format: "DHL" }
                ];
                for (const { selector, format } of domStrategies) {
                    const nodes = doc.querySelectorAll(selector);
                    for (const node of nodes) {
                        if (node.children.length === 0) {
                            addCandidate(node.textContent, format);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("DOMParser extraction failed or not applicable, falling back to regex.", e);
        }
    }

    // Regex Fallback Strategy
    const regexStrategies = [
        { pattern: /<LabelImage>[\s\S]*?<Bytes>([\s\S]+?)<\/Bytes>[\s\S]*?<\/LabelImage>/i, format: "DHL" },
        { pattern: /<Label>[\s\S]*?<Image>([\s\S]+?)<\/Image>[\s\S]*?<\/Label>/i, format: "TNT" },
        { pattern: /<labels>[\s\S]*?<label>([\s\S]+?)<\/label>[\s\S]*?<\/labels>/i, format: "AusPost" },
        { pattern: /<labels\b[^>]*>([\s\S]+?)<\/labels>/i, format: "Canpar" },
        { pattern: /<Data>([\s\S]+?)<\/Data>/i, format: "Purolator" },
        { pattern: /<GraphicImage>([\s\S]+?)<\/GraphicImage>/i, format: "UPS" },
        { pattern: /<InternationalSignatureGraphicImage>([\s\S]+?)<\/InternationalSignatureGraphicImage>/i, format: "UPS" },
        { pattern: /<labelData>([\s\S]+?)<\/labelData>/i, format: "EVRi" },
        { pattern: /<bolBase64>([\s\S]+?)<\/bolBase64>/i, format: "TForce" },
        { pattern: /<Base64LabelImage(?: [^>]*)?>([\s\S]+?)<\/Base64LabelImage>/i, format: "Endicia" },
        { pattern: /<Image>([\s\S]+?)<\/Image>/i, format: "FedExEndicia" },
        { pattern: /<label>([\s\S]+?)<\/label>/i, format: "Loomis" },
        { pattern: /<label>([\s\S]+?)<\/label>/i, format: "GenericLabel" },
        { pattern: /<OutputImage>([\s\S]+?)<\/OutputImage>/i, format: "DHL" }
    ];

    for (const { pattern, format } of regexStrategies) {
        const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
        const globalRegex = new RegExp(pattern.source, flags);
        let match;
        while ((match = globalRegex.exec(content || "")) !== null) {
            if (match[1]) {
                let data = match[1].trim();
                if (data.startsWith("<![CDATA[") && data.endsWith("]]>") ) {
                    data = data.substring(9, data.length - 3).trim();
                }
                addCandidate(data, format);
            }
        }
    }

    // Raw Base64 Fallback Strategy
    if (results.length === 0) {
        const trimmed = normalizeBase64Candidate(content);
        if (isValidBase64(trimmed)) {
            return { data: [trimmed], format: "RawBase64" };
        }

        // Loose Extraction Strategy
        const cleanContent = (content || "").replace(/\s/g, "");
        const candidates = cleanContent.match(/[A-Za-z0-9+/=]{100,}/g);
        if (candidates) {
            candidates.sort((a, b) => b.length - a.length);
            for (let candidate of candidates) {
                const paddingIndex = candidate.indexOf("=");
                if (paddingIndex !== -1) {
                    const end = candidate[paddingIndex + 1] === "=" ? paddingIndex + 2 : paddingIndex + 1;
                    candidate = candidate.substring(0, end);
                }
                addCandidate(candidate, "ScrubbedBase64");
            }
        }
    }

    const unique = [...new Set(results)];
    if (unique.length > 0) return { data: unique, format: detectedFormat };
    return null;
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

self.extractLabelData = extractLabelData;
// Old alias for compatibility if needed
// self.extractGraphicImage = extractLabelData;
self.blobToBase64 = blobToBase64;
