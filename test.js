const WebSocket = require('ws');
const wsUrl = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.4.0&flash=false';
const ws = new WebSocket(wsUrl);

ws.on('open', () => {
    // Need a channel ID. xqc is chatrooms.119583
    ws.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: { auth: '', channel: 'chatrooms.119583' } // xQc channel
    }));
});

async function test() {
    const browser = await puppeteer.launch({ 
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
            '--single-process', '--disable-gpu'
        ]
    });
    const page = await browser.newPage();
}

ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.event === 'App\\Events\\ChatMessageEvent') {
        console.log(JSON.stringify(JSON.parse(msg.data), null, 2));
        process.exit(0);
    }
});
