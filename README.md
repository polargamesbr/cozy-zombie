# Cozy Zombie

Protótipo de um jogo de zumbis **top-down 2.5D** com visual *cozy*: uma pequena fazenda ao
entardecer, cheia de detalhes vivos, que vira um caos físico e exagerado quando os zumbis
aparecem. **Todos os gráficos, efeitos e sons são gerados por código** — não há sprites,
modelos, texturas ou áudios externos.

## Rodando

```bash
npm install
npm run dev        # abre em http://localhost:5173
```

Outros scripts:

| Script | O que faz |
| --- | --- |
| `npm run build` | build de produção em `dist/` |
| `npm run preview` | serve o build |
| `npm run typecheck` | TypeScript estrito |
| `npm test` | testes (Vitest) da física |
| `npm run shots -- overview combat` | screenshots automáticos (Chromium headless) em `shots/` |

## Controles

WASD andar · mouse mira/atira · Espaço rola · R recarrega · 1/2 troca arma · F chuta ·
G (segurar/soltar) dinamite · Q/E (ou botão direito) gira a câmera · roda dá zoom · M som ·
P qualidade · I mostra FPS · Esc pausa · N chama a próxima horda na hora.

A qualidade gráfica começa em "Alta" e cai sozinha (Média → Baixa) se o FPS ficar abaixo de ~48;
escolher com `P` desliga o ajuste automático e fica salvo. `?low` força Baixa, `?ultra` força Ultra.

## Documentação

- [`doc/GDD.md`](doc/GDD.md) — visão, direção de arte, gameplay, juice
- [`doc/ARQUITETURA.md`](doc/ARQUITETURA.md) — organização do código, física, render, testes
- [`doc/ROADMAP.md`](doc/ROADMAP.md) — o que já existe e os próximos passos
