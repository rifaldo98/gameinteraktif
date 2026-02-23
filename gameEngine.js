const MAX_QUEUE = 10;
const STARTING_HP = 30;
const BASE_DAMAGE_PER_HIT = 2;
const SWORD_DAMAGE_PER_HIT = 4;
const ROUND_START_DELAY_MS = 1000;
const SUMMON_PAUSE_MS = 3200;

const GIFT_RULES = {
    rose: { type: "hp", amount: 1 },
    mawar: { type: "hp", amount: 1 },
    donut: { type: "hp", amount: 30 },
    love: { type: "hp", amount: 100 },
    corgi: { type: "hp", amount: 300 },
    rosa: { type: "evolve" },
    "buket bunga": { type: "summon", summon: "lightning_mage", amount: 30 },
    bouquet: { type: "summon", summon: "lightning_mage", amount: 30 },
    "topi dan kumis": { type: "summon", summon: "fire_wizard", amount: 100 },
    "topi kumis": { type: "summon", summon: "fire_wizard", amount: 100 }
};

class Player {
    constructor(username) {
        this.username = username;
        this.hp = STARTING_HP;
        this.maxHp = STARTING_HP;
        this.hasSword = false;
        this.winStreak = 0;
    }

    attack(target) {
        const damagePerHit = this.hasSword ? SWORD_DAMAGE_PER_HIT : BASE_DAMAGE_PER_HIT;
        target.hp = Math.max(0, target.hp - damagePerHit);
        return damagePerHit;
    }

    addHp(amount) {
        if (!Number.isFinite(amount) || amount <= 0) {
            return;
        }

        this.hp += amount;
        if (this.hp > this.maxHp) {
            this.maxHp = this.hp;
        }
    }

    resetForBattle() {
        this.hp = STARTING_HP;
        this.maxHp = STARTING_HP;
        this.hasSword = false;
    }

    toJSON() {
        return {
            username: this.username,
            hp: this.hp,
            maxHp: this.maxHp,
            hasSword: this.hasSword,
            winStreak: this.winStreak
        };
    }
}

class Arena {
    constructor() {
        this.players = new Map();
        this.queue = [];
        this.reserve = [];

        this.champion = null;
        this.challenger = null;
        this.turn = "champion";

        this.lastAttack = null;
        this.attackSequence = 0;
        this.lastGift = null;
        this.giftSequence = 0;
        this.combatPauseUntil = 0;
        this.activePairKey = "";
    }

    addViewer(username) {
        const cleanUsername = this.normalizeUsername(username);
        if (!cleanUsername) {
            return { added: false, reason: "invalid_username" };
        }

        if (this.players.has(cleanUsername)) {
            return { added: false, reason: "already_exists" };
        }

        const player = new Player(cleanUsername);
        this.players.set(cleanUsername, player);

        if (!this.champion) {
            this.champion = player;
        } else if (!this.challenger) {
            this.challenger = player;
        } else {
            this.enqueue(cleanUsername);
        }

        this.startBattleIfReady();
        return { added: true, reason: "ok", player: player.toJSON() };
    }

    removeViewer(username) {
        const cleanUsername = this.normalizeUsername(username);
        if (!cleanUsername || !this.players.has(cleanUsername)) {
            return false;
        }

        this.players.delete(cleanUsername);
        this.queue = this.queue.filter((name) => name !== cleanUsername);
        this.reserve = this.reserve.filter((name) => name !== cleanUsername);

        if (this.champion && this.champion.username === cleanUsername) {
            this.champion = null;
        }
        if (this.challenger && this.challenger.username === cleanUsername) {
            this.challenger = null;
        }

        this.promoteReserveToQueue();
        this.startBattleIfReady();
        return true;
    }

    enqueue(username) {
        if (!this.players.has(username) || this.isInBattle(username)) {
            return;
        }

        if (this.queue.includes(username) || this.reserve.includes(username)) {
            return;
        }

        if (this.queue.length < MAX_QUEUE) {
            this.queue.push(username);
            return;
        }

        this.reserve.push(username);
    }

    promoteReserveToQueue() {
        while (this.queue.length < MAX_QUEUE && this.reserve.length > 0) {
            const next = this.reserve.shift();
            if (!next) {
                continue;
            }

            if (!this.players.has(next) || this.isInBattle(next) || this.queue.includes(next)) {
                continue;
            }

            this.queue.push(next);
        }
    }

    dequeueNextFighter() {
        while (this.queue.length > 0) {
            const nextUsername = this.queue.shift();
            if (!nextUsername) {
                continue;
            }

            const nextPlayer = this.players.get(nextUsername);
            if (!nextPlayer || this.isInBattle(nextUsername)) {
                continue;
            }

            this.promoteReserveToQueue();
            return nextPlayer;
        }

        this.promoteReserveToQueue();
        return null;
    }

    startBattleIfReady() {
        const previousPairKey = this.getPairKey();

        if (!this.champion) {
            this.champion = this.dequeueNextFighter();
        }

        if (!this.challenger) {
            this.challenger = this.dequeueNextFighter();
        }

        const nextPairKey = this.getPairKey();
        if (nextPairKey !== previousPairKey) {
            this.activePairKey = nextPairKey;
            if (nextPairKey) {
                this.combatPauseUntil = Math.max(this.combatPauseUntil, Date.now() + ROUND_START_DELAY_MS);
            }
        } else if (!nextPairKey) {
            this.activePairKey = "";
        }
    }

    nextTurn() {
        this.startBattleIfReady();
        if (!this.champion || !this.challenger) {
            return;
        }

        if (Date.now() < this.combatPauseUntil) {
            return;
        }

        if (this.champion.hp <= 0 || this.challenger.hp <= 0) {
            this.resolveDeath();
            return;
        }

        const attacker = this.turn === "champion" ? this.champion : this.challenger;
        const target = this.turn === "champion" ? this.challenger : this.champion;
        this.turn = this.turn === "champion" ? "challenger" : "champion";

        const targetHpBefore = target.hp;
        let totalDamage = 0;
        let landedHits = 0;

        for (let i = 0; i < 2; i += 1) {
            const damage = attacker.attack(target);
            totalDamage += damage;
            landedHits += 1;

            if (target.hp <= 0) {
                break;
            }
        }

        this.attackSequence += 1;
        const targetHpAfter = target.hp;
        const targetDied = targetHpAfter <= 0;
        this.lastAttack = {
            id: this.attackSequence,
            attacker: attacker.username,
            target: target.username,
            totalDamage,
            hits: landedHits,
            sword: attacker.hasSword,
            targetHpBefore,
            targetHpAfter,
            died: targetDied
        };

        if (targetDied) {
            this.resolveDeath();
        }
    }

    resolveDeath() {
        if (!this.champion || !this.challenger) {
            return;
        }

        let winner = null;
        let loser = null;

        if (this.champion.hp <= 0) {
            winner = this.challenger;
            loser = this.champion;
        } else if (this.challenger.hp <= 0) {
            winner = this.champion;
            loser = this.challenger;
        } else {
            return;
        }

        winner.winStreak += 1;

        if (loser && this.players.has(loser.username)) {
            loser.winStreak = 0;
            loser.resetForBattle();
            this.enqueue(loser.username);
        }

        // Keep side positions stable:
        // - if champion (left) dies, only refill champion slot
        // - if challenger (right) dies, only refill challenger slot
        if (loser === this.champion) {
            this.champion = this.dequeueNextFighter();
        } else {
            this.challenger = this.dequeueNextFighter();
        }

        this.turn = "champion";
        this.startBattleIfReady();
    }

    applyGift(username, rawGiftName) {
        const cleanUsername = this.normalizeUsername(username);
        const giftName = this.normalizeGiftName(rawGiftName);
        const giftRule = GIFT_RULES[giftName];

        if (!cleanUsername || !giftRule) {
            return { applied: false, reason: "invalid_input" };
        }

        const target = this.getGiftEligiblePlayer(cleanUsername);
        if (!target) {
            return { applied: false, reason: "not_in_queue_or_battle" };
        }

        if (giftRule.type === "hp") {
            target.addHp(giftRule.amount);
            return { applied: true, reason: "hp_added", amount: giftRule.amount };
        }

        if (giftRule.type === "evolve") {
            target.hasSword = true;
            return { applied: true, reason: "tengu_evolved" };
        }

        if (giftRule.type === "summon") {
            if (Date.now() < this.combatPauseUntil) {
                return { applied: false, reason: "summon_in_progress" };
            }

            const opponent = this.getBattleOpponent(target.username);
            if (!opponent) {
                return { applied: false, reason: "summon_requires_active_battle" };
            }

            const damage = Math.max(0, Math.trunc(giftRule.amount) || 0);
            const targetHpBefore = opponent.hp;
            opponent.hp = Math.max(0, opponent.hp - damage);
            const targetHpAfter = opponent.hp;
            const targetDied = targetHpAfter <= 0;

            this.giftSequence += 1;
            this.lastGift = {
                id: this.giftSequence,
                kind: "summon",
                summon: giftRule.summon,
                sourceGift: giftName,
                caster: target.username,
                target: opponent.username,
                damage,
                targetHpBefore,
                targetHpAfter,
                died: targetDied
            };

            this.combatPauseUntil = Date.now() + SUMMON_PAUSE_MS;

            if (targetDied) {
                this.resolveDeath();
            }

            return {
                applied: true,
                reason: "summon_cast",
                summon: giftRule.summon,
                damage,
                died: targetDied
            };
        }

        return { applied: false, reason: "unsupported_gift" };
    }

    getGiftEligiblePlayer(username) {
        if (this.champion && this.champion.username === username) {
            return this.champion;
        }

        if (this.challenger && this.challenger.username === username) {
            return this.challenger;
        }

        if (this.queue.includes(username)) {
            return this.players.get(username) || null;
        }

        return null;
    }

    getBattleOpponent(username) {
        if (!this.champion || !this.challenger) {
            return null;
        }

        if (this.champion.username === username) {
            return this.challenger;
        }

        if (this.challenger.username === username) {
            return this.champion;
        }

        return null;
    }

    getPairKey() {
        if (!this.champion || !this.challenger) {
            return "";
        }
        return this.champion.username + "|" + this.challenger.username;
    }

    isInBattle(username) {
        return Boolean(
            (this.champion && this.champion.username === username) ||
            (this.challenger && this.challenger.username === username)
        );
    }

    normalizeUsername(username) {
        if (typeof username !== "string") {
            return "";
        }
        return username.trim();
    }

    normalizeGiftName(giftName) {
        if (typeof giftName !== "string") {
            return "";
        }
        return giftName
            .trim()
            .toLowerCase()
            .replace(/[_-]+/g, " ")
            .replace(/\s+/g, " ");
    }

    toJSON() {
        const mapPlayer = (player) => (player ? player.toJSON() : null);
        const queuePlayers = this.queue
            .map((username) => this.players.get(username))
            .filter(Boolean)
            .map((player) => player.toJSON());

        return {
            settings: {
                maxQueue: MAX_QUEUE,
                startingHp: STARTING_HP
            },
            champion: mapPlayer(this.champion),
            challenger: mapPlayer(this.challenger),
            queue: queuePlayers,
            reserveCount: this.reserve.length,
            turn: this.turn,
            lastAttack: this.lastAttack,
            lastGift: this.lastGift
        };
    }
}

module.exports = { Player, Arena, MAX_QUEUE, STARTING_HP };
