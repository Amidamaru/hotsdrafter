const os = require('os');
const path = require('path');
const fs = require('fs');

let configuration = null;

class HotsHelpers {
    static detectGameStorageDir() {
        if(os.platform() === "linux") {
            let username = os.userInfo().username.toString();
            return HotsHelpers.detectGameStorageDirDocuments( path.join(os.homedir(), ".wine", "drive_c", "users", username, "My Documents") )
                || HotsHelpers.detectGameStorageDirDocuments( path.join(os.homedir(), "Documents") );
        } else {
            return HotsHelpers.detectGameStorageDirDocuments( path.join(os.homedir(), "My Documents") )
                || HotsHelpers.detectGameStorageDirDocuments( path.join(os.homedir(), "Documents") );
        }
    }
    static detectGameTempDir() {
        if(os.platform() === "linux") {
            let username = os.userInfo().username.toString();
            return HotsHelpers.detectGameTempDirFolder( path.join(os.homedir(), ".wine", "drive_c", "users", username, "Temp") )
                || HotsHelpers.detectGameTempDirFolder( path.join(os.homedir(), "Games", "battlenet", "drive_c", "users", username, "Temp") )
                || HotsHelpers.detectGameTempDirFolder( path.join(os.homedir(), "Temp") );
        } else {
            return HotsHelpers.detectGameTempDirFolder( path.join(os.homedir(), "Temp") );
        }
    }
    static detectGameStorageDirDocuments(documentFolder) {
        let target = path.join(documentFolder, "Heroes of the Storm");
        if (fs.existsSync(target)) {
            return target;
        }
        return null;
    }
    static detectGameTempDirFolder(documentFolder) {
        let target = path.join(documentFolder, "Heroes of the Storm");
        if (fs.existsSync(target)) {
            return target;
        }
        return null;
    }
    static getStorageDir() {
        let cacheDir = ".";
        if(os.platform() === "linux") {
            cacheDir = path.join(os.homedir(), "/.config/HotsDrafter");
        } else {
            cacheDir = path.join(os.homedir(), "/AppData/Roaming/HotsDrafter");
        }
        return cacheDir;
    }
    static getConfig() {
        const Config = require('./config.js');
        if (configuration === null) {
            configuration = new Config();
        }
        return configuration;
    }
    static debugLog(message) {
        // Only log if debug is enabled in config
        if (HotsHelpers.getConfig().getOption("debugEnabled")) {
            console.log(message);
        }
    }
    static screenshotVirtualScreen(screen, x, y, width, height) {
        let result = Object.assign({}, screen);
        result.offsetX += x;
        result.offsetY += y;
        result.width = width;
        result.height = height;
        result.crop = width+"x"+height+"+"+x+"+"+y;
        return result;
    }
    static imageBackgroundMatch(image, colorMatches, tolerance) {
        if (typeof tolerance === "undefined") {
            tolerance = 2;
        }
        let matchCount = 0;
        let matchesPositive = colorMatches;
        let matchesNegative = [];
        
        // Sample points: center, vertical 1/3 & 2/3, horizontal 1/3 & 2/3
        let samplePoints = [
            { x: Math.floor(image.bitmap.width / 2), y: Math.floor(image.bitmap.height / 2), name: "Center" },
            { x: Math.floor(image.bitmap.width / 2), y: Math.floor(image.bitmap.height / 3), name: "Vertical 1/3" },
            { x: Math.floor(image.bitmap.width / 2), y: Math.floor(2 * image.bitmap.height / 3), name: "Vertical 2/3" },
            { x: Math.floor(image.bitmap.width / 3), y: Math.floor(image.bitmap.height / 2), name: "Horizontal 1/3" },
            { x: Math.floor(2 * image.bitmap.width / 3), y: Math.floor(image.bitmap.height / 2), name: "Horizontal 2/3" }
        ];
        
        for (let point of samplePoints) {
            let match = HotsHelpers.imagePixelMatch(image, point.x, point.y, matchesPositive, matchesNegative);
            if (match) {
                matchCount++;
            }
            //console.log("[imageBackgroundMatch] " + point.name + " (" + point.x + "," + point.y + "): " + (match ? "YES" : "NO"));
        }
        
        let required = (5 - tolerance);
        let result = matchCount >= required;
        //console.log("[imageBackgroundMatch] Total: " + matchCount + " matches, Required: " + required + ", Tolerance: " + tolerance + " => " + (result ? "MATCHED" : "NOT matched"));
        
        return result;
    }
    static imageLockedHeroBackgroundMatch(image, colorMatches, tolerance, teamColor) {
        if (typeof tolerance === "undefined") {
            tolerance = 1;
        }
        if (typeof teamColor === "undefined") {
            teamColor = null;
        }
        let matchCount = 0;
        let matchesPositive = colorMatches;
        let matchesNegative = [];
        
        // Sample points customized for locked heroes - 4 points: left, right, top, bottom middle
        let samplePoints = [
            { x: Math.floor(image.bitmap.width / 4)+2, y: Math.floor(image.bitmap.height / 2), name: "Left Middle" },
            { x: Math.floor(3 * image.bitmap.width / 4) - 2, y: Math.floor(image.bitmap.height / 2), name: "Right Middle" },
            { x: Math.floor(image.bitmap.width / 2), y: Math.floor(image.bitmap.height / 4) + 2, name: "Top Middle" },
            { x: Math.floor(image.bitmap.width / 2), y: Math.floor(3 * image.bitmap.height / 4) - 2, name: "Bottom Middle" }
        ];
        
        if (teamColor === "red") {
            console.log("[imageLockedHeroBackgroundMatch] Image dimensions: " + image.bitmap.width + "x" + image.bitmap.height);
            console.log("[imageLockedHeroBackgroundMatch] Sample Points: " + JSON.stringify(samplePoints));
        }
        
        for (let point of samplePoints) {
            let match = HotsHelpers.imagePixelMatch(image, point.x, point.y, matchesPositive, matchesNegative);
            if (match) {
                matchCount++;
            }
            //console.log("[imageLockedHeroBackgroundMatch] " + point.name + " (" + point.x + "," + point.y + "): " + (match ? "YES" : "NO"));
        }
        
        let required = (4 - tolerance);
        let result = matchCount >= required;
        //console.log("[imageLockedHeroBackgroundMatch] Total: " + matchCount + " matches, Required: " + required + ", Tolerance: " + tolerance + " => " + (result ? "MATCHED" : "NOT matched"));
        
        return result;
    }
    static imageCompare(imageA, imageB, rasterSize) {
        if (typeof rasterSize === "undefined") {
            rasterSize = 1;
        }
        
        // Safety checks
        if (!imageA || !imageA.bitmap || !imageB || !imageB.bitmap) {
            console.log("[imageCompare] ERROR: Invalid image data");
            return 0;
        }
        
        // Check if images have same dimensions
        if (imageA.bitmap.width !== imageB.bitmap.width || imageA.bitmap.height !== imageB.bitmap.height) {
            console.log("[imageCompare] WARNING: Image dimensions don't match. A: " + imageA.bitmap.width + "x" + imageA.bitmap.height + ", B: " + imageB.bitmap.width + "x" + imageB.bitmap.height);
            // Still try to compare, but be careful with bounds
        }
        
        let score = 0;
        let scoreCount = 0;
        let pixelCount = 0;
        
        try {
            for (let x = 0; x < imageA.bitmap.width; x+=rasterSize) {
                for (let y = 0; y < imageA.bitmap.height; y+=rasterSize) {
                    // Make sure we don't go out of bounds on imageB
                    if (x < imageB.bitmap.width && y < imageB.bitmap.height) {
                        let pixelColorA = imageA.getPixelColor(x, y);
                        let pixelColorB = imageB.getPixelColor(x, y);
                        score += HotsHelpers.imagePixelCompare(pixelColorA, pixelColorB);
                        scoreCount++;
                        pixelCount++;
                    }
                }
            }
            
            // Calculate average score
            if (scoreCount > 0) {
                score = score / scoreCount;
            } else {
                console.log("[imageCompare] WARNING: No pixels compared (scoreCount=0)");
                return 0;
            }
            
            return score;
        } catch (error) {
            console.log("[imageCompare] ERROR comparing images: " + error.message);
            return 0;
        }
    }
    static imageFindColor(image, matchesColor) {
        for (let x = 0; x < image.bitmap.width; x++) {
            for (let y = 0; y < image.bitmap.height; y++) {
                if (HotsHelpers.imagePixelMatch(image, x, y, matchesColor, [])) {
                    return true;
                }
            }
        }
        return false;
    }
    static imageCleanupName(image, matchesPositive, matchesNegative, colorPositive, colorNegative) {
        if (typeof matchesNegative === "undefined") {
            matchesNegative = [];
        }
        if (typeof colorPositive === "undefined") {
            colorPositive = 0xFFFFFFFF;
        }
        if (typeof colorNegative === "undefined") {
            colorNegative = 0x000000FF;
        }
        let textMinX = image.bitmap.width-1;
        let textMaxX = 0;
        let textMinY = image.bitmap.height-1;
        let textMaxY = 0;
        for (let x = 0; x < image.bitmap.width; x++) {
            let positive = false;
            let negative = false;
            for (let y = 0; y < image.bitmap.height; y++) {
                let pixelColor = image.getPixelColor(x, y);
                let pixelMatch = HotsHelpers.imagePixelColorMatch(pixelColor, matchesPositive, matchesNegative);
                if (pixelMatch > 0) {
                    image.setPixelColor( HotsHelpers.imageColorMix(colorPositive, colorNegative, pixelMatch / 255), x, y );
                    positive = true;
                    textMinY = Math.min(textMinY, y);
                    textMaxY = Math.max(textMaxY, y);
                } else {
                    image.setPixelColor(colorNegative, x, y);
                }
                if (pixelMatch < 0) {
                    negative = true;
                }
            }
            if (positive && !negative) {
                textMinX = Math.min(textMinX, x);
                textMaxX = Math.max(textMaxX, x);
            }
        }
        textMinX = Math.max(0, textMinX - 8);
        textMaxX = Math.min(image.bitmap.width-1, textMaxX + 8);
        textMinY = Math.max(0, textMinY - 4);
        textMaxY = Math.min(image.bitmap.height-1, textMaxY + 4);
        if (textMaxX < textMinX) {
            return false;
        } else {
            image.crop({ x: textMinX, y: textMinY, w: textMaxX - textMinX, h: textMaxY - textMinY });
            return true;
        }
    }
    static imageOcrOptimize(image) {
        return image.greyscale().contrast(0.4).normalize().blur(1).scale({ f: 0.5 });
    }
    static imagePixelCompare(pixelColorA, pixelColorB) {
        let colorA = { b: (pixelColorA >> 8) & 0xFF, g: (pixelColorA >> 16) & 0xFF, r: (pixelColorA >> 24) & 0xFF };
        let colorB = { b: (pixelColorB >> 8) & 0xFF, g: (pixelColorB >> 16) & 0xFF, r: (pixelColorB >> 24) & 0xFF };
        let colorDiffLum = HotsHelpers.imageColorLumDiff(colorA, colorB);
        let colorDiffHue = HotsHelpers.imageColorHueDiff(colorA, colorB);
        let matchValue = Math.round(
            1 + ((128 - colorDiffLum) * 63 / 128) + (Math.max(0, 90 - colorDiffHue) * 191 / 90)
        );
        return matchValue;
    }
    static imagePixelMatch(image, x, y, matchesPositive, matchesNegative) {
        let pixelColor = image.getPixelColor(x, y);
        return this.imagePixelColorMatch(pixelColor, matchesPositive, matchesNegative)
    }
    static imagePixelColorMatch(pixelColor, matchesPositive, matchesNegative) {
        let color = { a: pixelColor & 0xFF, b: (pixelColor >> 8) & 0xFF, g: (pixelColor >> 16) & 0xFF, r: (pixelColor >> 24) & 0xFF };
        let matchBest = (matchesPositive.length === 0 ? 255 : 0);
        for (let m = 0; m < matchesPositive.length; m++) {
            matchBest = Math.max(
                matchBest, HotsHelpers.imageColorMatch(color, matchesPositive[m].color, matchesPositive[m].toleranceLum, matchesPositive[m].toleranceHue)
            );
        }
        for (let m = 0; m < matchesNegative.length; m++) {
            if (HotsHelpers.imageColorMatch(color, matchesNegative[m].color, matchesNegative[m].toleranceLum, matchesNegative[m].toleranceHue)) {
                matchBest = -1;
                break;
            }
        }
        return matchBest;
    }
    static imageColorAlpha(color, alpha) {
        return color - (color & 0xFF) + alpha;
    }
    static imageColorMix(colorA, colorB, ratio) {
        if (typeof ratio === "undefined") {
            ratio = 0.5;
        }
        if (typeof colorA == "object") {
            return {
                r: Math.round((colorA.r * ratio) + (colorB.r * (1 - ratio))),
                g: Math.round((colorA.g * ratio) + (colorB.g * (1 - ratio))),
                b: Math.round((colorA.b * ratio) + (colorB.b * (1 - ratio)))
            };
        } else {
            return Math.round((colorA & 0xFF) * ratio + (colorB & 0xFF) * (1 - ratio)) +
                (Math.round(((colorA >> 8) & 0xFF) * ratio + ((colorB >> 8) & 0xFF) * (1 - ratio)) << 8) +
                (Math.round(((colorA >> 16) & 0xFF) * ratio + ((colorB >> 16) & 0xFF) * (1 - ratio)) << 16) +
                (Math.round(((colorA >> 24) & 0xFF) * ratio + ((colorB >> 24) & 0xFF) * (1 - ratio)) << 24) >>> 0;

        }
    }
    static imageColorHue(color) {
        let valueMin = Math.min(color.r, color.g, color.b);
        let valueMax = Math.max(color.r, color.g, color.b);
        if (valueMin == valueMax) {
            return 0;
        }
        let hue = 0;
        if (valueMax === color.r) {
            hue = (color.g - color.b) / (valueMax - valueMin);
        }
        if (valueMax === color.g) {
            hue = 2 + (color.b - color.r) / (valueMax - valueMin);
        }
        if (valueMax === color.b) {
            hue = 4 + (color.r - color.g) / (valueMax - valueMin);
        }
        hue *= 60;
        if (hue < 0) {
            hue += 360;
        }
        return hue;
    }
    static imageColorHueDiff(colorA, colorB) {
        let hueA = HotsHelpers.imageColorHue(colorA);
        let hueB = HotsHelpers.imageColorHue(colorB);
        let hueDiff = Math.abs(hueA - hueB);
        if (hueDiff > 180) {
            hueDiff -= 180;
        }
        return Math.abs(hueDiff);
    }
    static imageColorLumDiff(colorA, colorB) {
        return (Math.abs(colorA.r - colorB.r) + Math.abs(colorA.g - colorB.g) + Math.abs(colorA.b - colorB.b)) / 3;
    }
    static imageColorMatch(colorA, colorB, toleranceLum, toleranceHue) {
        if (typeof toleranceHue === "undefined") {
            toleranceHue = toleranceLum;
        }
        let colorDiffLum = HotsHelpers.imageColorLumDiff(colorA, colorB);
        let colorDiffHue = HotsHelpers.imageColorHueDiff(colorA, colorB);
        if ((colorDiffLum <= toleranceLum) && (colorDiffHue <= toleranceHue)) {
            let matchValue = Math.round(
                1 + ((toleranceLum - colorDiffLum) * 127 / toleranceLum) + ((toleranceHue - colorDiffHue) * 127 / toleranceHue)
            );
            return matchValue;
        } else {
            return 0;
        }
    }
    static scaleOffset(source, baseSize, targetSize) {
        let result = Object.assign({}, source);
        result.x = Math.round((source.x / baseSize.x) * targetSize.x);
        result.y = Math.round((source.y / baseSize.y) * targetSize.y);
        return result;
    }
    static logDebug(value, depth) {
        if (typeof depth === "undefined") {
            depth = null;
        }
        console.log(require('util').inspect(value, { depth: depth }));
    }
}

module.exports = HotsHelpers;
