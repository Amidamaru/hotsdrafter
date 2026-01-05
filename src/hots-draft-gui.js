// Nodejs dependencies
const path = require('path');
const Twig = require('twig');
const EventEmitter = require('events');
const { ipcRenderer } = require('electron');

// Local classes
const HotsHelpers = require('./hots-helpers.js');

// Templates
const templates = {
    "main": path.resolve(__dirname, "..", "gui", "pages", "main.twig.html"),
    "config": path.resolve(__dirname, "..", "gui", "pages", "config.twig.html"),
    "replays": path.resolve(__dirname, "..", "gui", "pages", "replays.twig.html"),
    "detectionTuningContent": path.resolve(__dirname, "..", "gui", "elements", "detectionTuning.content.twig.html"),
    "elementBan": path.resolve(__dirname, "..", "gui", "elements", "ban.twig.html"),
    "elementPlayer": path.resolve(__dirname, "..", "gui", "elements", "player.twig.html"),
    "elementReplay": path.resolve(__dirname, "..", "gui", "elements", "replay.twig.html")
};

class HotsDraftGui extends EventEmitter {

    constructor(window) {
        console.log("[HotsDraftGui] Constructor called");
        super();
        this.debugStep = "Initializing...";
        this.document = window.document;
        this.window = window;
        // GUI relevant fields
        this.page = "main";
        this.ready = false;
        this.config = null;
        this.displays = null;
        this.draft = null;
        this.talents = null;
        this.gameActive = false;
        this.gameData = null;
        this.debugData = [];
        this.modalActive = false;
        this.updateProgress = 0;
        this.lastTalentProviderHash = null;  // Track talent provider data to avoid unnecessary updates
        this.registerEvents();
        this.sendEvent("gui", "window.ready");
        this.renderPage();
    }
    debugEnabled() {
        return HotsHelpers.getConfig().getOption("debugEnabled");
    }
    registerEvents() {
        console.log("[GUI] registerEvents() - Starting, jQuery available=" + (typeof jQuery !== 'undefined'));
        ipcRenderer.on("gui", (event, type, ...parameters) => {
            this.handleEvent(null, type, parameters);
        });
        
        // Register menu button events once (not in template to avoid duplicate registration)
        console.log("[GUI] registerEvents() - Registering menu button events");
        jQuery(document).on("click", "[data-action=\"draft\"]", (e) => {
            e.preventDefault();
            this.changePage("main");
        });
        jQuery(document).on("click", "[data-action=\"replays\"]", (e) => {
            e.preventDefault();
            this.changePage("replays");
        });
        jQuery(document).on("click", "[data-action=\"config\"]", (e) => {
            e.preventDefault();
            this.changePage("config");
        });
        jQuery(document).on("click", "[data-action=\"forceUpdate\"]", (e) => {
            e.preventDefault();
            this.forceUpdate();
        });
        jQuery(document).on("click", "[data-action=\"resetDraft\"]", (e) => {
            e.preventDefault();
            console.log("[GUI] Reset button clicked");
            this.sendEvent("gui", "draft.reset");
            this.sendEvent("gui", "update.forced");
        });
        jQuery(document).on("click", "[data-action=\"quit\"]", (e) => {
            e.preventDefault();
            this.quit();
        });
        // Handle clicks on failed bans (???)
        jQuery(document).on("click", "[data-type='ban'][data-failed='true']", (e) => {
            e.preventDefault();
            e.stopPropagation();
            let banElement = jQuery(e.currentTarget);
            let team = banElement.attr("data-team");
            let index = banElement.attr("data-index");
            console.log("[GUI] Failed ban clicked - team: " + team + ", index: " + index);
            this.showHeroSelectionModal(team, index);
        });
        console.log("[GUI] registerEvents() - Menu button events registered");
    }
    showHeroSelectionModal(team, banIndex) {
        console.log("[GUI] showHeroSelectionModal - team: " + team + ", banIndex: " + banIndex);
        if (!this.gameData) {
            console.error("[GUI] gameData not available");
            return;
        }
        
        // Get all heroes
        let allHeroes = this.gameData.getHeroes();
        let heroOptions = allHeroes.map(hero => `<option value="${hero.id}">${hero.name}</option>`).join('');
        
        // Create modal HTML
        let modalHtml = `
            <div class="modal fade" id="heroSelectionModal" tabindex="-1" role="dialog" aria-labelledby="heroSelectionLabel" aria-hidden="true">
                <div class="modal-dialog" role="document">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title" id="heroSelectionLabel">Hero Selection für fehlgeschlagenen Ban</h5>
                            <button type="button" class="close" data-dismiss="modal" aria-label="Close">
                                <span aria-hidden="true">&times;</span>
                            </button>
                        </div>
                        <div class="modal-body">
                            <label for="heroSelector">Wähle einen Hero:</label>
                            <select id="heroSelector" class="form-control">
                                <option value="">-- Wähle einen Hero --</option>
                                ${heroOptions}
                            </select>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-dismiss="modal">Abbrechen</button>
                            <button type="button" class="btn btn-primary" id="confirmHeroSelection">Bestätigen</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Remove old modal if exists
        jQuery("#heroSelectionModal").remove();
        
        // Add modal to DOM
        jQuery("body").append(modalHtml);
        
        // Show modal
        jQuery("#heroSelectionModal").modal("show");
        
        // Handle confirmation
        let self = this;
        jQuery("#confirmHeroSelection").off("click").on("click", function() {
            let selectedHeroId = jQuery("#heroSelector").val();
            if (selectedHeroId) {
                let hero = allHeroes.find(h => h.id == selectedHeroId);
                if (hero) {
                    console.log("[GUI] Selected hero: " + hero.name + " (id: " + hero.id + ")");
                    self.sendEvent("gui", "ban.manual-select", [team, banIndex, hero.id, hero.name]);
                    jQuery("#heroSelectionModal").modal("hide");
                }
            }
        });
    }

    handleEvent(event, type, parameters) {
        switch (type) {
            case "config":
                this.config = parameters[0];
                break;
            case "draft":
                this.draft = parameters[0];
                console.log("[GUI] Received draft data: " + this.draft.bans.length + " bans, " + this.draft.players.length + " players, teamActive=" + this.draft.teamActive + ", banActive=" + this.draft.banActive);
                // If page not rendered yet, do initial render
                if (jQuery(".page").html() === "" || jQuery(".page").find("[data-type='draft']").length === 0) {
                    console.log("[GUI] Initial draft data - rendering page");
                    this.refreshPage();
                } else {
                    // Page already rendered, don't refresh to preserve tabs
                    console.log("[GUI] Page already rendered - skipping full refresh");
                }
                break;
            case "draft.status":
                this.draftActive = parameters[0];
                // Don't refresh - already handled by draft updates
                console.log("[GUI] Draft status: " + this.draftActive);
                break;
            case "talents":
                this.talents = parameters[0];
                // Don't refresh - talentProvider handles its own rendering
                console.log("[GUI] Talents data received");
                break;
            case "ban.update":
                this.updateBan(...parameters);
                break;
            case "player.update":
                this.updatePlayer(...parameters);
                break;
            case "draftProvider.update":
                this.updateDraftProvider(...parameters);
                break;
            case "talentProvider.update":
                this.updateTalentProvider(...parameters);
                break;
            case "draft.cleared":
                console.log("[GUI] draft.cleared - Clearing talent tabs and refreshing page");
                // Clear talent tabs
                jQuery("[data-type=\"talent-provider\"] .nav-link").parent().remove();
                jQuery("[data-type=\"talent-provider\"] .tab-content").html("");
                // Force page refresh
                this.refreshPage();
                break;
            case "replay.update":
                this.updateReplay(...parameters);
                break;
            case "game.start":
                this.gameActive = true;
                break;
            case "game.end":
                this.gameActive = false;
                this.refreshPage();
                break;
            case "gameData":
                console.log("[HotsDraftGui] handleEvent() - Received gameData with " + (parameters[0].languageOptions ? parameters[0].languageOptions.length : 0) + " language options");
                this.gameData = parameters[0];
                this.refreshPage();
                break;
            case "debugData":
                this.debugData = parameters[0];
                break;
            case "displays.detected":
                console.log("[HotsDraftGui] handleEvent() - Received displays.detected with " + (parameters[0] ? parameters[0].length : 0) + " display(s)");
                this.setDisplays(parameters[0]);
                break;
            case "ready.status":
                this.ready = parameters[0];
                this.refreshPage();
                break;
            case "update.start":
                this.setUpdateProgress(0);
                break;
            case "update.progress":
                this.setUpdateProgress(parameters[0]);
                break;
            case "update.done":
                this.setUpdateProgress(100);
                break;
            case "page.update":
                this.refreshPage();
                break;
            case "update.progress":
                this.setUpdateProgress(parameters[0]);
                break;
        }
    }
    sendEvent(channel, type, ...parameters) {
        console.log("[HotsDraftGui] sendEvent() - channel=" + channel + ", type=" + type + ", params=" + JSON.stringify(parameters));
        ipcRenderer.send(channel, type, ...parameters);
    }

    changePage(targetPage) {
        if (this.page !== targetPage) {
            this.page = targetPage;
            this.renderPage();
        }
    }

    forceUpdate() {
        this.sendEvent("gui", "update.forced");
    }
    fixHeroName(name) {
        if (this.gameData.substitutions.hasOwnProperty(name)) {
          name = this.gameData.substitutions[name];
        }
        name = name.toUpperCase();
        return name;
    }
    hasPlayerRecentPicks(playerName) {
        return this.getPlayerBattleTags(playerName).length > 0;
    }
    getDisplays() {
        return this.displays;
    }
    getHeroId(heroName) {
        if (!this.gameData.heroes.name.hasOwnProperty(this.config.language)) {
            return null;
        }
        for (let heroId in this.gameData.heroes.name[this.config.language]) {
            if (this.gameData.heroes.name[this.config.language][heroId] === heroName) {
                return heroId;
            }
        }
        return null;
    }
    getHeroImage(heroName) {
        console.log("[getHeroImage] Called with heroName: '" + heroName + "'");
        if (!heroName) {
            console.log("[getHeroImage] heroName is empty/null, returning null");
            return null;
        }
        console.log("[getHeroImage] gameData available: " + (this.gameData ? 'YES' : 'NO'));
        
        // The heroName comes from the backend in English (e.g., "liming")
        // Don't try to translate it - just use it directly as the filename
        const banFileName = heroName.toLowerCase().replace(/[^a-z0-9]/g, '') + ".png";
        const imagePath = "../data/bans/" + banFileName;
        console.log("[getHeroImage] Using heroName directly as filename. banFileName: '" + banFileName + "', final path: '" + imagePath + "'");
        return imagePath;
    }

    reloadDraftProvider() {
        this.sendEvent("gui", "draftProvider.reload");
    }
    draftProviderAction(...params) {
        this.sendEvent("gui", "draftProvider.action", ...params);
    }

    saveHeroBanImage(heroId, imageData) {
        this.sendEvent("gui", "ban.save", heroId, imageData);
    }

    saveCorrection(heroNameFailed, heroId) {
        this.sendEvent("gui", "hero.correct", heroNameFailed, heroId);
    }

    setConfigOption(name, value) {
        console.log("[HotsDraftGui] setConfigOption() - " + name + " = " + JSON.stringify(value));
        if (this.config === null) {
            console.error("Trying to modify config before receiving it!");
            return;
        }
        this.config[name] = value;
        this.sendEvent("gui", "config.option.set", name, value);
    }
    setDisplays(displays) {
        this.displays = displays;
    }
    setDebugStep(step) {
        this.debugStep = step;
        jQuery(".debug-step").text(step);
    }
    setModalActive(modalActive) {
        this.modalActive = modalActive;
        if (!modalActive) {
            // Re-render page after closing a modal
            this.refreshPage();
        }
    }
    setUpdateProgress(percent) {
        this.updateProgress = percent;
        jQuery(".page").find(".progress-bar").css("width", this.updateProgress+"%");
    }

    pauseDetection() {
        this.sendEvent("gui", "detection.pause");
    }

    resumeDetection() {
        this.sendEvent("gui", "detection.resume");
    }

    resetDraft() {
        this.sendEvent("gui", "draft.reset");
    }

    quit() {
        this.sendEvent("gui", "quit");
    }

    renderPage() {
        console.log("[GUI] renderPage() - Rendering page: " + this.page);
        if (this.modalActive) {
            console.log("[GUI] renderPage() - Modal is active, skipping render");
            return;
        }
        Twig.renderFile(templates[this.page], {
            gui: this
        }, (error, html) => {
            if (error) {
                console.error("[GUI] renderPage() - Twig render error:", error);
            } else {
                console.log("[GUI] renderPage() - Page rendered successfully, inserting into DOM");
                jQuery(".page").html(html);
                // Execute inline scripts (jQuery.html() doesn't execute them automatically)
                jQuery(".page").find("script").each((index, element) => {
                    let scriptContent = jQuery(element).text();
                    console.log("[GUI] renderPage() - Executing script #" + index);
                    try {
                        eval(scriptContent);
                    } catch (err) {
                        console.error("[GUI] renderPage() - Script execution error:", err);
                    }
                });
                // After rendering, manually bind events for config page
                if (this.page === "config") {
                    console.log("[GUI] renderPage() - Config page detected, calling bindConfigPageEvents()");
                    this.bindConfigPageEvents();
                } else {
                    console.log("[GUI] renderPage() - Page is '" + this.page + "', not config");
                }
            }
        });
    }

    bindConfigPageEvents() {
        // Bind all form field change events for config page
        console.log("[GUI] bindConfigPageEvents() - Binding config page events...");
        console.log("[GUI] this.gameData = " + JSON.stringify(this.gameData));
        
        // Simple text/select fields
        jQuery("#playerBattleTag").on("change keyup", (e) => {
            this.setConfigOption("playerBattleTag", e.target.value);
        });

        jQuery("#displayMode").on("change", (e) => {
            this.setConfigOption("displayMode", e.target.value);
        });

        jQuery("#language").on("change", (e) => {
            console.log("[GUI] Language changed to: " + e.target.value);
            this.setConfigOption("language", e.target.value);
        });
        
        // Debug: Check if language dropdown has options
        let languageOptions = jQuery("#language option").length;
        let languageValue = jQuery("#language").val();
        console.log("[GUI] Language dropdown found with " + languageOptions + " options, current value: " + languageValue);
        
        // Log all available options
        jQuery("#language option").each((index, option) => {
            console.log("[GUI]   Option " + index + ": value='" + option.value + "', text='" + option.text + "'");
        });

        jQuery("#draftProvider").on("change", (e) => {
            this.setConfigOption("draftProvider", e.target.value);
        });

        jQuery("#talentProvider").on("change", (e) => {
            this.setConfigOption("talentProvider", e.target.value);
        });

        jQuery("#gameDisplay").on("change", (e) => {
            this.setConfigOption("gameDisplay", e.target.value);
        });

        jQuery("#playerName").on("change keyup", (e) => {
            this.setConfigOption("playerName", e.target.value);
        });

        jQuery("#googleBigQueryProject").on("change keyup", (e) => {
            this.setConfigOption("googleBigQueryProject", (e.target.value !== "" ? e.target.value : null));
        });

        // Checkbox fields
        jQuery("#uploadProvider_hotsapi").on("change", (e) => {
            this.setConfigOption("uploadProvider_hotsapi", e.target.checked);
        });

        jQuery("#gameImproveDetection").on("change", (e) => {
            this.setConfigOption("gameImproveDetection", e.target.checked);
        });

        jQuery("#debugEnabled").on("change", (e) => {
            this.setConfigOption("debugEnabled", e.target.checked);
        });

        // File/Directory selection buttons
        jQuery("#gameStorageDir").on("click", (e) => {
            this.openDirectoryDialog("gameStorageDir");
        });

        jQuery("#gameTempDir").on("click", (e) => {
            this.openDirectoryDialog("gameTempDir");
        });

        jQuery("#googleBigQueryAuth").on("click", (e) => {
            this.openFileDialog("googleBigQueryAuth");
        });

        // Save button
        jQuery("#saveConfigButton").on("click", () => {
            jQuery("#saveConfigButton").text("✓ Gespeichert!").prop("disabled", true).css("color", "green");
            setTimeout(() => {
                jQuery("#saveConfigButton").text("Konfiguration speichern").prop("disabled", false).css("color", "");
            }, 2000);
        });
    }

    openDirectoryDialog(fieldId) {
        const { ipcRenderer } = require('electron');
        const currentValue = jQuery("#" + fieldId).val();
        
        ipcRenderer.invoke('open-directory-dialog', { defaultPath: currentValue }).then((result) => {
            if (result.filePaths && result.filePaths.length > 0) {
                jQuery("#" + fieldId).val(result.filePaths[0]);
                this.setConfigOption(fieldId, (result.filePaths[0] !== "" ? result.filePaths[0] : null));
                jQuery("#" + fieldId).addClass("is-valid").removeClass("is-invalid");
            }
        }).catch((err) => {
            console.error("[GUI] Directory dialog error:", err);
        });
    }

    openFileDialog(fieldId) {
        const { ipcRenderer } = require('electron');
        const currentValue = jQuery("#" + fieldId).val();
        
        ipcRenderer.invoke('open-file-dialog', { defaultPath: currentValue }).then((result) => {
            if (result.filePaths && result.filePaths.length > 0) {
                jQuery("#" + fieldId).val(result.filePaths[0]);
                this.setConfigOption(fieldId, (result.filePaths[0] !== "" ? result.filePaths[0] : null));
                jQuery("#" + fieldId).addClass("is-valid").removeClass("is-invalid");
            }
        }).catch((err) => {
            console.error("[GUI] File dialog error:", err);
        });
    }
    refreshPage() {
        if (this.modalActive) {
            return;
        }
        
        // Don't refresh page if we have talent tabs (active or not) - preserve user's selection
        // Check for any nav-link in the talent provider, not just active ones
        if (this.page === "main" && jQuery("[data-type=\"talent-provider\"] .nav-link").length > 0) {
            console.log("[GUI] refreshPage() - Talent tabs exist, skipping full refresh to preserve state");
            return;
        }
        
        this.renderPage();
    }
    
    updateDraftDisplay() {
        // Update draft display without full page refresh to preserve UI state
        // This is a minimal update that preserves tabs and other UI elements
        console.log("[HotsDraftGui] updateDraftDisplay() - Minimal draft update");
        
        // For now, just log that we're doing a minimal update
        // The template will automatically reflect changes via binding
        // If needed, specific elements can be updated here
    }

    renderDetectionTunerContent(targetElement, cbDone) {
        let debugDataGrouped = {};
        for (let i = 0; i < this.debugData.length; i++) {
            if (!debugDataGrouped.hasOwnProperty(this.debugData[i].colorsIdent)) {
                debugDataGrouped[this.debugData[i].colorsIdent] = {
                    images: [],
                    colorsPositive: this.debugData[i].colorsPositive,
                    colorsNegative: this.debugData[i].colorsNegative,
                    colorsInvert: this.debugData[i].colorsInvert
                };
            }
            debugDataGrouped[this.debugData[i].colorsIdent].images.push(this.debugData[i]);
        }
        Twig.renderFile(templates["detectionTuningContent"], {
            debugData: debugDataGrouped
        }, (error, html) => {
            if (error) {
                console.error(error);
            } else {
                jQuery(targetElement).html(html);
                cbDone();
            }
        });
    }

    updateBan(banData) {
        console.log("[GUI updateBan] team=" + banData.team + ", index=" + banData.index + ", heroName=" + banData.heroName);
        console.log("[GUI updateBan] Full banData: " + JSON.stringify(banData));
        // Update local draft data
        for (let i = 0; i < this.draft.bans.length; i++) {
            if ((this.draft.bans[i].team == banData.team) && (this.draft.bans[i].index == banData.index)) {
                this.draft.bans[i] = banData;
                break;
            }
        }
        // Update gui
        let selector = "[data-type=\"ban\"][data-team=\""+banData.team+"\"][data-index=\""+banData.index+"\"]";
        if (jQuery(selector).length === 0) {
            // No element available. Skip.
            // TODO: Render the whole page in this case?
            return;
        }
        console.log("[GUI updateBan] Rendering ban with heroName: " + banData.heroName);
        Twig.renderFile(templates.elementBan, Object.assign({ gui: this }, banData), (error, html) => {
            if (error) {
                console.error(error);
            } else {
                console.log("[GUI updateBan] Ban HTML rendered successfully for " + banData.heroName);
                jQuery(selector).replaceWith(html);
                jQuery(document).trigger("ban.init", jQuery(selector));
            }
        });
    }

    updatePlayer(playerData) {
        // Update local draft data
        for (let i = 0; i < this.draft.players.length; i++) {
            if ((this.draft.players[i].team == playerData.team) && (this.draft.players[i].index == playerData.index)) {
                this.draft.players[i] = playerData;
                break;
            }
        }
        // Update gui
        let selector = "[data-type=\"player\"][data-team=\""+playerData.team+"\"][data-index=\""+playerData.index+"\"]";
        if (jQuery(selector).length === 0) {
            // No element available. Skip.
            // TODO: Render the whole page in this case?
            return;
        }
        Twig.renderFile(templates.elementPlayer, Object.assign({ gui: this }, playerData), (error, html) => {
            if (error) {
                console.error(error);
            } else {
                jQuery(selector).replaceWith(html);
                jQuery(document).trigger("player.init", jQuery(selector));
            }
        });
    }

    updateReplay(replayData) {
        // Update local game data
        this.gameData.replays.details[replayData.index] = replayData;
        // Update gui
        let selector = "[data-type=\"replay\"][data-index=\""+replayData.index+"\"]";
        if (jQuery(selector).length === 0) {
            // No element available. Skip.
            // TODO: Render the whole page in this case?
            return;
        }
        Twig.renderFile(templates.elementReplay, Object.assign({ gui: this }, replayData), (error, html) => {
            if (error) {
                console.error(error);
            } else {
                jQuery(selector).replaceWith(html);
                jQuery(document).trigger("replay.init", jQuery(selector));
            }
        });
    }

    updateDraftProvider(providerData) {
        // Update local draft data
        this.draft.provider = providerData;
        // Update gui
        let selector = "[data-type=\"draft-provider\"]";
        if (jQuery(selector).length === 0) {
            // No element available. Skip.
            // TODO: Render the whole page in this case?
            return;
        }
        let providerTemplate = path.resolve(__dirname, "..", "gui", providerData.template);
        Twig.renderFile(providerTemplate, Object.assign({ gui: this }, providerData.templateData), (error, html) => {
            if (error) {
                console.error(error);
            } else {
                jQuery(selector).replaceWith(html);
                jQuery(document).trigger("draftProvider.init", jQuery(selector));
            }
        });
    }

    updateTalentProvider(providerData) {
        // Initialize talents object if not already done
        if (this.talents === null) {
            this.talents = { provider: null };
        }
        
        // Update local draft data
        this.talents.provider = providerData;
        
        // Update gui
        let selector = "[data-type=\"talent-provider\"]";
        if (jQuery(selector).length === 0) {
            // No element available. Skip.
            return;
        }
        
        // Don't update if tabs already exist - preserve user's tab selection
        if (jQuery(selector).find(".nav-link").length > 0) {
            // Tabs already exist, check if this is a refresh
            // Hide content, show spinner
            jQuery(selector).find(".container").hide();
            jQuery("#talentLoadingSpinner").show();
            
            // Small delay before reloading
            setTimeout(() => {
                // Clear tabs so they reload
                jQuery(selector).find(".nav-link").parent().remove();
                jQuery(selector).find(".tab-content").html("");
                
                // Re-render
                let providerTemplate = path.resolve(__dirname, "..", "gui", providerData.template);
                Twig.renderFile(providerTemplate, Object.assign({ gui: this }, providerData.templateData), (error, html) => {
                    if (error) {
                        console.error(error);
                        jQuery("#talentLoadingSpinner").hide();
                    } else {
                        console.log("[GUI] updateTalentProvider - Rendering new template and hiding spinner");
                        jQuery(selector).html(jQuery(html).html());
                        jQuery("#talentLoadingSpinner").hide();
                        jQuery(selector).find(".container").show();
                        console.log("[GUI] updateTalentProvider - Spinner hidden, content shown");
                        jQuery(document).trigger("talentProvider.init", jQuery(selector));
                        jQuery(document).trigger("talentProvider.updated");
                        console.log("[GUI] updateTalentProvider - Events triggered");
                    }
                });
            }, 300);
            return;
        }
        
        // First render - show spinner while loading
        jQuery("#talentLoadingSpinner").show();
        
        let providerTemplate = path.resolve(__dirname, "..", "gui", providerData.template);
        Twig.renderFile(providerTemplate, Object.assign({ gui: this }, providerData.templateData), (error, html) => {
            if (error) {
                console.error(error);
                jQuery("#talentLoadingSpinner").hide();
            } else {
                jQuery(selector).html(jQuery(html).html());
                jQuery("#talentLoadingSpinner").hide();
                jQuery(document).trigger("talentProvider.init", jQuery(selector));
            }
        });
    }
}

module.exports = HotsDraftGui;
