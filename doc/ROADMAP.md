# Roadmap

Estado atual e próximos passos. Cada iteração deve manter o jogo jogável, com screenshots de QA
(`npm run shots`) e `npm test`/`npm run typecheck` verdes.

## v0.1 — Protótipo da fazenda ✅

- [x] Base Vite + TypeScript + Three.js, pipeline de render com toon shading, bloom HDR e grade quente
- [x] Câmera 2.5D orbital (Q/E, botão direito), zoom, look-ahead, shake, kick, punch de FOV
- [x] Fazenda: casa com varanda e porta, celeiro, estrada, lago, cercas, caminhonete, árvores, horta, varal, decoração
- [x] Grama instanciada que balança e reage a personagens/explosões; flores, juncos, floresta ao redor
- [x] Jogador chibi com animação procedural, esquiva, pistola e espingarda, recarga
- [x] Zumbis (shambler, runner, brute) com flow field, antecipação de ataque, cambaleio, derrubada e levantar
- [x] Ragdoll Verlet estilizado: voa, gira, quebra cercas, desliza com rastro de sangue, cabeça pode voar
- [x] Props físicos (caixas, barris, latas, vasos, cadeiras, abóboras, feno) e botijões explosivos em cadeia
- [x] Sangue estilizado (gotas → manchas que somem), furos de bala, queimados, detritos, cartuchos
- [x] Vida ambiente: pássaros, borboletas, folhas, fumaça, cortinas, roupas, água, lâmpadas piscando, sombras de nuvens
- [x] Áudio 100% sintetizado (tiros, bomba, impactos, gemidos, pássaros, alarme, vento)
- [x] HUD mínimo + telas de título/pausa/morte
- [x] API de teste + screenshots headless + testes de física + CI

## v0.2 — Rumo ao "AAA estilizado" (ordem recomendada)

1. **Som e música** (maior ganho percebido por esforço)
   - [x] Reverb por convolução com resposta de impulso gerada por código + eco direcional vindo do celeiro/casa
   - [x] Tiros em camadas (estalo + corpo + thump + mecânica + cauda + eco), variação de ±6% por disparo
   - [x] Música procedural: violão (Karplus–Strong) + kalimba em Ré maior que vira Ré menor com bateria e baixo pulsante no combate; vinhetas de vitória e morte
   - [x] Panner HRTF, abafamento de sons atrás de paredes
2. **Luz e pós-processamento**
   - [x] AO suave (GTAO em meia resolução, sem partículas/grama/contornos) + rim light quente nos personagens
   - [x] Névoa baixa ray-marched contra o shadow map do sol (feixes de luz/sombra) + névoa de altura
   - [x] Partículas "soft" (somem suavemente ao cruzar o chão), fumaça iluminada pelo sol
   - [x] Manchas de sangue iluminadas (recebem sombra) e SMAA para bordas limpas; `?low` desliga AO/névoa/MSAA
3. **Animação e reações**
   - [x] Membros com cotovelo/joelho (IK de 2 ossos no ragdoll) e movimento secundário (chapéu, cabelo, mochila) — personagem virou uma `SkinnedMesh` (6 draw calls em vez de ~30)
   - [x] Reações localizadas: tiro na perna → zumbi manca/rasteja; espingarda pode arrancar braço (coto sangrando); chapéu voa
   - [x] Rostos: piscar, susto ao tomar dano, zumbi abrindo a boca antes do ataque
4. **Verbos de combate**
   - [x] Chute/empurrão corpo a corpo (joga zumbis em cercas, no lago, em outros zumbis) — tecla F
   - [x] Dinamite arremessável com arco previsto — segurar/soltar G, quica e rola, contador no HUD
   - [x] Kill-cam em câmera lenta no último zumbi da horda (zoom + barras de cinema)
   - [x] Mortes pelo ambiente: lago (corpos boiam, derrubado se afoga), botijão, caminhonete que pega fogo e explode; rótulos de abate
5. **Inimigos e estrutura**
   - [x] Zumbis que pulam/derrubam cercas (pulo desajeitado; brutos e rastejantes quebram), horda saindo do celeiro com as portas voando (a cada 3 hordas), rastejantes de nascença
   - [x] Um dia na fazenda: tarde → pôr do sol → noite → amanhecer (cada horda avança meio período), hordas automáticas entre fases, consertar cercas (segurar C)
6. **Técnico**
   - [x] 60 fps estáveis: cercas em `BatchedMesh` por trecho, janelas mescladas por prédio, grama em blocos com frustum culling + densidade por nível, 4 níveis de qualidade (padrão Média, ajuste automático), FPS com `I` — draw calls −8 a −13%
   - [x] Suporte a controle com vibração (twin-stick, mira assistida leve, toda tremida de tela vibra o controle)

## Próximos passos (v0.3, sugestão)

- Props dinâmicos em lote (BatchedMesh por material) e árvores/pássaros instanciados
- Pré-compilar shaders (`compileAsync`) numa tela de carregamento para não engasgar no começo
- Arma corpo a corpo (pá), upgrades simples entre hordas, galinhas fugindo
- Opções num menu (volume da música, vibração, sensibilidade da mira assistida)

## Backlog anterior

1. **Polimento visual**
   - [x] Ciclo de tempo do dia opcional (tarde → pôr do sol → noite com vaga-lumes e luzes acesas)
   - [x] Rostos mais expressivos (piscar, susto ao tomar dano)
   - [ ] Pegadas/grama amassada temporária por onde passam corpos
   - [ ] Melhorar leitura dos zumbis no meio da grama alta (contorno mais forte à distância)
2. **Feel**
   - [x] Rumble/vibração em gamepad + suporte a controle
   - [x] Mais variações de reação de acerto (braço arrancado com espingarda)
   - [x] Corpos boiando no lago (afundar parcialmente + respingos)
   - [ ] Latas e cartuchos chutáveis pelo jogador
3. **Mundo interativo**
   - [ ] Janelas que quebram, lâmpada do poste que pode ser apagada a tiro
   - [ ] Galinhas que fogem e cata-vento que gira com explosões
   - [ ] Portas do celeiro abrindo para um interior pequeno
4. **Gameplay**
   - [x] Arremessável (dinamite) · [ ] arma corpo a corpo (pá)
   - [ ] Mais tipos de zumbi (espantalho zumbi, galinha zumbi?)
   - [ ] Progressão curta entre hordas (upgrades simples)
5. **Técnico**
   - [x] Mesclar segmentos de cerca para reduzir draw calls (props dinâmicos ainda separados)
   - [x] Opção de qualidade (sombras/MSAA/bloom) e contador de FPS
   - [ ] Deploy automático (GitHub Pages)
