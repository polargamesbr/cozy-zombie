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
    navgrid.ts            flow field (Dijkstra) para os zumbis
  entities/
    characterModel.ts     rig chibi procedural (partes pivotadas nas juntas) + ragdoll + blend para levantar
    player.ts             movimento, esquiva, armas, recarga, animação procedural, dano
    zombie.ts             IA (vagar/perseguir/antecipar/investir/cambalear/derrubado/levantar), morte
    combat.ts             hitscan: pellets, acúmulo por zumbi, reações por superfície, juice global
    weapons.ts            definições das armas + malhas das armas
    pickup.ts             munição e torta
  fx/
    particles.ts          billboards instanciados (atlas), gotas, blobs de fogo/fumaça
    decals.ts             manchas de sangue, furos de bala, queimados (instanciados, somem com o tempo)
    debris.ts             pedaços que quicam e somem (tábuas, cacos, cartuchos, gibs)
    leaves.ts             folhas que flutuam, pousam e somem
    effects.ts            receitas de juice (poeira, faíscas, muzzle, sangue, explosão, respingo…)
  audio/sfx.ts            todos os sons sintetizados em WebAudio
  ui/                     HUD, overlay (título/pausa/morte), ícones SVG desenhados à mão
  debug/testApi.ts        window.__game (automação e screenshots)
```

## Renderização

- `MeshToonMaterial` com rampa própria (sombra → meio → luz com bordas suaves). A maior parte do
  cenário estático é **mesclada** com `GeoBuilder` (uma malha por material, cor por vértice).
- Vento: `addWind()` injeta balanço no vertex shader (árvores, arbustos, flores). A grama tem um
  shader próprio que também recebe até 10 "empurradores" (jogador/zumbis) e a rajada de explosões.
- Personagens: 3 draw calls por junta (malha, contorno por casco invertido, silhueta X-ray). A
  silhueta usa stencil: o corpo visível escreve 1; o X-ray desenha só onde está oculto (`GreaterDepth`) e o stencil ≠ 1.
- Pós: `RenderPass` (MSAA 4x, HalfFloat, stencil) → bloom com threshold alto (só HDR: muzzle,
  lâmpadas, fogo) → grade (tinta quente, saturação, vinheta, flash e vermelho de dano) → `OutputPass`
  (Neutral tone mapping + sRGB).

## Física

- **Passo fixo de 120 Hz** com acumulador; o tempo de jogo é escalado por hit stop/slow-mo.
- **Ragdoll Verlet**: cabeça, ombros, quadris, mãos e pés; torso rígido (6 vínculos), cabeça
  presa nos ombros, membros de um segmento, limites suaves. Atrito de derrapagem proporcional à
  massa apoiada, amortecimento de rolamento, restituição baixa ("thud"), impactos reportados para
  efeitos. Colide com chão, colisores estáticos (quebrando os quebráveis), props, personagens
  vivos (efeito boliche) e outros ragdolls. Dorme quando para.
- **Corpos rígidos** (props): impulsos sequenciais contra chão/estáticos com pontos amostrados
  (cantos de caixa, ponto mais baixo analítico do aro de cilindros → rolamento correto).
- **Personagens vivos**: círculos no plano XZ empurrados para fora dos estáticos, lago e limites.
- Balas: `PhysicsWorld.raycast` testa chão, estáticos, props, partículas de ragdolls e cápsulas
  de personagens (com esfera de cabeça para headshot).

## Tempo e juice

`Game.hitstop(s)` congela o mundo (escala 0.03) mantendo câmera/shake em tempo real.
`Game.slowmo(escala, s)` para a morte do jogador. `Game.explode()` centraliza efeitos, dano,
impulsos, reação de cenário, rajada na grama e barulho.

## Testes e QA visual

- `npm test` — Vitest (física do ragdoll: voo + derrapagem curta, repouso, desencaixe suave).
- `npm run typecheck` — TypeScript estrito.
- `npm run build && npm run shots -- overview combat explosion` — abre o jogo no Chromium
  headless (SwiftShader) em `?test` (tempo manual e seed fixa) e salva screenshots em `shots/`.
  Cenários disponíveis em `scripts/shots.mjs` (overview, wide, barn, pond, closeup, combat,
  explosion, chase, title, pick).
- `window.__game` (em qualquer modo): `advance(s)`, `teleport(x,z)`, `aim(x,z)`, `fire()`,
  `spawn(tipo,x,z)`, `explode(x,z)`, `camera({yaw,zoom})`, `pick(px,py)`, `state()`…

## Como adicionar conteúdo

- **Novo prop físico**: estenda `Prop` (`world/props.ts`), crie a malha centrada no centro de
  massa, escolha `Shape` e massa; sobrescreva `hitFx`, `fragile`, `breakApart` se quebrar.
- **Novo objeto reativo estático**: crie um `StaticCollider` com um `HitReceiver`
  (`onBulletHit`, `onImpact` → retorne `true` se quebrou, `onBlast`) e registre em `farm.ts`.
- **Nova cor**: adicione em `palette.ts` e use a chave (nunca hex solto em código novo de cenário).
- **Novo tipo de zumbi**: adicione em `ZDEFS` e `styleFor()` (`entities/zombie.ts`).
