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
            socket.emit('roomUser', data);
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
            kickChatClient.on('ChatMessage', (msg) => {
                if (socket.currentKickSessionId !== sessionId) {
                    return;
                }
                
                console.log(`[Kick] Chat message received:`, msg);
                
                // Fetch avatar asynchronously to avoid delaying chat messages!
                if (msg.sender && msg.sender.username) {
                    const lowerUser = msg.sender.username.toLowerCase();
                    if (kickAvatarCache.has(lowerUser)) {
                        msg.sender.profilePic = kickAvatarCache.get(lowerUser);
                    } else {
                        // Provide default fallback immediately
                        let defaultNum = 1;
                        let hash = 0;
                        for (let i = 0; i < msg.sender.username.length; i++) {
                            hash = msg.sender.username.charCodeAt(i) + ((hash << 5) - hash);
                        }
                        defaultNum = Math.abs(hash % 6) + 1;
                        msg.sender.profilePic = `https://kick.com/img/default-profile-pictures/default-avatar-${defaultNum}.webp`;
                        
                        // Fetch in background and notify client if it changes
                        fetchKickAvatar(msg.sender.username).then(url => {
                            if (url && url !== msg.sender.profilePic) {
                                io.emit('updateKickAvatar', { username: msg.sender.username, url });
                            }
                        }).catch(() => {});
                    }
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

            kickChatClient.on('GiftedSubscriptions', (gift) => {
                if (socket.currentKickSessionId !== sessionId) {
                    return;
                }
                
                console.log(`[Kick] Gifted Subscriptions received:`, gift);
                socket.emit('kickGiftedSubscriptions', {
                    data: gift,
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

        twitchChatClient = new tmi.Client({
            channels: [ channelName ]
        });

        twitchChatClient.connect().then(async () => {
            console.log(`[Twitch] Connected to ${channelName}`);
            
            let roomId = null;
            try {
                if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_ACCESS_TOKEN) {
                    const userRes = await axios.get(`https://api.twitch.tv/helix/users?login=${channelName}`, {
                        headers: {
                            'Client-ID': process.env.TWITCH_CLIENT_ID,
                            'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
                        }
                    });
                    if (userRes.data && userRes.data.data && userRes.data.data.length > 0) {
                        roomId = userRes.data.data[0].id;
                    }
                }
            } catch (err) {
                console.error(`[Twitch] Failed to fetch roomId for ${channelName}:`, err.message);
            }

            socket.emit('twitchConnected', { channelName, roomId });
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
                profilePic: profilePic,
                username: username
            });
        });
        
        twitchChatClient.on('disconnected', (reason) => {
            console.log(`[Twitch] Disconnected from ${channelName}: ${reason}`);
            socket.emit('twitchDisconnected', reason);
        });

        twitchChatClient.on('timeout', (channel, username, reason, duration, userstate) => {
            socket.emit('twitchTimeout', { username, duration });
        });

        twitchChatClient.on('ban', (channel, username, reason, userstate) => {
            socket.emit('twitchBan', { username });
        });

        twitchChatClient.on('messagedeleted', (channel, username, deletedMessage, userstate) => {
            socket.emit('twitchMessageDeleted', { username, messageId: userstate['target-msg-id'] });
        });

        twitchChatClient.on('clearchat', (channel) => {
            socket.emit('twitchClearChat');
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



// TWITCH MODERATION ENDPOINT
app.post('/api/twitch/moderate', async (req, res) => {
    const { action, targetUserId, broadcasterId, messageId, duration: reqDuration, reason: reqReason } = req.body;
    
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_ACCESS_TOKEN) {
        return res.status(400).json({ error: 'Twitch API credentials not configured in .env' });
    }

    try {
        // Fetch moderator ID if not cached
        if (!global.twitchModeratorId) {
            const userRes = await axios.get('https://api.twitch.tv/helix/users', {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
                }
            });
            if (userRes.data && userRes.data.data && userRes.data.data.length > 0) {
                global.twitchModeratorId = userRes.data.data[0].id;
            } else {
                throw new Error("Could not fetch user ID from access token.");
            }
        }

        const modId = global.twitchModeratorId;

        if (action === 'delete') {
            await axios.delete(`https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${broadcasterId}&moderator_id=${modId}&message_id=${messageId}`, {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
                }
            });
            return res.json({ success: true });
        } else if (action === 'clear') {
            await axios.delete(`https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${broadcasterId}&moderator_id=${modId}`, {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
                }
            });
            return res.json({ success: true });
        } else if (action === 'timeout' || action === 'ban') {
            const duration = action === 'timeout' ? (reqDuration || 600) : undefined; // Use requested duration or default to 10 minutes
            
            await axios.post(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${modId}`, {
                data: {
                    user_id: targetUserId,
                    duration: duration,
                    reason: reqReason || "Moderated via Chat Reader"
                }
            }, {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
            return res.json({ success: true });
        } else if (action === 'unban') {
            await axios.delete(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${modId}&user_id=${targetUserId}`, {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
                }
            });
            return res.json({ success: true });
        } else if (action === 'vip') {
            await axios.post(`https://api.twitch.tv/helix/channels/vips?broadcaster_id=${broadcasterId}&user_id=${targetUserId}`, null, {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
                }
            });
            return res.json({ success: true });
        } else if (action === 'unvip') {
            await axios.delete(`https://api.twitch.tv/helix/channels/vips?broadcaster_id=${broadcasterId}&user_id=${targetUserId}`, {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
                }
            });
            return res.json({ success: true });
        } else if (action === 'shoutout') {
            await axios.post(`https://api.twitch.tv/helix/chat/shoutouts?from_broadcaster_id=${broadcasterId}&to_broadcaster_id=${targetUserId}&moderator_id=${modId}`, null, {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
                }
            });
            return res.json({ success: true });
        } else if (action === 'warning') {
            await axios.post(`https://api.twitch.tv/helix/moderation/warnings?broadcaster_id=${broadcasterId}&moderator_id=${modId}`, {
                data: {
                    user_id: targetUserId,
                    reason: reqReason || "Warning via Chat Reader"
                }
            }, {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
            return res.json({ success: true });
        }
        
        return res.status(400).json({ error: 'Invalid action' });
    } catch (error) {
        console.error('[Twitch] Moderation Error:', error.response?.data || error.message);
        return res.status(500).json({ error: error.response?.data?.message || error.message });
    }
});

// TWITCH BANNED USERS ENDPOINT

// TWITCH CHAT ENDPOINT
app.post('/api/twitch/chat', async (req, res) => {
    const { broadcasterId, message, replyMessageId } = req.body;
    
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_ACCESS_TOKEN) {
        return res.status(400).json({ error: 'Twitch API credentials not configured in .env' });
    }

    try {
        if (!global.twitchModeratorId) {
            const userRes = await axios.get('https://api.twitch.tv/helix/users', {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
                }
            });
            if (userRes.data && userRes.data.data && userRes.data.data.length > 0) {
                global.twitchModeratorId = userRes.data.data[0].id;
            } else {
                throw new Error("Could not fetch user ID from access token.");
            }
        }

        const payload = {
            broadcaster_id: broadcasterId,
            sender_id: global.twitchModeratorId,
            message: message
        };
        
        if (replyMessageId) {
            payload.reply_parent_message_id = replyMessageId;
        }

        await axios.post('https://api.twitch.tv/helix/chat/messages', payload, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        
        return res.json({ success: true });
    } catch (error) {
        console.error('[Twitch] Chat Send Error:', error.response?.data || error.message);
        return res.status(500).json({ error: error.response?.data?.message || error.message });
    }
});

// TWITCH EMOTES ENDPOINT
// TWITCH BADGES ENDPOINT
app.get('/api/twitch/badges/:broadcasterId', async (req, res) => {
    const { broadcasterId } = req.params;
    
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_ACCESS_TOKEN) {
        return res.status(400).json({ error: 'Twitch API credentials not configured in .env' });
    }

    try {
        const headers = {
            'Client-ID': process.env.TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
        };

        // Fetch channel badges
        const channelBadgesRes = await axios.get(`https://api.twitch.tv/helix/chat/badges?broadcaster_id=${broadcasterId}`, { headers });
        
        // Fetch global badges
        const globalBadgesRes = await axios.get('https://api.twitch.tv/helix/chat/badges/global', { headers });

        res.json({
            channelBadges: channelBadgesRes.data?.data || [],
            globalBadges: globalBadgesRes.data?.data || []
        });
    } catch (error) {
        console.error('[Twitch] Error fetching badges:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to fetch Twitch badges' });
    }
});

app.get('/api/twitch/emotes/:broadcasterId', async (req, res) => {
    const { broadcasterId } = req.params;
    
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_ACCESS_TOKEN) {
        return res.status(400).json({ error: 'Twitch API credentials not configured in .env' });
    }

    try {
        const headers = {
            'Client-ID': process.env.TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
        };

        // Fetch channel emotes
        const channelEmotesRes = await axios.get(`https://api.twitch.tv/helix/chat/emotes?broadcaster_id=${broadcasterId}`, { headers });
        
        // Fetch global emotes
        const globalEmotesRes = await axios.get('https://api.twitch.tv/helix/chat/emotes/global', { headers });

        res.json({
            channelEmotes: channelEmotesRes.data?.data || [],
            globalEmotes: globalEmotesRes.data?.data || []
        });
    } catch (error) {
        console.error('[Twitch] Emotes Fetch Error:', error.response?.data || error.message);
        return res.status(500).json({ error: error.response?.data?.message || error.message });
    }
});

// TWITCH CLIP ENDPOINT
app.post('/api/twitch/clip/:channelName', async (req, res) => {
    const { channelName } = req.params;
    
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_ACCESS_TOKEN) {
        return res.status(400).json({ error: 'Twitch credentials not configured in server' });
    }

    try {
        const headers = {
            'Client-ID': process.env.TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        };

        // Fetch broadcaster ID first
        const userRes = await axios.get(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channelName)}`, { headers });
        if (!userRes.data || !userRes.data.data || userRes.data.data.length === 0) {
            return res.status(404).json({ error: 'Twitch channel not found' });
        }
        const broadcasterId = userRes.data.data[0].id;

        // Create clip
        const response = await axios.post(`https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}`, {}, { headers });
        
        return res.json(response.data.data[0]);
    } catch (error) {
        console.error('[Twitch] Clip Error:', error.response?.data || error.message);
        return res.status(error.response?.status || 500).json(error.response?.data || { message: error.message });
    }
});

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
    
    if (!username) return fallbackUrl;
    
    const lowerUser = username.toLowerCase();
    if (kickAvatarCache.has(lowerUser)) {
        return kickAvatarCache.get(lowerUser);
    }

    try {
        const axios = require('axios');
        // Use allorigins to bypass Kick's Cloudflare protection for the API
        const res = await axios.get(`https://api.allorigins.win/raw?url=https://kick.com/api/v2/channels/${encodeURIComponent(lowerUser)}`, { timeout: 3000 });
        if (res.data && res.data.user && res.data.user.profile_pic) {
            kickAvatarCache.set(lowerUser, res.data.user.profile_pic);
            return res.data.user.profile_pic;
        }
    } catch (e) {
        // If the user doesn't have a channel (404), cache the fallback so we don't keep delaying their messages
        if (e.response && e.response.status === 404) {
            kickAvatarCache.set(lowerUser, fallbackUrl);
        }
        // For timeouts or 403s, we DO NOT cache the fallback, so it can retry on their next message!
    }
    
    return fallbackUrl;
}

app.get('/api/kick-avatar/:username', async (req, res) => {
    const url = await fetchKickAvatar(req.params.username);
    res.json({ url });
});


// Serve frontend files handled at the top

// Global error handlers to prevent crashes
process.on('uncaughtException', function (err) {
    console.error('Caught exception: ', err);
    // Don't exit the process, just log the error
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Global] Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit the process, just log the error
});

// TWITCH AD SCHEDULE ENDPOINT
app.get('/api/twitch/ads', async (req, res) => {
    const { broadcasterId } = req.query;
    
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_ACCESS_TOKEN) {
        return res.status(400).json({ error: 'Twitch API credentials not configured' });
    }
    
    if (!broadcasterId) {
        return res.status(400).json({ error: 'Missing broadcasterId' });
    }

    try {
        const response = await axios.get(`https://api.twitch.tv/helix/channels/ads?broadcaster_id=${broadcasterId}`, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
            }
        });
        return res.json(response.data);
    } catch (error) {
        return res.status(500).json({ error: error.response?.data?.message || error.message });
    }
});

// TWITCH CHANNEL ACTIONS ENDPOINTS
app.get('/api/twitch/banned', async (req, res) => {
    const { broadcasterId } = req.query;
    if (!broadcasterId || !process.env.TWITCH_ACCESS_TOKEN) return res.json({ error: true });

    try {
        const response = await axios.get(`https://api.twitch.tv/helix/moderation/banned?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`, {
            headers: {
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: true, message: err.message });
    }
});

app.get('/api/twitch/channel', async (req, res) => {
    const { broadcasterId } = req.query;
    if (!broadcasterId || !process.env.TWITCH_ACCESS_TOKEN) return res.status(400).json({ error: true, message: 'Missing parameters or token' });

    try {
        const response = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${broadcasterId}`, {
            headers: {
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });
        const data = await response.json();
        if (data.error) throw new Error(data.message);
        res.json(data.data[0]);
    } catch (err) {
        res.status(500).json({ error: true, message: err.message });
    }
});

app.patch('/api/twitch/channel', async (req, res) => {
    const { broadcasterId, title, game_id } = req.body;
    console.log('[Twitch] PATCH /channels request body:', req.body);
    if (!broadcasterId || !process.env.TWITCH_ACCESS_TOKEN) return res.status(400).json({ error: true, message: 'Missing parameters or token' });

    try {
        const response = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${broadcasterId}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title, game_id })
        });
        
        console.log('[Twitch] PATCH /channels response status:', response.status);
        if (response.status === 204) {
            res.json({ success: true });
        } else {
            const data = await response.json();
            console.log('[Twitch] PATCH /channels error data:', data);
            res.status(response.status).json({ error: true, message: data.message || 'Failed to update channel' });
        }
    } catch (err) {
        console.error('[Twitch] PATCH /channels caught error:', err.message);
        res.status(500).json({ error: true, message: err.message });
    }
});

app.get('/api/twitch/search-categories', async (req, res) => {
    const { query } = req.query;
    if (!query || !process.env.TWITCH_ACCESS_TOKEN) return res.status(400).json({ error: true, message: 'Missing query or token' });

    try {
        const response = await fetch(`https://api.twitch.tv/helix/search/categories?query=${encodeURIComponent(query)}`, {
            headers: {
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });
        const data = await response.json();
        if (data.error) throw new Error(data.message);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: true, message: err.message });
    }
});

app.get('/api/twitch/search-channels', async (req, res) => {
    const { query } = req.query;
    if (!query || !process.env.TWITCH_ACCESS_TOKEN) return res.json({ data: [] });

    try {
        // 1. Search for channels (bypassing live_only=true due to Twitch API caching bugs)
        const searchRes = await fetch(`https://api.twitch.tv/helix/search/channels?query=${encodeURIComponent(query)}&first=10`, {
            headers: {
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });
        const searchData = await searchRes.json();
        
        if (!searchData.data || searchData.data.length === 0) {
            return res.json({ data: [] });
        }

        // 2. Fetch viewer counts for these channels to confirm they are actually live
        const userIds = searchData.data.map(c => `user_id=${c.id}`).join('&');
        const streamRes = await fetch(`https://api.twitch.tv/helix/streams?${userIds}`, {
            headers: {
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });
        const streamData = await streamRes.json();

        // 3. Map viewer counts back to channels
        const viewerMap = {};
        if (streamData.data) {
            streamData.data.forEach(stream => {
                viewerMap[stream.user_id] = stream.viewer_count;
            });
        }

        const enrichedData = searchData.data.map(c => ({
            ...c,
            viewer_count: viewerMap[c.id] || 0
        })).filter(c => c.viewer_count > 0).sort((a, b) => b.viewer_count - a.viewer_count); // Sort by viewers descending

        res.json({ data: enrichedData });
    } catch (err) {
        console.error('[Twitch] Channel Search error:', err.message);
        res.json({ data: [] });
    }
});

app.post('/api/twitch/raid', async (req, res) => {
    const { broadcasterId, targetUsername } = req.body;
    if (!broadcasterId || !targetUsername || !process.env.TWITCH_ACCESS_TOKEN) return res.status(400).json({ error: true, message: 'Missing parameters or token' });

    try {
        // 1. Get target broadcaster ID
        const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${targetUsername}`, {
            headers: {
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });
        const userData = await userRes.json();
        if (userData.error) throw new Error(userData.message);
        if (!userData.data || userData.data.length === 0) throw new Error('Target user not found');
        const targetId = userData.data[0].id;

        // 2. Start raid
        const raidRes = await fetch(`https://api.twitch.tv/helix/raids?from_broadcaster_id=${broadcasterId}&to_broadcaster_id=${targetId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });
        const raidData = await raidRes.json();
        if (raidData.error) throw new Error(raidData.message);
        res.json(raidData);
    } catch (err) {
        res.status(500).json({ error: true, message: err.message });
    }
});

app.delete('/api/twitch/raid', async (req, res) => {
    const { broadcasterId } = req.body;
    if (!broadcasterId || !process.env.TWITCH_ACCESS_TOKEN) return res.status(400).json({ error: true, message: 'Missing parameters or token' });

    try {
        const response = await fetch(`https://api.twitch.tv/helix/raids?broadcaster_id=${broadcasterId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });
        if (response.status === 204) {
            res.json({ success: true });
        } else {
            const data = await response.json();
            throw new Error(data.message || 'Failed to cancel raid');
        }
    } catch (err) {
        res.status(500).json({ error: true, message: err.message });
    }
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