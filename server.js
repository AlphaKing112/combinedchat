require('dotenv').config();

// Set environment variables to avoid Puppeteer issues in Vercel
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';
process.env.PUPPETEER_ARGS = '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-accelerated-2d-canvas --no-first-run --no-zygote --single-process --disable-gpu';

const express = require('express');
const { createServer } = require('http');
// === Twitch Avatar Fetching ===
const twitchAvatarCache = {};
async function fetchTwitchAvatar(username) {
    if (!username) return 'https://static-cdn.jtvnw.net/user-default-pictures-uv/41780b5a-def8-11e9-94d9-784f43822e80-profile_image-70x70.png';
    username = username.toLowerCase();
    if (twitchAvatarCache[username]) {
        return twitchAvatarCache[username];
    }
    
    try {
        const https = require('https');
        const url = await new Promise((resolve, reject) => {
            const req = https.get(`https://decapi.me/twitch/avatar/${username}`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data.trim()));
            });
            req.on('error', reject);
            req.setTimeout(3000, () => { req.abort(); resolve(null); });
        });
        
        if (url && url.startsWith('http')) {
            twitchAvatarCache[username] = url;
            return url;
        }
    } catch (e) {
        console.error(`[Twitch Avatar Error] for ${username}:`, e.message);
    }
    
    const fallback = `https://ui-avatars.com/api/?name=${username}&background=random`;
    twitchAvatarCache[username] = fallback;
    return fallback;
}

require('socket.io');
const { Server } = require('socket.io');
const { TikTokConnectionWrapper, getGlobalConnectionCount } = require('./connectionWrapper');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { WebcastPushConnection } = require('tiktok-live-connector');
const { clientBlocked } = require('./limiter');
const { createClient } = require('@retconned/kick-js');
const KickChatFallback = require('./kick-chat-fallback');
const tmi = require('tmi.js');


// Global error handler for Puppeteer errors
process.on('unhandledRejection', (reason, promise) => {
    console.log(`[Global] Unhandled Rejection at:`, promise, 'reason:', reason);
    // Don't crash the app, just log the error
});

const app = express();
const httpServer = createServer(app);

// Enable cross origin resource sharing
const io = new Server(httpServer, {
    cors: {
        origin: '*'
    }
});



// Serve static files with explicit MIME types
app.use(express.static('public', {
    setHeaders: (res, path) => {
        if (path.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css');
        }
    }
}));
app.use(express.json());






io.on('connection', (socket) => {
    let tiktokConnectionWrapper = null;
    let kickChatClient = null;
    let kickSessionId = 0;
    let twitchChatClient = null;

    console.info('New connection from origin', socket.handshake.headers['origin'] || socket.handshake.headers['referer']);

    socket.on('testEvent', (data) => {
        console.log('[Test] testEvent received:', data);
        socket.emit('testEvent', { message: 'Backend received your test event!', timestamp: new Date().toISOString() });
    });

    socket.on('disconnectKick', () => {
        if (kickChatClient) {
            try { kickChatClient.disconnect(); } catch (e) {}
            kickChatClient = null;
        }
        socket.emit('kickDisconnected', 'Disconnected');
    });

    socket.on('disconnectTwitch', () => {
        if (twitchChatClient) {
            try { twitchChatClient.disconnect(); } catch (e) {}
            twitchChatClient = null;
        }
        socket.emit('twitchDisconnected', 'Disconnected');
    });

    socket.on('disconnectTikTok', () => {
        if (tiktokConnectionWrapper) {
            tiktokConnectionWrapper.disconnect();
            tiktokConnectionWrapper = null;
        }
        socket.emit('tiktokDisconnected', 'Disconnected');
    });

    // TIKTOK CHAT HANDLING
    socket.on('setUniqueId', (uniqueId, options) => {
        console.log(`[TikTok] Attempting to connect to: ${uniqueId}`);

        // Prohibit the client from specifying these options (for security reasons)
        if (typeof options === 'object' && options) {
            delete options.requestOptions;
            delete options.websocketOptions;
        } else {
            options = {};
        }

        // Session ID in .env file is optional
        if (process.env.SESSIONID) {
            options.session = {
                cookie: {
                    value: {
                        sessionId: process.env.SESSIONID
                    }
                }
            };
            console.info('Using SessionId');
        }

        // Check if rate limit exceeded
        if (process.env.ENABLE_RATE_LIMIT && clientBlocked(io, socket)) {
            socket.emit('tiktokDisconnected', 'You have opened too many connections or made too many connection requests. Please reduce the number of connections/requests or host your own server instance. The connections are limited to avoid that the server IP gets blocked by TokTok.');
            return;
        }

        // Connect to the given username (uniqueId)
        try {
            // Disconnect any existing connection first
            if (tiktokConnectionWrapper) {
                tiktokConnectionWrapper.disconnect();
            }
            tiktokConnectionWrapper = new TikTokConnectionWrapper(uniqueId, options, true);
            
            // Add error handler to prevent crashes
            tiktokConnectionWrapper.on('error', (error) => {
                // Don't log detailed errors for offline users
                if (error.info && error.info.includes('user_not_found') || 
                    error.exception && error.exception.message && error.exception.message.includes('user_not_found')) {
                    console.log(`[TikTok] User ${uniqueId} is not live or not found`);
                } else {
                    console.error(`[TikTok] Error for ${uniqueId}:`, error);
                }
                socket.emit('tiktokDisconnected', `User is not currently live. Please try a different username.`);
            });
            
            tiktokConnectionWrapper.connect();
        } catch (err) {
            // Clean up error messages for offline users
            let cleanError = err.toString();
            if (cleanError.includes('user_not_found') || cleanError.includes('Failed to retrieve room_id')) {
                console.log(`[TikTok] User ${uniqueId} is not live or not found`);
                cleanError = 'User is not currently live. Please try a different username.';
            } else {
                console.error(`[TikTok] Connection error for ${uniqueId}:`, err);
            }
            socket.emit('tiktokDisconnected', cleanError);
            return;
        }

        tiktokConnectionWrapper.on('connected', state => {
            console.log(`[TikTok] Connected to: ${state.roomId}`);
            socket.emit('tiktokConnected', state);
        });

        tiktokConnectionWrapper.on('disconnected', reason => {
            console.log(`[TikTok] Disconnected: ${reason}`);
            socket.emit('tiktokDisconnected', reason);
        });

        const extractUserInfo = (data) => {
            const user = data.user || data;
            let profilePictureUrl = '';
            if (user.avatarThumb && user.avatarThumb.urlList && user.avatarThumb.urlList.length > 0) {
                profilePictureUrl = user.avatarThumb.urlList[0];
            } else if (data.profilePictureUrl) {
                profilePictureUrl = data.profilePictureUrl;
            }
            return {
                uniqueId: user.displayId || user.uniqueId || '',
                nickname: user.nickname || '',
                profilePictureUrl: profilePictureUrl
            };
        };

        const emitTikTok = (eventName, data) => {
            if (!data) return;
            const userInfo = extractUserInfo(data);
            const emitData = {
                ...data,
                ...userInfo,
                comment: data.content || data.comment || ''
            };
            if (eventName === 'gift') {
                if (data.gift) {
                    emitData.giftId = data.gift.id || data.giftId;
                    emitData.giftName = data.gift.name || data.giftName;
                    emitData.diamondCount = data.gift.diamondCount || data.diamondCount;
                }
            }
            socket.emit(eventName, emitData);
        };

        // Forward events to the client using the shim
        tiktokConnectionWrapper.connection.on('chat', (data) => emitTikTok('chat', data));
        tiktokConnectionWrapper.connection.on('member', (data) => emitTikTok('member', data));
        tiktokConnectionWrapper.connection.on('gift', (data) => emitTikTok('gift', data));
        tiktokConnectionWrapper.connection.on('roomUser', (data) => {
            if (typeof data.viewerCount === 'number') {
                socket.emit('roomUser', data);
            } else if (data.data && typeof data.data.viewerCount === 'number') {
                socket.emit('roomUser', data.data);
            }
        });
        tiktokConnectionWrapper.connection.on('like', (data) => {
            if (data.likeCount === undefined && data.count !== undefined) {
                data.likeCount = data.count;
            }
            emitTikTok('like', data);
        });
        tiktokConnectionWrapper.connection.on('social', (data) => emitTikTok('social', data));
        
        // Ensure streamEnd is forwarded properly
        tiktokConnectionWrapper.connection.on('streamEnd', () => socket.emit('streamEnd'));
        tiktokConnectionWrapper.connection.on('questionNew', msg => socket.emit('questionNew', msg));
        tiktokConnectionWrapper.connection.on('linkMicBattle', msg => socket.emit('linkMicBattle', msg));
        tiktokConnectionWrapper.connection.on('linkMicArmies', msg => socket.emit('linkMicArmies', msg));
        tiktokConnectionWrapper.connection.on('liveIntro', msg => socket.emit('liveIntro', msg));
        tiktokConnectionWrapper.connection.on('emote', msg => socket.emit('emote', msg));
        tiktokConnectionWrapper.connection.on('envelope', msg => socket.emit('envelope', msg));
        tiktokConnectionWrapper.connection.on('subscribe', msg => socket.emit('subscribe', msg));
    });

    // KICK CHAT HANDLING - Direct WebSocket approach (no Puppeteer)
    const KICK_HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
    
    socket.on('setKickLink', async (kickLink, providedChatroomId) => {
        try {
            // Disconnect previous Kick client
            if (kickChatClient) {
                try {
                    kickChatClient.disconnect();
                } catch (e) {}
                kickChatClient = null;
            }
        
            // Increment session ID
            kickSessionId += 1;
            const thisSessionId = kickSessionId;
            socket.currentKickSessionId = thisSessionId;
            
            // Extract the channel slug from the link or use as-is if already a slug
            let channelSlug = kickLink;
            const match = kickLink.match(/kick\.com\/([A-Za-z0-9_]+)/i);
            if (match) {
                channelSlug = match[1];
            }
            if (!channelSlug) {
                socket.emit('kickDisconnected', 'Invalid Kick link');
                return;
            }
            channelSlug = channelSlug.toLowerCase();

            console.log(`[Kick] Attempting to connect to ${channelSlug} (original input: ${kickLink}, providedChatroomId: ${providedChatroomId})`);

            if (providedChatroomId) {
                console.log(`[Kick] Using chatroomId from frontend: ${providedChatroomId}`);
                socket.emit('kickConnected', { channelSlug });
                startKickChatClient(channelSlug, thisSessionId, providedChatroomId);
                return;
            }

            // Fall back to public API
            try {
                const channelUrl = `https://kick.com/api/v1/channels/${channelSlug}`;
                const response = await axios.get(channelUrl, { 
                    headers: {
                        ...KICK_HEADERS,
                        'Accept': 'application/json'
                    },
                    timeout: 10000 // Increased timeout
                });
                const channelData = response.data;
                
                const followers = channelData.followersCount ?? null;
                const viewers = channelData.livestream?.viewer_count ?? null;
                
                // Emit connection event
                socket.emit('kickConnected', { channelSlug });
                
                console.log(`[Kick] Successfully connected to ${channelSlug} using public API`);
                
                // Start Kick chat client
                startKickChatClient(channelSlug, thisSessionId);
                
            } catch (error) {
                console.log(`[Kick] Public API failed for ${channelSlug}:`, error.message);
                
                // Be more lenient - still allow connection even if API fails
                // This could happen if the channel exists but API is having issues
                console.log(`[Kick] Proceeding with connection despite API failure`);
                socket.emit('kickConnected', { channelSlug });
                
                // Start Kick chat client anyway
                startKickChatClient(channelSlug, thisSessionId);
            }
            
        } catch (error) {
            console.error(`[Kick] Error setting up Kick connection:`, error);
            socket.emit('kickDisconnected', `Error setting up connection: ${error.message}`);
        }
    });

    // Kick chat client setup
    async function startKickChatClient(channelSlug, sessionId, chatroomId = null) {
        try {
            console.log(`[Kick] Starting chat client for ${channelSlug} using Fallback method`);
            
            // Bypass the official library because Cloudflare blocks Puppeteer and crashes the Node.js process
            kickChatClient = new KickChatFallback(channelSlug, chatroomId);
            kickChatClient.isFallback = true;
            await kickChatClient.connect();
            
            // Set up event handlers
            kickChatClient.on('ChatMessage', async (msg) => {
                if (socket.currentKickSessionId !== sessionId) {
                    return;
                }
                
                console.log(`[Kick] Chat message received:`, msg);
                
                // Fetch avatar before emitting to avoid pop-in
                if (msg.sender && msg.sender.username) {
                    msg.sender.profilePic = await fetchKickAvatar(msg.sender.username);
                }
                
                // Enhanced badge processing
                let badges = [];
                if (msg.badges && Array.isArray(msg.badges)) {
                    badges = msg.badges;
                } else if (msg.sender && msg.sender.badges && Array.isArray(msg.sender.badges)) {
                    badges = msg.sender.badges;
                }
                
                // We rely entirely on the badges provided by Kick in msg.sender.badges.
                
                socket.emit('kickChat', {
                    sender: {
                        ...msg.sender,
                        badges: badges
                    },
                    content: msg.content,
                    emotes: msg.emotes || [],
                    badges: badges,
                    channelSlug: channelSlug,
                    sessionId: sessionId,
                    timestamp: msg.timestamp || Date.now(),
                    messageId: msg.id
                });
            });
            
            kickChatClient.on('Gift', (gift) => {
                if (socket.currentKickSessionId !== sessionId) {
                    return;
                }
                
                console.log(`[Kick] Gift received:`, gift);
                socket.emit('kickGift', {
                    sender: gift.sender,
                    gift: gift.gift,
                    channelSlug: channelSlug,
                    sessionId: sessionId
                });
            });
            
            kickChatClient.on('Subscription', (sub) => {
                if (socket.currentKickSessionId !== sessionId) {
                    return;
                }
                
                console.log(`[Kick] Subscription received:`, sub);
                socket.emit('kickSubscription', {
                    sender: sub.sender,
                    subscription: sub.subscription,
                    channelSlug: channelSlug,
                    sessionId: sessionId
                });
            });
            
            kickChatClient.on('Follow', (follow) => {
                if (socket.currentKickSessionId !== sessionId) {
                    return;
                }
                
                console.log(`[Kick] Follow received:`, follow);
                socket.emit('kickFollow', {
                    sender: follow.sender,
                    channelSlug: channelSlug,
                    sessionId: sessionId
                });
            });
            
            kickChatClient.on('StreamStart', (streamData) => {
                console.log(`[Kick] Stream started:`, streamData);
                socket.emit('kickStreamStart', {
                    channelSlug: channelSlug,
                    sessionId: sessionId
                });
            });
            
            kickChatClient.on('StreamEnd', (streamData) => {
                console.log(`[Kick] Stream ended:`, streamData);
                socket.emit('kickStreamEnd', {
                    channelSlug: channelSlug,
                    sessionId: sessionId
                });
            });
            
            // Connect the client
            console.log(`[Kick] Chat client started successfully for ${channelSlug}`);
            
        } catch (error) {
            console.error(`[Kick] Failed to start chat client:`, error.message);
            // Don't emit disconnect, just log the error and continue
            console.log(`[Kick] Continuing without chat client for ${channelSlug}`);
        }
    }

    // TWITCH CHAT HANDLING
    socket.on('setTwitchChannel', (channelName) => {
        if (!channelName) return;
        console.log(`[Twitch] Attempting to connect to ${channelName}`);
        
        if (twitchChatClient) {
            twitchChatClient.disconnect().catch(() => {});
        }

        const tmiOptions = { channels: [ channelName ] };
        
        if (process.env.TWITCH_USERNAME && process.env.TWITCH_OAUTH_TOKEN) {
            tmiOptions.identity = {
                username: process.env.TWITCH_USERNAME,
                password: process.env.TWITCH_OAUTH_TOKEN
            };
        }

        twitchChatClient = new tmi.Client(tmiOptions);

        twitchChatClient.connect().then(() => {
            console.log(`[Twitch] Connected to ${channelName}`);
            socket.emit('twitchConnected', { channelName });
        }).catch((err) => {
            console.error(`[Twitch] Connection error for ${channelName}:`, err);
            socket.emit('twitchDisconnected', 'Error connecting to Twitch channel.');
        });

        twitchChatClient.on('message', async (channel, tags, message, self) => {
            if (self) return;
            
            const username = tags.username || tags['display-name'];
            const profilePic = await fetchTwitchAvatar(username);
            
            socket.emit('twitchChat', {
                channel: channel,
                tags: tags,
                message: message,
                timestamp: Date.now(),
                profilePic: profilePic
            });
        });
        
        twitchChatClient.on('disconnected', (reason) => {
            console.log(`[Twitch] Disconnected from ${channelName}: ${reason}`);
            socket.emit('twitchDisconnected', reason);
        });
        
        socket.on('twitchModerateUser', (action, targetUser, messageId) => {
            if (!twitchChatClient || !process.env.TWITCH_USERNAME) {
                console.warn('[Twitch] Moderation attempted but no identity provided in .env');
                return;
            }
            const chan = `#${channelName.replace('#', '')}`;
            
            if (action === 'timeout_1m') {
                twitchChatClient.timeout(chan, targetUser, 60, "Moderated via chat reader").catch(console.error);
            } else if (action === 'timeout_10m') {
                twitchChatClient.timeout(chan, targetUser, 600, "Moderated via chat reader").catch(console.error);
            } else if (action === 'ban') {
                twitchChatClient.ban(chan, targetUser, "Moderated via chat reader").catch(console.error);
            } else if (action === 'delete' && messageId) {
                twitchChatClient.deletemessage(chan, messageId).catch(console.error);
            }
        });
    });

    socket.on('disconnect', () => {
        // Clean up TikTok connection
        if (tiktokConnectionWrapper) {
            tiktokConnectionWrapper.disconnect();
        }
        
        // Clean up Kick chat client
        if (kickChatClient) {
            try {
                kickChatClient.disconnect();
            } catch (e) {}
            kickChatClient = null;
        }

        // Clean up Twitch chat client
        if (twitchChatClient) {
            twitchChatClient.disconnect().catch(() => {});
            twitchChatClient = null;
        }
    });
});

// Emit global connection statistics
setInterval(() => {
    io.emit('statistic', { globalConnectionCount: getGlobalConnectionCount() });
}, 5000)



// Test endpoint to verify Kick API connectivity
app.get('/api/kick-test/:channel', async (req, res) => {
  const channel = req.params.channel;
  try {
    console.log(`[Test] Testing Kick API for channel: ${channel}`);
    const url = `https://kick.com/api/v1/channels/${channel}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': `https://kick.com/${channel}`,
      }
    });
    const channelInfo = response.data;
    res.json({ 
      success: true, 
      channel: channel,
      data: channelInfo,
      message: 'Kick API is working'
    });
  } catch (error) {
    console.error(`[Test] Kick API test failed for ${channel}:`, error.message);
    res.status(500).json({ 
      success: false, 
      channel: channel,
      error: error.message,
      message: 'Kick API test failed'
    });
  }
});



// Avatar proxy to bypass CORS for Kick profile pictures
const kickAvatarCache = new Map();
const kickAvatarPending = new Map();
let kickAvatarBrowser = null;
let kickAvatarPage = null;

async function getKickAvatarPage() {
    if (!kickAvatarBrowser) {
        console.log('[Kick] Initializing Puppeteer for avatars...');
        kickAvatarBrowser = await puppeteer.launch({ 
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
                '--single-process', '--disable-gpu'
            ]
        });
        kickAvatarPage = await kickAvatarBrowser.newPage();
    }
    return kickAvatarPage;
}

async function fetchKickAvatar(username) {
    let defaultNum = 1;
    if (username) {
        let hash = 0;
        for (let i = 0; i < username.length; i++) {
            hash = username.charCodeAt(i) + ((hash << 5) - hash);
        }
        defaultNum = Math.abs(hash % 6) + 1; // 1 to 6
    }
    const fallbackUrl = `https://kick.com/img/default-profile-pictures/default-avatar-${defaultNum}.webp`;
    
    // Cloudflare blocks headless Puppeteer on Kick, which causes massive timeouts 
    // and dropped chat messages in the chat rendering loop. 
    // We immediately return the fallback avatar to keep chat fast and responsive.
    return fallbackUrl;
}

app.get('/api/kick-avatar/:username', async (req, res) => {
    const url = await fetchKickAvatar(req.params.username);
    res.json({ url });
});


// Serve frontend files handled at the top

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
    console.error('[Global] Uncaught Exception:', error);
    // Don't exit the process, just log the error
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Global] Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit the process, just log the error
});

// Start http listener
const port = process.env.PORT || 8081;
httpServer.listen(port);
console.info(`Server running! Please visit http://localhost:${port}`);

function getRandomColor(username) {
    // Simple hash-based color for consistency per user
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
        hash = username.charCodeAt(i) + ((hash << 5) - hash);
    }
    // Generate pastel color
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 70%)`;
} 