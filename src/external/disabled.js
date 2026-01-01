// Nodejs dependencies

// Local classes
const HotsDraftSuggestions = require('../hots-draft-suggestions.js');

class DisabledProvider extends HotsDraftSuggestions {

    constructor(app) {
        super(app);
    }

    getTemplate() {
        return "external/disabled.twig.html";
    }

    getTemplateData() {
        return {
            message: "Draft Provider deaktiviert"
        };
    }

    init() {
        return Promise.resolve(true);
    }

    update() {
        return Promise.resolve(true);
    }

};

module.exports = DisabledProvider;
