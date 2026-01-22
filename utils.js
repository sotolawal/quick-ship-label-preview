function extractGraphicImage(xml) {
    const match = xml.match(/<GraphicImage>([\s\S]+?)<\/GraphicImage>/);
    return match ? match[1].trim() : null;
}

function blobToBase64(blob) {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}

self.extractGraphicImage = extractGraphicImage;
self.blobToBase64 = blobToBase64;
