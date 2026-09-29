# Relé

Jogo por turnos e infinito: você roteia pulsos coloridos por uma rede de fios e escreve scripts, numa linguagem própria, para automatizar os padrões ocultos que descobrir.

Esta é a versão **MVP**: um protótipo mínimo para responder uma pergunta — descobrir o padrão e codificá-lo dá prazer?

## Rodando

```bash
npm install
npm run dev      # servidor de desenvolvimento em http://localhost:5173
npm test         # testes da DSL e do motor
npm run build    # checagem de tipos + build de produção em dist/
```

## Como jogar

- Pulsos entram pelas portas **P1–P3** e andam uma casa por turno. Cada um deve chegar à saída da sua cor; ruído (cinza) vai para o **TERRA**.
- Na **coluna de decisão** o pulso segue para o destino escolhido. Sem destino, cai no terra e é perdido.
- Pulsos **velados** (`?`) escondem a cor, mas ela segue uma regra oculta. A tabela *Pulsos revelados* mostra a cor real depois da entrega.
- Você tem **2 ações por turno** para definir destinos à mão. O **Classificador** automatiza o resto.
- Saída errada: −1 de integridade. Ruído numa saída: −2. Integridade zero encerra a partida.

| Tecla | Ação |
| --- | --- |
| `Espaço` / `Enter` | Encerrar o turno |
| `Tab` / `Shift+Tab` | Selecionar pulso |
| `1`–`5` | Enviar o pulso selecionado para a saída daquela linha |
| `Esc` | Pausar |
| `H` | Ajuda |
| `Ctrl+Enter` (no editor) | Aplicar o script |
| `Ctrl+Shift+Enter` (no editor) | Testar o script na bancada |

## A linguagem

```
box classificar(p, hist):
    if p.cor == GRAY:
        return TERRA
    const ciclo = [RED, BLUE, BLUE]
    return saida(p.cor ?? ciclo[p.seq % 3])
```

- Estrutura do Python (indentação, `if/elif/else`, `and/or/not`) com partes do JavaScript (`let`, `const`, `??`).
- `p.cor` (ou `None` se velado), `p.porta`, `p.seq`, `p.turno`.
- Retornos: `saida(COR)`, `TERRA` ou `MANUAL`.
- Limites: 50 operações por chamada, 60 de energia por turno, o chip custa 1 por turno.
- `hist`, `for`, `=>` e `match` existem no design, mas estão bloqueados (mostram o preço em PP).

## Escopo do MVP

Implementado, conforme o documento conceitual:

- Modo **fácil** (sem banco de tempo, bancada de testes livre, mudança de regime anunciada).
- Grade 5 × 5, portas 1–3, saídas RED/GREEN/BLUE/YELLOW e terra.
- Uma peça de padrão por regime: **ciclo** (`cor = ciclo[seq % n]`) ou **por porta**.
- Pulsos velados e ruído.
- Só a caixa **Classificador**; o roteamento até o destino é automático.
- Diretor adaptativo por onda (25 turnos), com níveis 0–5.
- Recorde e histórico do modo, bagagem (o Classificador segue para a próxima partida) e regra de partida abandonada.

Fora do MVP, por decisão de escopo: modos médio e difícil, banco de tempo, Roteador/Previsor/Vigia/Aprendiz, sensores, `mem`, pesquisa (PP) e desbloqueios, combinação de várias peças de padrão, mutação da grade e colisões entre pulsos.

## Estrutura

```
src/
  dsl/     lexer, parser, interpretador e valores da linguagem
  game/    motor de turnos, tabuleiro, padrões, diretor, bancada de testes
  ui/      interface: Canvas do tabuleiro, editor, armazenamento local
  core/    cores e gerador pseudoaleatório com semente
tests/     testes da DSL e do motor (Vitest)
```

## Deploy

O projeto é um site estático do Vite: na Vercel, importe o repositório e mantenha o preset **Vite** (build `npm run build`, saída `dist`). O MVP não precisa de funções de servidor; os dados ficam no `localStorage` do navegador.
