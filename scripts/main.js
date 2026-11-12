"use strict";

const ITEM_CAPACITY = 0;     // per drill capacity
const LIQUID_CAPACITY = 0;   // per pump capacity
const MAX_TRANSFERS = 8;       // items per drill per frame
const LIQUID_INTERVAL = 4;     // drill liquid dump every N frames
const NO_PATH = 99999;
const SHARE_FACTORY_ITEMS = true;  // set to false to share only liquids between factories
const FACTORY_ITEM_INTERVAL = 3;   // share factory items every N frames
                                   // host/device dependent
const DRILLS_ACCEPT_ITEMS = true;  // makes a drill pass items through them

const PumpClass = (typeof Pump !== "undefined") ? Pump : null;
const CrafterClass = (typeof GenericCrafter !== "undefined") ? GenericCrafter : null;
const GeneratorClass = (typeof ConsumeGenerator !== "undefined") ? ConsumeGenerator : null;
const TurretClass = (typeof BaseTurret !== "undefined") ? BaseTurret : null;
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
// The Idea:
// A "chain" is a group of same-kind blocks touching each other. Exits are
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
    },
    // Factories (crafters) and fuel-burning generators also have no exit:
    // touching ones of the same type balance the inputs they consume
    factory: {
        is: b => !isReactor(b) && (
            (CrafterClass != null && b instanceof CrafterClass) || 
            (GeneratorClass != null && b instanceof GeneratorClass) ||
            (TurretClass != null && b instanceof TurretClass)
        ),
        exit: b => false
    }
};

// Per block type: which items/liquids it consumes as inputs (cached).
// Items it also produces are excluded, so products are never passed around.
let inputCache = {};

function outputItemList(block) {
    let list = [];
    try {
        if (block.outputItems != null) {
            for (let i = 0; i < block.outputItems.length; i++) list.push(block.outputItems[i].item);
        } else if (block.outputItem != null) {
            list.push(block.outputItem.item);
        }
    } catch (_) {}
    return list;
}

function outputLiquidList(block) {
    let list = [];
    try {
        if (block.outputLiquids != null) {
            for (let i = 0; i < block.outputLiquids.length; i++) list.push(block.outputLiquids[i].liquid);
        } else if (block.outputLiquid != null) {
            list.push(block.outputLiquid.liquid);
        }
    } catch (_) {}
    return list;
}

function inputsOf(block) {
    let c = inputCache[block.id];
    if (c != null) return c;

    let outItems = outputItemList(block);
    let outLiquids = outputLiquidList(block);
    let outItemIds = {};
    for (let i = 0; i < outItems.length; i++) outItemIds[outItems[i].id] = true;

    let items = [];
    let liquids = [];

    let allItems = Vars.content.items();
    for (let i = 0; i < allItems.size; i++) {
        let it = allItems.get(i);
        if (block.consumesItem(it) && outItemIds[it.id] !== true) items.push(it);
    }
    let allLiquids = Vars.content.liquids();
    for (let i = 0; i < allLiquids.size; i++) {
        let l = allLiquids.get(i);
        if (block.consumesLiquid(l)) liquids.push(l);
    }

    // turrets: share coolant/liquid ammo only, never item ammo
    if (TurretClass != null && block instanceof TurretClass) items = [];

    // products that are not also consumed
    let pItems = outItems.filter(it => !block.consumesItem(it));
    let pLiquids = outLiquids.filter(l => !block.consumesLiquid(l));

    c = { items: items, liquids: liquids, outItems: pItems, outLiquids: pLiquids };
    inputCache[block.id] = c;
    return c;
}

let all = [];
let byId = {};   // plain objects: JS Set/Map clear() crashes on Android
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
    if (KINDS.factory.is(b)) {
        let inp = inputsOf(b);
        if (inp.items.length + inp.liquids.length + inp.outItems.length + inp.outLiquids.length > 0) return "factory";
    }
    return null;
}

function track(build) {
    try {
        if (build == null) return;
        let k = kindOf(build);
        if (k == null) return;
        if (byId[build.id] != null) return;
        let w = { b: build, k: k, rot: 0, d: NO_PATH, exL: false, exI: false, missL: 0, missI: 0, dL: NO_PATH, dI: NO_PATH };
        byId[build.id] = w;
        all.push(w);
        dirty = true;
        lastChange = tick;
    } catch (e) {
        logErr("track", e);
    }
}

// A rotating block (conveyor, duct...) whose front faces this machine is an
// INPUT line, not an exit. Without this check, the drill that the passing
// conveyor feeds counts as "touching an exit" (d = 0), so the drills treat
// it as the chain's end, push items towards it and they get stuck/bounce.
function isInputFeeder(t, machine) {
    try {
        if (t.block.rotate && t.front() === machine) return true;
    } catch (_) {}
    return false;
}

// Distance of every block to the nearest chain member touching a valid exit.
// Items/liquid only ever move to a strictly closer member, so they always
// flow toward the exit and every member can drain completely (no back and forth ping-pong shit).

function rebuildDistances() {
    dirty = false;
    let queue = [];

    for (let i = 0; i < all.length; i++) {
        let w = all[i];
        if (w.k === "reactor" || w.k === "factory") continue;
        let K = KINDS[w.k];
        w.d = NO_PATH;
        let prox = w.b.proximity;
        for (let j = 0; j < prox.size; j++) {
            let t = prox.get(j);
            if (t != null && !K.is(t.block) && K.exit(t.block) && !isInputFeeder(t, w.b)) {
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

    // Factory outputs: distance (in same-type factories) to the nearest factory
    // that touches something accepting its product.

    let qL = [];
    let qI = [];
    for (let i = 0; i < all.length; i++) {
        let w = all[i];
        if (w.k !== "factory") continue;
        w.dL = w.exL ? 0 : NO_PATH;
        w.dI = w.exI ? 0 : NO_PATH;
        if (w.exL) qL.push(w);
        if (w.exI) qI.push(w);
    }
    factoryBfs(qL, "dL");
    factoryBfs(qI, "dI");
}

function factoryBfs(queue, key) {
    let head = 0;
    while (head < queue.length) {
        let w = queue[head++];
        let block = w.b.block;
        let prox = w.b.proximity;
        for (let j = 0; j < prox.size; j++) {
            let t = prox.get(j);
            if (t == null || t.block != block) continue;
            let tw = byId[t.id];
            if (tw != null && tw.k === "factory" && tw[key] > w[key] + 1) {
                tw[key] = w[key] + 1;
                queue.push(tw);
            }
        }
    }
}

// Sticky exit detection: a factory counts as an "exit" for its product while a
// neighbouring block of another type keeps accepting it. Checked every few
// frames; the flag is dropped only after ~2 seconds of nothing accepting.

function detectExits(w) {
    let f = w.b;
    let block = f.block;
    let inp = inputsOf(block);
    let prox = f.proximity;

    let accL = false;
    let accI = false;
    for (let j = 0; j < prox.size; j++) {
        let t = prox.get(j);
        if (t == null || t.block == block) continue;
        if (!accL && f.liquids != null && t.block.hasLiquids) {
            for (let k = 0; k < inp.outLiquids.length; k++) {
                if (t.acceptLiquid(f, inp.outLiquids[k])) { accL = true; break; }
            }
        }
        if (!accI && SHARE_FACTORY_ITEMS && f.items != null && t.block.hasItems) {
            for (let k = 0; k < inp.outItems.length; k++) {
                if (t.acceptItem(f, inp.outItems[k])) { accI = true; break; }
            }
        }
    }

    if (accL) { w.missL = 0; if (!w.exL) { w.exL = true; dirty = true; lastChange = tick; } }
    else if (w.exL && ++w.missL >= 12) { w.exL = false; w.missL = 0; dirty = true; lastChange = tick; }

    if (accI) { w.missI = 0; if (!w.exI) { w.exI = true; dirty = true; lastChange = tick; } }
    else if (w.exI && ++w.missI >= 12) { w.exI = false; w.missI = 0; dirty = true; lastChange = tick; }
}

// Drills now accept items (so conveyors can feed through them), which means
// vanilla dump()/offload() would also hand items to a neighbouring drill in any
// direction - that fights processDrill and creates the back-and-forth.
// Drill -> drill transfer is handled ONLY by processDrill (towards the exit).
let patchedDrills = 0;
let RAW = {};
function patchDrillDump(b) {
    try {
        if (!DRILLS_ACCEPT_ITEMS) return;
        if (b.buildType == null) return;
        // Only patch plain vanilla drills with the default build class. Modded
        // drills with their own Drill subclass / custom build keep their logic.
        if (String(b.getClass().getName()) !== "mindustry.world.blocks.production.Drill") return;
        let inst = b.buildType.get();
        if (String(inst.getClass().getName()) !== "mindustry.world.blocks.production.Drill$DrillBuild") return;
        b.buildType = prov(() => extend(Drill.DrillBuild, b, {
            canDump(to, item) {
                if (to != null && to.block instanceof Drill) return false;
                return this.super$canDump(to, item);
            },
            // Drills take items from conveyors (pass-through), but never from
            // crafters (e.g. a furnace dumping its silicon into the drills) or
            // from other drills (processDrill moves those itself).
            acceptItem(source, item) {
                // Allowlist: only transport blocks (conveyors, bridges, junctions,
                // routers, sorters...) may insert items. Crafters of any kind,
                // drills and everything else are refused.
                if (source != null && source.block.group !== BlockGroup.transportation) return false;
                return this.super$acceptItem(source, item);
            }
        }));
        patchedDrills++;
    } catch (e) {
        logErr("patchDrillDump " + b.name, e);
    }
}

Events.on(EventType.ClientLoadEvent, cons(e => {
    try {
        RAW = {};
        Vars.content.blocks().each(cons(blk => {
            if (blk.itemDrop != null) RAW[blk.itemDrop.id] = true;
        }));
        ALL_ITEMS = [];
        Vars.content.items().each(cons(i => ALL_ITEMS.push(i)));
        Vars.content.blocks().each(cons(b => {
              if (KINDS.drill.is(b)) {
                patchDrillDump(b);
                b.itemCapacity = Math.max(b.itemCapacity, ITEM_CAPACITY);
                if (DRILLS_ACCEPT_ITEMS && b.itemFilter != null) {
                    // Drills accept RAW items only (anything an ore/floor/wall can
                    // drop: sand, coal, copper...). Crafted items such as silicon
                    // or graphite are never accepted, so a smelter touching the
                    // drills can't dump its output into them. This is a static
                    // block flag, so it works even if patchDrillDump doesn't.
                    for (let i = 0; i < b.itemFilter.length; i++) b.itemFilter[i] = !!RAW[i];
                }
            } else if (KINDS.pump.is(b)) {
                b.liquidCapacity = Math.max(b.liquidCapacity, LIQUID_CAPACITY);
            }
        }));
        Vars.ui.showInfoToast("Fluxweave: drill patch " + patchedDrills + " drill(s), raw items " + Object.keys(RAW).length, 6);
    } catch (err) {
        logErr("ClientLoadEvent", err);
    }
}));

Events.on(EventType.WorldLoadEvent, cons(e => {
    try {
        all = [];
        byId = {};
        inputCache = {};
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

let ALL_ITEMS = [];
function processDrill(w, doLiquid) {
    let drill = w.b;

    if (doLiquid && drill.liquids != null && drill.liquids.currentAmount() > 0.01) {
        drill.dumpLiquid(drill.liquids.current());
    }

    let items = drill.items;
    if (items.total() === 0) return;
    if (w.d >= NO_PATH) return;   // reminder to self: this line regulates all the
                                  // machines when no exit/output line is reachable

    let prox = drill.proximity;
    let pSize = prox.size;
    if (pSize === 0) return;

    w.rot++;
    let budget = MAX_TRANSFERS;

    // Try EVERY item type the drill holds, not only items.first(): otherwise
    // an item that cannot move (e.g. sand when the smelter is full of sand)
    // blocks every other item behind it (e.g. the coal the smelter needs).
    for (let ii = 0; ii < ALL_ITEMS.length && budget > 0; ii++) {
        let item = ALL_ITEMS[ii];
        while (budget > 0 && items.get(item) > 0) {
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

            if (!moved) break;   // this item is stuck, go on with the next type
            budget--;
        }
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
// Only liquid is shared. Fuel/items are never touched..
// because they will explode if you fail to supply the coolant first xd

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

// Touching factories of the same type balance the inputs they consume
// (liquids by level, items by a gradient of at least 2 so nothing ping-pongs)
// (Im trying to avoid what unloaders do when they're in close contact to each factory)
// and drain their products toward whichever factory touches an output.
// Only exact same block types interact.

function processFactory(w, doItems) {
    let f = w.b;
    let block = f.block;
    let inp = inputsOf(block);
    let prox = f.proximity;

    if (((tick + f.id) % 10) === 0) detectExits(w);

    for (let j = 0; j < prox.size; j++) {
        let t = prox.get(j);
        if (t == null || t.block != block) continue;

        if (f.liquids != null && t.liquids != null) {
            let cap = block.liquidCapacity;
            for (let k = 0; k < inp.liquids.length; k++) {
                let L = inp.liquids[k];
                let mine = f.liquids.get(L);
                if (mine < 0.01) continue;
                let theirs = t.liquids.get(L);
                if (mine <= theirs) continue;
                let move = Math.min((mine - theirs) / 2, cap - theirs);
                if (move > 0.01 && t.acceptLiquid(f, L)) {
                    f.liquids.remove(L, move);
                    t.handleLiquid(f, L, move);
                }
            }
        }

        // Products: once a factory is known to touch an output, everything is
        // drained towards it through strictly closer factories (nothing is left
        // behind). Until an output is found, products just spread evenly.
        // The factories' own vanilla dumping does the actual output.
        let tw = byId[t.id];

        if (f.liquids != null && t.liquids != null) {
            let cap = block.liquidCapacity;
            for (let k = 0; k < inp.outLiquids.length; k++) {
                let L = inp.outLiquids[k];
                let mine = f.liquids.get(L);
                if (mine < 0.01) continue;
                let theirs = t.liquids.get(L);
                let move = 0;
                if (w.dL < NO_PATH) {
                    if (tw != null && tw.dL < w.dL) move = Math.min(mine, cap - theirs);
                } else if (mine > theirs) {
                    move = Math.min((mine - theirs) / 2, cap - theirs);
                }
                if (move > 0.01) {
                    f.liquids.remove(L, move);
                    t.liquids.add(L, move);
                }
            }
        }

        if (doItems && SHARE_FACTORY_ITEMS && f.items != null && t.items != null) {
            for (let k = 0; k < inp.outItems.length; k++) {
                let it = inp.outItems[k];
                let mine = f.items.get(it);
                if (mine < 1) continue;
                let theirs = t.items.get(it);
                if (theirs >= block.itemCapacity) continue;
                let n = 0;
                if (w.dI < NO_PATH) {
                    if (tw != null && tw.dI < w.dI) n = Math.min(mine, block.itemCapacity - theirs, 3);
                } else if (mine >= 2 && mine - theirs >= 2) {
                    n = 1;
                }
                if (n > 0) {
                    f.items.remove(it, n);
                    t.items.add(it, n);
                }
            }
        }

        if (doItems && SHARE_FACTORY_ITEMS && f.items != null && t.items != null) {
            for (let k = 0; k < inp.items.length; k++) {
                let it = inp.items[k];
                let mine = f.items.get(it);
                if (mine < 2) continue;
                if (mine - t.items.get(it) < 2) continue;
                if (t.acceptItem(f, it)) {
                    f.items.remove(it, 1);
                    t.handleItem(f, it);
                }
            }
        }
    }
}

Events.run(Trigger.update, () => {
    if (Vars.state.isPaused()) return;
    tick++;
    let doLiquid = (tick % LIQUID_INTERVAL) === 0;
    let doFactoryItems = (tick % FACTORY_ITEM_INTERVAL) === 0;

    if ((tick % 120) === 0) { dirty = true; lastChange = tick; }  // conveyor rotation fires no tile event

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
            } else if (w.k === "reactor") {
                processReactor(w);
            } else {
                processFactory(w, doFactoryItems);
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
