const https = require('https');
const fs = require('fs');
const path = require('path');

// List of all heroes from Heroes Profile
const heroes = [
    'abathur', 'alarak', 'alexstrasza', 'ana', 'anduin', 'anubarak', 'artanis', 'arthas', 'auriel', 'azmodan',
    'blaze', 'brightwing', 'cassia', 'chen', 'cho', 'chromie', 'dva', 'deathwing', 'deckard', 'dehaka', 'diablo',
    'etc', 'falstad', 'fenix', 'gall', 'garrosh', 'gazlowe', 'genji', 'greymane', 'guldan', 'hanzo',
    'hogger', 'illidan', 'imperius', 'jaina', 'johanna', 'junkrat', 'kaelthas', 'kelthuzad', 'kerrigan', 'kharazim',
    'leoric', 'lili', 'liming', 'ltmorales', 'lucio', 'lunara', 'maiev', 'malganis', 'malfurion', 'malthael',
    'medivh', 'mei', 'mephisto', 'muradin', 'murky', 'nazeebo', 'nova', 'orphea', 'probius', 'qhira',
    'ragnaros', 'raynor', 'rehgar', 'rexxar', 'samuro', 'sgthammer', 'sonya', 'stitches', 'stukov', 'sylvanas',
    'tassadar', 'thebutcher', 'thelostvikings', 'thrall', 'tracer', 'tychus', 'tyrael', 'tyrande', 'uther', 'valeera',
    'valla', 'varian', 'whitemane', 'xul', 'yrel', 'zagara', 'zarya', 'zeratul', 'zuljin'
];

const downloadDir = path.join(__dirname, 'data', 'bans');

// Create directory if it doesn't exist
if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
}

let downloaded = 0;
let failed = 0;

console.log(`[HeroDownloader] Starting to download ${heroes.length} hero images to ${downloadDir}\n`);

function downloadHero(heroName) {
    return new Promise((resolve, reject) => {
        const url = `https://www.heroesprofile.com/images/heroes/${heroName}.png`;
        const filePath = path.join(downloadDir, `${heroName}.png`);

        // Skip if already exists
        if (fs.existsSync(filePath)) {
            console.log(`[${heroName}] Already exists, skipping`);
            downloaded++;
            resolve();
            return;
        }

        https.get(url, (response) => {
            // Check for redirect or error
            if (response.statusCode !== 200) {
                console.log(`[${heroName}] HTTP ${response.statusCode} - ${url}`);
                failed++;
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            const fileStream = fs.createWriteStream(filePath);
            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                console.log(`[${heroName}] Downloaded successfully`);
                downloaded++;
                resolve();
            });

            fileStream.on('error', (error) => {
                fs.unlink(filePath, () => {}); // Delete incomplete file
                console.log(`[${heroName}] File write error: ${error.message}`);
                failed++;
                reject(error);
            });
        }).on('error', (error) => {
            console.log(`[${heroName}] Download error: ${error.message}`);
            failed++;
            reject(error);
        });
    });
}

// Download all heroes sequentially to avoid overwhelming the server
async function downloadAll() {
    for (const hero of heroes) {
        try {
            await downloadHero(hero);
            // Small delay between downloads
            await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
            // Continue with next hero even if one fails
        }
    }

    console.log(`\n[HeroDownloader] Complete!`);
    console.log(`[HeroDownloader] Downloaded: ${downloaded}/${heroes.length}`);
    console.log(`[HeroDownloader] Failed: ${failed}/${heroes.length}`);
}

downloadAll();
