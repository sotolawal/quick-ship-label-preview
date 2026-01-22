console.log("Background service worker loaded!");
importScripts("utils.js");

chrome.runtime.onStartup.addListener(() => {
    console.log("Service worker started (onStartup)");
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("Service worker installed (onInstalled)");
});

// Keep the worker alive every 20 seconds
chrome.alarms.create("keepAlive", { periodInMinutes: 0.3 });

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepAlive") {
        console.log("KeepAlive ping");
    }
});

chrome.runtime.onMessage.addListener(async (msg, sender) => {
    if (msg.type === "packID") {
        console.log("BACKGROUND RECEIVED MESSAGE:", msg);
        await handlePackID(msg.packID, msg.baseUrl, sender.tab.id);
    }
});

async function handlePackID(packID, baseUrl, tabId) {
    const sendError = (errMsg) => {
        chrome.tabs.sendMessage(tabId, {
            type: "labelPreview",
            success: false,
            error: errMsg
        });
    };

    try {
        // Construct URL using the dynamic base URL provided by the content script
        // Ensure no trailing slash on baseUrl to match the path structure
        const cleanBase = baseUrl.replace(/\/$/, ""); 
        const xmlUrl = `${cleanBase}/CarrierXmlFile/UPS_APIShipReply__${packID}.xml`;
        console.log("Fetching XML:", xmlUrl);

        // Retry logic for XML fetch (up to 30 attempts * 2s = 60s max wait)
        let xmlResponse;
        let attempts = 0;
        const maxAttempts = 30;

        while (attempts < maxAttempts) {
            try {
                xmlResponse = await fetch(xmlUrl);
                if (xmlResponse.ok) break; // Success!
                // If it's not a 404 (missing file), it might be a real error, but we'll retry anyway
                // just in case it's a transient server issue.
            } catch (e) {
                // Network error, ignore and retry
            }
            
            attempts++;
            if (attempts < maxAttempts) {
                // Silent wait
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (!xmlResponse || !xmlResponse.ok) {
            throw new Error(`Failed to fetch XML after ${maxAttempts} attempts (Status: ${xmlResponse ? xmlResponse.status : 'Network Error'}). Is GenerateXMLFiles set to true?`);
        }

        const xml = await xmlResponse.text();

        // Use helper from utils.js
        const base64 = extractGraphicImage(xml);
        if (!base64) {
            throw new Error("No <GraphicImage> tag found in the XML response.");
        }

        let zpl = "";
        try {
            zpl = atob(base64);
        } catch (err) {
            throw new Error("Failed to decode base64 label data.");
        }

        // Clean ZPL for Labelary
        zpl = zpl.replace(/\r\n/g, "\n")
                 .replace(/\r/g, "\n")
                 .replace(/\0/g, "")
                 .trim();

        if (!zpl) {
            throw new Error("Decoded ZPL data is empty.");
        }

        console.log(`Sending ZPL to Labelary (${zpl.length} bytes)...`);
        
        // Use the correct endpoint with index /0
        // Use application/x-www-form-urlencoded as per docs for raw body
        const labelaryResp = await fetch("https://api.labelary.com/v1/printers/8dpmm/labels/4x6/0", {
            method: "POST",
            headers: { 
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "image/png",
                "X-Rotation": "180"
            },
            body: zpl
        });

        if (!labelaryResp.ok) {
            const errorText = await labelaryResp.text();
            console.error("Labelary API Response:", errorText);
            throw new Error(`Labelary API Error (${labelaryResp.status}): ${errorText || labelaryResp.statusText}`);
        }

        const pngBlob = await labelaryResp.blob();
        const b64png = await blobToBase64(pngBlob);

        // Extract hostname for history
        let website = "";
        try {
            website = new URL(baseUrl).hostname;
        } catch (e) {
            website = baseUrl;
        }

        // Save to History
        await saveToHistory({
            packID: packID,
            website: website,
            timestamp: Date.now(),
            png: b64png
        });

        chrome.tabs.sendMessage(tabId, {
            type: "labelPreview",
            success: true,
            png: b64png
        });

    } catch (err) {
        console.error("Background processing error:", err);
        sendError(err.message || "Unknown error occurred during processing.");
    }
}

async function saveToHistory(item) {
    try {
        const result = await chrome.storage.local.get("labelHistory");
        let history = result.labelHistory || [];
        
        // Remove duplicates if any (based on packID)
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
