# Relé

Jogo por turnos e infinito: você roteia pulsos coloridos por uma rede de fios e relés e escreve scripts, numa linguagem própria, para automatizar os padrões ocultos que descobrir.

## Rodando

```bash
npm install
npm run dev      # servidor de desenvolvimento em http://localhost:5173
npm test         # testes da DSL e do motor
npm run build    # checagem de tipos + build de produção em dist/
```

## Como jogar

- A grade tem **15 × 15** casas. Pulsos entram pelas **portas** à esquerda (até 10) e andam uma casa por turno. Cada um deve sair pela **saída da sua cor** à direita (até 10 cores); ruído (cinza) vai para o **TERRA**.
- Nas quatro **colunas de relés** (◆), o pulso segue a seta do relé (▲ ► ▼). A seta persiste para quem passar depois.
- Pulsos **velados** (`?`) escondem a cor, mas ela segue uma **regra oculta**, que pode usar o número de sequência, a porta, a **carga** (1–3, os pontinhos), a **forma** (círculo, quadrado, triângulo) e o pulso anterior. A aba **Sinais** mostra a sequência com linhas por porta, carga ou forma e agrupamento por `seq % k`.
- Você tem **2 ações por turno**: definir o destino de um pulso, girar um relé ou segurar um pulso por 1 turno. O resto se automatiza com as duas caixas programáveis.
- **Filas e colisões:** quem vai para uma casa com pulso parado espera atrás. Dois pulsos entrando na mesma casa colidem (−1 de integridade cada). No barramento vertical, pulsos em sentidos opostos se cruzam.
- Saída errada: −1. Ruído numa saída: −2. Sem destino na 2ª coluna de relés, o pulso vai ao terra. Depois de 60 turnos na grade, queima.
- O **diretor** sobe do nível 0 ao 10: mais portas, mais cores, regras combinadas, fios rompidos a cada onda e saídas que trocam de cor.

| Tecla | Ação |
| --- | --- |
| `Espaço` / `Enter` | Encerrar o turno |
| `Tab` / `Shift+Tab` | Selecionar pulso |
| `1`–`9`, `0` / `T` | Enviar o pulso selecionado a uma saída de cor / ao terra |
| `S` | Segurar o pulso selecionado por 1 turno |
| Clique no relé | Girar (Shift+clique ou botão direito: ao contrário) |
| `E` | Ir para o editor |
| `Esc` | Pausar (no editor: sair dele) |
| `H` | Ajuda |
| `Ctrl+Enter` / `Ctrl+Shift+Enter` (no editor) | Aplicar / testar o script |
| `Ctrl+Espaço` (no editor) | Sugestões |

## A linguagem

Duas caixas, cada uma com assinatura fixa:

```
box classificar(p, hist):          # decide o destino de cada pulso que entra
    if p.cor == GRAY:
        return TERRA
    if len(hist) > 0 and hist[-1].forma == TRIANGULO:
        return saida(PINK)
    return saida(p.cor ?? [RED, BLUE, BLUE][p.seq % 3])

box rotear(j, p, destino):         # decide a seta de um relé quando há pulso nele
    if destino == None:
        return MANTER
    if destino.linha < j.linha and j.norte and not ocupado(j, NORTE):
        return NORTE
    if destino.linha > j.linha and j.sul and not ocupado(j, SUL):
        return SUL
    return LESTE
```

- Estrutura do Python (indentação, `if/elif/else`, `for x in lista:`, `break`, `continue`, fatiamento `l[a:b]`) com partes do JavaScript (`let`, `const`, `??`).
- Pulso `p`: `cor` (ou `None` se velado), `porta`, `seq`, `turno`, `carga`, `forma`; no Roteador também `direcao` (para onde vinha andando). `hist`: os 10 pulsos anteriores.
- Relé `j`: `linha`, `coluna`, `norte`, `leste`, `sul` (fio livre?), `direcao`. `destino`: `linha`, `cor`, `terra`, ou `None`. Sensor `ocupado(j, DIR)`: a próxima casa vai estar ocupada?
- Retornos: Classificador `saida(COR)`, `TERRA`, `MANUAL`; Roteador `NORTE`, `LESTE`, `SUL`, `ESPERAR`, `MANTER`.
- Limites: 120 operações por chamada, 1000 de energia por turno, cada caixa instalada custa 1 por turno. `=>` e `match` continuam bloqueados (mostram o preço em PP).

## Escopo atual

- Modo **fácil**: sem banco de tempo, bancada de testes livre, mudança de regime anunciada.
- Regras ocultas com peça-base (ciclo, mapa por porta/carga/forma, tabela com `seq % n`, atributo do pulso anterior) e até dois modificadores (ruído periódico, cor fixa por atributo).
- Bancada: o Classificador roda contra os pulsos que já saíram, com o véu e o `hist` originais; o Roteador é verificado simulando uma rota de cada porta ativa para cada saída ativa.
- Recorde e histórico do modo, bagagem (as duas caixas seguem para a próxima partida) e regra de partida abandonada.

Ainda fora: modos médio e difícil, banco de tempo, caixas Previsor/Vigia/Aprendiz, `mem`, pesquisa (PP) e desbloqueios.

## Estrutura

```
src/
  dsl/     lexer, parser, interpretador e valores da linguagem
  game/    motor de turnos, grade e relés, regras ocultas, diretor, caixas e bancada
  ui/      interface: Canvas da grade, linha do tempo em SVG, editor com realce e sugestões
  core/    cores, formas, direções e gerador pseudoaleatório com semente
tests/     testes da DSL e do motor (Vitest)
```

## Deploy

O projeto é um site estático do Vite: na Vercel, importe o repositório e mantenha o preset **Vite** (build `npm run build`, saída `dist`). Não há funções de servidor por enquanto; os dados ficam no `localStorage` do navegador.
