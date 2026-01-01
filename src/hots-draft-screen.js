// Nodejs dependencies
const { Jimp } = require('jimp');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

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
            fs.readdir(directoryPath, (errorMessage, files) => {
                if (errorMessage) {
                    reject(new Error('Unable to scan directory: ' + errorMessage));
                    return;
                }
                let loadPromises = [];
                files.forEach((file) => {
                    let match = file.match(/^(.+)\.png$/);
                    if (match) {
                        // Load image
                        let heroId = match[1];
                        loadPromises.push(
                            Jimp.read(directoryPath+"/"+file).then(async (image) => {
                                this.banImages[heroId] = image.resize({ w: this.offsets["banSizeCompare"].x, h: this.offsets["banSizeCompare"].y });
                            })
                        );
                    }
                });
                if (loadPromises.length === 0) {
                    resolve(true);
                } else {
                    Promise.all(loadPromises).then(() => {
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
                for (let color in this.offsets["teams"]) {
                    // Get offsets
                    let teamOffsets = this.offsets["teams"][color];
                    let posBanCheck = teamOffsets["banCheck"];
                    // Check bans
                    let banCheckImg = this.screenshot.clone().crop({ x: posBanCheck.x, y: posBanCheck.y, w: sizeBanCheck.x, h: sizeBanCheck.y }).scale({ f: 0.5 });
                    // Debug output - always save
                    banCheckImg.write("debug/111"+color+"_banCheck.png");

                                   console.log(`[HotsDraftScreen] detectTimer() - Checking ${color} team ban area:`);
                let samplePoints = [
                    { x: Math.floor(banCheckImg.bitmap.width / 2), y: Math.floor(banCheckImg.bitmap.height / 2), name: "Center" },
                    { x: 10, y: 10, name: "Top-Left" }
                ];
                for (let point of samplePoints) {
                    let colorHex = banCheckImg.getPixelColor(point.x, point.y);
                    let r = (colorHex >> 24) & 0xFF;
                    let g = (colorHex >> 16) & 0xFF;
                    let b = (colorHex >> 8) & 0xFF;
                    console.log(`  ${point.name} (${point.x},${point.y}): RGB(${r}, ${g}, ${b})`);
                }
                console.log(`  Looking for banActive colors:`, JSON.stringify(DraftLayout["colors"]["banActive"]));
                
                
                    if (HotsHelpers.imageFindColor(banCheckImg, DraftLayout["colors"]["banActive"])) {
                        console.log("[HotsDraftScreen] detectTimer() - Found " + color + " team banning");
                        this.teamActive = color;
                        this.banActive = true;
                        resolve(true);
                        return;
                    }
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
            let team = this.getTeam(color);
            if (team === null) {
                team = new HotsDraftTeam(color);
            }
            let playerPos = this.offsets["teams"][color]["players"];
            let detections = [];
            // Bans
            detections.push( this.detectBans(team) );
            // Players
            for (let i = 0; i < playerPos.length; i++) {
                detections.push( this.detectPlayer(i, team) );
            }
            Promise.all(detections).then((result) => {
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
                resolve(team);
            });
        }).then((result) => {
            // Success
            this.emit("detect.team.success", color);
            this.emit("change");
            return result;
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
                if (!HotsHelpers.imageBackgroundMatch(banImg, DraftLayout["colors"]["banBackground"])) {
                    let banImgCompare = banImg.clone().resize({ w: this.offsets["banSizeCompare"].x, h: this.offsets["banSizeCompare"].y });
                    // Debug output - always save
                    banImg.write("debug/" + team.color + "_ban" + i + "_Test.png");
                    banImgCompare.write("debug/" + team.color + "_ban" + i + "_TestCompare.png");
                    let matchBestHero = null;
                    let matchBestValue = 180;
                    for (let heroId in this.banImages) {
                        let heroValue = HotsHelpers.imageCompare(banImgCompare, this.banImages[heroId]);
                        if (heroValue > matchBestValue) {
                            matchBestHero = heroId;
                            matchBestValue = heroValue;
                        }
                    }
                    if (matchBestHero !== null) {
                        // Debug output - always save
                        console.log("Ban "+i+": "+matchBestHero+" / "+matchBestValue);
                        this.banImages[matchBestHero].write("debug/" + team.color + "_ban" + i + "_BestCompare.png");
                        let heroNameTranslated = (matchBestHero === "_fail" ? "--FAIL--" : this.app.gameData.getHeroName(matchBestHero));
                        if (bans.names[i] !== heroNameTranslated) {
                            bans.names[i] = heroNameTranslated;
                        }
                        // Lock bans that are detected properly and can not change to save detection time
                        if (!this.banActive && (bans.locked == i)) {
                            bans.locked++;
                        }
                    } else {
                        bans.names[i] = "???";
                        // Save the ban image and read buffer
                        const tempBanPath = 'debug/banImg_temp_' + i + '.png';
                        await banImg.write(tempBanPath);
                        const buffer = fs.readFileSync(tempBanPath);
                        bans.images[i] = buffer;
                    }
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
                console.log("player: ", team.color, " is locked");
                if (HotsHelpers.imageCleanupName(heroImgNameCropped, DraftLayout["colors"]["heroNameLocked"][colorIdent], [], 0x000000FF, 0xFFFFFFFF)) {
                    HotsHelpers.imageOcrOptimize(heroImgNameCropped);
                    heroVisible = true;
                    heroLocked = true;
                }
                this.debugDataAdd(heroImgNameCropped, heroImgNameCropped, "heroNameLocked-"+colorIdent, DraftLayout["colors"]["heroNameLocked"][colorIdent], [], false);
            } else {
                player.setLocked(false);
                // Hero not locked!
                console.log("player: ", team.color, " is NOT locked");
                if (team.getColor() === "blue") {
                    let heroImgNameCroppedOrg = heroImgNameCropped.clone();
                    if ((colorIdent == "blue-active") && HotsHelpers.imageCleanupName(heroImgNameCropped, DraftLayout["colors"]["heroNamePrepick"][colorIdent+"-picking"])) {
                        HotsHelpers.imageOcrOptimize(heroImgNameCropped.invert());
                        heroVisible = true;
                        this.debugDataAdd(heroImgNameCropped, heroImgNameCropped, "heroNamePrepick-"+colorIdent+"-picking", DraftLayout["colors"]["heroNamePrepick"][colorIdent+"-picking"], [], true);
                    } else if (HotsHelpers.imageCleanupName(heroImgNameCroppedOrg, DraftLayout["colors"]["heroNamePrepick"][colorIdent])) {
                        heroImgNameCropped = heroImgNameCroppedOrg;
                        HotsHelpers.imageOcrOptimize(heroImgNameCropped.invert());
                        heroVisible = true;
                        this.debugDataAdd(heroImgNameCropped, heroImgNameCropped, "heroNamePrepick-"+colorIdent, DraftLayout["colors"]["heroNamePrepick"][colorIdent], [], true);
                    }
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
                        let heroName = this.app.gameData.correctHeroName(result.text.trim());
                        if (heroName !== pickText) {
                            let detectionError = !this.app.gameData.heroExists(heroName);
                            player.setCharacter(heroName, detectionError);
                            player.setImageHeroName(imageHeroName);
                            player.setLocked(heroLocked);
                        }
                        return heroName;
                    })
                )
            }
            resolve(player);
        });
    }
    detectPlayerName(playerImgName, player, playerNameFinal, detections, index, team, colorIdent) {
        return new Promise(async (resolve, reject) => {
            let playerImgNameOriginal = (this.debugEnabled() ? playerImgName.clone() : null);
            if (!HotsHelpers.imageCleanupName(
                playerImgName, DraftLayout["colors"]["playerName"][colorIdent], DraftLayout["colors"]["boost"]
            )) {
                // Log the error but continue - player name detection may fail on some frames
                if (this.debugEnabled()) {
                    console.log("[Detection] Player name cleanup failed for " + team.color + " player " + index + " - skipping OCR");
                }
                // Don't set a name, just continue to next detection
                resolve(player);
                return;
            }
            HotsHelpers.imageOcrOptimize(playerImgName.invert());
            this.debugDataAdd(playerImgNameOriginal, playerImgName, "playerName-"+colorIdent, DraftLayout["colors"]["playerName"][colorIdent], DraftLayout["colors"]["boost"], true);
            // Debug output - always save
            playerImgName.write("debug/" + team.color + "_player" + index + "_PlayerNameTest.png");
            // Detect player name using tesseract
            let imagePlayerName = null;
            const tempPlayerPath = "debug/" + team.color + "_player" + index + "_PlayerName_temp.png";
            await playerImgName.write(tempPlayerPath);
            const playerBuffer = fs.readFileSync(tempPlayerPath);
            detections.push(
                Promise.resolve(playerBuffer).then((buffer) => {
                    imagePlayerName = buffer;
                    return ocrCluster.recognize(buffer, this.tessLangs+"+lat+rus+kor", this.tessParams);
                }).then((result) => {
                    let playerName = result.text.trim();
                    console.log(playerName+" / "+result.confidence);
                    player.setName(playerName, playerNameFinal);
                    player.setImagePlayerName(imagePlayerName);
                    this.app.gameData.updatePlayerRecentPicks(player);
                    return playerName;
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
