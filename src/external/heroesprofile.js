// Nodejs dependencies
const axios = require('axios');

// Local classes
const HotsDraftSuggestions = require('../hots-draft-suggestions.js');

class HeroesProfileProvider extends HotsDraftSuggestions {

    constructor(app) {
        super(app);
        this.heroesByName = {};
        this.heroesById = {};
        this.heroesById_HP = {}; // HeroesProfile uses different IDs
        this.patches = [];
        this.currentPatch = "";
        this.picksBlue = [];
        this.picksRed = [];
        this.bans = [];
        this.sortField = {
            "blue": "value",
            "red": "value"
        };
        this.suggestions = {};
        this.suggestionsForm = "";
        this.updateActive = false;
        this.updatePending = false;
    }

    addHero(id, name, role, image, hpId) {
        let hero = {
            id: id, name: name, role: role, image: image, hpId: hpId
        }
        this.heroesByName[name.toUpperCase()] = hero;
        this.heroesById[id] = hero;
        if (hpId) {
            this.heroesById_HP[hpId] = hero;
        }
    }

    loadInitialData(response) {
        // Parse patches from response if available
        if (response.patches && Array.isArray(response.patches)) {
            this.patches = response.patches;
            if (this.patches.length > 0) {
                this.currentPatch = this.patches[0].id || this.patches[0];
            }
        }
        
        // Parse hero mapping if available in response
        if (response.heroes && typeof response.heroes === 'object') {
            for (let hpId in response.heroes) {
                let heroData = response.heroes[hpId];
                if (heroData.name) {
                    this.addHero(
                        heroData.id || hpId,
                        heroData.name,
                        heroData.role || "Unknown",
                        heroData.image || "",
                        hpId
                    );
                }
            }
        }
    }

    loadUpdateData(response) {
        if (!response || !response.suggestions) {
            console.error("[HeroesProfile] Update failed: invalid response");
            console.error("[HeroesProfile] Response: ", response);
            this.suggestionsForm = null;
            if (this.updatePending) {
                this.update();
            }
            return;
        }

        console.log("[HeroesProfile] Parsing suggestions from response...");
        console.log("[HeroesProfile] Friend suggestions count: " + Object.keys(response.suggestions.friend || {}).length);
        console.log("[HeroesProfile] Enemy suggestions count: " + Object.keys(response.suggestions.enemy || {}).length);

        this.suggestions = {
            friend: [],
            enemy: [],
            tips: (response.tips || [])
        };

        // Parse friendly suggestions (heroes to pick for our team)
        if (response.suggestions.friend) {
            for (let heroId in response.suggestions.friend) {
                let hero = response.suggestions.friend[heroId];
                
                // Use hero ID from response, fallback to index
                let id = hero.id || hero.heroId || heroId;
                hero.id = id;
                hero.hpId = heroId;
                
                // Extract star rating (best/meta picks are usually marked)
                hero.starred = hero.starred || hero.recommended || hero.meta || false;
                
                // Extract value/winrate for sorting
                hero.value = parseFloat(hero.value || hero.winrate || 0);
                hero.winrate = parseFloat(hero.winrate || 0);
                hero.popularity = parseFloat(hero.popularity || hero.pickRate || 0);
                
                // Extract hero image if provided
                hero.image = hero.image || hero.heroImage || "";
                
                this.suggestions.friend.push(hero);
            }
        }

        // Parse enemy suggestions (heroes to pick against enemy)
        if (response.suggestions.enemy) {
            for (let heroId in response.suggestions.enemy) {
                let hero = response.suggestions.enemy[heroId];
                
                let id = hero.id || hero.heroId || heroId;
                hero.id = id;
                hero.hpId = heroId;
                hero.starred = hero.starred || hero.recommended || hero.meta || false;
                hero.value = parseFloat(hero.value || hero.winrate || 0);
                hero.winrate = parseFloat(hero.winrate || 0);
                hero.popularity = parseFloat(hero.popularity || hero.pickRate || 0);
                hero.image = hero.image || hero.heroImage || "";
                
                this.suggestions.enemy.push(hero);
            }
        }

        console.log("[HeroesProfile] Suggestions parsed successfully");
        console.log("[HeroesProfile] Friend heroes loaded: " + this.suggestions.friend.length);
        console.log("[HeroesProfile] Enemy heroes loaded: " + this.suggestions.enemy.length);

        this.sortSuggestions("blue");
        this.sortSuggestions("red");
        console.log("[HeroesProfile] Suggestions sorted");
        
        this.emit("update.done");
        this.emit("change");
        if (this.updatePending) {
            console.log("[HeroesProfile] Update pending, calling update again");
            this.update();
        }
    }

    getHeroByName(name) {
        name = this.app.gameData.getHeroNameTranslation(name, "en-us");
        if (this.heroesByName.hasOwnProperty(name)) {
            return this.heroesByName[name];
        } else {
            return null;
        }
    }

    getHeroById(id) {
        return this.heroesById[id];
    }

    getHeroByHPId(hpId) {
        return this.heroesById_HP[hpId];
    }

    getTemplate() {
        return "external/heroesprofile.twig.html";
    }

    getTemplateData() {
        return {
            suggestions: this.getSuggestions(),
            sortField: this.sortField,
            heroesById: this.heroesById,
            heroesByName: this.heroesByName
        };
    }

    getSuggestions() {
        return this.suggestions;
    }

    getSortField(team) {
        return this.sortField[team];
    }

    handleGuiAction(parameters) {
        switch (parameters.shift()) {
            case "sortBy":
                this.sortBy(...parameters);
                break;
        }
    }

    sortBy(team, field) {
        this.sortField[team] = field;
        this.sortSuggestions(team);
        this.emit("change");
    }

    sortSuggestions(team) {
        let suggestionField = null;
        switch (team) {
            case "blue":
                suggestionField = "friend";
                break;
            case "red":
                suggestionField = "enemy";
                break;
            default:
                throw new Error("Unknown team: " + team);
                break;
        }
        if (this.suggestions.hasOwnProperty(suggestionField)) {
            let sortField = this.sortField[team];
            this.suggestions[suggestionField].sort((a, b) => {
                return (b[sortField] - a[sortField]);
            });
            this.suggestions[suggestionField].map((entry, index) => {
                entry.order = index;
            });
        }
    }

    init() {
        this.updateActive = true;
        // Initialize with first available patch
        this.currentPatch = "2.55.14.95918"; // Can be updated dynamically
        return new Promise((resolve, reject) => {
            // For now, we initialize without needing core data
            // HeroesProfile API provides everything we need
            this.updateActive = false;
            resolve(true);
        });
    }

    update() {
        console.log("[HeroesProfile] update() called");
        if (this.updateActive) {
            console.log("[HeroesProfile] update already active, marking as pending");
            this.updatePending = true;
            return;
        }
        this.updatePending = false;
        this.updateActive = true;

        // Collect picks and bans
        this.bans = [];
        this.picksBlue = [];
        this.picksRed = [];
        console.log("[HeroesProfile] Collecting picks and bans from screen...");

        let teamBlue = this.screen.getTeam("blue");
        if (teamBlue !== null) {
            // Collect bans
            let bansBlue = teamBlue.getBans();
            console.log("[HeroesProfile] Blue bans raw: " + JSON.stringify(bansBlue));
            for (let i = 0; i < bansBlue.length; i++) {
                if ((bansBlue[i] === "???") || (bansBlue[i] === null)) {
                    continue;
                }
                let hero = this.getHeroByName(bansBlue[i]);
                if (hero !== null) {
                    this.bans.push(hero.hpId || hero.id);
                }
            }
            
            // Collect picks
            let playersBlue = teamBlue.getPlayers();
            console.log("[HeroesProfile] Blue players count: " + playersBlue.length);
            for (let i = 0; i < playersBlue.length; i++) {
                let character = playersBlue[i].getCharacter();
                let locked = playersBlue[i].isLocked();
                console.log("[HeroesProfile] Blue player " + i + ": character='" + character + "', locked=" + locked);
                if (!locked) {
                    continue;
                }
                let hero = this.getHeroByName(character);
                if (hero !== null) {
                    this.picksBlue.push(hero.hpId || hero.id);
                }
            }
        }

        let teamRed = this.screen.getTeam("red");
        if (teamRed !== null) {
            // Collect bans
            let bansRed = teamRed.getBans();
            console.log("[HeroesProfile] Red bans raw: " + JSON.stringify(bansRed));
            for (let i = 0; i < bansRed.length; i++) {
                if ((bansRed[i] === "???") || (bansRed[i] === null)) {
                    continue;
                }
                let hero = this.getHeroByName(bansRed[i]);
                if (hero !== null) {
                    this.bans.push(hero.hpId || hero.id);
                }
            }
            
            // Collect picks
            let playersRed = teamRed.getPlayers();
            console.log("[HeroesProfile] Red players count: " + playersRed.length);
            for (let i = 0; i < playersRed.length; i++) {
                let character = playersRed[i].getCharacter();
                let locked = playersRed[i].isLocked();
                console.log("[HeroesProfile] Red player " + i + ": character='" + character + "', locked=" + locked);
                if (!locked) {
                    continue;
                }
                let hero = this.getHeroByName(character);
                if (hero !== null) {
                    this.picksRed.push(hero.hpId || hero.id);
                }
            }
        }

        // Build request params
        let formData = new URLSearchParams();
        formData.append('data[0][name]', 'minor_timeframe');
        formData.append('data[0][value]', this.currentPatch);
        
        for (let pick of this.picksBlue) {
            formData.append('heroesPicked[]', pick);
        }
        for (let pick of this.picksRed) {
            formData.append('heroesPicked[]', pick);
        }
        for (let ban of this.bans) {
            formData.append('heroesPicked[]', ban);
        }

        let currentPickNumber = (this.picksBlue.length + this.picksRed.length);
        formData.append('currentPickNumber', currentPickNumber);
        formData.append('mockdraft', 'false');

        // Create unique form signature to avoid unnecessary updates
        let formSignature = formData.toString();
        if (formSignature === this.suggestionsForm) {
            console.log("[HeroesProfile] Draft state unchanged, skipping API call");
            this.updateActive = false;
            return true;
        }
        this.suggestionsForm = formSignature;

        if (!this.suggestionsForm) {
            console.log("[HeroesProfile] ⭐ FIRST UPDATE - Making initial API call");
        } else {
            console.log("[HeroesProfile] ⭐ DRAFT CHANGED - Making new API call");
        }

        console.log("[HeroesProfile] Draft state changed!");
        console.log("[HeroesProfile] Picks Blue: " + this.picksBlue.join(", "));
        console.log("[HeroesProfile] Picks Red: " + this.picksRed.join(", "));
        console.log("[HeroesProfile] Bans: " + this.bans.join(", "));
        console.log("[HeroesProfile] Current Pick Number: " + currentPickNumber);
        console.log("[HeroesProfile] Patch: " + this.currentPatch);

        // Make API request
        let url = "https://drafter.heroesprofile.com/getInitialDraftData";
        
        return new Promise((resolve, reject) => {
            console.log("[HeroesProfile] Sending POST request to: " + url);
            console.log("[HeroesProfile] Request body: " + formData.toString());
            
            axios.post(url, formData, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            })
                .then(response => {
                    this.updateActive = false;
                    console.log("[HeroesProfile] API response received, status: " + response.status);
                    
                    if (response.status !== 200) {
                        console.error("[HeroesProfile] Invalid status code <" + response.status + ">");
                        reject('Invalid status code <' + response.status + '>');
                        return;
                    }
                    
                    console.log("[HeroesProfile] Response data keys: " + Object.keys(response.data).join(", "));
                    this.loadUpdateData(response.data);
                    resolve(true);
                })
                .catch(error => {
                    this.updateActive = false;
                    console.error("[HeroesProfile] API error: " + error.message);
                    if (error.response) {
                        console.error("[HeroesProfile] Response status: " + error.response.status);
                        console.error("[HeroesProfile] Response body: " + JSON.stringify(error.response.data));
                        console.error("[HeroesProfile] Response headers: " + JSON.stringify(error.response.headers));
                    } else {
                        console.error("[HeroesProfile] No response from server");
                    }
                    console.error("[HeroesProfile] Request was: " + formData.toString());
                    reject(error);
                });
        });
    }

};

module.exports = HeroesProfileProvider;
