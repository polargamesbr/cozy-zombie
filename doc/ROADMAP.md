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

## Próximas iterações (backlog priorizado)

1. **Polimento visual**
   - [ ] Ciclo de tempo do dia opcional (tarde → pôr do sol → noite com vaga-lumes e luzes acesas)
   - [ ] Rostos mais expressivos (piscar, susto ao tomar dano)
   - [ ] Pegadas/grama amassada temporária por onde passam corpos
   - [ ] Melhorar leitura dos zumbis no meio da grama alta (contorno mais forte à distância)
2. **Feel**
   - [ ] Rumble/vibração em gamepad + suporte a controle
   - [ ] Mais variações de reação de acerto (braço arrancado com espingarda)
   - [ ] Corpos boiando no lago (afundar parcialmente + respingos)
   - [ ] Latas e cartuchos chutáveis pelo jogador
3. **Mundo interativo**
   - [ ] Janelas que quebram, lâmpada do poste que pode ser apagada a tiro
   - [ ] Galinhas que fogem e cata-vento que gira com explosões
   - [ ] Portas do celeiro abrindo para um interior pequeno
4. **Gameplay**
   - [ ] Arremessável (dinamite) e arma corpo a corpo (pá)
   - [ ] Mais tipos de zumbi (espantalho zumbi, galinha zumbi?)
   - [ ] Progressão curta entre hordas (upgrades simples)
5. **Técnico**
   - [ ] Mesclar segmentos de cerca/props estáticos para reduzir draw calls
   - [ ] Opção de qualidade (sombras/MSAA/bloom) e contador de FPS
   - [ ] Deploy automático (GitHub Pages)
