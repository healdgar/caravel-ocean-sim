# Career design

The game to build first: a life at sea from 1492 to 1689, covering New World discovery, colonization or resistance to it, and piracy. The simulation stays open to ancient or modern eras later, but those eras are a constraint on the structure, not current scope.

## Goals

- **Roles emerge from actions.** There is no class to pick. A player becomes a trader, pirate, loyal subject, traitor, friend to Indigenous nations or compassionate helper by what they do.
- **Six measures of a life:** wealth, marriage and family, reputation with each power and nation, health, influence, and greater good. Greater good cannot be bought. The ending also shows what became of the world.
- **Losing does not end the game.** Sinking or capture costs the ship, cargo and health, and may mean ransom or being marooned. Only death ends a career.
- **History is a baseline.** A passive player sees history as it happened. Player actions shift who holds each port, which empire prospers and which nations survive.
- **The player cannot be a slaver.** See [The slave trade](#the-slave-trade).

## Ports

Every port offers a market, a shipyard, tavern rumours (sometimes false), assignments from governors, and society for patrons and courtship. Indigenous towns offer trade, healers, council and stories.

## Indigenous nations

Each nation tracks population, food, defence, unity, knowledge and trust. Sovereignty depends on the weakest, so no single tool is enough: medicine alone leaves survivors to be conquered, guns alone leave armies to die of plague, and treaties alone get broken.

| Tool | Counters | Catch |
|---|---|---|
| Medicine and knowledge | Epidemics | No germ theory or vaccine yet, so the tools are quarantine, nursing, food, and variolation learned on distant voyages. A crew can carry plague ashore |
| Guns and training | Conquest, slave raids | Powder creates dependency and arming one nation can start an arms race. Gunsmiths and training outlast shipments, and the Crown calls it treason |
| Language and law | Treaty fraud, legal dispossession | Law protects only with force behind it, and interpreters can be turned |
| Brokering alliances | Divide and conquer | European allies come with strings attached |

Also needed: food and land, fighting slavers, and time, because the aim is to delay colonization until populations recover. Knowledge flows both ways: nations can teach cures, piloting and local medicine. They have their own agendas and can refuse, bargain or turn on the player. The best ending is one where they no longer need the player.

Historical details in this design were written from memory and must be checked against sources before becoming in-game text.

## The slave trade

It exists in the world as an atrocity to fight. No market, cargo, assignment, prize choice or ending lets the player buy, sell or hold people, and no later system may add one. Capturing a slaver frees her captives. Indigenous crews cannot be pressed into service: their prize choice frees them instead.

## Arms

| Who | Ranged | Hand to hand |
|---|---|---|
| Taíno canoe | Bows, fire arrows | Macana |
| Oseberg, Lusoria | Bows, fire arrows | Sword |
| Gipsy Moth IV | None | Cutlass |
| Niña, Pinta, Santa María, Flying Cloud, Victory | Their authored guns | Cutlass |

- Canoes and yachts carry no guns by default. A shipyard may later fit swivels to a hull as a deliberate purchase.
- Shots hurt the bodies they reach. Above the rail is open air; below it the hull shields the crew, though a shot striking a bulwark or breaking through throws splinters at those close by. A small count stands in for hands not drawn, such as below decks.
- Arrows never breach a hull. Those that reach a body stay in it, fixed to the bone they struck. A fire arrow can catch rigging or timber: crews douse one, but several on one spot outrun them.
- A ball kills whoever it meets and flies on. It may take a limb, break it or crush a chest. Splinters can break limbs. A new ship or a pressed replacement starts whole.
- Muskets and pistols come later, as further rows in `GUNNERY_WEAPONS` and `VESSEL_SIDEARMS`.
- Archers stay abstract until crews can carry visible bows. Bows also borrow a clipped slap sound until they have recordings.
- A lost limb collapses at its joint. There is no separate severed piece and no blood yet.

## Build order

1. **Foundation (in progress):** prize choices, one owner for damage and repairs, fresh encounter ships, a real sinking outcome, one save file, current tests.
2. **Trader loop:** market, shipyard and money, leading to a first ending screen.
3. **Wider world:** reputation, assignments, rumours, encounters using all nine ship models.
4. **Nations:** the model above, epidemics and the four tools.
5. **Changing history:** port control and nation survival visibly change.
6. **A full life:** marriage, ageing and the full ending.

## Structure

- `js/vessel-damage.js` owns repairs, restores and refloats. Fresh hits stay in `js/gunnery-control.js`. Hull integrity is derived from `hullDamageJoules` and flooding is carried in `boat.cargoTonnes`, so never set either alone: use `setVesselHullIntegrity`, `repairVessel` and `pumpVesselDry`. `damage.sunk` and `damage.settledWreck` are the only wreck flags.
- `resetVesselDamageState` makes a pooled hull a new ship. Call it through `prepareEncounterVessel` in `js/main.js`, which also restores geometry and revives the company.
- `js/career-save.js` owns the one saved game (`waterworld.career.v1`): voyage, vessel, sovereignty, share URL and career record. It holds no DOM or GPU code. A tab writes only after it owns the save, through continuing, starting fresh or having nothing to protect, so a shared link cannot overwrite a voyage. The URL remains a shareable scene, not the save.
- `js/career-ui.js` holds career DOM.
- `js/crew-wounds.js` owns body hits, stuck arrows and injuries. A hit waits as a pending wound until the next pose finds the nearest bone. `applyCrewCasualtiesAndMorale` keeps the counts, and only a magazine blast still harms by area.
- `GUNNERY_WEAPONS` in `js/gunnery-state.js` says what a battery fires: its ammunition, whether it burns powder and how far it reaches. Check it rather than testing for a model id.
- New career systems take powers, goods, currency, tools and timelines from era data rather than from the core. Do not add new `1550`, `cannon` or crown literals to career code.
- Build rules: `build.mjs` concatenates modules into one scope with an explicit `order`, so new modules must be added there and top-level names must be unique across `js/`.

## Testing

Run `npm run build` first, because Git does not track the single-file bundles several tests read. `npm test` defaults to SwiftShader in parallel, which times out on many GPU tests. Use `WEBGPU_BACKEND=metal node --test --test-concurrency=1`. `tests/career-loop-gpu.test.mjs` plays the foundation through the real game.
