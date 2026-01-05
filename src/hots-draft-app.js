// Nodejs dependencies
const path = require('path');
const screenshot = require('screenshot-desktop');
const Twig = require('twig');
const HotsReplay = require('hots-replay');
const EventEmitter = require('events');

// Local classes
const HotsDraftScreen = require('../src/hots-draft-screen.js');
const HotsGameData = require('./hots-game-data.js');
const HotsHelpers = require('../src/hots-helpers.js');

// Templates
const templates = {
    "main": path.resolve(__dirname, "..", "gui", "pages", "main.twig.html"),
    "config": path.resolve(__dirname, "..", "gui", "pages", "config.twig.html"),
    "replay": path.resolve(__dirname, "..", "gui", "pages", "replay.twig.html"),
};

class HotsDraftApp extends EventEmitter {

    constructor() {
        super();
        this.gameData = new HotsGameData( HotsHelpers.getConfig().getOption("language") );
        this.screen = new HotsDraftScreen(this);
        this.draftProvider = null;
        this.talentProvider = null;
        this.displays = null;
        // Status fields
        this.ready = false;  // Initialize ready state
        this.statusGameDataPending = false;
        this.statusGameActive = false;
        this.statusGameActiveLock = null;
        this.statusGameSaveFile = { file: null, mtime: 0, updated: 0 };
        this.statusGameLastReplay = { file: null, mtime: 0, updated: 0 };
        this.statusTempModTime = 0;
        this.statusDraftData = null;
        this.statusDraftActive = false;
        this.statusDetectionRunning = false;
        this.statusDetectionPaused = false;
        this.statusUpdatePending = false;
        this.lastPlayerHero = null;  // Track hero changes for auto-refresh
        this.talentUpdateTimeout = null;  // Debounce talent provider updates
        this.lastDraftDataHash = null;  // Prevent sending duplicate draft data
        // Initialize
        this.registerEvents();
    }
    
    // Call init after a small delay to allow registerEvents to finish
    startInit() {
        console.log("[HotsDraftApp] startInit() - Called, scheduling init() after 100ms");
        setTimeout(() => {
            console.log("[HotsDraftApp] startInit() - Now calling init()");
            this.init();
        }, 100);
    }
    debugEnabled() {
        return HotsHelpers.getConfig().getOption("debugEnabled");
    }
    createDraftProvider() {
        const DraftProviderName = HotsHelpers.getConfig().getOption("draftProvider");
        const DraftProvider = require('../src/external/'+DraftProviderName+'.js');
        return new DraftProvider(this);
    }
    createTalentProvider() {
        const TalentProviderName = HotsHelpers.getConfig().getOption("talentProvider");
        const TalentProvider = require('../src/external/'+TalentProviderName+'.js');
        return new TalentProvider(this);
    }
    registerEvents() {
        // Bind ready event
        this.on("ready", () => {
            this.startDetection();
        });
        this.on("draft.started", () => {
            this.sendDraftData();
        });
        // Detection events
        this.screen.on("detect.teams.new", () => {
            if (this.statusDraftActive) {
                this.sendDraftData();
                // Register events for updating singular elements
                let teams = this.screen.getTeams();
                for (let t = 0; t < teams.length; t++) {
                    let team = teams[t];
                    team.on("ban.update", (banIndex) => {
                        this.sendBan(team, banIndex);
                    });
                    let players = team.getPlayers();
                    for (let p = 0; p < players.length; p++) {
                        let player = players[p];
                        players[p].on("change", () => {
                            this.sendPlayerData(player);
                        });
                    }
                }
            }
        });
        this.screen.on("detect.teams.update", () => {
            if (this.statusDraftActive) {
                this.sendDraftData();
            }
        });
        this.screen.on("detect.error", (error) => {
            this.setDebugStep("Detection failed!")
            this.checkNextUpdate();
            if (this.debugEnabled()) {
                console.log("Analysing screenshot failed!");
            }
        });
        this.screen.on("detect.success", () => {
            this.setDebugStep("Detection successful!")
            this.checkNextUpdate();
            if (this.debugEnabled()) {
                console.log("Analysing screenshot successful!");
            }
        });
        this.screen.on("detect.done", () => {
            this.statusDetectionRunning = false;
            if (this.debugEnabled()) {
                this.sendDebugData();
            }
            if (!this.statusGameActive) {
                // Trigger game start when all players locked their hero in the draft
                let playersLocked = 0;
                let teams = this.screen.getTeams();
                for (let t = 0; t < teams.length; t++) {
                    let players = teams[t].getPlayers();
                    for (let p = 0; p < players.length; p++) {
                        if (players[p].isLocked()) {
                            playersLocked++;
                        }
                    }
                }
                if (playersLocked === 10) {
                    this.statusGameActive = true;
                    this.statusGameActiveLock = (new Date()).getTime() + 1000 * 180;
                    this.triggerGameStart();
                }
            }
        });
        this.screen.on("detect.map.start", () => {
            this.setDebugStep("Detecting map...")
        });
        this.screen.on("detect.timer.start", () => {
            this.setDebugStep("Detecting active team...")
        });
        this.screen.on("detect.teams.start", () => {
            this.setDebugStep("Detecting picks and bans...")
        });
        // Download events for game data
        this.gameData.on("update.start", () => {
            this.ready = false;
            this.sendReadyState();
            this.statusGameDataPending = true;
            this.sendEvent("gui", "update.start");
        });
        this.gameData.on("update.progress", (percent) => {
            this.sendEvent("gui", "update.progress", percent);
        });
        this.gameData.on("update.done", () => {
            this.statusGameDataPending = false;
            this.sendEvent("gui", "update.done");
            this.sendGameData();
            this.updateReadyState();
            if (HotsHelpers.getConfig().getOption("playerName") === "") {
                // Try to detect the player name
                if (this.gameData.replays.details.length > 10) {
                    let playerNames = {};
                    let playerBestCount = 0;
                    let playerBestName = "";
                    for (let i = 0; i < this.gameData.replays.details.length; i++) {
                        let replayData = this.gameData.replays.details[i];
                        for (let p = 0; p < replayData.replayDetails.m_playerList.length; p++) {
                            let player = replayData.replayDetails.m_playerList[p];
                            if (!playerNames.hasOwnProperty(player.m_name)) {
                                playerNames[player.m_name] = 1;
                            } else {
                                playerNames[player.m_name]++;
                            }
                            if (playerNames[player.m_name] > playerBestCount) {
                                playerBestCount = playerNames[player.m_name];
                                playerBestName = player.m_name;
                            }
                        }
                    }
                    HotsHelpers.getConfig().setOption("playerName", playerBestName);
                    this.sendConfig();
                }
            }
        });
        this.gameData.on("replay.update", (index) => {
            this.sendReplayData(index);
        });
        // Send initial game data and displays to GUI (before update.done)
        console.log("[HotsDraftApp] registerEvents() - Sending initial gameData and displays to GUI");
        this.sendGameData();
        // Now that all event listeners are registered, start the initialization
        this.startInit();
    }
    handleEvent(type, parameters) {
        switch (type) {
            case "ban.save":
                this.screen.saveHeroBanImage(...parameters);
                break;
            case "ban.manual-select":
                console.log("[HotsDraftApp] handleEvent() - ban.manual-select: team=" + parameters[0] + ", index=" + parameters[1] + ", heroId=" + parameters[2]);
                this.handleManualBanSelect(...parameters);
                break;
            case "config.option.set":
                console.log("[HotsDraftApp] handleEvent() - config.option.set: " + parameters[0] + " = " + parameters[1]);
                HotsHelpers.getConfig().setOption(...parameters);
                switch (parameters[0]) {
                    case "language":
                        this.statusGameDataPending = true;
                        this.updateLanguage();
                        this.updateForced();
                        this.updatePage();
                        break;
                    case "draftProvider":
                        this.initDraftProvider();
                        break;
                    case "talentProvider":
                        this.initTalentProvider();
                        break;
                }
                break;
            case "detection.pause":
                this.statusDetectionPaused = true;
                break;
            case "detection.resume":
                this.statusDetectionPaused = false;
                break;
            case "draft.reset":
                console.log("[HotsDraftApp] handleEvent() - draft.reset received");
                this.resetDraft();
                break;
            case "hero.correct":
                this.gameData.addHeroCorrection(...parameters);
                break;
            case "draftProvider.action":
                this.draftProvider.handleGuiAction(parameters);
                break;
            case "draftProvider.reload":
                this.initDraftProvider();
                break;
            case "talentProvider.action":
                this.talentProvider.handleGuiAction(parameters);
                break;
            case "talentProvider.reload":
                this.initTalentProvider();
                break;
            case "talentProvider.refresh":
                console.log("[HotsDraftApp] Refreshing talent provider...");
                this.talentProvider.update().then(() => {
                    console.log("[HotsDraftApp] Talent provider refreshed, sending update to GUI");
                    this.sendTalentProvider(this.talentProvider);
                }).catch((error) => {
                    console.error("[HotsDraftApp] Talent provider refresh failed: " + error);
                });
                break;
            case "update.forced":
                console.log("[HotsDraftApp] handleEvent() - update.forced received");
                this.updateForced();
                break;
            case "window.ready":
                this.sendConfig();
                this.init();
                break;
        }
    }
    handleManualBanSelect(team, banIndex, heroId, heroName) {
        console.log("[HotsDraftApp] handleManualBanSelect() - team=" + team + ", index=" + banIndex + ", heroId=" + heroId + ", heroName=" + heroName);
        
        // Get the team object
        let teamObj = this.screen.getTeam(team);
        if (!teamObj) {
            console.error("[HotsDraftApp] Team not found: " + team);
            return;
        }
        
        // Update the ban with the selected hero
        teamObj.addBan(banIndex, heroName);
        
        // Save the hero image to data/bans folder for future recognition
        this.screen.saveHeroBanImageByHeroId(heroId);
        
        // Send updated draft data
        this.sendDraftData();
    }
    sendEvent(channel, type, ...parameters) {
        if (this.debugEnabled()) console.log("[HotsDraftApp] sendEvent() - channel=" + channel + ", type=" + type);
        process.send([channel, type, ...parameters]);
    }
    sendConfig() {
        this.sendEvent("gui", "config", HotsHelpers.getConfig().options);
    }
    sendDraftData() {
        // Update statusDraftData first so providers can access it
        this.statusDraftData = this.collectDraftData();
        console.log("[HotsDraftApp] sendDraftData() - Sending draft with " + this.statusDraftData.bans.length + " bans, " + this.statusDraftData.players.length + " players, teamActive=" + this.statusDraftData.teamActive + ", banActive=" + this.statusDraftData.banActive);
        
        // Auto-update talent provider when player hero changes (debounced to prevent spam)
        let currentPlayerHero = null;
        let playerName = this.getConfig().getOption("playerName");
        for (let i = 0; i < this.statusDraftData.players.length; i++) {
            if (this.statusDraftData.players[i].playerName === playerName) {
                currentPlayerHero = this.statusDraftData.players[i].heroName;
                break;
            }
        }
        
        // If hero changed, schedule talent provider update (debounced - max once per 500ms)
        if (currentPlayerHero !== this.lastPlayerHero && currentPlayerHero !== null) {
            console.log("[HotsDraftApp] sendDraftData() - Player hero changed from '" + (this.lastPlayerHero || "none") + "' to '" + currentPlayerHero + "', scheduling talent provider update");
            this.lastPlayerHero = currentPlayerHero;
            
            // Clear existing timeout
            if (this.talentUpdateTimeout) {
                clearTimeout(this.talentUpdateTimeout);
            }
            
            // Schedule update with 500ms debounce
            this.talentUpdateTimeout = setTimeout(() => {
                console.log("[HotsDraftApp] Debounced talent provider update executing...");
                this.talentProvider.update();
                this.talentUpdateTimeout = null;
            }, 500);
        }
        
        this.sendEvent("gui", "draft", this.statusDraftData);
    }
    sendTalentData() {
        this.sendEvent("gui", "talents", this.collectTalentData());
    }
    sendGameData() {
        console.log("[HotsDraftApp] sendGameData() - Sending languageOptions, heroes, maps, etc. to GUI");
        this.sendEvent("gui", "gameData", {
            languageOptions: this.gameData.languageOptions,
            heroes: this.gameData.heroes,
            maps: this.gameData.maps,
            replays: this.gameData.replays,
            substitutions: this.gameData.substitutions,
            playerBattleTags: this.gameData.playerBattleTags,
            playerPicks: this.gameData.playerPicks
        });
    }
    sendDebugData() {
        if (this.screen.debugData.length > 1) {
            this.sendEvent("gui", "debugData", this.screen.debugData);
        }
    }
    sendBan(team, banIndex) {
        this.sendEvent("gui", "ban.update", this.collectBanData(team, banIndex));
    }
    sendPlayerData(player) {
        this.sendEvent("gui", "player.update", this.collectPlayerData(player));
    }
    sendReplayData(replayIndex) {
        this.sendEvent("gui", "replay.update", this.collectReplayData(replayIndex));
    }
    sendDraftProvider(provider) {
        this.sendEvent("gui", "draftProvider.update", this.collectProviderData(provider));
    }
    sendTalentProvider(provider) {
        this.sendEvent("gui", "talentProvider.update", this.collectProviderData(provider));
    }
    sendReadyState() {
        console.log("[HotsDraftApp] sendReadyState() - Sending ready.status=" + this.ready + " to GUI");
        this.sendEvent("gui", "ready.status", this.ready);
    }
    sendDraftState() {
        this.sendEvent("gui", "draft.status", this.statusDraftActive);
    }
    resetDraft() {
        console.log("[HotsDraftApp] resetDraft() - Resetting draft data");
        this.statusDraftActive = false;
        this.statusGameActive = false;
        this.statusGameActiveLock = null;
        this.screen.clear();
        this.sendDraftState();
        // Update draft provider to get fresh data
        this.draftProvider.update();
        // Tell GUI to clear talent tabs and refresh
        this.sendEvent("gui", "draft.cleared");
        console.log("[HotsDraftApp] resetDraft() - Draft reset complete, waiting for new draft");
    }

    init() {
        this.initDraftProvider();
        this.initTalentProvider();
        this.downloadGameData();
        this.detectDisplays();
        // Send initial game data to GUI immediately (for config page dropdowns to work)
        this.sendGameData();
    }
    initDraftProvider() {
        // Remove old provider
        if (this.draftProvider !== null) {
            this.draftProvider.removeAllListeners("change");
            this.draftProvider = null;
        }
        // Init provider
        this.draftProvider = this.createDraftProvider();
        this.draftProvider.init();
        this.draftProvider.on("change", () => {
            if (this.statusDraftActive) {
                this.sendDraftProvider(this.draftProvider);
            }
        });
    }
    initTalentProvider() {
        // Remove old provider
        if (this.talentProvider !== null) {
            this.talentProvider.removeAllListeners("change");
            this.talentProvider = null;
        }
        // Init provider
        this.talentProvider = this.createTalentProvider();
        this.talentProvider.init();
        this.talentProvider.on("change", () => {
            if (this.statusGameActive) {
                this.sendTalentProvider(this.talentProvider);
            }
        });
    }
    detectDisplays() {
        screenshot.listDisplays().then((displays) => {
            console.log("[HotsDraftApp] detectDisplays() - Found " + displays.length + " display(s)");
            this.displays = displays;
            this.sendEvent("gui", "displays.detected", displays);
            // Update config
            let displayPrimary = null;
            let displayConfig = HotsHelpers.getConfig().getOption("gameDisplay");
            let displayConfigFound = false;
            for (let i = 0; i < displays.length; i++) {
                if (displays[i].id == displayConfig) {
                    displayConfigFound = true;
                    break;
                }
                if (displays[i].primary) {
                    displayPrimary = displays[i].id;
                }
            }
            if (!displayConfigFound) {
                HotsHelpers.getConfig().setOption("gameDisplay", (displayPrimary !== null ? displayPrimary : null));
            }
            // Update status
            this.emit("displays.detected");
            this.updateReadyState();
            // Debug output
            if (this.debugEnabled()) {
                console.log("=== DISPLAYS DETECTED ===");
            }
        });
    }
    downloadGameData() {
        this.statusGameDataPending = true;
        this.gameData.update();
    }
    setDebugStep(step) {
        // Debug step logging disabled
    }
    updateForced() {
        console.log("[HotsDraftApp] updateForced() - Starting");
        this.screen.clear();
        this.draftProvider.update();
        // Update talent provider and send talents even if statusGameActive is false
        console.log("[HotsDraftApp] updateForced() - Calling talentProvider.update()");
        this.talentProvider.update().then(() => {
            console.log("[HotsDraftApp] updateForced() - Talent provider update completed, sending talents");
            console.log("[HotsDraftApp] updateForced() - Sending talent provider data");
            // Directly send talent provider data (don't wait for change event since statusGameActive might be false)
            this.sendTalentProvider(this.talentProvider);
        }).catch((err) => {
            console.error("[HotsDraftApp] updateForced() - Talent provider update error:", err);
        });
        this.statusGameActiveLock = null;
        this.update();
        this.sendDraftData();
    }
    updateReadyState() {
        console.log("[HotsDraftApp] updateReadyState() - ready=" + this.ready + ", statusGameDataPending=" + this.statusGameDataPending + ", displays=" + (this.displays !== null ? "YES" : "NO"));
        if (!this.ready) {
            console.log("[HotsDraftApp] updateReadyState() - Check: !statusGameDataPending=" + (!this.statusGameDataPending) + ", displays!==null=" + (this.displays !== null));
            if (!this.statusGameDataPending && (this.displays !== null)) {
                console.log("[HotsDraftApp] updateReadyState() - Setting ready=true and emitting 'ready' event");
                this.ready = true;
                this.emit("ready");
                this.sendReadyState();
            } else {
                console.log("[HotsDraftApp] updateReadyState() - NOT ready yet: statusGameDataPending=" + this.statusGameDataPending + ", displays=" + (this.displays !== null));
            }
        } else {
            console.log("[HotsDraftApp] updateReadyState() - Already ready, skipping");
        }
    }
    updatePage() {
        // Update the gui if the main page is active
        this.sendEvent("gui", "page.update");
    }
    quit() {
        this.app.quit();
    }
    checkNextUpdate() {
        if (!this.statusGameActive && (this.screen.getMap() !== null)) {
            setTimeout(() => {
                this.update();
            }, 500);
        } else {
            this.queueUpdate();
        }
    }
    isGameActive() {
        let now = (new Date()).getTime();
        if (now < this.statusGameActiveLock) {
            return true;
        }
        let tempFileAge = (now - this.statusTempModTime) / 1000;
        if (tempFileAge < 60) {
            return true;
        }
        if (this.statusGameSaveFile !== null) {
            let latestSaveAge = (now - this.statusGameSaveFile.mtime) / 1000;
            if ((this.statusGameSaveFile.mtime - this.statusGameLastReplay.mtime) / 1000 > 30) {
                return (latestSaveAge < 150);
            } else {
                // New replay available, game is done!
                return false;
            }
        } else {
            return false;
        }
    }
    getConfig() {
        return HotsHelpers.getConfig();
    }
    startDetection() {
        this.update();
    }
    queueUpdate() {
        if (!this.statusUpdatePending) {
            this.statusUpdatePending = true;
            setTimeout(() => {
                this.update();
            }, 1000);
        }
    }
    submitReplayData() {
        if (this.statusDraftData === null) {
            return;
        }
        let gameData = this.statusDraftData;
        // Clear draft state
        this.statusDraftData = null;
        // Replay found?
        if (this.statusGameLastReplay.file === null) {
            return;
        }
        // Submit player names and images
        let replay = new HotsReplay(this.statusGameLastReplay.file);
        let replayDetails = replay.getReplayDetails();
        // Validate map name
        if (gameData.map !== replayDetails.m_title.toUpperCase()) {
            return;
        }
        // Match players
        let playersLeft = gameData.players;
        let playersMatched = [];
        for (let r = 0; r < replayDetails.m_playerList.length; r++) {
            for (let i = 0; i < playersLeft.length; i++) {
                if ((playersLeft[i].playerName === replayDetails.m_playerList[r].m_name) ||
                    (playersLeft[i].heroName === replayDetails.m_playerList[r].m_hero.toUpperCase())) {
                    // Player- or Hero-Name matches!
                    playersLeft[i].playerName = replayDetails.m_playerList[r].m_name;
                    playersLeft[i].heroName = replayDetails.m_playerList[r].m_hero.toUpperCase();
                    playersMatched.push( playersLeft[i] );
                    playersLeft.splice(i, 1);
                    break;
                }
            }
        }
        if (playersMatched.length < 9) {
            return;
        }
        for (let i = 0; i < playersMatched.length; i++) {
            let player = playersMatched[i];
            if (player.playerNameImage !== null) {
                this.submitTrainingImage("playerName", player.playerName, player.playerNameImage);
            }
            if (player.heroNameImage !== null) {
                this.submitTrainingImage("heroName", player.heroName, player.heroNameImage);
            }
        }
    }

    /**
     * @param {string} type
     * @param {string} text
     * @param {Buffer} image
     */
    submitTrainingImage(type, text, image) {
        let url = "https://hotsdrafter.godlike.biz/training.php";
        let parameters = {
            "type": type, "text": text, image: image
        };
        request.post({ url: url, formData: parameters }, (err, httpResponse, body) => {
            // TODO: Error handling
        });
    }
    update() {
        if (this.debugEnabled()) console.log("[HotsDraftApp] update() - Starting...");
        this.statusUpdatePending = false;
        // Update game files
        if (this.debugEnabled()) console.log("[HotsDraftApp] update() - Calling updateGameFiles...");
        this.updateGameFiles().then(() => {
            if (this.debugEnabled()) console.log("[HotsDraftApp] update() - updateGameFiles done");
            // Update status
            if (this.statusGameActive) {
                if (this.statusDraftActive) {
                    // Draft just ended
                    this.statusDraftActive = false;
                    this.emit("draft.ended");
                    this.sendDraftState();
                    if (this.debugEnabled()) {
                        console.log("=== DRAFT ENDED ===");
                    }
                }
            } else {
                // Check draft status
                if (this.screen.getMap() !== null) {
                    // Draft is active
                    if (!this.statusDraftActive) {
                        // Draft just started
                        this.statusDraftActive = true;
                        this.emit("draft.started");
                        this.sendDraftState();
                        if (this.debugEnabled()) {
                            console.log("=== DRAFT STARTED ===");
                        }
                    }
                } else {
                    // Draft not active
                    if (this.statusDraftActive) {
                        // Draft just ended
                        this.statusDraftActive = false;
                        this.emit("draft.ended");
                        if (this.debugEnabled()) {
                            console.log("=== DRAFT ENDED ===");
                        }
                    }
                }
                if (this.debugEnabled()) console.log("[HotsDraftApp] update() - Calling updateScreenshot...");
                this.updateScreenshot();
            }
            if (this.debugEnabled()) console.log("[HotsDraftApp] update() - Calling checkNextUpdate...");
            this.checkNextUpdate();
        }).catch((error) => {
            if (this.debugEnabled()) console.warn("[HotsDraftApp] update() - Error in updateGameFiles:", error);
            if (this.debugEnabled()) console.log("[HotsDraftApp] update() - Calling checkNextUpdate anyway...");
            this.checkNextUpdate();
        });
    }
    updateGameFiles() {
        if (this.debugEnabled()) console.log("[HotsDraftApp] updateGameFiles() - Starting...");
        return this.gameData.updateSaves().then(() => {
            if (this.debugEnabled()) console.log("[HotsDraftApp] updateGameFiles() - updateSaves done, calling updateReplays...");
            return this.gameData.updateReplays();
        }).then(() => {
            if (this.debugEnabled()) console.log("[HotsDraftApp] updateGameFiles() - updateReplays done, updating status...");
            this.statusTempModTime = this.gameData.updateTempModTime();
            this.statusGameSaveFile = this.gameData.getLatestSave();
            this.statusGameLastReplay = this.gameData.getLatestReplay();
            // Check if game state changed
            let gameActive = this.isGameActive();
            if (this.statusGameActive !== gameActive) {
                this.statusGameActive = gameActive
                if (gameActive) {
                    if (this.debugEnabled()) console.log("[HotsDraftApp] updateGameFiles() - Game started");
                    this.triggerGameStart();
                } else {
                    if (this.debugEnabled()) console.log("[HotsDraftApp] updateGameFiles() - Game ended");
                    this.triggerGameEnd();
                }
            }
            // Upload missing replays
            if (this.debugEnabled()) console.log("[HotsDraftApp] updateGameFiles() - Calling uploadReplays...");
            return this.gameData.uploadReplays();
        }).then((uploadCount) => {
            if (this.debugEnabled()) console.log("[HotsDraftApp] updateGameFiles() - uploadReplays done, count=" + uploadCount);
            if (uploadCount > 0) {
                // Save updated game data and send it to the gui
                this.gameData.save();
                this.sendGameData();
            }
            if (this.debugEnabled()) console.log("[HotsDraftApp] updateGameFiles() - Done");
        }).catch((error) => {
            if (this.debugEnabled()) console.warn("[HotsDraftApp] updateGameFiles() - Error:", error);
            // Continue anyway
        });
    }
    triggerGameStart() {
        // Game started
        this.updateDraftData();
        // Don't send talent data here - wait for auto-update when hero is picked
        this.screen.clear();
        this.emit("game.started");
        this.sendEvent("gui", "game.start");
        this.setDebugStep("Waiting for game to end...");
        if (this.debugEnabled()) {
            console.log("=== GAME STARTED ===");
        }
    }
    triggerGameEnd() {
        // Game ended
        this.submitReplayData();
        this.sendGameData();
        this.emit("game.ended");
        this.sendEvent("gui", "game.end");
        if (this.debugEnabled()) {
            console.log("=== GAME ENDED ===");
        }
    }
    collectDraftData() {
        let draftData = {
            map: this.screen.getMap(),
            teamActive: this.screen.getTeamActive(),
            banActive: this.screen.banActive,
            provider: this.collectProviderData(this.draftProvider),
            talentProvider: this.collectProviderData(this.talentProvider),
            bans: [],
            bansLocked: {},
            players: []
        };
        let teams = this.screen.getTeams();
        for (let t = 0; t < teams.length; t++) {
            let team = teams[t];
            let bans = team.getBans();
            for (let i in bans) {
                draftData.bans.push( this.collectBanData(team, i) );
            }
            draftData.bansLocked[team.getColor()] = team.bansLocked;
            for (let i in team.getPlayers()) {
                let player = team.getPlayer(i);
                draftData.players.push( this.collectPlayerData(player) );
            }
        };
        return draftData;
    }
    collectTalentData() {
        let talentData = {
            provider: this.collectProviderData(this.talentProvider)
        };
        return talentData;
    }
    collectProviderData(provider) {
        return {
            template: provider.getTemplate(),
            templateData: provider.getTemplateData()
        };
    }
    collectBanData(team, index) {
        let banImage = team.getBanImageData(index);
        let banData = {
            index: index,
            team: team.getColor(),
            locked: team.getBansLocked() > index,
            heroName: team.getBanHero(index),
            heroImage: (banImage !== null ? banImage.toString('base64') : null)
        };
        console.log("[collectBanData] team=" + team.getColor() + ", index=" + index + ", heroName=" + banData.heroName + ", locked=" + banData.locked);
        return banData;
    }
    collectPlayerData(player) {
        let playerNameImg = player.getImagePlayerName();
        let heroNameImg = player.getImageHeroName();
        return {
            index: player.getIndex(),
            team: player.getTeam().getColor(),
            playerName: player.getName(),
            playerNameImage: (playerNameImg ? playerNameImg.toString('base64') : null),
            heroName: player.getCharacter(),
            heroNameImage: (player.isLocked() && heroNameImg ? heroNameImg.toString('base64') : null),
            detectionFailed: player.isDetectionFailed(),
            locked: player.isLocked(),
            recentPicks: player.getRecentPicks()
        };
    }
    collectReplayData(replayIndex) {
        return Object.assign({ index:replayIndex}, this.gameData.replays.details[replayIndex]);
    }
    updateLanguage() {
        this.screen.updateLanguage();
        this.gameData.updateLanguage();
    }
    updateDraftData() {
        this.setDebugStep("Checking draft data...");
        this.statusDraftData = this.collectDraftData();
    }
    updateScreenshot() {
        if (this.statusDetectionRunning || this.screen.updateActive || this.statusDetectionPaused) {
            return;
        }
        this.statusDetectionRunning = true;
        let screenshotOptions = { format: 'png' };
        
        // Use the configured gameDisplay from settings
        let gameDisplayConfig = HotsHelpers.getConfig().getOption("gameDisplay");
        if (gameDisplayConfig !== null && this.displays && this.displays.length > 0) {
            // Find the display with matching ID
            let foundDisplay = null;
            for (let i = 0; i < this.displays.length; i++) {
                if (this.displays[i].id === gameDisplayConfig) {
                    foundDisplay = this.displays[i];
                    break;
                }
            }
            if (foundDisplay) {
                screenshotOptions.screen = foundDisplay.id;
                console.log("[HotsDraftApp] Taking screenshot from configured display ID: " + foundDisplay.id + " (" + foundDisplay.width + "x" + foundDisplay.height + ")");
            } else {
                // Fallback: use the OTHER display (not Display 0, which is where the app runs)
                if (this.displays.length > 1) {
                    screenshotOptions.screen = this.displays[1].id;
                    console.log("[HotsDraftApp] Configured display not found, using secondary display: " + this.displays[1].id + " (" + this.displays[1].width + "x" + this.displays[1].height + ")");
                } else {
                    screenshotOptions.screen = this.displays[0].id;
                    console.log("[HotsDraftApp] Only one display available, using: " + this.displays[0].id + " (" + this.displays[0].width + "x" + this.displays[0].height + ")");
                }
            }
        } else if (this.displays && this.displays.length > 1) {
            // No display configured: use the OTHER display (assume app runs on Display 0, game runs on Display 1)
            screenshotOptions.screen = this.displays[1].id;
            console.log("[HotsDraftApp] No display configured, using secondary display (LG): " + this.displays[1].id + " (" + this.displays[1].width + "x" + this.displays[1].height + ")");
        } else if (this.displays && this.displays.length > 0) {
            screenshotOptions.screen = this.displays[0].id;
            console.log("[HotsDraftApp] Using available display: " + this.displays[0].id + " (" + this.displays[0].width + "x" + this.displays[0].height + ")");
        }
        
        this.setDebugStep("Capturing screenshot...");
        screenshot(screenshotOptions).then((image) => {
            if (this.statusGameActive) {
                this.statusDetectionRunning = false;
                return;
            }
            this.setDebugStep("Analysing screenshot...");
            if (this.debugEnabled()) {
                console.log("Analysing screenshot...");
            }
            this.screen.detect(image).catch((error) => {
                if (this.debugEnabled()) {
                    console.error("[HotsDraftApp] Screenshot detection failed:", error ? error.message : "Unknown error");
                    if (error && error.stack) console.error(error.stack);
                } else {
                    // Always log detection failures, even if debug is disabled
                    console.log("[HotsDraftApp] Screenshot detection failed: " + (error ? error.message : "Unknown error"));
                }
            });
        }).catch((error) => {
            this.statusDetectionRunning = false;
            if (this.debugEnabled()) {
                console.error("[HotsDraftApp] Screenshot capture failed:", error);
                console.error(error.stack);
            } else {
                console.log("[HotsDraftApp] Screenshot capture failed: " + error.message);
            }
        });
    }
}

module.exports = HotsDraftApp;
