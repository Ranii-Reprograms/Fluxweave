"use strict";

const ITEM_CAPACITY = 150;     // per drill
const LIQUID_CAPACITY = 150;   // per pump
const MAX_TRANSFERS = 8;       // items per drill per frame
const LIQUID_INTERVAL = 4;     // drill liquid dump every N frames
const NO_PATH = 99999;

const PumpClass = (typeof Pump !== "undefined") ? Pump : null;
const ReactorClasses = [];
if (typeof NuclearReactor !== "undefined") ReactorClasses.push(NuclearReactor);
if (typeof ImpactReactor !== "undefined") ReactorClasses.push(ImpactReactor);
if (typeof VariableReactor !== "undefined") ReactorClasses.push(VariableReactor);

function isReactor(b) {
    for (let i = 0; i < ReactorClasses.length; i++) {
        if (b instanceof ReactorClasses[i]) return true;
    }
    return false;
}

// A "chain" is a group of a same-kind blocks touching each other. Exits are
// neighbouring blocks of another kind that can actually take items/liquid.
const KINDS = {
    drill: {
        is: b => b instanceof Drill,
        exit: b => b.hasItems
    },
    pump: {
        is: b => PumpClass != null && b instanceof PumpClass,
        exit: b => b.hasLiquids
    },
    // Reactors have no "exit": touching reactors just balance their coolant
    reactor: {
        is: b => isReactor(b),
        exit: b => false
    }
};

let all = [];
let byId = {};
let tick = 0;
let dirty = false;
let lastChange = 0;

function logErr(where, e) {
    try { Log.err("[Fluxweave] error in " + where + ": " + e); } catch (_) {}
}

function kindOf(build) {
    let b = build.block;
    if (b == null) return null;
    if (KINDS.drill.is(b) && build.items != null) return "drill";
    if (KINDS.pump.is(b) && build.liquids != null) return "pump";
    if (KINDS.reactor.is(b) && build.liquids != null) return "reactor";
    return null;
}

function track(build) {
    try {
        if (build == null) return;
        let k = kindOf(build);
        if (k == null) return;
        if (byId[build.id] != null) return;
        let w = { b: build, k: k, rot: 0, d: NO_PATH };
        byId[build.id] = w;
        all.push(w);
        dirty = true;
        lastChange = tick;
    } catch (e) {
        logErr("track", e);
    }
}

// Distance of every block to the nearest chain member touching a valid exit.
// Items/liquid only ever move to a strictly closer member, so they always
// flow toward the exit and every member can drain completely (no ping-pong type shi that makes the game stutter or lag).
function rebuildDistances() {
    dirty = false;
    let queue = [];

    for (let i = 0; i < all.length; i++) {
        let w = all[i];
        if (w.k === "reactor") continue;
        let K = KINDS[w.k];
        w.d = NO_PATH;
        let prox = w.b.proximity;
        for (let j = 0; j < prox.size; j++) {
            let t = prox.get(j);
            if (t != null && !K.is(t.block) && K.exit(t.block)) {
                w.d = 0;
                queue.push(w);
                break;
            }
        }
    }

    let head = 0;
    while (head < queue.length) {
        let w = queue[head++];
        let K = KINDS[w.k];
        let prox = w.b.proximity;
        for (let j = 0; j < prox.size; j++) {
            let t = prox.get(j);
            if (t == null || !K.is(t.block)) continue;
            let tw = byId[t.id];
            if (tw != null && tw.d > w.d + 1) {
                tw.d = w.d + 1;
                queue.push(tw);
            }
        }
    }
}

Events.on(EventType.ClientLoadEvent, cons(e => {
    try {
        Vars.content.blocks().each(cons(b => {
            if (KINDS.drill.is(b)) {
                b.itemCapacity = Math.max(b.itemCapacity, ITEM_CAPACITY);
            } else if (KINDS.pump.is(b)) {
                b.liquidCapacity = Math.max(b.liquidCapacity, LIQUID_CAPACITY);
            }
        }));
    } catch (err) {
        logErr("ClientLoadEvent", err);
    }
}));

Events.on(EventType.WorldLoadEvent, cons(e => {
    try {
        all = [];
        byId = {};
        Groups.build.each(cons(b => track(b)));
        dirty = true;
        lastChange = tick;
    } catch (err) {
        logErr("WorldLoadEvent", err);
    }
}));

Events.on(EventType.TileChangeEvent, cons(e => {
    try {
        if (e.tile != null) track(e.tile.build);
        dirty = true;
        lastChange = tick;
    } catch (err) {
        logErr("TileChangeEvent", err);
    }
}));

function processDrill(w, doLiquid) {
    let drill = w.b;

    if (doLiquid && drill.liquids != null && drill.liquids.currentAmount() > 0.01) {
        drill.dumpLiquid(drill.liquids.current());
    }

    let items = drill.items;
    if (items.total() === 0) return;
    if (w.d >= NO_PATH) return;   // no exit reachable/no output line

    let prox = drill.proximity;
    let pSize = prox.size;
    if (pSize === 0) return;

    let item = items.first();
    if (item == null) return;

    w.rot++;
    let transfers = 0;

    while (transfers < MAX_TRANSFERS && items.get(item) > 0) {
        let moved = false;

        for (let j = 0; j < pSize; j++) {
            let target = prox.get((j + w.rot) % pSize);
            if (target == null) continue;

            if (target.block instanceof Drill) {
                let tw = byId[target.id];
                if (tw != null && tw.d < w.d && target.items != null &&
                    target.items.get(item) < target.block.itemCapacity) {
                    items.remove(item, 1);
                    target.items.add(item, 1);
                    moved = true;
                    break;
                }
            } else if (target.acceptItem(drill, item)) {
                items.remove(item, 1);
                target.handleItem(drill, item);
                moved = true;
                break;
            }
        }

        if (!moved) break;
        transfers++;
    }
}

// Vanilla pumps already push liquid into adjacent conduits/consumers, so we
// only add the part vanilla lacks: forwarding to a closer pump in the chain.
function processPump(w) {
    let pump = w.b;
    let liq = pump.liquids;
    let amt = liq.currentAmount();
    if (amt < 0.01) return;
    if (w.d >= NO_PATH || w.d === 0) return;

    let liquid = liq.current();
    if (liquid == null) return;

    let prox = pump.proximity;
    for (let j = 0; j < prox.size && amt >= 0.01; j++) {
        let t = prox.get(j);
        if (t == null || !KINDS.pump.is(t.block) || t.liquids == null) continue;
        let tw = byId[t.id];
        if (tw == null || tw.d >= w.d) continue;

        let tl = t.liquids;
        if (!(tl.current() == liquid || tl.currentAmount() < 0.2)) continue;

        let space = t.block.liquidCapacity - tl.get(liquid);
        let move = Math.min(amt, space);
        if (move > 0.01) {
            liq.remove(liquid, move);
            tl.add(liquid, move);
            amt -= move;
        }
    }
}

// Touching reactors balance their coolant level (fuller -> emptier, never
// below the neighbour's level), so one conduit can feed a whole row.
// Only liquid is shared. Fuel/items are never touched.
function processReactor(w) {
    let r = w.b;
    let liq = r.liquids;
    if (liq.currentAmount() < 0.01) return;
    let liquid = liq.current();
    if (liquid == null) return;

    let cap = r.block.liquidCapacity;
    let prox = r.proximity;
    for (let j = 0; j < prox.size; j++) {
        let t = prox.get(j);
        if (t == null || t.liquids == null || !KINDS.reactor.is(t.block)) continue;

        let tl = t.liquids;
        if (!(tl.current() == liquid || tl.currentAmount() < 0.2)) continue;

        let tcap = t.block.liquidCapacity;
        let mine = liq.get(liquid);
        let theirs = tl.get(liquid);
        let diff = mine / cap - theirs / tcap;
        if (diff <= 0) continue;

        let move = Math.min(diff * cap / 2, tcap - theirs, mine);
        if (move > 0.01) {
            liq.remove(liquid, move);
            tl.add(liquid, move);
        }
    }
}

Events.run(Trigger.update, () => {
    if (Vars.state.isPaused()) return;
    tick++;
    let doLiquid = (tick % LIQUID_INTERVAL) === 0;

    // wait a few frames after a change so block proximity has updated
    if (dirty && tick - lastChange >= 6) {
        try { rebuildDistances(); } catch (e) { logErr("rebuildDistances", e); }
    }

    for (let i = all.length - 1; i >= 0; i--) {
        let w = all[i];
        let build = w.b;
        let remove = false;

        try {
            if (!build.isValid()) {
                remove = true;
            } else if (w.k === "drill") {
                processDrill(w, doLiquid);
            } else if (w.k === "pump") {
                processPump(w);
            } else {
                processReactor(w);
            }
        } catch (e) {
            logErr("update", e);
            remove = true;
        }

        if (remove) {
            try { delete byId[build.id]; } catch (_) {}
            let last = all.pop();
            if (i < all.length) all[i] = last;
            dirty = true;
            lastChange = tick;
        }
    }
});
