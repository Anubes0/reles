# Relé

Jogo por turnos e infinito: você roteia pulsos coloridos por uma rede de fios e relés e escreve scripts, numa linguagem própria, para automatizar os padrões ocultos que descobrir.

**Jogue em [reles-fawn.vercel.app](https://reles-fawn.vercel.app/).**

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
- Você tem **2 ações por turno**: definir o destino de um pulso, girar um relé ou segurar um pulso por 1 turno. O resto se automatiza com as caixas programáveis.
- **Filas e colisões:** quem vai para uma casa com pulso parado espera atrás. Dois pulsos entrando na mesma casa colidem (−1 de integridade cada). No barramento vertical, pulsos em sentidos opostos se cruzam.
- Saída errada: −1. Ruído numa saída: −2. Sem destino na 2ª coluna de relés, o pulso vai ao terra. Depois de 60 turnos na grade, queima.
- O **diretor** sobe do nível 0 ao 10: mais portas, mais cores, regras combinadas, fios rompidos a cada onda e saídas que trocam de cor.
- A partida fica salva no navegador: dá para fechar a aba e continuar depois. Só existe uma partida por vez; começar outra abandona a atual.

### Modos

| | Fácil | Médio | Difícil |
| --- | --- | --- | --- |
| Banco de tempo | não | 60 s, +5 s por turno | 30 s, +3 s por turno |
| Bancada de testes | livre | custa 5 s do banco | não existe |
| Aplicar script | imediato | imediato | encerra o turno |
| Mudança de regime | anunciada | só um ícone pisca | sem aviso |
| Registro | 12 eventos | 5 | 3 |
| Saídas apagam | não | depois de 8 turnos sem entrega | depois de 3 |
| Velados (nível 0 → 10) | 25% → 65% | 45% → 75% | 60% → 90% |
| Energia por turno | 1000 | 800 | 600 |
| Multiplicador de pontos | 1,0 → 3,5 | 1,5 → 4,5 | 2,5 → 6,0 |
| Bagagem | 4 caixas | 3 | 2 |

Com o banco zerado, os turnos passam sozinhos, só com os scripts, até ele voltar a 10 s. Trocar de janela ou `Esc` pausam o banco.

### Pontos, pesquisa e bagagem

- Entrega certa: 10 × multiplicador; ruído no terra: 5 × multiplicador. Um pulso **sintonizado** (o Previsor acertou a cor) vale o dobro.
- **Eficiência:** ao fim de cada onda, até 25% dos pontos da onda, na proporção da energia que sobrou nos turnos com scripts.
- Cada partida terminada rende **1 PP a cada 100 pontos**. Os PP compram, na **Pesquisa** (`P`), recursos da linguagem e caixas novas. PP, desbloqueios, recorde, histórico e bagagem são **separados por modo**.
- No fim da partida você escolhe quais caixas instaladas seguem para a próxima (a **bagagem**); o que não for levado é apagado. Partida abandonada só entra no recorde e no histórico se tiver pontos, e não rende PP nem bagagem.

| Tecla | Ação |
| --- | --- |
| `Espaço` / `Enter` | Encerrar o turno |
| `Tab` / `Shift+Tab` | Selecionar pulso |
| `1`–`9`, `0` / `T` | Enviar o pulso selecionado a uma saída de cor / ao terra |
| `S` | Segurar o pulso selecionado por 1 turno |
| Clique no relé | Girar (Shift+clique ou botão direito: ao contrário) |
| `E` | Ir para o editor |
| `P` | Pesquisa |
| `Esc` | Pausar (no editor: sair dele) |
| `H` | Ajuda |
| `Ctrl+Enter` / `Ctrl+Shift+Enter` (no editor) | Aplicar / testar o script |
| `Ctrl+Espaço` (no editor) | Sugestões |

## A linguagem

Cinco caixas, cada uma com assinatura fixa. As duas primeiras vêm liberadas; as outras saem na pesquisa.

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

box prever(hist):                  # aposta na cor do próximo pulso: acertou, ele vale o dobro
    if len(hist) == 0:
        return None
    return [RED, BLUE][(hist[-1].seq + 1) % 2]

box vigiar(evento, hist):          # recebe cada ENTREGA, COLISAO ou QUEIMOU; ALERTA pausa o jogo
    if evento.tipo == ENTREGA and not evento.ok:
        return ALERTA
    return None

box ao_entregar(p, ok):            # o Aprendiz: vê a cor real de quem saiu e grava no mem
    if ok:
        mem[0] = p.cor
```

- Estrutura do Python (indentação, `if/elif/else`, `for x in lista:`, `break`, `continue`, fatiamento `l[a:b]`) com partes do JavaScript (`let`, `const`, `??`). Sempre proibidos: `while`, recursão, `import`, aleatoriedade.
- Pulso `p`: `cor` (ou `None` se velado), `porta`, `seq`, `turno`, `carga`, `forma`; no Roteador também `direcao` (para onde vinha andando). `hist`: os 10 pulsos anteriores (no Vigia, os 10 eventos anteriores).
- Relé `j`: `linha`, `coluna`, `norte`, `leste`, `sul` (fio livre?), `direcao`. `destino`: `linha`, `cor`, `terra`, ou `None`. Sensor `ocupado(j, DIR)`: a próxima casa vai estar ocupada?
- Evento do Vigia: `tipo`, `pulso` (com a cor real), `ok`, `saida`, `terra`, `destino`.
- Limites: 120 operações por chamada; energia por turno conforme o modo; cada caixa instalada custa 1 por turno.

| Pesquisa | Libera | PP |
| --- | --- | --- |
| Sensores avançados | `vizinhos(j)` (relés ao lado, com `.via`) e `dist(j, destino)` (passos até a saída) | 80 |
| Memória | `mem`: 8 posições compartilhadas entre as caixas; cada uma ocupada custa 2 de energia por turno | 100 |
| Funcional | `x => ...`, `.filter`, `.map`, `.some` | 100 |
| Casamento | `match`/`case` | 120 |
| Previsor | caixa `prever(hist)` | 150 |
| Vigia | caixa `vigiar(evento, hist)` | 150 |
| Aprendiz | caixa `ao_entregar(p, ok)`; exige Memória | 400 |

## O que ainda está em aberto

- Calibrar os números jogando (energia, multiplicadores, preços em PP, bancos de tempo).
- Recordes online usando um servidor na Vercel.

## Estrutura

```
src/
  dsl/     lexer, parser, interpretador e valores da linguagem
  game/    motor de turnos, grade e relés, regras ocultas, diretor, caixas e bancada
  ui/      interface: Canvas da grade, linha do tempo em SVG, editor com realce e sugestões
  core/    cores, formas, direções e gerador pseudoaleatório com semente
tests/     testes da DSL e do motor (Vitest)
```

## Deploy na Vercel

O projeto é um site estático do Vite, já configurado em `vercel.json` (preset Vite, `npm run build`, saída `dist`, cache longo para os arquivos com hash e cabeçalhos de segurança básicos).

1. Na Vercel, **Add New… → Project** e importe o repositório `Anubes0/reles`.
2. Mantenha o que a Vercel detectar (Framework: Vite). Não há variáveis de ambiente.
3. **Deploy.** A cada push na `main`, a Vercel publica de novo; cada pull request ganha uma prévia.

Requer Node 22.12 ou mais novo (campo `engines` do `package.json`). Não há funções de servidor por enquanto: partida em andamento, recordes, pesquisa, bagagem e scripts ficam no `localStorage` de cada navegador.
