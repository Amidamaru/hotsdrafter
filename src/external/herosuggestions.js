// Nodejs dependencies
const axios = require('axios');

// Local classes
const HotsDraftSuggestions = require('../hots-draft-suggestions.js');

class HeroSuggestionsProvider extends HotsDraftSuggestions {

    constructor(app) {
        super(app);
        this.suggestions = {};
        this.suggestionsForm = "";
        this.updateActive = false;
        this.updatePending = false;
        this.apiUrl = "https://n8n-vftr.sliplane.app/webhook/bc37491b-bd6e-43b3-900e-e9504c7c31e9";
    }

    init() {
        console.log("[HeroSuggestions] Provider initialized");
        this.updateActive = false;
        return new Promise((resolve, reject) => {
            resolve(true);
        });
    }

    update() {
        console.log("[HeroSuggestions] update() called");
        if (this.updateActive) {
            console.log("[HeroSuggestions] Update already active, marking as pending");
            this.updatePending = true;
            return;
        }
        this.updatePending = false;
        this.updateActive = true;

        // Get draft screen data
        console.log("[HeroSuggestions] Collecting heroes, picks and map from screen...");
        
        let allHeroes = [];  // bans + picks
        let teamPicks = [];  // locked heroes on blue team
        let mapName = "";

        // Get current map - map is already the English name from screen
        let map = this.screen.getMap();
        if (map) {
            mapName = map;  // screen.getMap() returns the English map name directly
            console.log("[HeroSuggestions] Map: " + mapName);
        } else {
            console.log("[HeroSuggestions] No map detected yet");
        }

        // Get blue team picks
        let teamBlue = this.screen.getTeam("blue");
        if (teamBlue !== null) {
            let playersBlue = teamBlue.getPlayers();
            console.log("[HeroSuggestions] Blue players: " + playersBlue.length);
            for (let i = 0; i < playersBlue.length; i++) {
                if (playersBlue[i].isLocked()) {
                    let heroName = playersBlue[i].getCharacter();
                    heroName = this.app.gameData.fixHeroName(heroName);  // Normalize name
                    console.log("[HeroSuggestions] Blue pick " + i + ": " + heroName);
                    if (heroName && heroName !== "???") {
                        teamPicks.push(heroName);
                        allHeroes.push(heroName);
                    }
                }
            }
        }

        // Get bans from both teams
        let teamRed = this.screen.getTeam("red");
        if (teamRed !== null) {
            let bansRed = teamRed.getBans();
            console.log("[HeroSuggestions] Red bans raw: " + JSON.stringify(bansRed));
            for (let i = 0; i < bansRed.length; i++) {
                if (bansRed[i] && bansRed[i] !== "???" && bansRed[i] !== null) {
                    let heroName = this.app.gameData.fixHeroName(bansRed[i]);  // Normalize name
                    console.log("[HeroSuggestions] Red ban: " + heroName);
                    allHeroes.push(heroName);
                }
            }
            
            let playersRed = teamRed.getPlayers();
            console.log("[HeroSuggestions] Red players: " + playersRed.length);
            for (let i = 0; i < playersRed.length; i++) {
                if (playersRed[i].isLocked()) {
                    let heroName = playersRed[i].getCharacter();
                    heroName = this.app.gameData.fixHeroName(heroName);  // Normalize name
                    console.log("[HeroSuggestions] Red pick " + i + ": " + heroName);
                    if (heroName && heroName !== "???") {
                        allHeroes.push(heroName);
                    }
                }
            }
        }

        if (teamBlue !== null) {
            let bansBlue = teamBlue.getBans();
            console.log("[HeroSuggestions] Blue bans raw: " + JSON.stringify(bansBlue));
            for (let i = 0; i < bansBlue.length; i++) {
                if (bansBlue[i] && bansBlue[i] !== "???" && bansBlue[i] !== null) {
                    let heroName = this.app.gameData.fixHeroName(bansBlue[i]);  // Normalize name
                    console.log("[HeroSuggestions] Blue ban: " + heroName);
                    allHeroes.push(heroName);
                }
            }
        }

        // Remove duplicates and sort
        allHeroes = [...new Set(allHeroes)];
        teamPicks = [...new Set(teamPicks)];

        console.log("[HeroSuggestions] All heroes (bans+picks): " + allHeroes.join(", "));
        console.log("[HeroSuggestions] Team picks: " + teamPicks.join(", "));
        console.log("[HeroSuggestions] Map: " + mapName);

        // Check if we have at least 4 heroes - otherwise don't call API
        if (allHeroes.length < 4) {
            console.log("[HeroSuggestions] Not enough heroes (" + allHeroes.length + "/4), skipping API call");
            this.suggestions = "ERROR_INSUFFICIENT_HEROES";
            this.emit("change");
            this.updateActive = false;
            return true;
        }

        // Create signature to detect changes
        let signature = JSON.stringify({
            heroes: allHeroes.sort().join(","),
            picks: teamPicks.sort().join(","),
            map: mapName
        });

        if (signature === this.suggestionsForm) {
            console.log("[HeroSuggestions] No changes detected, skipping API call");
            this.updateActive = false;
            return true;
        }
        this.suggestionsForm = signature;

        // Helper function to normalize names for API (remove accents, special chars, spaces)
        const normalizeForAPI = (name) => {
            return name
                .toLowerCase()
                .normalize('NFD')                   // Decompose accents
                .replace(/[\u0300-\u036f]/g, '')    // Remove diacritics
                .replace(/[.'\s]/g, '')              // Remove apostrophes, periods, spaces
                .toUpperCase();
        };

        // Build API query string with normalized names
        let queryParams = new URLSearchParams();
        queryParams.append('heroes', allHeroes.map(normalizeForAPI).join(','));
        queryParams.append('map', mapName);
        queryParams.append('teampicks', teamPicks.map(normalizeForAPI).join(','));

        let fullUrl = this.apiUrl + "?" + queryParams.toString();
        console.log("[HeroSuggestions] ⭐ Making API call to: " + fullUrl);

        return new Promise((resolve, reject) => {
            axios.get(fullUrl)
                .then(response => {
                    this.updateActive = false;
                    console.log("[HeroSuggestions] API response received, status: " + response.status);
                    console.log("[HeroSuggestions] Response data: " + JSON.stringify(response.data));

                    if (response.status !== 200) {
                        console.error("[HeroSuggestions] Invalid status code <" + response.status + ">");
                        reject('Invalid status code <' + response.status + '>');
                        return;
                    }

                    this.loadUpdateData(response.data);
                    resolve(true);
                })
                .catch(error => {
                    this.updateActive = false;
                    console.error("[HeroSuggestions] API error: " + error.message);
                    if (error.response) {
                        console.error("[HeroSuggestions] Response status: " + error.response.status);
                        console.error("[HeroSuggestions] Response body: " + JSON.stringify(error.response.data));
                    } else {
                        console.error("[HeroSuggestions] No response from server");
                    }
                    console.error("[HeroSuggestions] Request URL: " + fullUrl);
                    reject(error);
                });
        });
    }

    loadUpdateData(response) {
        console.log("[HeroSuggestions] Parsing API response...");

        if (!response || (typeof response === 'string' && response.trim() === '')) {
            console.error("[HeroSuggestions] Empty response from API");
            this.suggestions = "ERROR_EMPTY_RESPONSE";
            this.emit("change");
            return;
        }

        // Store the response as-is (should be HTML string or object)
        // If it's an object, convert to JSON string for storage
        if (typeof response === 'string') {
            this.suggestions = response;
        } else {
            this.suggestions = JSON.stringify(response);
        }
        
        console.log("[HeroSuggestions] Suggestions loaded, length: " + String(this.suggestions).length);

        this.emit("update.done");
        this.emit("change");

        if (this.updatePending) {
            console.log("[HeroSuggestions] Update pending, calling update again");
            this.update();
        }
    }

    getTemplate() {
        return "external/herosuggestions.twig.html";
    }

    getTemplateData() {
        return {
            suggestions: this.suggestions
        };
    }

    getSuggestions() {
        return this.suggestions;
    }

};

module.exports = HeroSuggestionsProvider;
