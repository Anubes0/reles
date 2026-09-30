import { BOX_INFO, type BoxId } from '../game/boxes';
import { MODE_IDS, MODES, type ModeId } from '../game/mode';
import { RESEARCH, type ResearchId } from '../game/research';
import { el } from './dom';
import type { MatchRecord } from './storage';

type Child = Node | string | null | false;

function button(label: string, onClick: () => void, cls = '', autofocus = false): HTMLButtonElement {
  const b = el('button', { type: 'button', class: cls }, label);
  if (autofocus) b.setAttribute('data-autofocus', '');
  b.addEventListener('click', onClick);
  return b;
}

function keys(combo: string, what: string): Node[] {
  const parts = combo.split('+').flatMap((k, i) => (i ? ['+', el('kbd', {}, k)] : [el('kbd', {}, k)]));
  return [el('dt', {}, ...parts), el('dd', {}, what)];
}

export function helpContent(onClose: () => void): Child[] {
  return [
    el('h2', {}, 'Relé — como jogar'),
    el('ul', {},
      el('li', {}, 'Pulsos entram pelas portas à esquerda e andam uma casa por turno. Cada um deve sair pela saída da sua cor, à direita; ruído (cinza) vai para o TERRA.'),
      el('li', {}, 'Nas colunas de relés (◆), o pulso segue a seta. Clique num relé para girá-lo (1 ação); a seta vale para todos que passarem depois.'),
      el('li', {}, 'O Classificador decide o destino; o Roteador decide as setas. Previsor, Vigia e Aprendiz saem na Pesquisa, comprada com os pontos das partidas.'),
      el('li', {}, 'Pulsos velados (?) escondem a cor, mas ela segue uma regra oculta: porta, carga (pontinhos), forma e o pulso anterior. Use a aba Sinais.'),
      el('li', {}, 'Pulso parado forma fila; dois pulsos entrando na mesma casa colidem (−1 cada). Saída errada: −1. Ruído numa saída: −2.'),
      el('li', {}, 'Três modos: no médio e no difícil há banco de tempo, as saídas apagam e a troca de regime quase não avisa. Recorde, pesquisa e bagagem são separados por modo.'),
      el('li', {}, 'A partida fica salva neste navegador: pode fechar a aba e voltar depois. Trocar de janela pausa o banco de tempo.'),
    ),
    el('h3', {}, 'Atalhos'),
    el('dl', { class: 'help-keys' },
      ...keys('Espaço', 'encerrar o turno'),
      ...keys('Tab', 'selecionar o próximo pulso'),
      ...keys('1–9, 0', 'enviar o pulso selecionado a uma saída de cor (T: terra)'),
      ...keys('S', 'segurar o pulso selecionado por 1 turno'),
      ...keys('Clique', 'girar um relé (Shift+clique ou botão direito: ao contrário)'),
      ...keys('E', 'ir para o editor · P: pesquisa · H: ajuda'),
      ...keys('Esc', 'pausar (no editor: sair dele)'),
      ...keys('Ctrl+Enter', 'aplicar o script · Ctrl+Shift+Enter: testar'),
    ),
    el('div', { class: 'actions' }, button('Jogar', onClose, 'primary', true)),
  ];
}

/** Motivo de uma pausa que não foi pedida pelo jogador (alerta do Vigia, partida retomada). */
export interface PauseNote {
  title: string;
  text: string;
}

export function pauseContent(note: PauseNote | null, hasBank: boolean, onClose: () => void): Child[] {
  return [
    el('div', { class: 'pause-screen' },
      el('h2', {}, note ? note.title : 'Pausado'),
      note ? el('p', {}, note.text) : null,
      el('p', { class: 'muted' }, `${hasBank ? 'O banco de tempo fica congelado. ' : ''}Pressione Esc para voltar.`),
      el('div', { class: 'actions' }, button('Voltar', onClose, 'primary', true)),
    ),
  ];
}

export interface ModeCardInfo {
  record: number;
  points: number;
}

/** Escolha do modo para a próxima partida. Sem `onCancel` (partida encerrada), só dá para começar. */
export function modeContent(
  current: ModeId,
  inProgress: boolean,
  info: Record<ModeId, ModeCardInfo>,
  onStart: (mode: ModeId) => void,
  onCancel: (() => void) | null,
): Child[] {
  let chosen = current;
  const cards = MODE_IDS.map((id) => {
    const m = MODES[id];
    const card = el('button', { type: 'button', class: 'mode-card', 'aria-pressed': String(id === chosen) },
      el('strong', {}, m.label),
      el('span', { class: 'desc' }, m.summary),
      el('span', { class: 'meta' }, `recorde ${info[id].record} · ${info[id].points} PP · bagagem ${m.baggageLimit}`),
    );
    card.addEventListener('click', () => {
      chosen = id;
      for (const c of cards) c.setAttribute('aria-pressed', String(c === card));
    });
    card.addEventListener('dblclick', () => onStart(id));
    return card;
  });
  return [
    el('h2', {}, 'Nova partida'),
    el('p', { class: 'muted' }, 'Escolha o modo. Recorde, pontos de pesquisa, desbloqueios e bagagem são separados por modo.'),
    el('div', { class: 'mode-cards' }, ...cards),
    inProgress ? el('p', { class: 'muted' }, 'Só existe uma partida por vez: começar outra abandona a atual (os pontos só contam se forem maiores que 0, e nada mais vem dela).') : null,
    el('div', { class: 'actions' },
      onCancel ? button(inProgress ? 'Continuar a atual' : 'Cancelar', onCancel, 'ghost') : null,
      button('Começar', () => onStart(chosen), 'primary', true),
    ),
  ];
}

/** Loja de pesquisa do modo. */
export function researchContent(
  mode: ModeId,
  points: number,
  unlocked: ReadonlySet<ResearchId>,
  onBuy: (id: ResearchId, price: number) => void,
  onClose: () => void,
): Child[] {
  const items = RESEARCH.map((item) => {
    const owned = unlocked.has(item.id);
    const needs = item.requer && !unlocked.has(item.requer) ? RESEARCH.find((r) => r.id === item.requer)!.nome : null;
    const action = owned
      ? el('span', { class: 'owned-tag' }, 'liberado')
      : button(`${item.preco} PP`, () => onBuy(item.id, item.preco), points >= item.preco && !needs ? 'primary' : '');
    if (!owned && (points < item.preco || needs)) (action as HTMLButtonElement).disabled = true;
    return el('li', { class: owned ? 'owned' : '' },
      el('span', { class: 'name' }, item.nome),
      action,
      el('span', { class: 'what' }, item.libera, needs ? ` · requer ${needs}` : ''),
    );
  });
  return [
    el('h2', {}, `Pesquisa · ${MODES[mode].label}`),
    el('p', {}, el('strong', {}, `${points} PP`), el('span', { class: 'muted' }, ' — cada partida terminada rende 1 PP a cada 100 pontos. O que se compra aqui vale só neste modo.')),
    el('ul', { class: 'research-list' }, ...items),
    el('div', { class: 'actions' }, button('Fechar', onClose, 'primary', true)),
  ];
}

/** Evolução no modo: as últimas partidas, com um gráfico de pontos. */
export function historyContent(mode: ModeId, records: MatchRecord[], onClose: () => void): Child[] {
  const finished = records.filter((r) => !r.abandoned);
  const rows = [...records].reverse().map((r) =>
    el('tr', { class: r.abandoned ? 'abandoned' : '' },
      el('td', {}, new Date(r.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })),
      el('td', {}, String(r.score)),
      el('td', {}, String(r.turns)),
      el('td', {}, r.precision === null ? '—' : `${Math.round(r.precision * 100)}%`),
      el('td', {}, r.maxLevel === undefined ? '—' : String(r.maxLevel)),
      el('td', {}, r.regimes === undefined ? '—' : String(r.regimes)),
      el('td', {}, r.avgTurnSeconds === undefined ? '—' : `${r.avgTurnSeconds.toFixed(1)} s`),
      el('td', {}, r.abandoned ? 'abandonada' : ''),
    ),
  );
  return [
    el('h2', {}, `Histórico · ${MODES[mode].label}`),
    records.length === 0
      ? el('p', { class: 'muted' }, 'Nenhuma partida registrada neste modo ainda.')
      : el('div', {},
          finished.length > 1 ? sparkline(finished.map((r) => r.score)) : null,
          el('table', { class: 'history-table' },
            el('thead', {}, el('tr', {}, ...['data', 'pontos', 'turnos', 'precisão', 'nível', 'regimes', 'tempo/turno', ''].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...rows),
          ),
        ),
    el('div', { class: 'actions' }, button('Fechar', onClose, 'primary', true)),
  ];
}

function sparkline(values: number[]): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const w = 560;
  const h = 70;
  const max = Math.max(...values, 1);
  const x = (i: number) => 10 + (i * (w - 20)) / Math.max(1, values.length - 1);
  const y = (v: number) => h - 10 - (v / max) * (h - 20);
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Pontos das últimas ${values.length} partidas terminadas`);
  const axis = document.createElementNS(ns, 'line');
  Object.entries({ x1: 10, x2: w - 10, y1: h - 10, y2: h - 10, class: 'axis' }).forEach(([k, v]) => axis.setAttribute(k, String(v)));
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('class', 'line');
  line.setAttribute('points', values.map((v, i) => `${x(i)},${y(v)}`).join(' '));
  svg.append(axis, line);
  values.forEach((v, i) => {
    const dot = document.createElementNS(ns, 'circle');
    Object.entries({ cx: x(i), cy: y(v), r: 3, class: 'dot' }).forEach(([k, val]) => dot.setAttribute(k, String(val)));
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${v} pontos`;
    dot.append(title);
    svg.append(dot);
  });
  return svg;
}

export interface OverSummary {
  score: number;
  turns: number;
  precision: number | null;
  acertos: number;
  maxLevel: number;
  regimes: string[];
  pp: number;
  efficiencyPoints: number;
  predictions: { feitas: number; acertos: number };
}

/** Fim de partida: resumo, regras reveladas e a escolha da bagagem. */
export function overContent(
  mode: ModeId,
  s: OverSummary,
  isRecord: boolean,
  record: number,
  installed: BoxId[],
  onConfirm: (carry: BoxId[]) => void,
): Child[] {
  const limit = MODES[mode].baggageLimit;
  const precision = s.precision === null ? '—' : `${Math.round(s.precision * 100)}%`;
  const stat = (label: string, value: string) => el('div', {}, el('dt', {}, label), el('dd', {}, value));
  const boxes = installed.map((box, i) => {
    const input = el('input', { type: 'checkbox', value: box });
    input.checked = i < limit;
    return { box, input };
  });
  const enforceLimit = () => {
    const chosen = boxes.filter((b) => b.input.checked).length;
    for (const b of boxes) b.input.disabled = !b.input.checked && chosen >= limit;
  };
  for (const b of boxes) b.input.addEventListener('change', enforceLimit);
  enforceLimit();
  const extras = [
    s.efficiencyPoints > 0 ? `${s.efficiencyPoints} de eficiência` : null,
    s.predictions.feitas > 0 ? `Previsor: ${s.predictions.acertos}/${s.predictions.feitas}` : null,
  ].filter(Boolean);

  return [
    el('h2', {}, `Fim de partida · ${MODES[mode].label}`),
    el('p', { class: 'big' }, String(s.score)),
    isRecord ? el('p', { class: 'record' }, 'Novo recorde neste modo!') : el('p', { class: 'muted' }, `Recorde: ${record}`),
    el('dl', { class: 'summary-grid' },
      stat('Turnos', String(s.turns)),
      stat('Precisão', precision),
      stat('Nível máx.', String(s.maxLevel)),
      stat('Pesquisa', `+${s.pp} PP`),
    ),
    extras.length ? el('p', { class: 'muted' }, extras.join(' · ')) : null,
    el('h3', {}, 'As regras desta partida'),
    el('ol', { class: 'regimes' }, ...s.regimes.map((r) => el('li', {}, r))),
    el('h3', {}, `Bagagem: até ${limit} ${limit === 1 ? 'caixa' : 'caixas'}`),
    installed.length === 0
      ? el('p', { class: 'muted' }, 'Nenhuma caixa instalada: nada segue para a próxima partida.')
      : el('div', { class: 'baggage' },
          ...boxes.map(({ box, input }) => el('label', {}, input, `${BOX_INFO[box].label} `, el('code', {}, BOX_INFO[box].signature))),
          el('p', { class: 'muted' }, 'O que não for levado é apagado, sem cópia para depois.'),
        ),
    el('div', { class: 'actions' },
      button('Levar e começar outra', () => onConfirm(boxes.filter((b) => b.input.checked).map((b) => b.box)), 'primary', true),
    ),
  ];
}
