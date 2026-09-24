export type OverlayMode = 'title' | 'pause' | 'dead' | 'none';

const CONTROLS = `
  <div class="controls">
    <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>andar</span></div>
    <div><kbd>Mouse</kbd><span>mirar · clique atira</span></div>
    <div><kbd>Espaço</kbd><span>rolar / esquivar</span></div>
    <div><kbd>R</kbd><span>recarregar</span> <kbd>F</kbd><span>chutar</span></div>
    <div><kbd>G</kbd><span>segure: mirar dinamite · solte: arremessa</span></div>
    <div><kbd>1</kbd><kbd>2</kbd><span>pistola · espingarda</span></div>
    <div><kbd>Q</kbd><kbd>E</kbd><span>girar câmera (ou botão direito)</span></div>
    <div><kbd>Roda</kbd><span>zoom</span></div>
    <div><kbd>M</kbd><span>som</span> <kbd>P</kbd><span>qualidade</span> <kbd>Esc</kbd><span>pausa</span></div>
  </div>`;

/** Title / pause / game-over cards, all HTML+CSS. */
export class Overlay {
  readonly root: HTMLDivElement;
  mode: OverlayMode = 'none';
  onAction: ((mode: OverlayMode) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'overlay';
    parent.appendChild(this.root);
    this.root.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.card-ignore')) return;
      if (this.mode !== 'none') this.onAction?.(this.mode);
    });
  }

  show(mode: OverlayMode, extra = ''): void {
    this.mode = mode;
    this.root.className = `overlay ${mode === 'none' ? '' : 'visible'} mode-${mode}`;
    if (mode === 'title') {
      this.root.innerHTML = `
        <div class="card title-card">
          <div class="logo"><span class="logo-cozy">Cozy</span><span class="logo-zombie">Zombie</span></div>
          <p class="tagline">Uma tarde tranquila na fazenda… quase.</p>
          ${CONTROLS}
          <div class="cta">Clique para começar</div>
        </div>`;
    } else if (mode === 'pause') {
      this.root.innerHTML = `
        <div class="card">
          <h2>Pausa</h2>
          ${CONTROLS}
          <div class="cta">Clique para continuar</div>
        </div>`;
    } else if (mode === 'dead') {
      this.root.innerHTML = `
        <div class="card dead-card">
          <h2>Você foi mordido!</h2>
          <p class="tagline">${extra || 'A fazenda ainda precisa de você.'}</p>
          <div class="cta">Clique para tentar de novo</div>
        </div>`;
    } else {
      this.root.innerHTML = '';
    }
  }
}
