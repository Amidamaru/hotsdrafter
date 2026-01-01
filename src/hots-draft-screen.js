// Nodejs dependencies
const { Jimp } = require('jimp');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const imghash = require('imghash');

// Local classes
const HotsDraftTeam = require('./hots-draft-team.js');
const HotsDraftPlayer = require('./hots-draft-player.js');
const HotsHelpers = require('./hots-helpers.js');
const TesseractCluster = require('./tesseract-cluster.js');

const ocrCluster = new TesseractCluster(4);

// Data files
const DraftLayout = require('../data/draft-layout-3440x1440');

class HotsDraftScreen extends EventEmitter {

    constructor(app) {
        super();
        this.app = app;
        this.debugData = [];
        this.updateActive = false;
        this.tessLangs = HotsHelpers.getConfig().getTesseractLanguage();
        this.tessParams = {};
        this.offsets = {};
        this.banImages = null;
        this.banHashes = null; // Perceptual hashes for ban images
        this.banActive = false;
        this.screenshot = null;
        this.map = null;
        this.mapLock = 0;
        this.teams = [];
        this.teamActive = null;
        // Update handling
        this.on("update.started", () => {
            this.updateActive = true;
        });
        this.on("update.done", () => {
            this.updateActive = false;
        });
        this.on("update.failed", () => {
            // Nothing yet
        });
    }
    debugEnabled() {
        return HotsHelpers.getConfig().getOption("debugEnabled");
    }
    loadOffsets() {
        let baseSize = DraftLayout["screenSizeBase"];
        let targetSize = { "x": this.screenshot.bitmap.width, "y": this.screenshot.bitmap.height };
        this.offsets["mapSize"] = HotsHelpers.scaleOffset(DraftLayout["mapSize"], baseSize, targetSize);
        this.offsets["mapPos"] = HotsHelpers.scaleOffset(DraftLayout["mapPos"], baseSize, targetSize);
        this.offsets["banSize"] = HotsHelpers.scaleOffset(DraftLayout["banSize"], baseSize, targetSize);
        this.offsets["banSizeCompare"] = HotsHelpers.scaleOffset(DraftLayout["banSizeCompare"], baseSize, targetSize);
        this.offsets["banCheckSize"] = HotsHelpers.scaleOffset(DraftLayout["banCheckSize"], baseSize, targetSize);
        this.offsets["banCropSize"] = HotsHelpers.scaleOffset(DraftLayout["banCropSize"], baseSize, targetSize);
        this.offsets["timerPos"] = HotsHelpers.scaleOffset(DraftLayout["timerPos"], baseSize, targetSize);
        this.offsets["timerSize"] = HotsHelpers.scaleOffset(DraftLayout["timerSize"], baseSize, targetSize);
        this.offsets["playerSize"] = HotsHelpers.scaleOffset(DraftLayout["playerSize"], baseSize, targetSize);
        this.offsets["nameSize"] = HotsHelpers.scaleOffset(DraftLayout["nameSize"], baseSize, targetSize);
        this.offsets["nameHeroSizeRotated"] = HotsHelpers.scaleOffset(DraftLayout["nameHeroSizeRotated"], baseSize, targetSize);
        this.offsets["namePlayerSizeRotated"] = HotsHelpers.scaleOffset(DraftLayout["namePlayerSizeRotated"], baseSize, targetSize);
        this.offsets["teams"] = {};
        for (let team in DraftLayout["teams"]) {
            let players = [];
            for (let i = 0; i < DraftLayout["teams"][team]["players"].length; i++) {
                players.push(HotsHelpers.scaleOffset(DraftLayout["teams"][team]["players"][i], baseSize, targetSize));
            }
            let bans = [];
            for (let i = 0; i < DraftLayout["teams"][team]["bans"].length; i++) {
                bans.push(HotsHelpers.scaleOffset(DraftLayout["teams"][team]["bans"][i], baseSize, targetSize));
            }
            this.offsets["teams"][team] = {
                "players": players,
                "bans": bans,
                "banCheck": HotsHelpers.scaleOffset(DraftLayout["teams"][team]["banCheck"], baseSize, targetSize),
                "banCropPos": HotsHelpers.scaleOffset(DraftLayout["teams"][team]["banCropPos"], baseSize, targetSize),
                "name": HotsHelpers.scaleOffset(DraftLayout["teams"][team]["name"], baseSize, targetSize),
                "nameHeroRotated": HotsHelpers.scaleOffset(DraftLayout["teams"][team]["nameHeroRotated"], baseSize, targetSize),
                "namePlayerRotated": HotsHelpers.scaleOffset(DraftLayout["teams"][team]["namePlayerRotated"], baseSize, targetSize)
            };
        }
    }
    loadBanImages() {
        return new Promise((resolve, reject) => {
            if (this.banImages !== null) {
                resolve(true);
                return;
            }
            this.banImages = {};
            this.banHashes = {};
            // Create cache directory if it does not exist
            let storageDir = HotsHelpers.getStorageDir();
            let banHeroDir = path.join(storageDir, "bans");
            if (!fs.existsSync( banHeroDir )) {
                fs.mkdirSync(banHeroDir, { recursive: true });
            }
            const directoryPathBase = path.join(__dirname, "..", "data", "bans");
            const directoryPathUser = banHeroDir;
            this.loadBanImagesFromDir(directoryPathBase).then(() => {
                return this.loadBanImagesFromDir(directoryPathUser);
            }).then(() => {
                resolve(true);
            }).catch((error) => {
                reject(error);
            });
        });
    }
    loadBanImagesFromDir(directoryPath) {
        return new Promise((resolve, reject) => {
            fs.readdir(directoryPath, async (errorMessage, files) => {
                if (errorMessage) {
                    reject(new Error('Unable to scan directory: ' + errorMessage));
                    return;
                }
                let loadPromises = [];
                files.forEach((file) => {
                    let match = file.match(/^(.+)\.png$/);
                    if (match) {
                        // Load image and calculate hash
                        let heroId = match[1];
                        let filePath = path.join(directoryPath, file);
                        loadPromises.push(
                            Promise.all([
                                Jimp.read(filePath),
                                imghash.hash(filePath)
                            ]).then(([image, hash]) => {
                                this.banImages[heroId] = image.resize({ w: this.offsets["banSizeCompare"].x, h: this.offsets["banSizeCompare"].y });
                                this.banHashes[heroId] = hash;
                                console.log(`[loadBanImages] Loaded ${heroId} (hash: ${hash.substring(0, 8)}...)`);
                            })
                        );
                    }
                });
                if (loadPromises.length === 0) {
                    resolve(true);
                } else {
                    Promise.all(loadPromises).then(() => {
                        console.log(`[loadBanImages] Loaded ${loadPromises.length} hero images with hashes`);
                        resolve(true);
                    }).catch((error) => {
                        reject(error);
                    });
                }
            });
        });
    }
    saveHeroBanImage(heroId, banImageBase64) {
        if (!this.banImages.hasOwnProperty(heroId)) {
            let buffer = Buffer.from(banImageBase64.substr( banImageBase64.indexOf("base64,") + 7 ), 'base64');
            Jimp.read(buffer).then((image) => {
                let banHeroFile = path.join(HotsHelpers.getStorageDir(), "bans", heroId+".png");
                image.write(banHeroFile);
                this.banImages[heroId] = image.resize({ w: this.offsets["banSizeCompare"].x, h: this.offsets["banSizeCompare"].y });
            });
        }
    }
    
    // Helper: Save jimp image to file and return buffer
    async jimpImageToBuffer(jimpImage, tempPath) {
        try {
            // Ensure directory exists
            const dir = path.dirname(tempPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            // Write image to temp file
            jimpImage.write(tempPath);
            // Wait a bit for file system to write
            await new Promise(resolve => setTimeout(resolve, 100));
            // Read file as buffer
            const buffer = fs.readFileSync(tempPath);
            return buffer;
        } catch (error) {
            console.error("[HotsDraftScreen] jimpImageToBuffer error:", error);
            throw error;
        }
    }
    debugDataClear() {
        this.debugData = [];
    }
    debugDataAdd(imgOriginal, imgCleanup, colorsIdent, colorsPositive, colorsNegative, invert) {
        if (!this.debugEnabled()) {
            return;
        }
        let imgOriginalBase64 = null;
        let imgCleanupBase64 = null;
        // Save images to get buffers
        const tempDebugPath1 = "debug/debug_orig_" + Date.now() + ".png";
        const tempDebugPath2 = "debug/debug_clean_" + Date.now() + ".png";
        imgOriginal.write(tempDebugPath1);
        imgCleanup.write(tempDebugPath2);
        imgOriginalBase64 = fs.readFileSync(tempDebugPath1).toString('base64');
        imgCleanupBase64 = fs.readFileSync(tempDebugPath2).toString('base64');
        
        // Push debug data
        this.debugData.push({
            imgOriginal: imgOriginalBase64,
            imgCleanup: imgCleanupBase64,
            colorsIdent: colorsIdent,
            colorsPositive: colorsPositive,
            colorsNegative: colorsNegative,
            colorsInvert: invert
        });
    }
    clear() {
        this.map = null;
        this.teams = [];
        this.emit("change");
    }
    detect(screenshotFile) {
        // Start detection
        return new Promise((resolve, reject) => {
            if (this.updateActive) {
                resolve(false);
                return;
            }
            this.emit("detect.start");
            this.debugDataClear();
            let timeStart = (new Date()).getTime();
            Jimp.read(screenshotFile).then((screenshot) => {
                if (this.debugEnabled()) {
                    console.log("Loaded screenshot after "+((new Date()).getTime() - timeStart)+"ms");
                    timeStart = (new Date()).getTime();
                }
                // Screenshot file loaded
                this.screenshot = screenshot;
                this.emit("detect.screenshot.load.success");
                // Load offsets
                this.loadOffsets();
                // Load images for detecting banned heroes (if not already loaded)
                return this.loadBanImages();
            }).then(() => {
                if (this.debugEnabled()) {
                    console.log("Loaded ban images after "+((new Date()).getTime() - timeStart)+"ms");
                    timeStart = (new Date()).getTime();
                }
                this.emit("detect.ban.images.load.success");
                // Detect draft timer
                this.emit("detect.timer.start");
                return this.detectTimer();
            }).then(() => {
                if (this.debugEnabled()) {
                    console.log("Detected timer after "+((new Date()).getTime() - timeStart)+"ms");
                    timeStart = (new Date()).getTime();
                }
                // Success
                this.emit("detect.timer.success");
                this.emit("change");
                // Detect map text
                this.emit("detect.map.start");
                return this.detectMap();
            }).then((mapName) => {
                if (this.debugEnabled()) {
                    console.log("Detected map name after "+((new Date()).getTime() - timeStart)+"ms");
                    timeStart = (new Date()).getTime();
                }
                // Success
                if (this.getMap() !== mapName) {
                    this.clear();
                    this.setMap(mapName);
                }
                this.emit("detect.map.success");
                this.emit("change");
                // Teams
                this.emit("detect.teams.start");
                return this.detectTeams();
            }).then((teams) => {
                if (this.debugEnabled()) {
                    console.log("Detected teams after "+((new Date()).getTime() - timeStart)+"ms");
                    timeStart = (new Date()).getTime();
                }
                if (this.teams.length === 0) {
                    // Initial detection
                    this.addTeam(teams[0]); // Team blue
                    this.addTeam(teams[1]); // Team red
                    this.emit("detect.teams.new");
                } else {
                    // Update
                    this.emit("detect.teams.update");
                }
                this.emit("detect.teams.success");
                this.emit("detect.success");
                this.emit("detect.done");
                this.emit("change");
                resolve(true);
            }).catch((error) => {
                // Error in the detection chain
                this.emit("detect.error", error);
                this.emit("detect.done");
                reject(error);
            });
        });
    }
    detectMap() {
        return new Promise(async (resolve, reject) => {
            try {
                let mapPos = this.offsets["mapPos"];
                let mapSize = this.offsets["mapSize"];
                console.log("[HotsDraftScreen] detectMap() - Looking for map at pos(" + mapPos.x + "," + mapPos.y + ") size(" + mapSize.x + "x" + mapSize.y + ")");
                let mapNameImg = this.screenshot.clone().crop({ x: mapPos.x, y: mapPos.y, w: mapSize.x, h: mapSize.y });
                let mapNameImgOriginal = mapNameImg.clone();
                
                // Save raw screenshot of map area (ALWAYS for debugging/testing)
                console.log("[HotsDraftScreen] detectMap() - Saving raw map area screenshot to debug/mapName_raw.png");
                mapNameImg.clone().write("debug/mapName_raw.png");
                
                // Cleanup and trim map name
                if (!HotsHelpers.imageCleanupName(mapNameImg, DraftLayout["colors"]["mapName"])) {
                    console.log("[HotsDraftScreen] detectMap() - ERROR: No map text found at expected location");
                    console.log("[HotsDraftScreen] detectMap() - Debug: mapNameColors = " + JSON.stringify(DraftLayout["colors"]["mapName"]));
                    reject(new Error("No map text found at the expected location!"));
                    return;
                }
                // Only once every 20 seconds if already detected to improve performance
                let timeNow = (new Date()).getTime();
                if ((this.map !== null) && (this.mapLock > timeNow)) {
                    resolve(this.getMap());
                    return;
                }
                // Convert to black on white for optimal detection
                mapNameImg = mapNameImg.scale({ f: 2 }).invert();
                mapNameImg = HotsHelpers.imageOcrOptimize(mapNameImg);
                // Debug output (ALWAYS save for testing)
                console.log("[HotsDraftScreen] detectMap() - Saving processed map image to debug/mapName.png");
                mapNameImg.write("debug/mapName.png");
                
                this.debugDataAdd(mapNameImgOriginal, mapNameImg, "mapName", DraftLayout["colors"]["mapName"], [], true);
                // Detect map name using tesseract
                if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - Running OCR on map name image...");
                if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - OCR languages: " + JSON.stringify(this.tessLangs));
                
                // Save the image and read it back for tesseract
                const tempImagePath = "debug/mapName_ocr_temp.png";
                // Wait a bit to ensure file is written
                await new Promise(resolve => setTimeout(resolve, 50));
                mapNameImg.write(tempImagePath);
                // Wait for file to be written before reading
                await new Promise(resolve => setTimeout(resolve, 50));
                
                // Read the saved PNG file and pass buffer to tesseract
                const buffer = fs.readFileSync(tempImagePath);
                
                // Recognize map name using OCR
                const result = await ocrCluster.recognize(buffer, this.tessLangs, this.tessParams);
                if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - OCR result: '" + result.text.trim() + "'");
                let ocrMapName = result.text.trim();
                // If OCR language is not English, try to translate to English
                let mapName = ocrMapName;
                if (this.tessLangs && this.tessLangs[0] !== "eng") {
                    if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - OCR returned non-English result, attempting translation...");
                    let translatedName = this.app.gameData.translateMapName(ocrMapName, this.app.gameData.language, "en-us");
                    if (translatedName) {
                        if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - Translated '" + ocrMapName + "' to '" + translatedName + "'");
                        mapName = translatedName;
                    }
                }
                mapName = this.app.gameData.fixMapName(mapName);
                if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - After fixMapName: '" + mapName + "'");
                if ((mapName !== "") && (this.app.gameData.mapExists(mapName, "en-us"))) {
                    if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - SUCCESS: Found map '" + mapName + "'");
                    this.mapLock = timeNow + 20000;
                    resolve(mapName);
                } else {
                    if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - ERROR: Map name '" + mapName + "' not recognized");
                    reject(new Error("Map name could not be detected!"));
                }
            } catch (error) {
                if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - OCR ERROR caught!");
                if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - Error type: " + typeof error);
                if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - Error: " + JSON.stringify(error));
                if (error) {
                    if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - Error message: " + (error.message || "no message"));
                    if (this.debugEnabled()) console.log("[HotsDraftScreen] detectMap() - Error toString: " + error.toString());
                    if (error.stack && this.debugEnabled()) {
                        console.log("[HotsDraftScreen] detectMap() - Stack: " + error.stack);
                    }
                }
                reject(error);
            }
        });
    }
    detectTimer() {
        return new Promise(async (resolve, reject) => {
            let timerPos = this.offsets["timerPos"];
            let timerSize = this.offsets["timerSize"];
            let timerImg = this.screenshot.clone().crop({ x: timerPos.x, y: timerPos.y, w: timerSize.x, h: timerSize.y }).scale({ f: 0.5 });
           // if (this.debugEnabled()) {
                // Debug output
                timerImg.write("debug/pickTimer.png");
                console.log("[HotsDraftScreen] detectTimer() - Checking timer area at pos(" + timerPos.x + "," + timerPos.y + ") size(" + timerSize.x + "x" + timerSize.y + ")");

            if (HotsHelpers.imageFindColor(timerImg, DraftLayout["colors"]["timer"]["blue"])) {
                // Blue team active
                console.log("[HotsDraftScreen] detectTimer() - Found BLUE team timer");
                this.teamActive = "blue";
                this.banActive = false;
                resolve(true);
                return;
            } else if (HotsHelpers.imageFindColor(timerImg, DraftLayout["colors"]["timer"]["red"])) {
                // Red team active
                console.log("[HotsDraftScreen] detectTimer() - Found RED team timer");
                this.teamActive = "red";
                this.banActive = false;
                resolve(true);
                return;
          } else if (HotsHelpers.imageFindColor(timerImg, DraftLayout["colors"]["timer"]["ban"])) {
                // Banning, check which team is banning
                console.log("[HotsDraftScreen] detectTimer() - Found BAN phase timer");
                let sizeBanCheck = this.offsets["banCheckSize"];
                
                // Check BOTH teams and COUNT matches
                let blueMatchCount = 0;
                let redMatchCount = 0;
                
                for (let color in this.offsets["teams"]) {
                    // Get offsets
                    let teamOffsets = this.offsets["teams"][color];
                    let posBanCheck = teamOffsets["banCheck"];
                    // Check bans
                    let banCheckImg = this.screenshot.clone().crop({ x: posBanCheck.x, y: posBanCheck.y, w: sizeBanCheck.x, h: sizeBanCheck.y }).scale({ f: 0.5 });
                    // Debug output - always save
                    await banCheckImg.write("debug/" + color + "_banCheck.png");

                    console.log(`[HotsDraftScreen] detectTimer() - Checking ${color} team ban area:`);
                    
                    // Sample MORE points to count matches
                    let samplePoints = [
                        { x: Math.floor(banCheckImg.bitmap.width / 2), y: Math.floor(banCheckImg.bitmap.height / 2), name: "Center" },
                        { x: 10, y: 10, name: "Top-Left" },
                        { x: banCheckImg.bitmap.width - 10, y: 10, name: "Top-Right" },
                        { x: 10, y: banCheckImg.bitmap.height - 10, name: "Bottom-Left" },
                        { x: banCheckImg.bitmap.width - 10, y: banCheckImg.bitmap.height - 10, name: "Bottom-Right" },
                        { x: Math.floor(banCheckImg.bitmap.width / 4), y: Math.floor(banCheckImg.bitmap.height / 2), name: "Left-Center" },
                        { x: Math.floor(banCheckImg.bitmap.width * 3 / 4), y: Math.floor(banCheckImg.bitmap.height / 2), name: "Right-Center" }
                    ];
                    
                    let matchCount = 0;
                    for (let point of samplePoints) {
                        let colorHex = banCheckImg.getPixelColor(point.x, point.y);
                        let r = (colorHex >> 24) & 0xFF;
                        let g = (colorHex >> 16) & 0xFF;
                        let b = (colorHex >> 8) & 0xFF;
                        //console.log(`  ${point.name} (${point.x},${point.y}): RGB(${r}, ${g}, ${b})`);
                        
                        // Check if this pixel matches banActive color
                        if (HotsHelpers.imagePixelMatch(banCheckImg, point.x, point.y, DraftLayout["colors"]["banActive"], [])) {
                            matchCount++;
                            console.log(`    -> MATCH!`);
                        }
                    }
                    
                    console.log(`  ${color} team match count: ${matchCount}/${samplePoints.length}`);
                    
                    if (color === "blue") {
                        blueMatchCount = matchCount;
                    } else {
                        redMatchCount = matchCount;
                    }
                }
                
                // Decide based on which team has MORE matches
                console.log(`[HotsDraftScreen] detectTimer() - Blue matches: ${blueMatchCount}, Red matches: ${redMatchCount}`);
                
                if (redMatchCount > blueMatchCount) {
                    console.log("[HotsDraftScreen] detectTimer() - RED team is banning (more matches)");
                    this.teamActive = "red";
                    this.banActive = true;
                    resolve(true);
                    return;
                } else if (blueMatchCount > redMatchCount) {
                    console.log("[HotsDraftScreen] detectTimer() - BLUE team is banning (more matches)");
                    this.teamActive = "blue";
                    this.banActive = true;
                    resolve(true);
                    return;
                } else if (blueMatchCount === redMatchCount && blueMatchCount > 0) {
                    console.log("[HotsDraftScreen] detectTimer() - WARNING: Same match count! Defaulting to blue");
                    this.teamActive = "blue";
                    this.banActive = true;
                    resolve(true);
                    return;
                } else {
                    console.log("[HotsDraftScreen] detectTimer() - ERROR: No team has enough ban indicator matches!");
                    // Fall through to error below
                }
            }
            this.teamActive = null;
            console.log("[HotsDraftScreen] detectTimer() - ERROR: Could not find any timer colors (blue/red/ban)");
            reject(new Error("Failed to detect pick counter"));
        });
    }
    detectTeams() {
        return new Promise(async (resolve, reject) => {
            let teamDetections = [
                this.detectTeam("blue"),
                this.detectTeam("red")
            ];
            Promise.all(teamDetections).then((teams) => {
                resolve(teams);
            }).catch((error) => {
                reject(error);
            });
        });
    }
    detectTeam(color) {
        return new Promise(async (resolve, reject) => {
            console.log("[detectTeam] Starting detection for " + color + " team");
            let team = this.getTeam(color);
            if (team === null) {
                team = new HotsDraftTeam(color);
            }
            let playerPos = this.offsets["teams"][color]["players"];
            let detections = [];
            // Bans
            console.log("[detectTeam] " + color + " - Starting ban detection");
            detections.push( this.detectBans(team) );
            // Players
            for (let i = 0; i < playerPos.length; i++) {
                console.log("[detectTeam] " + color + " - Starting player " + i + " detection");
                detections.push( this.detectPlayer(i, team) );
            }
            console.log("[detectTeam] " + color + " - Waiting for all detections to complete (" + detections.length + " promises)");
            Promise.all(detections).then((result) => {
                console.log("[detectTeam] " + color + " - All detections completed");
                let banResult = result.shift();
                for (let i = 0; i < banResult.names.length; i++) {
                    team.addBan(i, banResult.names[i]);
                }
                for (let i = 0; i < banResult.images.length; i++) {
                    team.addBanImageData(i, banResult.images[i]);
                }
                team.setBansLocked(banResult.locked, (this.debugEnabled() ? banResult.confidence : null));
                if (team.getPlayers().length === 0) {
                    for (let i = 0; i < result.length; i++) {
                        team.addPlayer(result[i]);
                    }
                }
                console.log("[detectTeam] " + color + " - Team detection complete, resolving");
                resolve(team);
            }).catch((error) => {
                console.log("[detectTeam] " + color + " - ERROR in Promise.all: " + error.message);
                reject(error);
            });
        }).then((result) => {
            // Success
            console.log("[detectTeam] " + color + " - Emitting success event");
            this.emit("detect.team.success", color);
            this.emit("change");
            return result;
        }).catch((error) => {
            console.log("[detectTeam] " + color + " - FAILED: " + error.message);
            throw error;
        });
    }
    detectBans(team) {
        return new Promise(async (resolve, reject) => {
            let teamOffsets = this.offsets["teams"][team.getColor()];
            let bans = {
                names: team.getBans().slice(0),
                images: team.getBanImages().slice(0),
                locked: team.getBansLocked()
            };
            let banImageTasks = [];
            // Get offsets
            let posBans = teamOffsets["bans"];
            let sizeBan = this.offsets["banSize"];
            // Check bans
            for (let i = bans.locked; i < posBans.length; i++) {
                let posBan = posBans[i];
                let banImg = this.screenshot.clone().crop({ x: posBan.x, y: posBan.y, w: sizeBan.x, h: sizeBan.y });
                
                // Debug output - always save raw ban image
                banImg.write("debug/" + team.color + "_ban" + i + "_Test.png");
                
                // Check if this ban slot is EMPTY (background only)
                if (HotsHelpers.imageBackgroundMatch(banImg, DraftLayout["colors"]["banBackground"])) {
                    console.log("[" + team.color + "] Ban "+i+": EMPTY (no hero selected yet)");
                    // Ban slot is empty, skip it
                    continue;
                }
                
                // Ban slot has something - try to match hero using perceptual hash
                let banImgCompare = banImg.clone();//.resize({ w: this.offsets["banSizeCompare"].x, h: this.offsets["banSizeCompare"].y });
                const tempBanComparePath = "debug/" + team.color + "_ban" + i + "_TestCompare.png";
                await banImgCompare.write(tempBanComparePath);
                
                // Calculate hash for the ban image
                const banHash = await imghash.hash(tempBanComparePath);
                
                // Helper: Calculate Hamming distance between two hex hashes
                const hammingDistance = (hash1, hash2) => {
                    let distance = 0;
                    for (let i = 0; i < hash1.length; i++) {
                        const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
                        distance += xor.toString(2).split('1').length - 1;
                    }
                    return distance;
                };
                
                let matchBestHero = null;
                let matchBestDistance = Infinity; // Lower is better with hash distance
                let matchSecondDistance = Infinity;
                let heroScores = {};
                
                // Compare hash with all hero hashes
                for (let heroId in this.banHashes) {
                    const distance = hammingDistance(banHash, this.banHashes[heroId]);
                    const score = 100 - distance; // Convert to score (higher is better)
                    heroScores[heroId] = score;
                    
                    if (distance < matchBestDistance) {
                        matchSecondDistance = matchBestDistance;
                        matchBestHero = heroId;
                        matchBestDistance = distance;
                    } else if (distance < matchSecondDistance) {
                        matchSecondDistance = distance;
                    }
                }
                
                let matchBestValue = 100 - matchBestDistance; // For display
                let matchSecondValue = 100 - matchSecondDistance;
                
                // Debug: show all scores
                let topScores = Object.entries(heroScores).sort((a, b) => b[1] - a[1]).slice(0, 5);
                console.log("[" + team.color + "] Ban "+i+" [HASH] Top 5: " + topScores.map(e => e[0] + ":" + e[1].toFixed(2)).join(", "));
                console.log("[" + team.color + "] Ban "+i+" [HASH] Best: " + matchBestHero + " distance:" + matchBestDistance + ", Second: distance:" + matchSecondDistance + ", Threshold: 15");
                console.log("[" + team.color + "] Ban "+i+" [HASH] Ban hash: " + banHash.substring(0, 16) + "...");
                if (matchBestHero) {
                    console.log("[" + team.color + "] Ban "+i+" [HASH] Match hash: " + this.banHashes[matchBestHero].substring(0, 16) + "...");
                }
                
                // Hash distance threshold: 0 = identical, 1-10 = very similar, 11-20 = similar, >20 = different
                if (matchBestHero !== null && matchBestDistance <= 10) {
                    // Additional check: gap between best and second-best must be significant
                    let distanceGap = matchSecondDistance - matchBestDistance;
                    console.log("[" + team.color + "] Ban "+i+": " + matchBestHero + " / distance:" + matchBestDistance + " (gap: " + distanceGap + ")");
                    this.banImages[matchBestHero].write("debug/" + team.color + "_ban" + i + "_BestCompare.png");
                    let heroNameTranslated = (matchBestHero === "_fail" ? "--FAIL--" : this.app.gameData.getHeroName(matchBestHero));
                    console.log("[HeroName DEBUG] Ban " + i + " - matchBestHero: '" + matchBestHero + "', heroNameTranslated: '" + heroNameTranslated + "', previous value: '" + bans.names[i] + "' (empty: " + (heroNameTranslated === "") + ")");
                    if (bans.names[i] !== heroNameTranslated) {
                        console.log("[HeroName DEBUG] Ban " + i + " - Updating from '" + bans.names[i] + "' to '" + heroNameTranslated + "'");
                        bans.names[i] = heroNameTranslated;
                    }
                    // Lock bans that are detected properly and can not change to save detection time
                    if (!this.banActive && (bans.locked == i)) {
                        bans.locked++;
                    }
                } else {
                    console.log("[" + team.color + "] Ban "+i+": no matching hero found (best distance: " + matchBestDistance + ")");
                    bans.names[i] = "???";
                    // Save the ban image and read buffer
                    const tempBanPath = 'debug/banImg_temp_' + i + '.png';
                    await banImg.write(tempBanPath);
                    const buffer = fs.readFileSync(tempBanPath);
                    bans.images[i] = buffer;
                }
            }
            // All ban images handled synchronously
            resolve(bans);
        }).then((result) => {
            // Success
            this.emit("detect.bans.success", team);
            this.emit("change");
            return result;
        });
    }
    detectPlayer(index, team) {
        return new Promise(async (resolve, reject) => {
            let player = team.getPlayer(index);
            if (player === null) {
                player = new HotsDraftPlayer(index, team);
            }
            let teamOffsets = this.offsets["teams"][team.getColor()];
            let colorIdent = team.getColor()+( this.teamActive == team.getColor() ? "-active" : "-inactive" );
            let pickText = DraftLayout.pickText[HotsHelpers.getConfig().getOption("language")];
            // Text detection is more reliable when the team is not currently picking (cleaner background)
            let playerNameFinal = (this.teamActive !== team.getColor());
            // Get offsets
            let posPlayer = teamOffsets["players"][index];
            let posName = teamOffsets["name"];
            let posHeroNameRot = teamOffsets["nameHeroRotated"];
            let posPlayerNameRot = teamOffsets["namePlayerRotated"];
            let sizePlayer = this.offsets["playerSize"];
            let sizeName = this.offsets["nameSize"];
            let sizeHeroNameRot = this.offsets["nameHeroSizeRotated"];
            let sizePlayerNameRot = this.offsets["namePlayerSizeRotated"];
            let detections = [];
            let playerImg = this.screenshot.clone().crop({ x: posPlayer.x, y: posPlayer.y, w: sizePlayer.x, h: sizePlayer.y });
            // Debug output - always save
            playerImg.write("debug/aaa" + team.color + "_player" + index + "_Test.png");
            // Crop name region: from posName, but limit size to playerImg bounds
            let nameW = Math.min(sizeName.x, sizePlayer.x - posName.x);
            let nameH = Math.min(sizeName.y, sizePlayer.y - posName.y);
            let playerImgNameRaw = playerImg.clone().crop({ x: posName.x, y: posName.y, w: nameW, h: nameH }).scale({ f: 4 });
            playerImgNameRaw.write("debug/bbb" + team.color + "_player" + index + "_Test.png");


            detections.push(
                // Hero name detection
                this.detectHeroName(playerImgNameRaw, player, index, team, colorIdent, pickText, detections),
                // Player name detection
                this.detectPlayerName(playerImgNameRaw, player, playerNameFinal, detections, index, team, colorIdent)
            );
            Promise.all(detections).then(() => {
                resolve(player);
            }).catch((error) => {
              reject(error);
          });
        });
    }
    detectHeroName(heroImgName, player, index, team, colorIdent, pickText, detections) {
        return new Promise(async (resolve, reject) => {
            let heroVisible = false;
            let heroLocked = false;
            let teamOffsets = this.offsets["teams"][team.getColor()];
            let nameAngle = DraftLayout["teams"][team.getColor()]["name"]["angle"];
            let posHeroNameRotated = HotsHelpers.scaleOffset(DraftLayout["teams"][team.getColor()]["nameHeroRotated"], DraftLayout["screenSizeBase"], { "x": this.screenshot.bitmap.width, "y": this.screenshot.bitmap.height });
            let sizeHeroNameRotated = this.offsets["nameHeroSizeRotated"];
            
            // Rotate the image first
            let heroImgNameRotated = heroImgName.clone().rotate({ deg: nameAngle, resize: false });
            
            // Then crop the hero name region
            let heroImgNameCropped = heroImgNameRotated.clone().crop({ 
                x: posHeroNameRotated.x, 
                y: posHeroNameRotated.y, 
                w: sizeHeroNameRotated.x, 
                h: sizeHeroNameRotated.y 
            });
            heroImgNameCropped.write("debug/ccc" + team.color + "_player" + index + "_Test.png");

            console.log("active team: ", this.teamActive);
            if (HotsHelpers.imageBackgroundMatch(heroImgNameCropped, DraftLayout["colors"]["heroBackgroundLocked"][colorIdent])) {
                // Hero locked!
                console.log("player: ", team.color, " -", index, " is locked");
                if (HotsHelpers.imageCleanupName(heroImgNameCropped, DraftLayout["colors"]["heroNameLocked"][colorIdent], [], 0x000000FF, 0xFFFFFFFF)) {
                    HotsHelpers.imageOcrOptimize(heroImgNameCropped);
                    heroVisible = true;
                    heroLocked = true;
                }
                this.debugDataAdd(heroImgNameCropped, heroImgNameCropped, "heroNameLocked-"+colorIdent, DraftLayout["colors"]["heroNameLocked"][colorIdent], [], false);
            } else {
                player.setLocked(false);
                // Hero not locked!
                console.log("HERE");
                console.log("player: ", team.color,  " -", index, " is NOT locked");
                if (team.getColor() === "blue") {
                    let heroImgNameCroppedOrg = heroImgNameCropped.clone();
                    if ((colorIdent == "blue-active") && HotsHelpers.imageCleanupName(heroImgNameCropped, DraftLayout["colors"]["heroNamePrepick"][colorIdent+"-picking"])) {
                        HotsHelpers.imageOcrOptimize(heroImgNameCropped.invert());
                        heroVisible = true;
                        console.log("player: ", team.color,  " -", index, " is NOT locked - if blue-active");
                        this.debugDataAdd(heroImgNameCropped, heroImgNameCropped, "heroNamePrepick-"+colorIdent+"-picking", DraftLayout["colors"]["heroNamePrepick"][colorIdent+"-picking"], [], true);
                    } else if (HotsHelpers.imageCleanupName(heroImgNameCroppedOrg, DraftLayout["colors"]["heroNamePrepick"][colorIdent])) {
                        heroImgNameCropped = heroImgNameCroppedOrg;
                        HotsHelpers.imageOcrOptimize(heroImgNameCropped.invert());
                        console.log("player: ", team.color,  " -", index, " is NOT locked - if not blue-active");
                        heroVisible = true;
                        this.debugDataAdd(heroImgNameCropped, heroImgNameCropped, "heroNamePrepick-"+colorIdent, DraftLayout["colors"]["heroNamePrepick"][colorIdent], [], true);
                    }
                    
                console.log("AFTER HERE");
                }
            }
            if (heroVisible) {
                // Detect hero name using tesseract
                let imageHeroName = null;
                const tempHeroPath = "debug/" + team.color + "_player" + index + "_HeroName_temp.png";
                await heroImgNameCropped.write(tempHeroPath);
                const buffer = fs.readFileSync(tempHeroPath);
                detections.push(
                    Promise.resolve(buffer).then((buffer) => {
                        imageHeroName = buffer;
                        return ocrCluster.recognize(buffer, this.tessLangs, this.tessParams);
                    }).then((result) => {
                        if (!result || !result.text) {
                            console.log("[HotsDraftScreen] detectHeroName() - OCR returned null/empty result for " + team.color + " player " + index);
                            return null;
                        }
                        let heroName = this.app.gameData.correctHeroName(result.text.trim());
                        if (heroName !== pickText) {
                            let detectionError = !this.app.gameData.heroExists(heroName);
                            player.setCharacter(heroName, detectionError);
                            player.setImageHeroName(imageHeroName);
                            player.setLocked(heroLocked);
                        }
                        return heroName;
                    }).catch((error) => {
                        console.log("[HotsDraftScreen] detectHeroName() - OCR error for " + team.color + " player " + index + ": " + error.message);
                        return null;
                    })
                )
            }
            resolve(player);
        });
    }
    detectPlayerName(playerImgName, player, playerNameFinal, detections, index, team, colorIdent) {
        return new Promise(async (resolve, reject) => {
            //console.log("[PlayerName] " + team.color + " player " + index + " - Starting detection with colorIdent: " + colorIdent);
            
            // Get rotation angle from layout
            let nameAngle = DraftLayout["teams"][team.getColor()]["name"]["angle"];
            let posPlayerNameRotated = HotsHelpers.scaleOffset(DraftLayout["teams"][team.getColor()]["namePlayerRotated"], DraftLayout["screenSizeBase"], { "x": this.screenshot.bitmap.width, "y": this.screenshot.bitmap.height });
            let sizePlayerNameRotated = this.offsets["namePlayerSizeRotated"];
            
            // Rotate the image first (same as hero name)
            let playerImgNameRotated = playerImgName.clone().rotate({ deg: nameAngle, resize: false });
            
            // Then crop the player name region
            let playerImgNameCropped = playerImgNameRotated.clone().crop({ 
                x: posPlayerNameRotated.x, 
                y: posPlayerNameRotated.y, 
                w: sizePlayerNameRotated.x, 
                h: sizePlayerNameRotated.y 
            });
            
            // Save ORIGINAL rotated/cropped image BEFORE cleanup for debugging
            let beforeCleanupPath = "debug/" + team.color + "_player" + index + "_BEFORE_cleanup.png";
            await playerImgNameRotated.clone().write(beforeCleanupPath);
            //console.log("[PlayerName] " + team.color + " player " + index + " - Saved BEFORE cleanup to: " + beforeCleanupPath);
            
            // Log sample pixels from the image
            let w = playerImgNameCropped.bitmap.width;
            let h = playerImgNameCropped.bitmap.height;
            let samplePoints = [
                { x: Math.floor(w/2), y: Math.floor(h/2), name: "Center" },
                { x: 10, y: 10, name: "Top-Left" },
                { x: w-10, y: 10, name: "Top-Right" }
            ];
            //console.log("[PlayerName] " + team.color + " player " + index + " - Sample pixel colors:");
            for (let point of samplePoints) {
                let colorHex = playerImgNameCropped.getPixelColor(point.x, point.y);
                let r = (colorHex >> 24) & 0xFF;
                let g = (colorHex >> 16) & 0xFF;
                let b = (colorHex >> 8) & 0xFF;
                //console.log("  " + point.name + " (" + point.x + "," + point.y + "): RGB(" + r + ", " + g + ", " + b + ")");
            }
            
            // Log the colors we're looking for
            //console.log("[PlayerName] " + team.color + " player " + index + " - Expected colors for colorIdent '" + colorIdent + "':");
            console.log("  playerName colors: " + JSON.stringify(DraftLayout["colors"]["playerName"][colorIdent]));
            console.log("  boost colors: " + JSON.stringify(DraftLayout["colors"]["boost"]));
            
            let playerImgNameOriginal = (this.debugEnabled() ? playerImgNameCropped.clone() : null);
            let cleanupResult = HotsHelpers.imageCleanupName(
                playerImgNameCropped, DraftLayout["colors"]["playerName"][colorIdent], DraftLayout["colors"]["boost"]
            );
            
            //console.log("[PlayerName] " + team.color + " player " + index + " - imageCleanupName returned: " + cleanupResult);
            
            if (!cleanupResult) {
                // Log the error but continue - player name detection may fail on some frames
                //console.log("[PlayerName] " + team.color + " player " + index + " - Image cleanup FAILED (colorIdent: " + colorIdent + ")");
                if (this.debugEnabled()) {
                    console.log("[Detection] Player name cleanup failed for " + team.color + " player " + index + " - skipping OCR");
                }
                // Don't set a name, just continue to next detection
                resolve(player);
                return;
            }
            //console.log("[PlayerName] " + team.color + " player " + index + " - Image cleanup OK, running OCR...");
            HotsHelpers.imageOcrOptimize(playerImgNameCropped.invert());
            this.debugDataAdd(playerImgNameOriginal, playerImgNameCropped, "playerName-"+colorIdent, DraftLayout["colors"]["playerName"][colorIdent], DraftLayout["colors"]["boost"], true);
            // Debug output - always save
            playerImgNameCropped.write("debug/" + team.color + "_player" + index + "_PlayerNameTest.png");
            // Detect player name using tesseract
            let imagePlayerName = null;
            const tempPlayerPath = "debug/" + team.color + "_player" + index + "_PlayerName_temp.png";
            await playerImgNameCropped.write(tempPlayerPath);
            const playerBuffer = fs.readFileSync(tempPlayerPath);
            detections.push(
                Promise.resolve(playerBuffer).then((buffer) => {
                    imagePlayerName = buffer;
                    return ocrCluster.recognize(buffer, this.tessLangs+"+lat+rus+kor", this.tessParams);
                }).then((result) => {
                    if (!result || !result.text) {
                        // console.log("[PlayerName OCR] " + team.color + " player " + index + " - OCR returned null/empty result");
                        return null;
                    }
                    let playerName = result.text.trim();
                    // console.log("[PlayerName OCR] " + team.color + " player " + index + " - RAW: '" + playerName + "' (confidence: " + result.confidence + ")");
                    // console.log("[PlayerName OCR] " + team.color + " player " + index + " - Image saved to: debug/" + team.color + "_player" + index + "_PlayerNameTest.png");
                    player.setName(playerName, playerNameFinal);
                    player.setImagePlayerName(imagePlayerName);
                    this.app.gameData.updatePlayerRecentPicks(player);
                    return playerName;
                }).catch((error) => {
                    // console.log("[PlayerName OCR] " + team.color + " player " + index + " - ERROR: " + error.message);
                    return null;
                })
            );
            resolve(player);
        });
    }
    addTeam(team) {
        this.teams.push(team);
        team.on("change", () => {
            this.emit("team.updated", this);
            this.emit("change");
        });
    }
    /**
     * @returns {string|null}
     */
    getMap() {
        return this.map;
    }
    getTeam(color) {
        for (let i = 0; i < this.teams.length; i++) {
            if (this.teams[i].getColor() === color) {
                return this.teams[i];
            }
        }
        return null;
    }
    getTeamActive() {
        return this.teamActive;
    }
    getTeams() {
        return this.teams;
    }
    setMap(mapName) {
        console.log(mapName);
        this.map = mapName;
    }
    updateLanguage() {
        this.tessLangs = HotsHelpers.getConfig().getTesseractLanguage();
    }


}

module.exports = HotsDraftScreen;
