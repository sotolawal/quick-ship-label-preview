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

function extractLabelData(xml) {
    // 1. DOMParser Strategy (Robust, Preferred)
    if (typeof DOMParser !== "undefined") {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xml, "application/xml");
            
            // Check for parse errors (DOMParser returns a document with <parsererror> on failure)
            const parserError = doc.querySelector("parsererror");
            if (!parserError) {
                // Priority list of selectors
                const domStrategies = [
                    // Specific / Nested
                    { selector: "LabelImage Bytes", format: "DHL" },
                    { selector: "Label Image",      format: "TNT" },
                    { selector: "labels label",     format: "AusPost" },
                    
                    // Unique Tags
                    { selector: "GraphicImage",     format: "UPS" },
                    { selector: "labelImage",       format: "LoomisYodel" },
                    { selector: "labelData",        format: "EVRi" },
                    { selector: "bolBase64",        format: "TForce" },
                    { selector: "Base64LabelImage", format: "Endicia" },
                    
                    // Generic (Last resort)
                    { selector: "Image",            format: "FedExEndicia" },
                    { selector: "label",            format: "GenericLabel" }
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
                                return { data: content, format: format };
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

        // Specific unique tags
        { pattern: /<GraphicImage>([\s\S]+?)<\/GraphicImage>/i, format: "UPS" },
        { pattern: /<labelImage>([\s\S]+?)<\/labelImage>/i,     format: "LoomisYodel" },
        { pattern: /<labelData>([\s\S]+?)<\/labelData>/i,       format: "EVRi" },
        { pattern: /<bolBase64>([\s\S]+?)<\/bolBase64>/i,       format: "TForce" },
        { pattern: /<Base64LabelImage(?: [^>]*)?>([\s\S]+?)<\/Base64LabelImage>/i,    format: "Endicia" },
        
        // Common tags (checked last)
        { pattern: /<Image>([\s\S]+?)<\/Image>/i,                                     format: "FedExEndicia" },
        { pattern: /<label>([\s\S]+?)<\/label>/i,                                     format: "GenericLabel" }
    ];

    for (const { pattern, format } of regexStrategies) {
        const match = xml.match(pattern);
        if (match && match[1]) {
            let data = match[1].trim();
            // Remove CDATA wrapper if present
            if (data.startsWith("<![CDATA[") && data.endsWith("]]>")) {
                data = data.substring(9, data.length - 3).trim();
            }
            
            // Validate to avoid returning XML fragments or empty strings
            if (isValidBase64(data)) {
                return { data: data, format: format };
            }
        }
    }

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