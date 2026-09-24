# Cozy Zombie — Documento de Design

> Uma tarde tranquila na fazenda… quase.

## Visão

Um jogo de zumbis **top-down 2.5D** com direção visual **cozy**: cenário limpo, formas
arredondadas, cores suaves e luz quente de fim de tarde. O diferencial é o **contraste**: o
mundo parece aconchegante e tranquilo, mas o combate é físico, exagerado e extremamente
satisfatório de assistir.

- Quando não há combate → vontade de explorar e ficar no lugar.
- Quando o combate começa → cada tiro tem peso, cada zumbi voa, o cenário reage.

**Tudo é gerado por código**: geometria, texturas (Canvas), personagens, efeitos, interface
e até os sons (WebAudio). Não existe nenhum asset gráfico ou sonoro externo no projeto.

## Direção de arte

| Pilar | Como é aplicado |
| --- | --- |
| Cozy / cartoon | Toon shading com rampa suave de 3 tons, formas arredondadas (`RoundedBox`, cápsulas, blobs com ruído) |
| Paleta harmoniosa | Tudo sai de `src/render/palette.ts` (verdes sálvia, cremes, terracota, vermelho-celeiro, pastéis) |
| Luz quente | Sol baixo de fim de tarde vindo do sudoeste, céu lavanda no preenchimento, névoa pêssego |
| Sombras macias | Shadow map PCF com raio, sombras de contato (blob) sob personagens e AO pintado no chão |
| Cenário respira | Poucos objetos, agrupados; grande área livre de grama entre casa, celeiro e estrada |
| Silhuetas claras | Personagens chibi (cabeça grande), contorno invertido escuro, silhueta X-ray atrás de paredes |
| Pouca poluição | Efeitos rápidos que somem; manchas desaparecem depois de ~40 s; corpos afundam após ~30 s |

### Personagens

- **Fazendeiro(a)** (jogador): boné vermelho, jaqueta mostarda, calça jeans, mochila verde.
- **Shambler**: zumbi comum, pele menta, camisa lavanda/azul/cáqui, cabelo musgo, braços estendidos.
- **Runner**: menor e rápido, moletom com capuz vermelho, braços balançando.
- **Brute**: grande, barrigudo, macacão jeans e chapéu de palha; lento, aguenta muito, derruba 2 corações.

Olhos pintados por código em textura (canvas) — zumbis ganham olhos em "X" ao morrer.

## Mapa (protótipo)

Uma pequena fazenda de ~62 × 48 m (`src/world/layout.ts`):

- Casa com varanda, porta que abre sozinha, janelas iluminadas com cortinas, chaminé fumegando, lâmpada balançando.
- Quintal com cerca branca (quebrável), horta de repolhos, canteiros de flores, vasos.
- Celeiro vermelho com portas que balançam, cata-vento, fardos de feno, caixas, barris e botijões de gás.
- Plantação de abóboras, carrinho de mão, caminhonete pastel com alarme.
- Estrada asfaltada com caixa de correio, poste antigo e placa pendurada "Fazenda Recanto Feliz".
- Lago com vitórias-régias, juncos e ondulações; varal com roupas ao vento.
- Moldura de floresta e colinas fora da área jogável.

## Gameplay

- Movimento WASD relativo à câmera, rolamento com invencibilidade (Espaço/Shift).
- Mira no mouse; o tiro sai na altura da arma, mas "gruda" em alvos baixos/altos sob o cursor (latas, abóboras, cabeças,
  pernas e zumbis rastejando).
- **Pistola**: 8 balas, rápida, precisa, knockback moderado.
- **Espingarda**: 6 cartuchos, recarga cartucho a cartucho (interrompível), 11 bagos em cone,
  queda de dano com a distância. De perto arremessa zumbis longe.
- Zumbis vagam perto do celeiro, percebem o jogador por proximidade ou **barulho de tiro**
  (raio de 22–32 m) e perseguem usando um *flow field* que contorna casa, cercas e celeiro.
- Ataque com antecipação (braços sobem, cotovelos armados, boca escancarada), investida e recuperação — dá para esquivar.
- **Dano localizado**: tiro na perna faz o zumbi mancar; mais dano nas pernas (ou espingarda nelas)
  derruba e ele passa a **rastejar** (lento, baixo, difícil de acertar). Espingarda de perto pode
  **arrancar um braço** (o coto sangra, o braço quica no chão). Chapéus voam em headshots e mortes.
- Objetivo: limpar a fazenda (5 zumbis). Depois, `N` chama hordas maiores.
- Pickups: munição em caixas quebradas, torta (+2 corações) ao limpar a fazenda.

## Feel & Juice

Ao atirar:
muzzle flash em estrela + luz pontual, recoil da arma e dos braços, squash do corpo, recuo do
personagem, screen shake por trauma, *kick* direcional da câmera, punch de FOV (espingarda),
**hit stop** ao acertar (maior no abate), fumaça, faíscas, cartuchos ejetados que quicam e
tilintam, poeira no chão, rajada que deita a grama, pássaros fugindo.

Ao acertar zumbis:
flash branco, sangue estilizado (gotas que viram manchas), névoa vermelha, knockback,
cambaleio; no abate vira **ragdoll** Verlet que dobra o corpo, voa, gira, bate em cercas
(e as quebra), cai, desliza deixando rastro. Espingarda à queima-roupa pode arrancar a cabeça
(estilizado, com "fonte" de sangue). Explosões lançam vários corpos e derrubam os sobreviventes,
que se levantam depois. Rostos reagem: piscam, fazem careta (> <) ao tomar dano e ficam com X
nos olhos ao morrer.

Mundo reativo:
caixas e vasos quebram, cercas quebram em pedaços, cadeiras/latas/barris/abóboras são corpos
físicos, portas balançam, placa e lâmpadas balançam, árvores sacodem e soltam folhas,
caminhonete balança e dispara o alarme, a caixa de correio solta cartas, botijões vazam,
giram e explodem (reação em cadeia).

Vida ambiente:
árvores e grama balançando, folhas caindo, fumaça na chaminé, borboletas, pássaros que
ciscam e fogem, cortinas e roupas ao vento, água com brilho e ondulações, lâmpadas que piscam,
sombras de nuvens deslizando no chão.

## HUD

Mínimo: corações (canto superior esquerdo), arma + munição `6 / 24` (inferior direito),
objetivo pequeno (superior direito) e uma mira própria que abre com o recuo, mostra
marcador de acerto e anel de recarga.

## Controles

| Tecla | Ação |
| --- | --- |
| WASD / setas | andar |
| Mouse | mirar · clique atira (segurar = automático) |
| Espaço / Shift | rolar (esquiva) |
| R | recarregar |
| 1 / 2 / Tab | pistola / espingarda / alternar |
| Q / E ou botão direito arrastando | girar a câmera |
| Roda do mouse | zoom |
| M | som liga/desliga |
| Esc | pausa |
| N | nova horda |
