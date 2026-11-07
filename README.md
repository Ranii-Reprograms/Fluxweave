# Fluxweave
Touching blocks work together as one. Link drills, pumps and reactors into a chain, and a single input or output serves the whole line.

# What it does
Drills: each drill holds up to 150 items. Items flow through the chain toward the drill touching a conveyor, core or other block that accepts items, and every drill drains completely.
Pumps: same idea, but each pump holds 150 liquid. Liquid is forwarded toward the pump touching a conduit or other liquid block.
Reactors: touching reactors balance their coolant level, fuller to emptier, so a single conduit into one reactor supplies the rest. Only coolant is shared. Fuel and other items are never moved between reactors.

# Notes
- Tested on Mindustry v8 build 160.7 (Android) only.
- Multiplayer: it changes how items and liquids move, so everyone needs the mod installed.
Works on blocks built on the game's Drill, Pump, NuclearReactor, ImpactReactor and VariableReactor classes, including modded blocks that use them. Laser-style drills (BeamDrill) and blocks with fully custom logic are not affected.
- Reactors still need enough total coolant since the chain shares what the conduit delivers. Test big builds in a sandbox first, since a coolant shortage can still cause a meltdown.

# Credits
Based on unified-drills by Foxelling (https://github.com/Foxelling/unified-drills), which had the idea of chained drills sharing one inventory.
