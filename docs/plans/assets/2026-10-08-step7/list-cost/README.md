# Costo della lista delle luci sulla CPU (passo 7, Task 8f3)

L'harness usa e getta che ha misurato la riga «Lista delle luci (passo 7)» del design dei light layers
(`docs/plans/2026-09-26-phase17-light-layer-groups-design.md`, tabella dei costi): `deriveLightGroups` del
branch contro quello di master (`1d19575`, il modulo prima del passo 7) sugli stessi frame sintetici,
300, 1000 e 10 000 luci point tutte in vista a z distinte più 1000 ricevitori; 300 chiamate di
riscaldamento e 1000 misurate per variante e taglia, alternate; mediane e delta in `run1.json`,
`run2.json`, `run3.json` (Node 24.21.0, Apple M2 Pro, 2026-10-10; la riga cita la corsa 1).

Per rieseguirlo (non resta nulla in `ts/src`):

1. `cp docs/plans/assets/2026-10-08-step7/list-cost/list-cost.tmp.test.ts ts/src/render/`
2. `git show 1d19575:ts/src/render/light-groups.ts > ts/src/render/light-groups-master.tmp.ts`
3. `G1_OUT=/tmp/run.json npx --prefix ts vitest run --root ts src/render/list-cost.tmp.test.ts`
4. `rm ts/src/render/list-cost.tmp.test.ts ts/src/render/light-groups-master.tmp.ts`

Le variabili `G1_N` e `G1_WARMUP` cambiano il numero di chiamate misurate e di riscaldamento. Il terzo
decimale non si riproduce da una corsa all'altra (0,037-0,040 ms a 300 luci su quattro corse): la riga
del design arrotonda a +0,04 ms.
