# Arquitetura técnica

Stack: **TypeScript + Vite + Three.js (WebGL2)**. Nenhuma outra dependência de runtime.
Física, partículas, áudio e toda a arte são implementados no próprio projeto.

```
src/
  main.ts                 entrada: cria o Game e a API de teste
  style.css               HUD e telas (HTML/CSS)
  game/
    Game.ts               orquestra tudo: loop, tempo (hit stop/slow-mo), explosões, hordas
    context.ts            GameCtx: serviços compartilhados entregues a objetos do mundo
  core/                   matemática, RNG determinístico, ruído simplex, input
  render/
    palette.ts            TODA a paleta de cores do jogo
    materials.ts          toon ramp, cache de materiais, vento (vertex shader), contorno
    textures.ts           texturas pintadas em canvas (tábuas, telhas, tijolos, rostos, manchas…)
    geometry.ts           GeoBuilder (merge com vertex colors), blobs, vigas, UV em coordenadas de mundo
    pipeline.ts           renderer + pós (bloom só para HDR, grade quente, vinheta, flash/dano)
    cameraRig.ts          câmera 2.5D orbital com shake por trauma, kick e punch de FOV
    lighting.ts           sol/hemisfério/preenchimento; sombra acompanha a câmera (snap em texel)
  physics/
    colliders.ts          StaticCollider (caixa orientada ou cilindro) + raycasts
    rigid.ts              RigidBody por impulsos (props) com pontos de contato
    ragdoll.ts            ragdoll Verlet de 9 partículas (Jakobsen)
    world.ts              PhysicsWorld: passo fixo 120 Hz, raycast de balas, blast, personagens
  world/
    layout.ts             o mapa como dados (casa, celeiro, caminhos, cercas, spawns…)
    farm.ts               monta o cenário a partir do layout
    ground.ts             chão pintado num canvas 2048² + detalhe + sombras de nuvens
    nature.ts             árvores, arbustos, pedras, grama instanciada que reage, flores, juncos
    buildings.ts          casa e celeiro (porta, lâmpada, cortinas, chaminé, portas do celeiro)
    fences.ts             cercas quebráveis (segmentos com HP)
    props.ts              props físicos: caixas, barris, latas, vasos, cadeiras, abóboras, feno, botijões
    decor.ts              caixa de correio, poste, placa, varal, barreiras, carrinho de mão
    vehicle.ts            caminhonete com suspensão e alarme
    pond.ts               água com shader, vitórias-régias, ondulações
    ambient.ts            pássaros, borboletas, piados
    navgrid.ts            flow field (Dijkstra) para os zumbis; cercas são "caras", não bloqueiam
  entities/
    characterModel.ts     rig chibi em SkinnedMesh (ossos rígidos, cotovelo/joelho), rostos, movimento secundário,
                          partes soltas (chapéu, braço), IK do ragdoll + blend para levantar
    player.ts             movimento, esquiva, armas, recarga, animação procedural, dano
    zombie.ts             IA (vagar/perseguir/antecipar/investir/cambalear/derrubado/levantar), mancar/rastejar,
                          braço arrancado, morte
    combat.ts             hitscan: pellets, acúmulo por zumbi, reações por superfície, juice global; chute
    dynamite.ts           dinamite (voo balístico exato, quica, pavio) + arco previsto (ThrowArc)
    weapons.ts            definições das armas + malhas das armas
    pickup.ts             munição e torta
  fx/
    particles.ts          billboards instanciados (atlas), gotas, blobs de fogo/fumaça
    decals.ts             manchas de sangue, furos de bala, queimados (instanciados, somem com o tempo)
    debris.ts             pedaços que quicam e somem (tábuas, cacos, cartuchos, gibs)
    leaves.ts             folhas que flutuam, pousam e somem
    effects.ts            receitas de juice (poeira, faíscas, muzzle, sangue, explosão, respingo…)
  audio/sfx.ts            todos os sons sintetizados em WebAudio (roteamento: HRTF, abafamento, reverb, eco)
  audio/music.ts          trilha procedural com camadas calma/tensa guiadas pelo perigo
  audio/dsp.ts            DSP puro testável: resposta de impulso, Karplus–Strong, harmonia e melodias
  ui/                     HUD, overlay (título/pausa/morte), ícones SVG desenhados à mão
  debug/testApi.ts        window.__game (automação e screenshots)
```

## Renderização

- `MeshToonMaterial` com rampa própria (sombra → meio → luz com bordas suaves). A maior parte do
  cenário estático é **mesclada** com `GeoBuilder` (uma malha por material, cor por vértice).
- Vento: `addWind()` injeta balanço no vertex shader (árvores, arbustos, flores). A grama tem um
  shader próprio que também recebe até 10 "empurradores" (jogador/zumbis) e a rajada de explosões.
- Personagens: cada um é **uma `SkinnedMesh`** com pesos rígidos (cada vértice preso a um osso:
  tronco, cabeça, chapéu, cabelo, mochila, braço/antebraço, coxa/canela, cotos) + a cabeça
  (malha própria com o rosto pintado). São 6 draw calls por personagem: corpo, contorno (casco
  invertido, só no grupo "contornado" da geometria), silhueta X-ray, e o mesmo para a cabeça. A
  silhueta usa stencil: o corpo visível escreve 1; o X-ray desenha só onde está oculto
  (`GreaterDepth`) e o stencil ≠ 1. Ossos com escala ~0 escondem partes (cotos até o braço sair).
- Rostos: texturas de canvas por expressão (`faceTexture`): neutro, piscando, susto/dor, ataque
  (boca escancarada) e morto; `CharacterModel.express()` troca por um tempo, piscar é automático.
- Movimento secundário: molas amortecidas (`Wobble`) movidas pela aceleração do osso-âncora no
  referencial local (chapéu, cabelo, mochila; recuo e tiros dão um `jiggle`). Partes soltas (chapéu
  que voa, braço arrancado) são ossos reanexados ao mundo com uma simulação simples (quica, gira,
  assenta deitado, encolhe após 20 s).
- Pós: `RenderPass` (MSAA 4x, HalfFloat, stencil) → `GTAOPass` em meia resolução (objetos com
  `userData.noAO` ficam de fora) → `AtmospherePass` (névoa baixa ray-marched contra o shadow map do
  sol, reaproveitando a profundidade do AO; névoa de altura) → bloom com threshold alto (só HDR:
  muzzle, lâmpadas, fogo) → grade (tinta quente, saturação, curva S, vinheta, flash e vermelho de
  dano) → `OutputPass` (Neutral tone mapping + sRGB) → SMAA. `?low` remove AO, atmosfera e MSAA.
- Personagens têm rim light quente (mais forte do lado do sol, `addRim`). Partículas de fumaça são
  iluminadas como pequenas esferas e somem suavemente ao cruzar o chão. Decals usam material toon
  instanciado (recebem luz e sombra como o chão).

## Ciclo do dia

`render/daycycle.ts` guarda quatro "humores" (tarde, pôr do sol, noite, amanhecer) com cor e
direção do sol, hemisfério, preenchimento, névoa/fundo (`Lighting.fogColor`), tinta/saturação/
vinheta do grade, cor e força dos feixes da `AtmospherePass` e o quanto é noite. `apply(t)`
interpola dois vizinhos (t = 0…4, cíclico). `Game` avança `dayTarget` em 0,5 a cada horda limpa
e o relógio anda devagar até lá; à noite acende as janelas (`WINDOW_GLOWS`), o lampião do
jogador (uma `PointLight` que existe sempre, para não recompilar shaders) e solta vaga-lumes.

## Física

- **Passo fixo de 120 Hz** com acumulador; o tempo de jogo é escalado por hit stop/slow-mo.
- **Ragdoll Verlet**: cabeça, ombros, quadris, mãos e pés; torso rígido (6 vínculos), cabeça
  presa nos ombros, membros que podem dobrar (mão/pé entre 50–62% e 100% do comprimento; cotovelo e
  joelho são resolvidos com IK de 2 ossos ao posar), limites suaves. Atrito de derrapagem proporcional à
  massa apoiada, amortecimento de rolamento, restituição baixa ("thud"), impactos reportados para
  efeitos. Colide com chão, colisores estáticos (quebrando os quebráveis), props, personagens
  vivos (efeito boliche) e outros ragdolls. Dorme quando para.
- **Corpos rígidos** (props): impulsos sequenciais contra chão/estáticos com pontos amostrados
  (cantos de caixa, ponto mais baixo analítico do aro de cilindros → rolamento correto).
- **Personagens vivos**: círculos no plano XZ empurrados para fora dos estáticos, lago e limites.
  Colisores `climbable` (cercas) entram no flow field com custo 4× por célula; o zumbi que encosta
  numa cerca (`PhysicsWorld.climbableAt`) entra em `vault` (arco sobre a cerca, sem colisão) ou
  `bash` (brutos/rastejantes: `FenceSegment.bash` até quebrar). `FenceSegment.repair()` a refaz.
- **Água**: `PhysicsWorld.water` (profundidade do lago) faz o chão dos ragdolls afundar no lago;
  partículas submersas recebem arrasto forte e empuxo (`Ragdoll.buoyancy`, que o zumbi zera aos
  poucos para o corpo afundar). Zumbi derrubado que cai na água se afoga.
- Balas: `PhysicsWorld.raycast` testa chão, estáticos, props, partículas de ragdolls e cápsulas
  de personagens (com esfera de cabeça para headshot). `Zombie.classify()` diz a parte atingida
  (cabeça, tronco, perna E/D, braço E/D); `Combat` soma o dano por parte: pernas fazem mancar e
  depois rastejar (hitbox baixa), espingarda de perto arranca braços.

## Áudio

- Cada som passa por `Sfx.out()`: atenuação por distância → (filtro passa-baixa se uma parede
  estiver entre o som e o ouvinte) → `PannerNode` HRTF (direção esquerda/direita, sempre "à
  frente", para não confundir numa câmera de cima) → bus de efeitos. Em paralelo vai um envio
  para o reverb (convolver com IR gerada em `dsp.ts`) e, para sons altos, ecos atrasados pelo
  caminho extra até o celeiro/casa, panoramizados a partir da parede.
- Trilha principal (`soundtrack.ts`): *Harvest Hush* em `public/music/`, tocada num `<audio>` em
  loop (fora do grafo WebAudio: sem decodificar minutos de áudio na memória e sem o silêncio de
  `MediaElementSource` com outra origem). "Mixagem" por volume/velocidade do elemento: abaixa
  um pouco em lutas pesadas, fica lenta e grave na kill-cam, quase some na morte e na pausa.
  Se o arquivo falhar, a música procedural abaixo assume; senão ela só toca as vinhetas.
- Música procedural (`music.ts`): agendador com lookahead de 180 ms em semicolcheias a 86 BPM. Camada
  calma (violão Karplus–Strong renderizado offline, kalimba, baixo, shaker) e camada tensa
  (Ré menor, baixo serrilhado pulsante, bumbo/caixa/chimbal, viradas). `Game` mede o perigo
  (zumbis alertas perto) e chama `setIntensity`; o modo troca na virada do compasso com histerese.

## Tempo e juice

`Game.hitstop(s)` congela o mundo (escala 0.03) mantendo câmera/shake em tempo real.
`Game.slowmo(escala, s)` para a morte do jogador e a kill-cam (último zumbi da horda: câmera
lenta + `CameraRig.focus` puxando para o corpo + barras de cinema via CSS `body.killcam`).
`Game.explode(pos, força, fonte)` centraliza efeitos, dano, impulsos, reação de cenário, rajada
na grama e barulho; a fonte (`propane`/`dynamite`/`truck`) vira o rótulo de abate
(`Game.feat()` → `Hud.feat()`, texto que salta da posição projetada na tela).

## Desempenho e qualidade

`RenderPipeline.setQuality(0..3)` (Ultra/Alta/Média/Baixa) troca escala de resolução
(≤1.75 / ≤1.25 / 1 / 0.75), MSAA, AO + névoa (só Ultra/Alta), bloom (até Média); `Game.applyQuality`
também muda o shadow map (2048/1024) e a densidade da grama (instâncias em ordem aleatória:
basta reduzir `count`). `Game.trackPerf` mede o FPS médio a cada ~2 s (ignorando engasgos
> 250 ms) e desce um nível se ficar < 48; `P` escolhe manualmente (salvo em `localStorage`; o nível automático também é lembrado e o
padrão inicial é Média),
`I` mostra o FPS. O shader da grama usa transposta/escala em vez de `inverse(mat3)` por vértice.

## Testes e QA visual

- `npm test` — Vitest (física do ragdoll: voo + derrapagem curta, repouso, desencaixe suave).
- `npm run typecheck` — TypeScript estrito.
- `npm run build && npm run shots -- overview combat explosion` — abre o jogo no Chromium
  headless (SwiftShader) em `?test` (tempo manual e seed fixa) e salva screenshots em `shots/`.
  Cenários disponíveis em `scripts/shots.mjs` (overview, wide, barn, pond, closeup, combat,
  explosion, chase, title, pick, limbs, crawl, crawlclose, faces, death, dodge, kick, dynamite,
  killcam, truck, fences, barnhorde, daycycle, repair…).
- `window.__game` (em qualquer modo): `advance(s)`, `teleport(x,z)`, `aim(x,z)`, `fire()`,
  `spawn(tipo,x,z)`, `explode(x,z)`, `camera({yaw,zoom})`, `hit(i,parte,dano)`, `tearArm(i,lado)`,
  `express(i,rosto,s)`, `kick()`, `holdThrow(x,z)`/`releaseThrow()`, `day(t)`, `wave(n)`,
  `breakFence(i)`, `pick(px,py)`, `state()`…

## Como adicionar conteúdo

- **Novo prop físico**: estenda `Prop` (`world/props.ts`), crie a malha centrada no centro de
  massa, escolha `Shape` e massa; sobrescreva `hitFx`, `fragile`, `breakApart` se quebrar.
- **Novo objeto reativo estático**: crie um `StaticCollider` com um `HitReceiver`
  (`onBulletHit`, `onImpact` → retorne `true` se quebrou, `onBlast`) e registre em `farm.ts`.
- **Nova cor**: adicione em `palette.ts` e use a chave (nunca hex solto em código novo de cenário).
- **Novo tipo de zumbi**: adicione em `ZDEFS` e `styleFor()` (`entities/zombie.ts`) e na escolha
  de tipos de `Game.spawnWave()`.
