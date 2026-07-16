const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function test() {
    const browser = await puppeteer.launch({ 
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
            '--single-process', '--disable-gpu'
        ]
    });
    try {
        const page = await browser.newPage();
        
        async function fetchUserUI(slug) {
            await page.goto(`https://kick.com/${slug}`, { waitUntil: 'networkidle2', timeout: 15000 });
            const imgSrc = await page.evaluate(() => {
                const img = document.querySelector('img');
                return img ? img.src : 'No img found';
            });
            console.log(slug, "first img:", imgSrc);
            const allImgs = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('img')).map(i => i.src);
            });
            console.log("All imgs:", allImgs);
        }
        await fetchUserUI('zamero-serebryakov69');
        await fetchUserUI('mr_cheesee');
    } catch(e) {
        console.error("Failed:", e.message);
    }
    await browser.close();
}
test();
