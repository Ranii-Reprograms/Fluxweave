# Fluxweave
- Touching blocks work together as one; drills/pumps/factories/reactors. A single input or output serves the whole line.

# Reasoning
- I made it to be less bothered about adding seperate input/output lines.. yes I'm lazy xd
- It "should" be compatible with other mods since y'know, Classes, heh.. unless another mod has its own custom logic that is 💀💀
- Made for lazy people like me ;P

# What it does and how they operate
- Drills: each drill holds up to 150 items. Items flow through the chain toward the drill touching a conveyor, core or other block that accepts items, and every drill drains completely. Boost liquid like water is shared too, so one pipe into a single drill supplies the whole chain, albeit drills from the far end of a liquid supply may fill slower, shouldn't matter tho if you have a strong conduit (or just use the instant liquid travel method; i.e liquid junctions/container chaining).
- Pumps: same idea, but each pump holds 150 liquid. Liquid is forwarded toward the pump touching a conduit or other liquid block.
- Reactors: touching reactors balance their coolant level, fuller to emptier, so a single conduit into one reactor supplies the rest. Only coolant is shared. Fuel and other items are never moved between reactors.
- Factories: touching factories of the exact same type share both ends of the process.
  - Inputs: the liquids and items they consume are balanced between neighbors, so one pipe and one conveyor can feed a whole row or column of factories.
  - Outputs: the products spread toward whichever factory touches an output, so one conduit or conveyor can carry away the whole row's production. Only products come out, never inputs (a cryomixer outputs it's produced cryofluid, not its water).
  - Only the same block type interacts, so different factories next to each other don't affect each other.
- To share liquids only, download the zip file and set SHARE_FACTORY_ITEMS to false at the top of scripts/main.js. 

# Notes
- Tested on Mindustry v8 build 160.7 (Android) only.
- Multiplayer: it changes how items and liquids move, so everyone needs the mod installed.
- Works on blocks built on the game's Drill, Pump, NuclearReactor, ImpactReactor, VariableReactor, and GenericCrafter classes, including modded blocks that use them. Laser-style drills (BeamDrill) and blocks with fully custom logic are not affected.
- Chains only share what you deliver. Test big reactor builds in a sandbox first, since a coolant shortage can still cause a meltdown. 

# Credits
Based on unified-drills by Foxelling (https://github.com/Foxelling/unified-drills), which had the idea of chained drills sharing one inventory 🤝.

# Also
- Ben Bagul
