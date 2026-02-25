/**
 * Helper to validate if a string looks like base64 image data.
 * It prevents returning nested XML tags or empty strings.
 */
function isValidBase64(str) {
    if (!str || str.trim().length < 20) return false;
    // Fast check: if it contains XML tags, it's likely a false positive match
    if (/[<>]/.test(str)) return false; 
    // Allow standard base64 characters and whitespace
    return /^[A-Za-z0-9+/=\s]+$/.test(str);
}

function extractLabelData(content) {
    const results = [];
    let detectedFormat = null;

    // 1. JSON Strategy
    if (content && (content.trim().startsWith("{") || content.trim().startsWith("["))) {
        try {
            const json = JSON.parse(content);
            
            const jsonStrategies = [
                { key: "LabelImage", format: "DHL" },
                { key: "GraphicImage", format: "UPS" },
                { key: "labelData", format: "EVRi" },
                { key: "bolBase64", format: "TForce" },
                { key: "Base64LabelImage", format: "Endicia" },
                { key: "Image", format: "FedExEndicia" },
                { key: "label", format: "Loomis" },
                { key: "labels", format: "RoyalMail"},
                { key: "label", format: "GenericLabel" },
                { key: "OutputImage", format: "DHL" },
                { key: "Bytes", format: "DHL" },
                { key: "Data", format: "Purolator" },
                { key: "data", format: "TForce" }
            ];

            const findInJson = (node) => {
                if (!node || typeof node !== 'object') return;
                
                for (const { key, format } of jsonStrategies) {
                    if (Object.prototype.hasOwnProperty.call(node, key)) {
                        const val = node[key];
                        if (typeof val === 'string' && isValidBase64(val)) {
                            results.push(val);
                            if (!detectedFormat) detectedFormat = format;
                        }

                        if (Array.isArray(val)) {
                            for (const item of val) {
                                if (typeof item === 'string' && isValidBase64(item)) {
                                    results.push(item);
                                    if (!detectedFormat) detectedFormat = format;
                                }
                            }
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

    // 2. DOMParser Strategy (Robust, Preferred)
    if (typeof DOMParser !== "undefined") {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(content, "application/xml");
            
            // Check for parse errors (DOMParser returns a document with <parsererror> on failure)
            const parserError = doc.querySelector("parsererror");
            if (!parserError) {
                // Priority list of selectors
                const domStrategies = [
                    // Specific / Nested
                    { selector: "LabelImage Bytes", format: "DHL" },
                    { selector: "Label Image",      format: "TNT" },
                    { selector: "labels label",     format: "AusPost" },
                    { type: "ns", 
                      ns: "http://ws.dto.canshipws.canpar.com/xsd", 
                      selector: "labels",           format: "Canpar" },
                    { selector: "Data",             format: "Purolator" },
                    
                    // Unique Tags
                    { selector: "GraphicImage",     format: "UPS" },
                    { selector: "labelData",        format: "EVRi" },
                    { selector: "bolBase64",        format: "TForce" },
                    { selector: "Base64LabelImage", format: "Endicia" },
                    
                    // Generic (Last resort)
                    { selector: "Image",            format: "FedExEndicia" },
                    { selector: "label",            format: "Loomis" },
                    { selector: "label",            format: "GenericLabel" },
                    { selector: "OutputImage",      format: "DHL" },
                ];

                for (const { selector, format } of domStrategies) {
                    const nodes = doc.querySelectorAll(selector);
                    for (const node of nodes) {
                        // Ensure the node is a leaf (text only) or CDATA, not containing other elements
                        // Note: textContent recursively gets text. We want to avoid grabbing a parent's text.
                        // Checking if it has element children helps.
                        if (node.children.length === 0) {
                            const content = node.textContent.trim();
                            if (isValidBase64(content)) {
                                results.push(content);
                                if (!detectedFormat) detectedFormat = format;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("DOMParser extraction failed or not applicable, falling back to regex.", e);
        }
    }

    // 2. Regex Fallback Strategy (Fragile but necessary for Service Workers/No-DOM envs)
    const regexStrategies = [
        // Complex/Nested paths
        { pattern: /<LabelImage>[\s\S]*?<Bytes>([\s\S]+?)<\/Bytes>[\s\S]*?<\/LabelImage>/i, format: "DHL" },
        { pattern: /<Label>[\s\S]*?<Image>([\s\S]+?)<\/Image>[\s\S]*?<\/Label>/i,           format: "TNT" },
        { pattern: /<labels>[\s\S]*?<label>([\s\S]+?)<\/label>[\s\S]*?<\/labels>/i,         format: "AusPost" },
        { pattern: /<labels\b[^>]*>([\s\S]+?)<\/labels>/i,                                  format: "Canpar" },
        { pattern: /<Data>([\s\S]+?)<\/Data>/i,                                             format: "Purolator" },

        // Specific unique tags
        { pattern: /<GraphicImage>([\s\S]+?)<\/GraphicImage>/i,                       format: "UPS" },
        { pattern: /<labelData>([\s\S]+?)<\/labelData>/i,                             format: "EVRi" },
        { pattern: /<bolBase64>([\s\S]+?)<\/bolBase64>/i,                             format: "TForce" },
        { pattern: /<Base64LabelImage(?: [^>]*)?>([\s\S]+?)<\/Base64LabelImage>/i,    format: "Endicia" },
        
        // Common tags (checked last)
        { pattern: /<Image>([\s\S]+?)<\/Image>/i,                                     format: "FedExEndicia" },
        { pattern: /<label>([\s\S]+?)<\/label>/i,                                     format: "Loomis" },
        { pattern: /<label>([\s\S]+?)<\/label>/i,                                     format: "GenericLabel" },
        { pattern: /<OutputImage>([\s\S]+?)<\/OutputImage>/i,                         format: "DHL" }
    ];

    for (const { pattern, format } of regexStrategies) {
        const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
        const globalRegex = new RegExp(pattern.source, flags);
        let match;
        while ((match = globalRegex.exec(content)) !== null) {
            if (match[1]) {
                let data = match[1].trim();
                if (data.startsWith("<![CDATA[") && data.endsWith("]]>")) {
                    data = data.substring(9, data.length - 3).trim();
                }
                if (isValidBase64(data)) {
                    results.push(data);
                    if (!detectedFormat) detectedFormat = format;
                }
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
// Keep old alias for compatibility if needed
// self.extractGraphicImage = extractLabelData; 
self.blobToBase64 = blobToBase64;