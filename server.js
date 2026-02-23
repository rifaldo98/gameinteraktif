const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Arena } = require("./gameEngine");

let TikTokLiveConnectorClass = null;
let WebcastEvent = {};
try {
    const tiktokLiveConnector = require("tiktok-live-connector");
    TikTokLiveConnectorClass =
        tiktokLiveConnector.TikTokLiveConnection ||
        tiktokLiveConnector.WebcastPushConnection ||
        null;
    WebcastEvent = tiktokLiveConnector.WebcastEvent || {};
} catch (_error) {
    TikTokLiveConnectorClass = null;
    WebcastEvent = {};
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const arena = new Arena();
const TICK_MS = 1200;
const SERVER_PORT = Number(process.env.PORT) || 3000;

const toBoolean = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const normalizeTikTokUniqueId = (rawValue) => {
    const input = String(rawValue || "").trim();
    if (!input) {
        return "";
    }

    const stripAtPrefix = (value) => value.replace(/^@+/, "").trim();

    if (!input.includes("://") && !input.includes("tiktok.com")) {
        return stripAtPrefix(input)
            .split(/[/?#]/)[0]
            .trim();
    }

    let candidate = input;
    if (!candidate.includes("://")) {
        candidate = "https://" + candidate;
    }

    try {
        const parsed = new URL(candidate);
        const segments = parsed.pathname.split("/").filter(Boolean);
        const atSegment = segments.find((segment) => segment.startsWith("@"));
        if (atSegment) {
            return stripAtPrefix(atSegment);
        }

        if (segments.length > 0) {
            return stripAtPrefix(segments[0]);
        }
    } catch (_error) {
        const match = input.match(/@([^/?#]+)/);
        if (match && match[1]) {
            return stripAtPrefix(match[1]);
        }
    }

    return "";
};

const TIKTOK_LIVE_ENABLED = toBoolean(process.env.ENABLE_TIKTOK_LIVE);
const TIKTOK_USERNAME = normalizeTikTokUniqueId(process.env.TIKTOK_USERNAME);
const TIKTOK_RECONNECT_MS = Math.max(1000, Number(process.env.TIKTOK_RECONNECT_MS) || 5000);
const TIKTOK_MAX_GIFT_REPEAT = Math.max(1, Math.trunc(Number(process.env.TIKTOK_MAX_GIFT_REPEAT) || 200));
const TIKTOK_CONNECT_WITH_UNIQUE_ID = toBoolean(
    process.env.TIKTOK_CONNECT_WITH_UNIQUE_ID === undefined
        ? "false"
        : process.env.TIKTOK_CONNECT_WITH_UNIQUE_ID
);
const TIKTOK_FETCH_ROOMINFO_ON_CONNECT = toBoolean(
    process.env.TIKTOK_FETCH_ROOMINFO_ON_CONNECT === undefined
        ? "false"
        : process.env.TIKTOK_FETCH_ROOMINFO_ON_CONNECT
);

app.use(express.static("public"));

const emitState = () => {
    io.emit("update", arena.toJSON());
};

io.on("connection", (socket) => {
    socket.on("join", (username) => {
        arena.addViewer(username);
        emitState();
    });

    socket.on("gift", ({ username, gift }) => {
        arena.applyGift(username, gift);
        emitState();
    });

    socket.on("leave", (username) => {
        arena.removeViewer(username);
        emitState();
    });

    emitState();
});

const resolveWebcastEvent = (eventKey, fallback) => {
    if (WebcastEvent && typeof WebcastEvent[eventKey] === "string") {
        return WebcastEvent[eventKey];
    }
    return fallback;
};

const extractTikTokUsername = (eventData) => {
    const raw =
        eventData?.uniqueId ||
        eventData?.user?.uniqueId ||
        eventData?.nickname ||
        "";

    if (typeof raw !== "string") {
        return "";
    }

    return raw.trim().replace(/^@+/, "");
};

const registerViewerFromEvent = (eventData, sourceLabel) => {
    const username = extractTikTokUsername(eventData);
    if (!username) {
        return { added: false, username: "" };
    }

    const result = arena.addViewer(username);
    if (result?.added) {
        console.log(`[TikTok] ${sourceLabel} -> ${username}`);
        emitState();
    }

    return { added: Boolean(result?.added), username };
};

const extractTikTokGiftName = (eventData) => {
    const candidates = [
        eventData?.giftName,
        eventData?.extendedGiftInfo?.name,
        eventData?.gift?.name
    ];

    for (const value of candidates) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }

    if (eventData?.giftId !== undefined && eventData?.giftId !== null) {
        return String(eventData.giftId);
    }

    return "";
};

const extractTikTokGiftCount = (eventData) => {
    const repeatCount = Number(eventData?.repeatCount);
    if (Number.isFinite(repeatCount) && repeatCount > 0) {
        return Math.max(1, Math.trunc(repeatCount));
    }
    return 1;
};

const isFinalTikTokGiftEvent = (eventData) => {
    const giftType = Number(eventData?.giftType);
    if (giftType === 1) {
        return Boolean(eventData?.repeatEnd);
    }
    return true;
};

const startTikTokBridge = () => {
    if (!TIKTOK_LIVE_ENABLED) {
        console.log("[TikTok] Bridge disabled (set ENABLE_TIKTOK_LIVE=true to enable).");
        return;
    }

    if (!TikTokLiveConnectorClass) {
        console.warn("[TikTok] Package 'tiktok-live-connector' is not installed.");
        return;
    }

    if (!TIKTOK_USERNAME) {
        console.warn("[TikTok] TIKTOK_USERNAME is empty/invalid. Use uniqueId (or full live URL).");
        return;
    }

    const connection = new TikTokLiveConnectorClass(TIKTOK_USERNAME, {
        processInitialData: false,
        enableExtendedGiftInfo: true,
        connectWithUniqueId: TIKTOK_CONNECT_WITH_UNIQUE_ID,
        fetchRoomInfoOnConnect: TIKTOK_FETCH_ROOMINFO_ON_CONNECT
    });
    let reconnectTimer = null;

    const scheduleReconnect = (reason) => {
        if (reconnectTimer) {
            return;
        }

        console.warn(`[TikTok] Reconnect scheduled (${reason}) in ${TIKTOK_RECONNECT_MS}ms`);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectToTikTokLive();
        }, TIKTOK_RECONNECT_MS);
    };

    const connectToTikTokLive = async () => {
        try {
            console.log(
                `[TikTok] Connecting as @${TIKTOK_USERNAME} ` +
                `(connectWithUniqueId=${String(TIKTOK_CONNECT_WITH_UNIQUE_ID)}, ` +
                `fetchRoomInfoOnConnect=${String(TIKTOK_FETCH_ROOMINFO_ON_CONNECT)})`
            );
            const state = await connection.connect();
            const roomId = state?.roomId ? String(state.roomId) : "unknown";
            console.log(`[TikTok] Connected to @${TIKTOK_USERNAME} (roomId=${roomId})`);
        } catch (error) {
            const message = error?.message || String(error);
            console.error(`[TikTok] Connection failed: ${message}`);

            const loweredMessage = String(message).toLowerCase();
            if (
                TIKTOK_CONNECT_WITH_UNIQUE_ID &&
                (loweredMessage.includes("premium feature") || loweredMessage.includes("pro plan"))
            ) {
                console.error(
                    "[TikTok] This mode requires Pro plan. Set TIKTOK_CONNECT_WITH_UNIQUE_ID=false and restart server."
                );
            }

            scheduleReconnect("connect_failed");
        }
    };

    connection.on(resolveWebcastEvent("MEMBER", "member"), (eventData) => {
        registerViewerFromEvent(eventData, "Join");
    });

    connection.on(resolveWebcastEvent("CHAT", "chat"), (eventData) => {
        registerViewerFromEvent(eventData, "Chat");
    });

    connection.on(resolveWebcastEvent("LIKE", "like"), (eventData) => {
        registerViewerFromEvent(eventData, "Like");
    });

    connection.on(resolveWebcastEvent("SOCIAL", "social"), (eventData) => {
        registerViewerFromEvent(eventData, "Social");
    });

    connection.on(resolveWebcastEvent("FOLLOW", "follow"), (eventData) => {
        registerViewerFromEvent(eventData, "Follow");
    });

    connection.on(resolveWebcastEvent("SHARE", "share"), (eventData) => {
        registerViewerFromEvent(eventData, "Share");
    });

    connection.on(resolveWebcastEvent("GIFT", "gift"), (eventData) => {
        const registerResult = registerViewerFromEvent(eventData, "GiftUser");
        const username = registerResult.username;
        if (!username) {
            return;
        }

        let stateChanged = false;

        if (!isFinalTikTokGiftEvent(eventData)) {
            if (stateChanged) {
                emitState();
            }
            return;
        }

        const giftName = extractTikTokGiftName(eventData);
        if (!giftName) {
            if (stateChanged) {
                emitState();
            }
            return;
        }

        const repeatCount = Math.min(TIKTOK_MAX_GIFT_REPEAT, extractTikTokGiftCount(eventData));
        let appliedCount = 0;
        for (let i = 0; i < repeatCount; i += 1) {
            const result = arena.applyGift(username, giftName);
            if (result?.applied) {
                appliedCount += 1;
                stateChanged = true;
            }
        }

        if (appliedCount > 0) {
            console.log(`[TikTok] Gift -> ${username} sent "${giftName}" x${repeatCount}`);
        }

        if (stateChanged) {
            emitState();
        }
    });

    connection.on(resolveWebcastEvent("STREAM_END", "streamEnd"), () => {
        scheduleReconnect("stream_end");
    });

    connection.on(resolveWebcastEvent("DISCONNECTED", "disconnected"), () => {
        scheduleReconnect("disconnected");
    });

    connectToTikTokLive();
};

setInterval(() => {
    arena.nextTurn();
    emitState();
}, TICK_MS);

startTikTokBridge();

server.listen(SERVER_PORT, () => {
    console.log(`Running on http://localhost:${SERVER_PORT}`);
});
