// Nodejs dependencies
const axios = require('axios');
const cheerio = require('cheerio');

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
        
        let allBans = [];      // only bans
        let allPicks = [];     // only picks
        let teamPicks = [];    // locked heroes on blue team
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
                        allPicks.push(heroName);
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
                    allBans.push(heroName);
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
                        allPicks.push(heroName);
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
                    allBans.push(heroName);
                }
            }
        }

        // Remove duplicates and sort
        allBans = [...new Set(allBans)];
        allPicks = [...new Set(allPicks)];
        teamPicks = [...new Set(teamPicks)];

        console.log("[HeroSuggestions] All bans: " + allBans.join(", "));
        console.log("[HeroSuggestions] All picks: " + allPicks.join(", "));
        console.log("[HeroSuggestions] Team picks: " + teamPicks.join(", "));
        console.log("[HeroSuggestions] Map: " + mapName);

        // Check if we have at least 4 heroes - otherwise don't call API
        let allHeroes = allBans.concat(allPicks);
        if (allHeroes.length < 4) {
            console.log("[HeroSuggestions] Not enough heroes (" + allHeroes.length + "/4), skipping API call");
            this.suggestions = "ERROR_INSUFFICIENT_HEROES";
            this.emit("change");
            this.updateActive = false;
            return true;
        }

        // Create signature to detect changes
        let signature = JSON.stringify({
            bans: allBans.sort().join(","),
            picks: allPicks.sort().join(","),
            teampicks: teamPicks.sort().join(","),
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

        // Build API query string with normalized names - BANS first, then PICKS
        let queryParams = new URLSearchParams();
        queryParams.append('heroes', allBans.map(normalizeForAPI).join(',') + (allPicks.length > 0 ? ',' + allPicks.map(normalizeForAPI).join(',') : ''));
        queryParams.append('map', mapName);
        queryParams.append('teampicks', teamPicks.map(normalizeForAPI).join(','));

        let fullUrl = this.apiUrl + "?" + queryParams.toString();
        console.log("[HeroSuggestions] ⭐ Making API call to: " + fullUrl);

        return new Promise((resolve, reject) => {
            axios.get(fullUrl)
                .then(response => {
                    this.updateActive = false;
                    console.log("[HeroSuggestions] API response received, status: " + response.status);

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

        let htmlContent = typeof response === 'string' ? response : JSON.stringify(response);
        
        // Parse HTML and add Draft Values under each hero
        try {
            const $ = cheerio.load(htmlContent);
            
            // Find all hero pictures and extract draft values
            $('.rounded-picture').each((index, element) => {
                const $element = $(element);
                const dataContent = $element.attr('data-content') || '';
                
                // Extract HP Draft Value using regex
                const draftValueMatch = dataContent.match(/HP Draft Value:\s*([\d.]+)/);
                if (draftValueMatch && draftValueMatch[1]) {
                    const draftValue = draftValueMatch[1];
                    
                    // Add CSS position relative to the link element if not already set
                    if (!$element.attr('style') || !$element.attr('style').includes('position')) {
                        $element.attr('style', (i, val) => (val || '') + '; position: relative; display: inline-block;');
                    }
                    
                    // Add a small span with the draft value positioned at the bottom
                    $element.append(`<span class="hero-draft-value" style="position: absolute; bottom: -12px; left: 50%; transform: translateX(-50%); font-size: 10px; font-weight: bold; color: #ff6b00; white-space: nowrap; line-height: 1;">${draftValue}</span>`);
                }
            });
            
            htmlContent = $.html();
            console.log("[HeroSuggestions] Draft values added to HTML");
        } catch (error) {
            console.error("[HeroSuggestions] Error parsing HTML: " + error.message);
            // Continue with unmodified content if parsing fails
        }

        this.suggestions = htmlContent;
        
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
