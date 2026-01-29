function extractLabelData(xml) {
    // Strategies based on carrier specific XML tags
    const strategies = [
        // Complex/Nested paths
        { pattern: /<LabelImage>[\s\S]*?<Bytes>([\s\S]+?)<\/Bytes>[\s\S]*?<\/LabelImage>/, format: "DHL" },
        { pattern: /<Label>[\s\S]*?<Image>([\s\S]+?)<\/Image>[\s\S]*?<\/Label>/,           format: "TNT" },
        { pattern: /<labels>[\s\S]*?<label>([\s\S]+?)<\/label>[\s\S]*?<\/labels>/,         format: "AusPost" },

        // Specific unique tags
        { pattern: /<GraphicImage>([\s\S]+?)<\/GraphicImage>/, format: "UPS" },
        { pattern: /<labelImage>([\s\S]+?)<\/labelImage>/,     format: "LoomisYodel" },
        { pattern: /<labelData>([\s\S]+?)<\/labelData>/,       format: "EVRi" },
        { pattern: /<bolBase64>([\s\S]+?)<\/bolBase64>/,       format: "TForce" },
        
        // Common tags (checked last)
        { pattern: /<Image>([\s\S]+?)<\/Image>/,               format: "FedExEndicia" },
        { pattern: /<label>([\s\S]+?)<\/label>/,               format: "GenericLabel" }
    ];

    for (const { pattern, format } of strategies) {
        const match = xml.match(pattern);
        if (match && match[1]) {
            let data = match[1].trim();
            // Remove CDATA wrapper if present
            if (data.startsWith("<![CDATA[") && data.endsWith("]]>")) {
                data = data.substring(9, data.length - 3);
            }
            return { data: data.trim(), format: format };
        }
    }

    return null;
}

function blobToBase64(blob) {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}

self.extractLabelData = extractLabelData;
// Keep old alias for compatibility if needed, but we will update background.js
self.extractGraphicImage = extractLabelData; 
self.blobToBase64 = blobToBase64;
