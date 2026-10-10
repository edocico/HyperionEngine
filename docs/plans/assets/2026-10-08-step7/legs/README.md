# Verdetti delle gambe GPU del Task 9 (passo 7)

Il risultato di ciascuna delle quattro gambe del Task 9 (workflow `gpu-leg`: un agente esegue i passi
nel browser, uno indipendente verifica le evidenze contro le aspettative scritte), sul Mac (Apple M2 Pro,
Chrome 155.0.8059.40, macOS 27.0.1), a `83a9b9d`. I percorsi locali sono sostituiti da `<repo>`, `~` e
`<tmp>`; per il resto i file sono quelli restituiti dai workflow.

- `task-9a-result.json`: master ricatturato (`ts/src` di `1d19575`), `regress` in B e C.
- `task-9b-result.json`: il banco sul passo 7 (WGSL e pipeline, `grow`, `regress`, `permute`, `order`). Passa.
- `task-9c-result.json`: l'harness in B, C e A e la scena statica A contro B.
- `task-9d-result.json`: il cancello M4 ricatturato. Passa.

9a e 9c hanno `pass: false`, e il controller ne ha accettato le evidenze (registro SDD, ruling R17 e R18):

- in 9a fallisce solo la console della pagina B, sporcata da due `fetch` diagnostiche che l'agente ha
  lanciato fuori dai passi DOPO aver scritto i dati; le ricatture sono identiche al bit fra B, C e la
  cattura del Task 1;
- in 9c fallisce solo la clausola del canvas sulle due pagine in Mode A: in un mondo `?bench` vuoto
  l'elemento resta a 300 × 150 finché il render worker non presenta un frame (era l'aspettativa a essere
  sbagliata; vedi la skill gpu-check §7). Tutte le altre aspettative passano.
