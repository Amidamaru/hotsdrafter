// Nodejs dependencies
const https = require('follow-redirects').https;
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const jimp = require('jimp');
const EventEmitter = require('events');

// Local classes
const HotsReplay = require('hots-replay');
const HotsReplayUploaders = {
    "hotsapi": require('./replay-uploaders/hotsapi.js')
};
const HotsHelpers = require('./hots-helpers.js');

// BigQuery Instance (lazy load)
let bigQueryHotsApi = null;

function getBigQuery() {
    if (!bigQueryHotsApi && HotsHelpers.getConfig().getOption("googleBigQueryProject")) {
        try {
            const {BigQuery} = require('@google-cloud/bigquery');
            bigQueryHotsApi = new BigQuery({
                projectId: HotsHelpers.getConfig().getOption("googleBigQueryProject"),
                keyFilename: HotsHelpers.getConfig().getOption("googleBigQueryAuth")
            });
        } catch (error) {
            console.warn("BigQuery not available:", error.message);
        }
    }
    return bigQueryHotsApi;
}

class HotsGameData extends EventEmitter {

    constructor(language) {
        super();
        this.language = language;
        this.languageOptions = [
            { id: "en-us", name: "English (US)" },
            { id: "de", name: "Deutsch" }
        ];
        this.heroes = {
            name: {},
            details: {},
            corrections: {}
        };
        this.maps = {
            name: {}
        };
        this.substitutions = {
            "ETC": "E.T.C.",
            "LUCIO": "LÚCIO"
        };
        this.mapTranslations = {
            "de": {
                "TEMPEL VON HANAMURA": "HANAMURA TEMPLE",
                "ALTERACPASS": "ALTERAC PASS",
                "SCHLACHTFELD DER EWIGKEIT": "BATTLEFIELD OF ETERNITY",
                "SCHWARZHERZS BUCHT": "BLACKHEART'S BAY",
                "BRAXIS WAFFENPLATZ": "BRAXIS HOLDOUT",
                "DER VERFLUCHTE HOHLE": "CURSED HOLLOW",
                "DAS DRACHENHEIM": "DRAGON SHIRE",
                "GARTEN DES SCHRECKENS": "GARDEN OF TERROR",
                "VERFLUCHTE GRUBENBAU": "HAUNTED MINES",
                "HÖLLENFEUER-SCHREINE": "INFERNAL SHRINES",
                "HÖHLEN DES VERLORENEN FELDZUGES": "LOST CAVERNS",
                "HIMMELSTEMPEL": "SKY TEMPLE",
                "GRABKAMMER DER SPINNENKONIGIN": "TOMB OF THE SPIDER QUEEN",
                "GRABKAMMER DER SPINNENKÖNIGIN": "TOMB OF THE SPIDER QUEEN",
                "TÜRME DES VERDERBENS": "TOWERS OF DOOM",
                "VOLSKAYA-FABRIK": "VOLSKAYA FOUNDRY",
                "SPRENGSTOFFFRACHTER": "WARHEAD JUNCTION"
            }
        };
        this.replays = {
            details: [],
            fileNames: [],
            latestReplay: { file: null, mtime: 0 },
            lastUpdate: 0
        };
        this.playerPicks = {};
        this.playerBattleTags = {};
        this.saves = {
            latestSave: { file: null, mtime: 0 },
            lastUpdate: 0
        };
        this.updateProgress = {
            tasksPending: 0,
            tasksDone: 0,
            tasksFailed: 0,
            retries: 0
        };
        // Load gameData and exceptions from disk
        this.load();
    }
    addHero(id, name, language) {
        name = this.fixHeroName(name);
        if (!this.heroExists(name, language)) {
            this.heroes.name[language][id] = name;
        }
    }
    addMap(id, name, language) {
        if (typeof language === "undefined") {
            language = this.language;
        }
        name = this.fixMapName(name);
        if (!this.mapExists(name, language)) {
            this.maps.name[language][id] = name;
        }
    }
    addHeroDetails(id, details, language) {
        if (language === this.language) {
            this.heroes.details[id] = details;
        }
    }
    addHeroCorrection(fromName, toId, language) {
        if (typeof language === "undefined") {
            language = this.language;
        }
        if (!this.heroes.corrections.hasOwnProperty(language)) {
          this.heroes.corrections[language] = {};
        }
        this.heroes.corrections[language][fromName] = this.getHeroName(toId, language);
        this.save();
    }

    addReplay(replayFile) {
        return new Promise((resolve, reject) => {
            this.progressTaskNew();
            this.loadReplay(replayFile).then((replayData) => {
                this.replays.fileNames.push(replayFile);
                if (replayData !== null) {
                    this.replays.details.push(replayData);
                    if (this.replays.latestReplay.mtime < replayData.mtime) {
                        this.replays.latestReplay = replayData;
                    }
                }
                this.progressTaskDone();
                resolve(replayData);
            }).catch((error) => {
                this.progressTaskFailed();
                reject(error);
            });
        });
    }
    loadReplay(replayFile) {
        return new Promise((resolve, reject) => {
            try {
                let fileStats = fs.statSync(replayFile);
                let replay = new HotsReplay(replayFile);
                let replayData = {
                    file: replayFile,
                    mtime: fileStats.mtimeMs,
                    replayDetails: replay.getReplayDetails(),
                    replayUploads: {}
                };
                let battleTags = replay.getReplayBattleLobby().battleTags;
                // Keep information about recent player picks
                for (let i = 0; i < replayData.replayDetails.m_playerList.length; i++) {
                    let player = replayData.replayDetails.m_playerList[i];
                    if (battleTags.length > i) {
                        // Add battle tag
                        let playerBattleTag = battleTags[i].tag;
                        if (!this.playerBattleTags.hasOwnProperty(player.m_name)) {
                            this.playerBattleTags[player.m_name] = [];
                        }
                        if (this.playerBattleTags[player.m_name].indexOf(playerBattleTag) === -1) {
                            this.playerBattleTags[player.m_name].push(playerBattleTag);
                        }
                    }
                }
                // Return replay data
                resolve(replayData);
            } catch (error) {
                reject(error);
            }
        });
    }
    downloadHeroIcon(heroId, heroImageUrl) {
        return new Promise((resolve, reject) => {
            let filename = path.join(HotsHelpers.getStorageDir(), "heroes", heroId+".png");
            let filenameCrop = path.join(HotsHelpers.getStorageDir(), "heroes", heroId+"_crop.png");
            if (!fs.existsSync(filename)) {
                try {
                    // Create cache directory if it does not exist
                    let heroesDir = path.join(HotsHelpers.getStorageDir(), "heroes");
                    if (!fs.existsSync( heroesDir )) {
                        fs.mkdirSync(heroesDir, { recursive: true });
                    }
                    https.get(heroImageUrl, function(response) {
                        if (response.statusCode !== 200) {
                            console.warn("Failed to download hero image from " + heroImageUrl + " with status " + response.statusCode);
                            resolve(); // Skip image, continue
                            return;
                        }
                        const file = fs.createWriteStream(filename);
                        const stream = response.pipe(file);
                        stream.on("finish", () => {
                            jimp.read(filename).then(async (image) => {
                                image.crop(10, 32, 108, 64).write(filenameCrop);
                                resolve();
                            }).catch((error) => {
                                console.error("Error loading image '"+heroImageUrl+"'");
                                console.error(error);
                                console.error(error.stack);
                                resolve(); // Skip image on error, continue
                            })
                        })
                    }).on('error', (error) => {
                        console.warn("Failed to download hero image from " + heroImageUrl + ": " + error.message);
                        resolve(); // Skip image, continue
                    });
                } catch(error) {
                    console.warn("Failed to process hero image from " + heroImageUrl + ": " + error.message);
                    resolve(); // Skip image, continue
                }
            } else {
                resolve();
            }
        });
    }
    correctHeroName(name, language) {
        if (typeof language === "undefined") {
            language = this.language;
        }
        if (!this.heroes.corrections.hasOwnProperty(language)) {
          this.heroes.corrections[language] = {};
        }
        if (this.heroes.corrections[language].hasOwnProperty(name)) {
            return this.heroes.corrections[language][name];
        }
        return name;
    }
    heroExists(name, language) {
        if (typeof language === "undefined") {
            language = this.language;
        }
        return (this.getHeroId(name, language) !== null);
    }
    mapExists(name, language) {
        if (typeof language === "undefined") {
            language = this.language;
        }
        return (this.getMapId(name, language) !== null);
    }
    fixMapName(name) {
        name = name.toUpperCase().trim();
        // Remove "VIEW BEST HEROES" and other web scraping artifacts
        name = name.split("\n")[0].trim();
        name = name.replace(/\s*VIEW BEST HEROES\s*/gi, "").trim();
        return name;
    }
    fixHeroName(name) {
        name = name.toUpperCase().trim();
        if (this.substitutions.hasOwnProperty(name)) {
          name = this.substitutions[name];
        }
        return name;
    }
    getMapId(mapName, language) {
        if (typeof language === "undefined") {
            language = this.language;
        }
        if (!this.maps.name.hasOwnProperty(language)) {
            this.maps.name[language] = {};
        }
        for (let mapId in this.maps.name[language]) {
            if (this.maps.name[language][mapId] === mapName) {
                return mapId;
            }
        }
        return null;
    }
    getMapName(mapId, language) {
        if (typeof language === "undefined") {
            language = this.language;
        }
        if (!this.maps.name.hasOwnProperty(language)) {
            this.maps.name[language] = {};
        }
        return this.maps.name[language][mapId];
    }
    getMapNameTranslation(mapName, language) {
        if (language === this.language) {
            // Same language, leave it as is
            return mapName;
        }
        // Get the map id in the current language
        let mapId = this.getMapId(mapName);
        // Return the map name in the desired language
        return this.getMapName(mapId, language);
    }
    getMapNames(language) {
        if (typeof language === "undefined") {
            language = this.language;
        }
        if (!this.maps.name.hasOwnProperty(language)) {
            this.maps.name[language] = {};
        }
        return this.maps.name[language];
    }
    translateMapName(mapName, fromLanguage, toLanguage) {
        // Try to find the map ID using the from language, then return the name in the to language
        if (typeof fromLanguage === "undefined") {
            fromLanguage = this.language;
        }
        if (typeof toLanguage === "undefined") {
            toLanguage = "en-us";
        }
        
        // Check if we have a direct translation in mapTranslations table
        if (this.mapTranslations.hasOwnProperty(fromLanguage)) {
            if (this.mapTranslations[fromLanguage].hasOwnProperty(mapName)) {
                return this.mapTranslations[fromLanguage][mapName];
            }
        }
        
        // If no translation found, try to get the map ID from the source language
        let mapId = this.getMapId(mapName, fromLanguage);
        if (mapId !== null) {
            // Now get the map name in the target language
            return this.getMapName(mapId, toLanguage);
        }
        return null;
    }
    getHeroName(heroId, language) {
        if (typeof language === "undefined") {
            language = this.language;
        }
        if (!this.heroes.name.hasOwnProperty(language)) {
            this.heroes.name[language] = {};
        }
        return this.heroes.name[language][heroId];
    }
    getHeroNameTranslation(heroName, language) {
        if (language === this.language) {
            // Same language, leave it as is
            return heroName;
        }
        // Get the hero id in the current language
        let heroId = this.getHeroId(heroName);
        // Return the hero name in the desired language
        return this.getHeroName(heroId, language);
    }
    getHeroNames(language) {
        if (typeof language === "undefined") {
            language = this.language;
        }
        if (!this.heroes.name.hasOwnProperty(language)) {
            this.heroes.name[language] = {};
        }
        return this.heroes.name[language];
    }
    getHeroId(heroName, language) {
        if (typeof language === "undefined") {
            language = this.language;
        }
        if (!this.heroes.name.hasOwnProperty(language)) {
            this.heroes.name[language] = {};
        }
        for (let heroId in this.heroes.name[language]) {
            if (this.heroes.name[language][heroId] === heroName) {
                return heroId;
            }
        }
        return null;
    }
    getHeroImage(heroName, language) {
        if (typeof language === "undefined") {
            language = this.language;
        }
        heroName = this.fixHeroName(heroName);
        let heroId = this.getHeroId(heroName, language);
        if (heroId === null) {
            console.error("Failed to find image for hero: "+heroName);
        }
        return path.join(HotsHelpers.getStorageDir(), "heroes", heroId+"_crop.png");
    }
    getFile() {
        return path.join(HotsHelpers.getStorageDir(), "gameData.json");
    }
    getLatestReplay() {
        return this.replays.latestReplay;
    }
    getLatestSave() {
        return this.saves.latestSave;
    }
    load() {
        let storageFile = this.getFile();
        // Read the data from file
        if (!fs.existsSync(storageFile)) {
            // Cache file does not exist! Initialize empty data object.
            return;
        }
        let cacheContent = fs.readFileSync(storageFile);
        try {
            let cacheData = JSON.parse(cacheContent.toString());
            console.log("[GameData] load() - Cache version: " + cacheData.formatVersion + ", languageOptions count: " + (cacheData.languageOptions ? cacheData.languageOptions.length : 0));
            if (cacheData.formatVersion == 5) {
                // Before loading, merge languageOptions from this.languageOptions (the defaults)
                // This ensures new languages are added even if cache is old
                if (cacheData.languageOptions && Array.isArray(cacheData.languageOptions)) {
                    // Check if we need to add new languages from defaults
                    for (let defaultLang of this.languageOptions) {
                        let found = false;
                        for (let cacheLang of cacheData.languageOptions) {
                            if (cacheLang.id === defaultLang.id) {
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            console.log("[GameData] load() - Adding missing language: " + defaultLang.id);
                            cacheData.languageOptions.push(defaultLang);
                        }
                    }
                }
                this.languageOptions = cacheData.languageOptions;
                this.maps = cacheData.maps;
                this.heroes = cacheData.heroes;
                this.replays = cacheData.replays;
                this.playerPicks = cacheData.playerPicks;
                this.playerBattleTags = cacheData.playerBattleTags;
                console.log("[GameData] load() - After load, languageOptions count: " + this.languageOptions.length);
            }
        } catch (e) {
            console.error("Failed to read gameData data!");
            console.error(e);
        }
    }
    save() {
        // Sort hero names alphabetically
        for (let language in this.heroes.name) {
            let heroSort = [];
            for (let heroId in this.heroes.name[language]) {
                heroSort.push([heroId, this.heroes.name[language][heroId]]);
            }
            heroSort.sort(function(a, b) {
                if(a[1] < b[1]) { return -1; }
                if(a[1] > b[1]) { return 1; }
                return 0;
            });
            this.heroes.name[language] = {};
            for (let i = 0; i < heroSort.length; i++) {
                this.heroes.name[language][ heroSort[i][0] ] = heroSort[i][1];
            }
        }
        // Create cache directory if it does not exist
        let storageDir = HotsHelpers.getStorageDir();
        if (!fs.existsSync( storageDir )) {
            fs.mkdirSync(storageDir, { recursive: true });
        }
        // Write specific type into cache
        let storageFile = this.getFile();
        fs.writeFileSync( storageFile, JSON.stringify({
            formatVersion: 5,
            languageOptions: this.languageOptions,
            maps: this.maps,
            heroes: this.heroes,
            replays: this.replays,
            playerPicks: this.playerPicks,
            playerBattleTags: this.playerBattleTags
        }) );
    }
    update() {
        console.log("[GameData] Starting update()...");
        this.emit("update.start");  // Signal that update is starting
        this.progressReset();
        this.progressTaskNew();
        return new Promise((resolve, reject) => {
            console.log("[GameData] update() - Starting updateReplays...");
            console.log("[GameData] update() - Starting updateSaves...");
            console.log("[GameData] update() - Starting updateMaps(en-us)...");
            console.log("[GameData] update() - Starting updateHeroes(en-us)...");
            let updatePromises = [
              this.updateReplays(),
              this.updateSaves(),
              this.updateMaps("en-us"),
              this.updateHeroes("en-us")
            ];
            if (this.language !== "en-us") {
                console.log("[GameData] update() - Adding language-specific updates for " + this.language);
                updatePromises.push( this.updateMaps(this.language) );
                updatePromises.push( this.updateHeroes(this.language) );
            }
            // Use allSettled instead of all so one failure doesn't break everything
            Promise.allSettled(updatePromises).then((result) => {
                console.log("[GameData] update() - All promises settled, resolving...");
                resolve(result);
            }).catch((error) => {
                console.warn("[GameData] update() - Update error (non-critical):", error);
                resolve([]);  // Continue anyway
            }).finally(() => {
                console.log("[GameData] update() - Emitting update.done");
                this.emit("update.done");
            });
        }).then((result) => {
            console.log("[GameData] update() - Final then(), calling progressTaskDone()");
            this.progressTaskDone();
            return result;
        }).catch((error) => {
            console.warn("[GameData] update() - Game data update failed (non-critical):", error);
            this.progressTaskDone();
            // Don't throw - app can work with cached data
            return null;
        });
    }
    updateMaps(language) {
        console.log("[GameData] updateMaps(" + language + ") - Starting...");
        this.progressTaskNew();
        // Only fetch maps for en-us, heroescounters doesn't have other languages
        if (language !== "en-us") {
            console.log("[GameData] updateMaps(" + language + ") - Skipping (only en-us supported)");
            this.progressTaskDone();
            return Promise.resolve();
        }
        let url = "https://www.heroescounters.com/map";
        console.log("[GameData] updateMaps(" + language + ") - Fetching from " + url);
        return new Promise((resolve, reject) => {
            https.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/75.0.3770.100 Safari/537.36'
                }
            }, (response) => {
                console.log("[GameData] updateMaps(" + language + ") - Got response with status " + response.statusCode);
                if (response.statusCode !== 200) {
                    console.warn("[GameData] updateMaps(" + language + ") - Maps fetch failed with status <" + response.statusCode + "> for " + url);
                    reject("Invalid status code <" + response.statusCode + ">");
                    return;
                }
                let data = "";
                response.on("data", (chunk) => {
                    data += chunk;
                });
                response.on("end", () => {
                    console.log("[GameData] updateMaps(" + language + ") - Got " + data.length + " bytes, parsing...");
                    this.updateMapsFromResponse(language, data).then(() => {
                        console.log("[GameData] updateMaps(" + language + ") - Maps parsing done");
                        resolve();
                    }).catch((error) => {
                        console.warn("[GameData] updateMaps(" + language + ") - Maps parsing error: " + error);
                        reject(error);
                    });
                });
            }).on("error", (error) => {
                console.warn("[GameData] updateMaps(" + language + ") - Network error: " + error.message);
                reject(error);
            });
        }).then((result) => {
            console.log("[GameData] updateMaps(" + language + ") - Done, calling progressTaskDone()");
            this.progressTaskDone();
            return result;
        }).catch((error) => {
            console.warn("[GameData] updateMaps(" + language + ") - Maps update failed (non-critical):", error);
            this.progressTaskDone();
            // Don't throw - continue with cached data
        });
    }
    updateMapsFromResponse(language, content) {
        return new Promise((resolve, reject) => {
            let self = this;
            let page = cheerio.load(content);
            
            // Parse maps from heroescounters.com structure
            // Maps are in links like: <a href="/map/cursedhollow">Cursed Hollow</a>
            let mapCount = 0;
            page('a[href^="/map/"]').each(function() {
                let href = page(this).attr('href');
                let mapName = page(this).text().trim();
                
                // Skip "VIEW BEST HEROES" links
                if (mapName === 'VIEW BEST HEROES') {
                    return;
                }
                
                // Extract map ID from URL (e.g., /map/cursedhollow -> cursedhollow)
                let mapIdMatch = href.match(/^\/map\/([a-z]+)$/);
                if (mapIdMatch) {
                    let mapId = mapIdMatch[1];
                    self.addMap(mapId, mapName, language);
                    mapCount++;
                }
            });
            
            console.log("Loaded " + mapCount + " maps from heroescounters.com");
            resolve();
            this.save();
        });
    }
    updateHeroes(language) {
        console.log("[GameData] updateHeroes(" + language + ") - Starting...");
        this.progressTaskNew();
        // Load heroes from hardcoded list (web scraping is unreliable due to dynamic content)
        return new Promise((resolve, reject) => {
            try {
                console.log("[GameData] updateHeroes(" + language + ") - Calling updateHeroesFromResponse...");
                this.updateHeroesFromResponse(language, "").then(() => {
                    console.log("[GameData] updateHeroes(" + language + ") - updateHeroesFromResponse done");
                    resolve();
                }).catch((error) => {
                    console.warn("[GameData] updateHeroes(" + language + ") - Heroes update error:", error);
                    resolve();  // Continue anyway with what we have
                });
            } catch (error) {
                console.warn("[GameData] updateHeroes(" + language + ") - Heroes update error:", error);
                resolve();  // Continue anyway
            }
        }).then((result) => {
            console.log("[GameData] updateHeroes(" + language + ") - Done, calling progressTaskDone()");
            this.progressTaskDone();
            return result;
        }).catch((error) => {
            console.warn("[GameData] updateHeroes(" + language + ") - Heroes update failed (non-critical):", error);
            this.progressTaskDone();
            // Don't throw - continue with cached data
        });
    }
    updateHeroesFromResponse(language, content) {
        return new Promise((resolve, reject) => {
            let self = this;
            
            // Hardcoded hero list from Heroes of the Storm
            // This ensures we always have the complete list even if websites change
            const heroList = [
                "Abathur", "Alarak", "Alexstrasza", "Ana", "Anduin", "Anub'arak",
                "Artanis", "Arthas", "Auriel", "Azmodan", "Blaze", "Brightwing",
                "Cassia", "Chen", "Cho", "Chromie", "D.Va", "Deathwing", "Deckard", "Dehaka",
                "Diablo", "E.T.C.", "Falstad", "Fenix", "Gall", "Garrosh", "Gazlowe",
                "Genji", "Greymane", "Gul'dan", "Hanzo", "Hogger", "Illidan", "Imperius",
                "Jaina", "Johanna", "Junkrat", "Kael'thas", "Kel'Thuzad", "Kerrigan",
                "Kharazim", "Leoric", "Li Li", "Li-Ming", "Lt. Morales", "Lúcio", "Lunara",
                "Maiev", "Mal'Ganis", "Malfurion", "Malthael", "Medivh", "Mei", "Mephisto",
                "Muradin", "Murky", "Nazeebo", "Nova", "Orphea", "Probius", "Qhira",
                "Ragnaros", "Raynor", "Rehgar", "Rexxar", "Samuro", "Sgt. Hammer", "Sonya",
                "Stitches", "Stukov", "Sylvanas", "Tassadar", "The Butcher", "The Lost Vikings",
                "Thrall", "Tracer", "Tychus", "Tyrael", "Tyrande", "Uther", "Valeera",
                "Valla", "Varian", "Whitemane", "Xul", "Yrel", "Zagara", "Zarya", "Zeratul", "Zul'jin"
            ];
            
            let heroCount = 0;
            heroList.forEach(heroName => {
                // Convert hero name to ID (lowercase, remove special characters)
                let heroId = heroName
                    .toLowerCase()
                    .replace(/[.']/g, '')  // Remove apostrophes and periods
                    .replace(/\s+/g, '');   // Remove spaces
                
                self.addHero(heroId, heroName, language);
                self.addHeroDetails(heroId, {name: heroName, slug: heroId}, language);
                heroCount++;
            });
            
            console.log("Loaded " + heroCount + " heroes from hardcoded list");
            resolve();
            this.save();
        });
    }
    updateLanguage() {
        this.language = HotsHelpers.getConfig().getOption("language");
        this.update();
    }
    updateReplays() {
        if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateReplays() - Starting...");
        this.progressTaskNew();
        return new Promise((resolve, reject) => {
            // Do not update replays more often than every 30 seconds
            let replayUpdateAge = ((new Date()).getTime() - this.replays.lastUpdate) / 1000;
            if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateReplays() - Last update was " + replayUpdateAge + " seconds ago");
            if (replayUpdateAge < 30) {
                if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateReplays() - Skipping (too recent)");
                resolve(true);
                return;
            }
            // Update replays
            if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateReplays() - Reading replay directories...");
            let accounts = HotsHelpers.getConfig().getAccounts();
            if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateReplays() - Found " + accounts.length + " account(s)");
            let gameStorageDir = HotsHelpers.getConfig().getOption("gameStorageDir");
            if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateReplays() - Game storage dir: " + gameStorageDir);
            
            // Skip if no accounts configured
            if (accounts.length === 0 || !gameStorageDir) {
                console.log("[GameData] updateReplays() - No accounts or storage dir configured, skipping");
                this.replays.lastUpdate = (new Date()).getTime();
                resolve(true);
                return;
            }
            
            let replayTasks = [];
            for (let a = 0; a < accounts.length; a++) {
                for (let p = 0; p < accounts[a].players.length; p++) {
                    let replayPath = path.join(gameStorageDir, "Accounts", accounts[a].id, accounts[a].players[p], "Replays", "Multiplayer");
                    console.log("[GameData] updateReplays() - Checking: " + replayPath);
                    let files = [];
                    try {
                        if (fs.existsSync(replayPath)) {
                            files = fs.readdirSync(replayPath);
                            console.log("[GameData] updateReplays() - Found " + files.length + " files in " + replayPath);
                        } else {
                            console.log("[GameData] updateReplays() - Path does not exist: " + replayPath);
                        }
                    } catch (error) {
                        console.warn("[GameData] updateReplays() - Failed to read directory: " + error.message);
                        continue;
                    }
                    files.forEach((file) => {
                        if (file.match(/\.StormReplay$/)) {
                            let fileAbsolute = path.join(replayPath, file);
                            if (this.replays.fileNames.indexOf(fileAbsolute) === -1) {
                                // New replay detected
                                replayTasks.push( this.addReplay(fileAbsolute) );
                            }
                        }
                    });
                }
            }
            this.replays.lastUpdate = (new Date()).getTime();
            if (replayTasks.length === 0) {
                resolve(true);
            } else {
                Promise.all(replayTasks).then((replays) => {
                    // Sort replays (newest first)
                    this.replays.details.sort((a, b) => {
                        return b.mtime - a.mtime;
                    });
                    // Only sore the details for the latest 100 replays
                    if (this.replays.details.length > 100) {
                        this.replays.details.splice(100);
                    }
                    // Update done!
                    resolve(true);
                }).catch((error) => {
                    reject(error);
                });
            }
        }).then((result) => {
            this.progressTaskDone();
            return result;
        }).catch((error) => {
            console.warn("Replays update error (non-critical):", error);
            this.progressTaskDone();
            // Don't throw - continue with what we have
        });
    }
    uploadReplays() {
        // Check upload state
        let uploadPromise = Promise.resolve(0);
        for (var uploadProvider in HotsReplayUploaders) {
            if (!HotsHelpers.getConfig().getOption("uploadProvider_"+uploadProvider)) {
                // Skip disabled providers
                continue;
            }
            for (let i = 0; i < this.replays.details.length; i++) {
                let replayData = this.replays.details[i];
                if (typeof replayData.replayUploads[uploadProvider] === "undefined") {
                    // Not uploaded yet
                    replayData.replayUploads[uploadProvider] = { result: "pending" };
                    this.emit("replay.update", i);
                    uploadPromise = uploadPromise.then((uploadCount) => {
                        uploadCount++;
                        return new Promise((resolve, reject) => {
                            HotsReplayUploaders[uploadProvider].upload(replayData.file).then((result) => {
                                replayData.replayUploads[uploadProvider] = { result: result };
                                this.emit("replay.update", i);
                                resolve(uploadCount);
                            }).catch((error) => {
                                replayData.replayUploads[uploadProvider] = { result: "error", error: error };
                                this.emit("replay.update", i);
                                resolve(uploadCount);
                            });
                        });
                    });
                }
            }
        }
        return uploadPromise;
    }
    updateSaves() {
        if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateSaves() - Starting...");
        this.progressTaskNew();
        return new Promise((resolve, reject) => {
            // Do not update saves more often than every 10 seconds
            let replayUpdateAge = ((new Date()).getTime() - this.saves.lastUpdate) / 1000;
            if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateSaves() - Last update was " + replayUpdateAge + " seconds ago");
            if (replayUpdateAge < 10) {
                if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateSaves() - Skipping (too recent)");
                resolve(true);
                return;
            }
            // Update saves
            if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateSaves() - Reading save directories...");
            let accounts = HotsHelpers.getConfig().getAccounts();
            if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateSaves() - Found " + accounts.length + " account(s)");
            let gameStorageDir = HotsHelpers.getConfig().getOption("gameStorageDir");
            if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateSaves() - Game storage dir: " + gameStorageDir);
            
            // Skip if no accounts configured
            if (accounts.length === 0 || !gameStorageDir) {
                if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateSaves() - No accounts or storage dir configured, skipping");
                this.saves.lastUpdate = (new Date()).getTime();
                resolve(true);
                return;
            }
            
            for (let a = 0; a < accounts.length; a++) {
                for (let p = 0; p < accounts[a].players.length; p++) {
                    let replayPath = path.join(gameStorageDir, "Accounts", accounts[a].id, accounts[a].players[p], "Saves", "Rejoin");
                    if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateSaves() - Checking: " + replayPath);
                    let files = [];
                    try {
                        if (fs.existsSync(replayPath)) {
                            files = fs.readdirSync(replayPath);
                            if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateSaves() - Found " + files.length + " files in " + replayPath);
                        } else {
                            if (HotsHelpers.getConfig().getOption("debugEnabled")) console.log("[GameData] updateSaves() - Path does not exist: " + replayPath);
                        }
                    } catch (error) {
                        if (HotsHelpers.getConfig().getOption("debugEnabled")) console.warn("[GameData] updateSaves() - Failed to read directory: " + error.message);
                        continue;
                    }
                    files.forEach((file) => {
                        if (file.match(/\.StormSave$/)) {
                            let fileAbsolute = path.join(replayPath, file);
                            let fileStats = fs.statSync(path.join(replayPath, file));
                            if (this.saves.latestSave.mtime < fileStats.mtimeMs) {
                                this.saves.latestSave.file = fileAbsolute;
                                this.saves.latestSave.mtime = fileStats.mtimeMs;
                            }
                        }
                    });
                }
            }
            this.saves.lastUpdate = (new Date()).getTime();
            resolve(true);
        }).then((result) => {
            this.progressTaskDone();
            return result;
        }).catch((error) => {
            console.warn("Saves update error (non-critical):", error);
            this.progressTaskDone();
            // Don't throw - continue with what we have
        });
    }
    updateTempModTime() {
        return this.updateTempFilesRecursive(
            HotsHelpers.getConfig().getOption("gameTempDir")
        );
    }
    updateTempFilesRecursive(baseDir) {
        if (!fs.existsSync(baseDir)) {
            return 0;
        }
        let files = fs.readdirSync(baseDir);
        let maxMtime = 0;
        try {
            files.forEach((file) => {
                let fileAbsolute = path.join(baseDir, file);
                let fileLstat = fs.lstatSync(fileAbsolute);
                if (fileLstat.isDirectory()) {
                    let dirMtime = this.updateTempFilesRecursive(fileAbsolute);
                    if (maxMtime < dirMtime) {
                        maxMtime = dirMtime;
                    }
                } else {
                    let fileStats = fs.statSync(fileAbsolute);
                    if (fileStats.isDirectory())
                    if (maxMtime < fileStats.mtimeMs) {
                        maxMtime = fileStats.mtimeMs;
                    }
                }
            });
        } catch (error) {
            // May happen when files or directories are deleted
        }
        return maxMtime;
    }

    /**
     * @param {HotsDraftPlayer} player
     */
    updatePlayerRecentPicks(player) {
        let playerName = player.getName();
        if (!this.playerBattleTags.hasOwnProperty(playerName)) {
            // No battletags known for player! Unable to fetch recent picks.
            return;
        }
        let playerPicks = {};
        for (let i = 0; i < this.playerBattleTags[playerName].length; i++) {
            let playerBattleTag = this.playerBattleTags[playerName][i];
            if (!this.playerPicks.hasOwnProperty(playerBattleTag)) {
                // No recent picks known for player! Fetch from hotsapi.net
                this.playerPicks[playerBattleTag] = [];
                let playerBattleTagParts = playerBattleTag.match(/^(.+)#([0-9]+)$/);
                if (playerBattleTagParts) {
                    let querySql = `
                      SELECT p.hero as heroName, COUNT(*) as pickCount
                      FROM \`cloud-project-179020.hotsapi.replays\` r, UNNEST(players) as p
                      WHERE (p.battletag_name = @tagName) AND (p.battletag_id = @tagId)
                      GROUP BY heroName
                      ORDER BY pickCount DESC`;
                    let queryOptions = {
                        query: querySql,
                        params: { tagName: playerBattleTagParts[1], tagId: parseInt(playerBattleTagParts[2]) }
                    };
                    const bq = getBigQuery();
                    if (bq) {
                        bq.query(queryOptions).then((result) => {
                            result[0].forEach((row) => {
                                this.playerPicks[playerBattleTag].push([ row.heroName, row.pickCount ]);
                            });
                            playerPicks[playerBattleTag] = this.playerPicks[playerBattleTag];
                            player.setRecentPicks(playerPicks);
                            this.save();
                        });
                    }
                }
                return;
            } else {
                playerPicks[playerBattleTag] = this.playerPicks[playerBattleTag];
                player.setRecentPicks(playerPicks);
            }
        }
    }
    progressReset() {
        this.updateProgress.tasksPending = 1;
        this.updateProgress.tasksDone = 0;
        this.updateProgress.tasksFailed = 0;
        this.progressRefresh();
    }
    progressTaskNew() {
        this.updateProgress.tasksPending++;
        this.progressRefresh();
    }
    progressTaskDone() {
        this.updateProgress.tasksDone++;
        this.progressRefresh();
    }
    progressTaskFailed() {
        this.updateProgress.tasksFailed++;
        this.progressRefresh();
    }
    progressRefresh() {
        this.emit("update.progress", Math.round(this.updateProgress.tasksDone * 100 / this.updateProgress.tasksPending));
    }
}

module.exports = HotsGameData;
